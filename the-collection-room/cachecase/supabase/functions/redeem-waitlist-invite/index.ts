// CacheCase invite-only — Phase 2B. The ONLY intended path that creates a new
// CacheCase account: validates the invite, creates the auth user with the
// Auth admin API, and atomically consumes + binds the invite.
//
// Once "Allow new users to sign up" is turned off in Supabase Auth, public
// supabase.auth.signUp() is refused and this function (service role) is the
// only way a new account can exist. Until then this is the app's path, and
// the open-signup bypass remains — see the Phase 2B rollout order.
//
// Public by design (logged-out callers; the invite code is the credential).
// Deploy with `supabase functions deploy redeem-waitlist-invite --no-verify-jwt`.
//
// Request:  POST { code, email, password, username }
// Response: 200 { status: 'ok', result: 'redeemed' | 'already_redeemed' }
//             → the app then signs in with signInWithPassword. No session or
//               token is ever returned from here.
//         | 400 { status: 'failed', reason: 'invalid_body' | 'invalid_email' | 'invalid_username' | 'invalid_password' }
//         | 409 { status: 'failed', reason: 'invalid' | 'expired' | 'used' | 'email_mismatch'
//                                        | 'username_taken' | 'username_mismatch' | 'account_exists' }
//         | 503 { status: 'failed', reason: 'retry' }   outcome unknown — safe to retry with the same input
//         | 500 { status: 'failed', reason: 'signup_failed' }
//
// ORDERING / FAILURE SEMANTICS (the Auth admin API can't join a Postgres
// transaction):
//   1. check_waitlist_invite(hash, email) — no lock. Bad/expired/used code,
//      wrong email, or reserved-username mismatch is rejected here, before
//      any account exists.
//   2. admin.createUser({ email_confirm: true }) — the existing
//      handle_new_user trigger still creates the profile + account number.
//      A taken username fails inside that trigger (nothing is created).
//   3. redeem_waitlist_invite(hash, user_id) — locks the invite row and
//      re-checks status, expiry and the ACCOUNT's real email at commit time,
//      then sets onboarded / onboarded_at / onboarded_user_id. Retried once
//      on an ambiguous error.
//   4. Definitive redemption failure for a user created by THIS request →
//      admin.deleteUser (profile cascades). Ambiguous → never delete; 503 so
//      the client retries.
//   Retry after an unclear result: if the invite was already bound, step 1
//   sees 'used' and the caller gets 'already_redeemed' only after proving
//   ownership of the bound account by signing in with the submitted
//   password. If the account exists but the invite isn't bound, createUser
//   reports the email exists and the same proof finishes the redemption
//   (idempotent per user). A wrong password gets a generic
//   'used' / 'account_exists'.
//
// email_confirm: true is deliberate (approved): the code only ever travelled
// to the invited address and the invite is bound to it, so redeeming it is
// proof of control of that inbox.
//
// Never logs or returns the code, its hash, the password, the email, or any
// token. Logs outcome/reason, and a user id only when cleanup fails.

import { createClient, isAuthRetryableFetchError } from 'npm:@supabase/supabase-js@2';

import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';
import {
  inviteCodeHash,
  normalizeEmail,
  normalizeUsername,
  validPassword,
  type InviteCheckRow,
} from '../_shared/waitlist-invite.ts';

type RedeemOutcome = 'redeemed' | 'already_redeemed' | 'invalid' | 'expired' | 'used' | 'email_mismatch' | 'no_user';

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ fn: 'redeem-waitlist-invite', ...fields }));
}

function failed(reason: string, status: number) {
  log({ outcome: 'failed', reason });
  return jsonResponse({ status: 'failed', reason }, status);
}

// Matched on Auth's error code (plus its classic message as a fallback) —
// NOT a loose "already exists", which also matches the Postgres detail Auth
// passes through when handle_new_user hits profiles_username_key.
function isEmailExistsError(err: { code?: string; message?: string }) {
  return (
    err.code === 'email_exists' ||
    err.code === 'user_already_exists' ||
    /email address has already been registered/i.test(err.message ?? '')
  );
}

// Proves the caller owns an EXISTING account for this email (retry after an
// ambiguous createUser, or an account that predates the invite). Returns its
// id, 'wrong' for bad credentials, or 'unknown'. The temporary session is
// revoked immediately and never leaves this function.
async function provenExistingUser(email: string, password: string): Promise<string | 'wrong' | 'unknown'> {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anonKey) {
    log({ outcome: 'misconfigured', detail: 'missing SUPABASE_ANON_KEY' });
    return 'unknown';
  }
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error) return isAuthRetryableFetchError(error) || (error.status ?? 0) >= 500 ? 'unknown' : 'wrong';
    const userId = data.user?.id;
    if (data.session?.access_token) {
      await serviceRoleClient().auth.admin.signOut(data.session.access_token, 'local').catch(() => {});
    }
    return userId ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// Profile id holding `username`, if any.
async function usernameOwner(username: string): Promise<string | null> {
  const { data } = await serviceRoleClient().from('profiles').select('id').eq('username', username).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function redeem(codeHash: string, userId: string): Promise<RedeemOutcome | null> {
  const client = serviceRoleClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await client.rpc('redeem_waitlist_invite', { p_code_hash: codeHash, p_user_id: userId });
      const row = (Array.isArray(data) ? data[0] : data) as { outcome: RedeemOutcome } | undefined;
      if (!error && row) return row.outcome;
      log({ outcome: 'redeem_rpc_error', attempt, db_code: error?.code ?? 'no_row' });
    } catch {
      log({ outcome: 'redeem_rpc_threw', attempt });
    }
  }
  return null; // ambiguous
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return failed('method_not_allowed', 405);

  let body: { code?: unknown; email?: unknown; password?: unknown; username?: unknown };
  try {
    body = await req.json();
  } catch {
    return failed('invalid_body', 400);
  }
  if (!body || typeof body !== 'object') return failed('invalid_body', 400);

  const email = normalizeEmail(body.email);
  if (!email) return failed('invalid_email', 400);
  const names = normalizeUsername(body.username);
  if (!names) return failed('invalid_username', 400);
  if (!validPassword(body.password)) return failed('invalid_password', 400);
  const password = body.password;
  // Malformed and unknown codes are indistinguishable to the caller.
  const codeHash = await inviteCodeHash(body.code);
  if (!codeHash) return failed('invalid', 409);

  const admin = serviceRoleClient();

  // 1. Pre-check — nothing is created unless this passes.
  const { data: checkData, error: checkError } = await admin.rpc('check_waitlist_invite', {
    p_code_hash: codeHash,
    p_email: email,
  });
  const check = (Array.isArray(checkData) ? checkData[0] : checkData) as InviteCheckRow | undefined;
  if (checkError || !check) {
    log({ outcome: 'check_failed', db_code: checkError?.code ?? 'no_row' });
    return failed('retry', 503);
  }
  if (check.outcome === 'used') {
    // Either someone else's consumed invite, or THIS caller's own earlier
    // redemption whose response was lost. Only the account owner can tell
    // them apart: prove ownership with the submitted credentials, and the
    // idempotent redemption reports 'already_redeemed' only if the invite
    // is bound to that exact account. Anything else stays 'used'.
    const proven = await provenExistingUser(email, password);
    if (proven === 'unknown') return failed('retry', 503);
    if (proven !== 'wrong' && (await redeem(codeHash, proven)) === 'already_redeemed') {
      log({ outcome: 'already_redeemed', created_here: false });
      return jsonResponse({ status: 'ok', result: 'already_redeemed' }, 200);
    }
    return failed('used', 409);
  }
  if (check.outcome !== 'valid') return failed(check.outcome, 409);
  if (check.email_matches !== true) return failed('email_mismatch', 409);
  if (check.reserved_username && check.reserved_username.trim().toLowerCase() !== names.username) {
    return failed('username_mismatch', 409);
  }

  // 2. Create the account (or prove ownership of an existing one).
  let userId: string;
  let createdHere = false;
  try {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username: names.username, display_name: names.displayName },
    });
    if (!error && data.user) {
      userId = data.user.id;
      createdHere = true;
    } else if (error && (isEmailExistsError(error) || isAuthRetryableFetchError(error))) {
      const proven = await provenExistingUser(email, password);
      if (proven === 'unknown') return failed('retry', 503);
      if (proven === 'wrong') {
        // Auth also reports a unique violation from handle_new_user (taken
        // username) as email_exists. If the username belongs to a DIFFERENT
        // account, that's what actually failed.
        const owner = await usernameOwner(names.username);
        if (owner) {
          const { data: ownerData } = await admin.auth.admin.getUserById(owner);
          if (ownerData.user?.email?.toLowerCase() !== email) return failed('username_taken', 409);
        }
        return failed('account_exists', 409);
      }
      userId = proven;
    } else {
      // Most likely handle_new_user hit profiles_username_key (the trigger
      // failure surfaces only as "Database error creating new user").
      const taken = await usernameOwner(names.username);
      log({ outcome: 'create_user_failed', auth_status: error?.status, auth_code: error?.code, username_taken: !!taken });
      return taken ? failed('username_taken', 409) : failed('signup_failed', 500);
    }
  } catch {
    // Thrown after the request may have reached Auth — same as ambiguous.
    const proven = await provenExistingUser(email, password);
    if (proven === 'wrong' || proven === 'unknown') return failed('retry', 503);
    userId = proven;
  }

  // 3. Atomic consume-and-bind.
  const outcome = await redeem(codeHash, userId);
  if (outcome === 'redeemed' || outcome === 'already_redeemed') {
    log({ outcome, created_here: createdHere });
    return jsonResponse({ status: 'ok', result: outcome }, 200);
  }
  if (outcome === null) {
    // Unknown whether the invite was bound — keep the account; a retry
    // finishes it through the existing-account path.
    return failed('retry', 503);
  }

  // 4. Definitive failure (e.g. expired or used between steps 1 and 3).
  if (createdHere) {
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
    if (deleteError) log({ outcome: 'cleanup_failed', user_id: userId, auth_status: deleteError.status });
    else log({ outcome: 'cleanup_deleted_user' });
  }
  const reason = outcome === 'no_user' ? 'signup_failed' : outcome;
  return failed(reason, reason === 'signup_failed' ? 500 : 409);
});
