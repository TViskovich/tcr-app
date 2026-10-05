// CacheCase invite-only access — Phase 2A. Grants an existing WAITLISTED
// signup access, issues an invite code, and emails it. Admin-only, invoked
// from the in-app admin screen (app/admin/waitlist.tsx).
//
// SECURITY — the caller must be an authenticated admin:
//   1. Deployed WITH gateway JWT verification (the default; do NOT pass
//      --no-verify-jwt). Rejects requests without a valid Supabase JWT.
//   2. requireAdmin (../_shared/admin-auth.ts) resolves the JWT to a user and
//      requires a row in public.admin_users. Layer 1 alone is not enough —
//      every signed-in app user has a JWT. No shared secret is involved;
//      the service-role key stays in this function's environment.
//
//   curl -X POST https://<project-ref>.supabase.co/functions/v1/grant-waitlist-access \
//     -H "Authorization: Bearer <an admin user's access token>" \
//     -H "Content-Type: application/json" \
//     -d '{"waitlist_signup_id":"<uuid>"}'          # or add "regenerate": true
//
// Request:  POST { waitlist_signup_id: uuid, regenerate?: boolean }
//   Everything else (code, status, timestamps, email body) is server-derived;
//   any other body field is ignored.
//
// Grant/regenerate is one atomic DB call — grant_waitlist_access (migration
// 20261005140000): row locked FOR UPDATE, status precondition, DB-clock
// timestamps, expiry exactly access_granted_at + 14 days. Two concurrent
// grants serialize: one 'granted', one 'already_granted', one code, one email.
//
// Codes are hash-only (see ../_shared/invite-code.ts): the plaintext exists
// in this function's memory and the email, and is never sent to PostgreSQL,
// logged, or returned. So the original code can't be re-sent — "resend" IS
// regeneration (`regenerate: true`), which invalidates the previous code.
//
// Email ordering: the grant commits first, then Resend is called (it can't
// join a DB transaction). If the email fails the grant is NOT rolled back and
// NOT automatically regenerated; the response reports the failure and an
// admin must deliberately call again with `regenerate: true`.
//
// Responses (never include the code or its hash):
//   200 { status: 'ok' | 'email_failed', result: 'granted' | 'regenerated', ...signup, email_delivery }
//   404 { status: 'failed', reason: 'not_found' }
//   409 { status: 'failed', reason: 'already_granted' | 'onboarded' | 'not_granted', ...signup }
//   400 invalid_body | invalid_waitlist_signup_id | invalid_regenerate
//   401 unauthorized · 403 forbidden (not an admin) · 405 method_not_allowed · 500 grant_failed

import { generateInviteCode, hashInviteCode, normalizeInviteCode } from '../_shared/invite-code.ts';
import { requireAdmin } from '../_shared/admin-auth.ts';
import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';
import { sendResendEmail, type EmailResult } from '../_shared/resend.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_LIFETIME_DAYS = 14; // Display only — the DB function sets the actual expiry.

type RpcRow = {
  outcome: 'granted' | 'regenerated' | 'not_found' | 'onboarded' | 'already_granted' | 'not_granted';
  email: string | null;
  name: string | null;
  status: string | null;
  access_granted_at: string | null;
  access_code_expires_at: string | null;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inviteEmail(name: string, code: string) {
  const text =
    `Hi ${name},\n\n` +
    `You're in. Your invite-only access to CacheCase is ready.\n\n` +
    `Your access code:\n\n${code}\n\n` +
    `You'll enter this code when you create your CacheCase account.\n\n` +
    `This invite expires in ${INVITE_LIFETIME_DAYS} days.\n\n` +
    `The CacheCase team`;
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#111;max-width:480px">` +
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>You're in. Your invite-only access to CacheCase is ready.</p>` +
    `<p style="margin-bottom:4px">Your access code:</p>` +
    `<p style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:22px;font-weight:700;letter-spacing:2px;margin-top:0">${code}</p>` +
    `<p>You'll enter this code when you create your CacheCase account.</p>` +
    `<p>This invite expires in ${INVITE_LIFETIME_DAYS} days.</p>` +
    `<p>The CacheCase team</p>` +
    `</div>`;
  return { subject: 'Your CacheCase invite is ready', text, html };
}

function signupFields(row: RpcRow, signupId: string) {
  return {
    waitlist_signup_id: signupId,
    email: row.email,
    signup_status: row.status,
    access_granted_at: row.access_granted_at,
    access_code_expires_at: row.access_code_expires_at,
  };
}

function deliveryFields(result: EmailResult) {
  return result.sent
    ? { sent: true, resend_id: result.resendId }
    : {
        sent: false,
        reason: result.reason,
        ...(result.httpStatus ? { resend_status: result.httpStatus } : {}),
        ...(result.resendError ? { resend_error: result.resendError } : {}),
      };
}

// Safe-to-log fields only: never the code, its hash, keys or JWTs. Email addresses aren't logged (join-waitlist doesn't either).
function logOutcome(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ fn: 'grant-waitlist-access', ...fields }));
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') {
    return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);
  }

  const client = serviceRoleClient();
  const admin = await requireAdmin(client, req, 'grant-waitlist-access');
  if (!admin.ok) return admin.response;

  let body: { waitlist_signup_id?: unknown; regenerate?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }

  const signupId = typeof body.waitlist_signup_id === 'string' ? body.waitlist_signup_id.trim().toLowerCase() : '';
  if (!UUID_RE.test(signupId)) {
    return jsonResponse({ status: 'failed', reason: 'invalid_waitlist_signup_id' }, 400);
  }
  if (body.regenerate !== undefined && typeof body.regenerate !== 'boolean') {
    return jsonResponse({ status: 'failed', reason: 'invalid_regenerate' }, 400);
  }
  const regenerate = body.regenerate === true;

  // Plaintext stays in this scope: emailed below, never persisted/logged.
  const code = generateInviteCode();
  const normalized = normalizeInviteCode(code);
  if (!normalized) {
    // Unreachable unless generate/normalize drift apart — fail closed.
    logOutcome({ waitlist_signup_id: signupId, outcome: 'code_generation_failed' });
    return jsonResponse({ status: 'failed', reason: 'grant_failed' }, 500);
  }
  const codeHash = await hashInviteCode(normalized);

  const { data, error } = await client.rpc('grant_waitlist_access', {
    p_signup_id: signupId,
    p_code_hash: codeHash,
    p_regenerate: regenerate,
  });
  const row = (Array.isArray(data) ? data[0] : data) as RpcRow | undefined;
  if (error || !row) {
    logOutcome({ waitlist_signup_id: signupId, outcome: 'grant_failed', db_code: error?.code ?? 'no_row' });
    return jsonResponse({ status: 'failed', reason: 'grant_failed' }, 500);
  }

  if (row.outcome === 'not_found') {
    logOutcome({ waitlist_signup_id: signupId, regenerate, outcome: 'not_found' });
    return jsonResponse({ status: 'failed', reason: 'not_found' }, 404);
  }

  if (row.outcome === 'onboarded' || row.outcome === 'already_granted' || row.outcome === 'not_granted') {
    const expired =
      row.outcome === 'already_granted' && row.access_code_expires_at
        ? new Date(row.access_code_expires_at).getTime() <= Date.now()
        : undefined;
    logOutcome({ waitlist_signup_id: signupId, regenerate, outcome: row.outcome });
    return jsonResponse(
      {
        status: 'failed',
        reason: row.outcome,
        ...signupFields(row, signupId),
        ...(expired !== undefined ? { expired } : {}),
      },
      409,
    );
  }

  // 'granted' | 'regenerated' — the new hash is committed. Send the email.
  const message = inviteEmail(row.name ?? 'there', code);
  const delivery: EmailResult = row.email
    ? await sendResendEmail({ to: row.email, ...message })
    : { sent: false, reason: 'resend_rejected' };

  logOutcome({
    waitlist_signup_id: signupId,
    admin_user_id: admin.userId,
    outcome: row.outcome,
    access_code_expires_at: row.access_code_expires_at,
    email_sent: delivery.sent,
    ...(delivery.sent
      ? { resend_status: delivery.httpStatus, resend_id: delivery.resendId }
      : { email_failure: delivery.reason, resend_status: delivery.httpStatus, resend_error: delivery.resendError }),
  });

  return jsonResponse(
    {
      status: delivery.sent ? 'ok' : 'email_failed',
      result: row.outcome,
      ...signupFields(row, signupId),
      email_delivery: deliveryFields(delivery),
      ...(delivery.sent ? {} : { next_step: 'Access is granted but the email did not send. Call again with "regenerate": true to issue a new code and retry.' }),
    },
    200,
  );
});
