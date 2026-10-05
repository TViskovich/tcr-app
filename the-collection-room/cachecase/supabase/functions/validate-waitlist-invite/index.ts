// CacheCase invite-only — Phase 2B. Informational invite-code check for the
// app's "You're invited" screen. UX only: redeem-waitlist-invite re-checks
// everything atomically at account creation, so a 'valid' here is never
// trusted later.
//
// Public by design, like join-waitlist: logged-out app users have no
// session, and the code itself is the credential. Deploy with
// `supabase functions deploy validate-waitlist-invite --no-verify-jwt`.
//
// Request:  POST { code: string }
// Response: 200 { valid: true, name, expires_at, reserved_username }
//         | 200 { valid: false, reason: 'invalid' | 'expired' | 'used' }
//         | 400 { status: 'failed', reason: 'invalid_body' } · 405 · 500 { reason: 'check_failed' }
//
// Malformed and unknown codes are both 'invalid'. 'expired' / 'used' are only
// reachable by someone holding the exact code (100-bit), so nothing here is
// enumerable. Never returns the waitlist id, invited email, or code hash, and
// never logs the code or hash.

import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';
import { inviteCodeHash, type InviteCheckRow } from '../_shared/waitlist-invite.ts';

function logOutcome(outcome: string) {
  console.log(JSON.stringify({ fn: 'validate-waitlist-invite', outcome }));
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') {
    return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);
  }

  let body: { code?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }

  const codeHash = await inviteCodeHash(body.code);
  if (!codeHash) {
    logOutcome('invalid');
    return jsonResponse({ valid: false, reason: 'invalid' }, 200);
  }

  const { data, error } = await serviceRoleClient().rpc('check_waitlist_invite', { p_code_hash: codeHash });
  const row = (Array.isArray(data) ? data[0] : data) as InviteCheckRow | undefined;
  if (error || !row) {
    console.log(JSON.stringify({ fn: 'validate-waitlist-invite', outcome: 'check_failed', db_code: error?.code ?? 'no_row' }));
    return jsonResponse({ status: 'failed', reason: 'check_failed' }, 500);
  }

  logOutcome(row.outcome);
  if (row.outcome !== 'valid') {
    return jsonResponse({ valid: false, reason: row.outcome }, 200);
  }
  return jsonResponse(
    {
      valid: true,
      name: row.name,
      expires_at: row.expires_at,
      reserved_username: row.reserved_username,
    },
    200,
  );
});
