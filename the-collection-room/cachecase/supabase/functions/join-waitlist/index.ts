// CacheCase waitlist signup — Phase 1's only public entry point into
// waitlist_signups. Framer's landing page form posts here; it never talks
// to Supabase directly (no anon-key insert path exists at all — see the
// migration's RLS/grant posture), so this Edge Function IS the security
// boundary, not a convenience wrapper around one.
//
// Fully anonymous by design, matching get-public-registry-card's own
// precedent: no Authorization header is expected or inspected. Deployed
// with gateway JWT verification disabled
// (`supabase functions deploy join-waitlist --no-verify-jwt`).
//
// Request:  POST { name: string, email: string }
// Response: 200 { status: 'ok'; result: 'waitlisted' | 'already_waitlisted' }
//         | 400 { status: 'failed'; reason: 'invalid_body' | 'invalid_name' | 'invalid_email' }
//         | 405 { status: 'failed'; reason: 'method_not_allowed' }
//         | 500 { status: 'failed'; reason: 'signup_failed' }   (unexpected DB error)
//
// Duplicate emails (by normalized, case-insensitive match) are idempotent —
// no second row is ever created, and the response looks like success rather
// than leaking a uniqueness-constraint error. Relies on the database's own
// unique index (waitlist_signups_normalized_email_key) as the actual race
// guard for two concurrent submissions of the same email, rather than a
// separate select-then-insert check that could itself race.
//
// access_code / access_granted_at / onboarded_at / reserved_username are
// never touched here — Phase 1 only ever inserts a bare 'waitlisted' row.
// Access-code generation, redemption, and admin batching are explicitly
// out of scope for this function.
//
// Resend is best-effort: if the insert succeeds but the confirmation email
// fails to send (missing secrets, Resend API error, network failure), the
// signup is NOT rolled back — it's logged and the caller still gets a
// success response, since the signup itself is the source of truth, not
// the email.

import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 100;
// RFC 5321's own limit on a complete email address (not a project-specific
// choice) — the standard practical bound regardless of validity per-part.
const MAX_EMAIL_LENGTH = 254;

// Postgres SQLSTATE for a unique_violation, surfaced verbatim on
// PostgrestError.code — the signal that waitlist_signups_normalized_email_key
// rejected this insert as a duplicate, not any other kind of failure.
const UNIQUE_VIOLATION = '23505';

async function sendConfirmationEmail(name: string, email: string): Promise<void> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('WAITLIST_FROM_EMAIL');

  if (!apiKey || !fromEmail) {
    console.error('[join-waitlist] RESEND_API_KEY or WAITLIST_FROM_EMAIL not set; skipping confirmation email');
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: email,
        subject: "You're on the CacheCase waitlist",
        text:
          `Hi ${name},\n\n` +
          `You're officially on the CacheCase waitlist. Public onboarding opens ` +
          `November 2026 — we'll email you again as soon as your access is granted.\n\n` +
          `Thanks for your patience,\nThe CacheCase team`,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('[join-waitlist] Resend send failed:', res.status, body);
    }
  } catch (err) {
    console.error('[join-waitlist] Resend request threw:', err instanceof Error ? err.message : err);
  }
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);
  }

  let body: { name?: unknown; email?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > MAX_NAME_LENGTH) {
    return jsonResponse({ status: 'failed', reason: 'invalid_name' }, 400);
  }

  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!rawEmail || rawEmail.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(rawEmail)) {
    return jsonResponse({ status: 'failed', reason: 'invalid_email' }, 400);
  }
  const email = rawEmail;

  const client = serviceRoleClient();

  const { error: insertError } = await client
    .from('waitlist_signups')
    .insert({ name, email, status: 'waitlisted' });

  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) {
      return jsonResponse({ status: 'ok', result: 'already_waitlisted' }, 200);
    }
    console.error('[join-waitlist] insert failed:', insertError.message);
    return jsonResponse({ status: 'failed', reason: 'signup_failed' }, 500);
  }

  await sendConfirmationEmail(name, email);

  return jsonResponse({ status: 'ok', result: 'waitlisted' }, 200);
});
