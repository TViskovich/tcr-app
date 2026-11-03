// Signed-out deletion status — the only thing a status capability can do.
//
//   POST { token: "<status capability>" }
//     200 { status: 'ok', state: 'processing' | 'completed' | 'failed' }
//     401 { status: 'failed', reason: 'invalid_capability' }   missing, malformed,
//                                                             unknown, revoked or expired
//     429 { status: 'failed', reason: 'rate_limited', retry_after_seconds }
//
// After Delete Now, the collector's Auth account is deleted with their
// session, so the app confirms the outcome with the capability that
// account-deletion issued it while it was still signed in
// (supabase/migrations/20261110120000_account_deletion_status_capability.sql).
//
// Gateway JWT verification is OFF for this function only because its
// callers have no session any more; the capability is the authorization,
// checked on every request. Nothing else is accepted: no job or user id is
// read from the request, so no one can ask about another collector's job.
// The response holds no ids, times, counts or personal data, and the
// capability can't change anything. Rate limits are enforced in the
// database (one check per capability every 2 s; 20 failed checks per client
// per 10 minutes). The capability and the client address are never logged
// or stored — only their SHA-256.

import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';

// 32 random bytes, base64url without padding.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return `\\x${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// The caller's address as the platform proxy reports it. Used only, hashed,
// for the failed-attempt limit.
function clientAddress(req: Request): string {
  return req.headers.get('cf-connecting-ip')?.trim()
    || req.headers.get('x-real-ip')?.trim()
    || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}

const invalid = () => jsonResponse({ status: 'failed', reason: 'invalid_capability' }, 401);

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);

  let token = '';
  try {
    const body = await req.json();
    if (typeof body?.token === 'string') token = body.token;
  } catch {}

  try {
    // Every attempt — including a missing or malformed capability — is
    // checked (and counted) the same way.
    const { data, error } = await serviceRoleClient().rpc('account_deletion_status_by_token', {
      p_token_hash: TOKEN_RE.test(token) ? await sha256(token) : await sha256(`malformed:${token.length}`),
      p_client_hash: await sha256(`account-deletion-status:${clientAddress(req)}`),
    });
    if (error) {
      console.error(JSON.stringify({ fn: 'account-deletion-status', outcome: 'check_failed', db_code: error.code }));
      return jsonResponse({ status: 'failed', reason: 'server_error' }, 500);
    }
    const result = data as { result: string; state?: string; retry_after_seconds?: number };
    if (result.result === 'rate_limited') {
      const retry = Math.max(1, Number(result.retry_after_seconds ?? 2));
      const res = jsonResponse({ status: 'failed', reason: 'rate_limited', retry_after_seconds: retry }, 429);
      res.headers.set('Retry-After', String(retry));
      return res;
    }
    if (result.result !== 'ok' || !TOKEN_RE.test(token)) return invalid();
    return jsonResponse({ status: 'ok', state: result.state }, 200);
  } catch {
    console.error(JSON.stringify({ fn: 'account-deletion-status', outcome: 'unexpected_error' }));
    return jsonResponse({ status: 'failed', reason: 'server_error' }, 500);
  }
});
