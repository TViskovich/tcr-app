/// <reference types="node" />
// Password recovery and password changes — end-to-end against the LOCAL
// Supabase stack (Auth + Mailpit), with disposable accounts created through
// the Auth admin API (the same path invite redemption uses).
//
// Exercises the exact Supabase calls the app makes (lib/auth.tsx,
// lib/account-credentials.ts): resetPasswordForEmail → the emailed code
// (read from Mailpit) → verifyOtp({ type: 'recovery' }) → updateUser →
// signOut({ scope: 'others' }); and the signed-in change (signInWithPassword
// → updateUser → signOut others). Codes and passwords are never printed.
//
// Prerequisites: local Supabase started with supabase/config.toml (signup
// disabled, recovery template with {{ .Token }}, otp_length 8,
// max_frequency 60s, minimum_password_length 8). Step 9 calls the
// account-export and account-deletion functions, so serve them first:
//   supabase functions serve --env-file <local functions env>
// Run (Node 24 runs .ts directly):  node scripts/integration/account-recovery.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { newPasswordProblem, passwordProblem, PASSWORD_MIN_LENGTH } from '../../lib/password-policy.ts';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const MAIL = st.MAILPIT_URL ?? st.INBUCKET_URL;
if (!MAIL || !/^http:\/\/(127\.0\.0\.1|localhost):/.test(MAIL)) throw new Error('Refusing: no local Mailpit.');
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const client = () => createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'account-recovery-it';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const pw = () => `Rc-${randomBytes(9).toString('base64url')}`;

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);

// ── Mailpit ────────────────────────────────────────────────────────────────
type Mail = { ID: string; Created: string; Subject: string };
async function mailsTo(email: string): Promise<Mail[]> {
  const r = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=50`);
  return ((await r.json()).messages ?? []) as Mail[];
}
async function newMail(email: string, seen: number, timeoutMs = 10_000): Promise<{ subject: string; text: string; html: string } | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const list = await mailsTo(email);
    if (list.length > seen) {
      const m = await (await fetch(`${MAIL}/api/v1/message/${list[0].ID}`)).json();
      return { subject: m.Subject as string, text: (m.Text ?? '') as string, html: (m.HTML ?? '') as string };
    }
    await sleep(300);
  }
  return null;
}
const codeIn = (mail: { text: string; html: string } | null) => (mail ? ((mail.text + ' ' + mail.html).match(/\b(\d{6,10})\b/)?.[1] ?? null) : null);
async function sql(statement: string) {
  execFileSync('supabase', ['db', 'query', '--local', statement], { stdio: ['ignore', 'pipe', 'ignore'] });
}

// ── Fixtures ───────────────────────────────────────────────────────────────
type U = { id: string; email: string; password: string };
async function createUser(key: string): Promise<U> {
  const email = `rc${run}${key}@example.test`;
  const password = pw();
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username: `rc${run}${key}` }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  return { id: data.user.id, email, password };
}
async function signedIn(u: U): Promise<SupabaseClient> {
  const c = client();
  const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`sign-in failed for fixture: ${error.message}`);
  return c;
}
async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  ids.push(...deletedFixtures); // permanently deleted in step 10: only their job rows remain
  if (ids.length) {
    await admin.from('account_lifecycle').delete().in('user_id', ids);
    await admin.from('account_deletion_jobs').delete().in('user_id', ids);
  }
  for (const id of ids) {
    const { data: files } = await admin.storage.from('account-exports').list(id, { limit: 1000 });
    for (const dir of files ?? []) {
      const { data: inner } = await admin.storage.from('account-exports').list(`${id}/${dir.name}`, { limit: 1000 });
      const paths = (inner ?? []).map((f) => `${id}/${dir.name}/${f.name}`);
      if (paths.length) await admin.storage.from('account-exports').remove(paths);
    }
    if (!deletedFixtures.includes(id)) await admin.auth.admin.deleteUser(id);
  }
  deletedFixtures.length = 0;
  const list = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent('to:"@example.test"')}&limit=500`)).json();
  const mine = ((list.messages ?? []) as (Mail & { To: { Address: string }[] })[]).filter((m) => m.To?.some((t) => /^rc[0-9a-f]{6}/.test(t.Address)));
  if (mine.length) await fetch(`${MAIL}/api/v1/messages`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ IDs: mine.map((m) => m.ID) }) });
  return ids.length;
}
const deletedFixtures: string[] = [];

// ── Edge Functions (served locally) ────────────────────────────────────────
async function fn(name: 'account-export' | 'account-deletion', body: Record<string, unknown>, accessToken: string) {
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}
const countOf = async (table: string, userId?: string) => {
  let q = admin.from(table).select('*', { count: 'exact', head: true });
  if (userId) q = q.eq('user_id', userId);
  const { count, error } = await q;
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
};
const totals = async () => ({
  exports: await countOf('account_exports'),
  lifecycle: await countOf('account_lifecycle'),
  pending: (await admin.from('account_lifecycle').select('user_id', { count: 'exact', head: true }).neq('state', 'active')).count ?? 0,
  deletion_jobs: await countOf('account_deletion_jobs'),
  users: (await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.length,
});
const amrMethods = (accessToken: string) =>
  ((JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).amr ?? []) as { method: string }[]).map((m) => m.method);
// The app drives an export with 'advance' calls (no recent sign-in needed).
async function driveExport(accessToken: string, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await fn('account-export', { action: 'advance' }, accessToken);
    const state = r.body.export?.state ?? r.body.export?.status;
    if (r.status !== 200 || ['ready', 'failed', 'expired'].includes(state)) return `${r.status} ${state ?? r.body.reason ?? ''}`.trim();
    await sleep(300);
  }
  return 'timed out';
}

async function requestCode(u: U): Promise<string | null> {
  const seen = (await mailsTo(u.email)).length;
  const { error } = await client().auth.resetPasswordForEmail(u.email);
  if (error) throw new Error(`reset request failed: ${error.code}`);
  return codeIn(await newMail(u.email, seen));
}

async function main() {
  step('0. Local Auth matches the invite-only production setup; the password policy');
  const settings = await (await fetch(`${st.API_URL}/auth/v1/settings`, { headers: { apikey: st.ANON_KEY } })).json();
  check('public signup is disabled (disable_signup = true)', settings.disable_signup === true, settings.disable_signup);
  const before = (await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.length;
  const probe = `rcprobe${run}@example.test`;
  const { error: signUpError } = await client().auth.signUp({ email: probe, password: pw() });
  const after = (await admin.auth.admin.listUsers({ perPage: 1000 })).data.users;
  check('a public signUp is refused (signup_disabled) and creates no account', signUpError?.code === 'signup_disabled'
    && after.length === before && !after.some((u) => u.email === probe), signUpError?.code);
  check(`password policy: under ${PASSWORD_MIN_LENGTH} characters, all spaces and over 72 bytes are refused`,
    passwordProblem('Short7!') !== null && passwordProblem('        ') !== null && passwordProblem('é'.repeat(37)) !== null
    && passwordProblem('longenough') === null && newPasswordProblem('longenough', 'different1') !== null && newPasswordProblem('longenough', 'longenough') === null);

  const A = await createUser('a'); // happy path
  const B = await createUser('b'); // expired code
  const C = await createUser('c'); // other sessions on recovery
  const D = await createUser('d'); // signed-in change
  const E = await createUser('e'); // pending deletion
  check('fixture accounts are created through the admin API while signup is disabled', !!A.id && !!E.id);

  step('1. Requesting a code: identical answers for known and unknown addresses');
  const unknown = `rcnobody${run}@example.test`;
  const seenA = (await mailsTo(A.email)).length;
  const known = await client().auth.resetPasswordForEmail(A.email);
  const none = await client().auth.resetPasswordForEmail(unknown);
  check('known and unknown addresses get the same API answer (no error, same data)', known.error === null && none.error === null
    && JSON.stringify(known.data) === JSON.stringify(none.data), { known: known.error?.code, unknown: none.error?.code });
  const mailA = await newMail(A.email, seenA);
  const codeA = codeIn(mailA);
  check('the known address receives the recovery email with an 8-digit code', !!mailA && /^\d{8}$/.test(codeA ?? '') && /password reset code/i.test(mailA.subject), mailA?.subject);
  check('the email contains no link (code only)', !!mailA && !/https?:\/\//i.test(mailA.text + mailA.html) && !/token_hash|access_token/i.test(mailA.html));
  await sleep(1500);
  check('the unknown address receives nothing', (await mailsTo(unknown)).length === 0);
  check('no account is created for the unknown address', !(await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.some((u) => u.email === unknown));

  step('2. Server-side resend limit (max_frequency 60 s)');
  const again = await client().auth.resetPasswordForEmail(A.email);
  const againUnknown = await client().auth.resetPasswordForEmail(unknown);
  check('an immediate second request for a real account is rate-limited (429) and sends nothing',
    again.error?.status === 429 && (await mailsTo(A.email)).length === seenA + 1, again.error?.code);
  // NOTE: Supabase answers 200 for the unknown address here — the app maps
  // both to the same screen (lib/auth.tsx requestPasswordReset), but the raw
  // API difference is recorded for the report.
  check('(recorded) the unknown address is not rate-limited by the server — the app must hide the difference', againUnknown.error === null);

  step('3. Wrong codes fail identically');
  const wrong = String((Number(codeA) + 1) % 100_000_000).padStart(8, '0');
  const wrongKnown = await client().auth.verifyOtp({ email: A.email, token: wrong, type: 'recovery' });
  const wrongUnknown = await client().auth.verifyOtp({ email: unknown, token: wrong, type: 'recovery' });
  check('a wrong code is refused (no session)', !!wrongKnown.error && !wrongKnown.data.session, wrongKnown.error?.code);
  check('…with the same error as a code for an unknown address', wrongKnown.error?.code === wrongUnknown.error?.code
    && wrongKnown.error?.status === wrongUnknown.error?.status, { known: wrongKnown.error?.code, unknown: wrongUnknown.error?.code });

  step('4. Correct code → new password (and a failed update keeps the session)');
  const recA = client();
  const verified = await recA.auth.verifyOtp({ email: A.email, token: codeA!, type: 'recovery' });
  check('the correct code signs the collector in (a recovery session)', !verified.error && !!verified.data.session, verified.error?.code);
  const amr = JSON.parse(Buffer.from(verified.data.session!.access_token.split('.')[1], 'base64url').toString()).amr as { method: string }[];
  check(`(recorded) the recovery session's sign-in method in the token: ${amr?.map((m) => m.method).join(',')}`, Array.isArray(amr));
  const weak = await recA.auth.updateUser({ password: 'short7' });
  check('a too-short new password is refused by the server (weak_password)', weak.error?.code === 'weak_password', weak.error?.code);
  const same = await recA.auth.updateUser({ password: A.password });
  check('reusing the current password is refused (same_password)', same.error?.code === 'same_password', same.error?.code);
  check('after a failed update the recovery session is still valid (the app keeps its hold)', !(await recA.auth.getUser()).error);
  const newA = pw();
  const ok = await recA.auth.updateUser({ password: newA });
  check('a valid new password is saved (works with secure_password_change on)', !ok.error, ok.error?.code);
  const signNew = await client().auth.signInWithPassword({ email: A.email, password: newA });
  const signOld = await client().auth.signInWithPassword({ email: A.email, password: A.password });
  check('the new password signs in', !signNew.error && !!signNew.data.session, signNew.error?.code);
  check('the old password is rejected', signOld.error?.code === 'invalid_credentials', signOld.error?.code);

  step('5. Reused and expired codes');
  const reuse = await client().auth.verifyOtp({ email: A.email, token: codeA!, type: 'recovery' });
  check('an already-used code is refused', !!reuse.error && !reuse.data.session, reuse.error?.code);
  const codeB = await requestCode(B);
  await sql(`UPDATE auth.users SET recovery_sent_at = now() - interval '2 hours' WHERE email = '${B.email}'`); // local test only
  const expired = await client().auth.verifyOtp({ email: B.email, token: codeB!, type: 'recovery' });
  check('an expired code is refused, with the same error as a wrong one', !!expired.error && !expired.data.session
    && expired.error.code === wrongKnown.error?.code, expired.error?.code);

  step('6. Recovery signs out every other session');
  const s1 = await signedIn(C);
  const s2 = await signedIn(C);
  const codeC = await requestCode(C);
  const recC = client();
  await recC.auth.verifyOtp({ email: C.email, token: codeC!, type: 'recovery' });
  const newC = pw();
  const upC = await recC.auth.updateUser({ password: newC });
  const othersOut = await recC.auth.signOut({ scope: 'others' });
  check('password saved and signOut({ scope: "others" }) succeeds', !upC.error && !othersOut.error, upC.error?.code ?? othersOut.error?.code);
  const r1 = await s1.auth.refreshSession();
  const u2 = await s2.auth.getUser();
  check('another device can no longer refresh its session', !!r1.error, r1.error?.code);
  check('…and Supabase Auth no longer accepts its session', !!u2.error, u2.error?.code);
  check('the recovering device stays signed in', !(await recC.auth.getUser()).error);
  const staleRead = await s2.from('profiles').select('id').eq('id', C.id);
  check(`(recorded) an old access token can still read until it expires (JWT lifetime): ${staleRead.error ? 'refused' : 'still readable'}`, true);

  step('7. Signed-in Change Password');
  const other = await signedIn(D);
  const wrongCurrent = await client().auth.signInWithPassword({ email: D.email, password: 'Not-the-password-1' });
  check('a wrong current password is refused', wrongCurrent.error?.code === 'invalid_credentials', wrongCurrent.error?.code);
  const me = await signedIn(D); // confirmPassword: a fresh sign-in
  const newD = pw();
  const upD = await me.auth.updateUser({ password: newD });
  const outD = await me.auth.signOut({ scope: 'others' });
  check('the new password is saved and other sessions signed out', !upD.error && !outD.error, upD.error?.code ?? outD.error?.code);
  check('the other device is signed out', !!(await other.auth.refreshSession()).error);
  check('old password rejected, new accepted', (await client().auth.signInWithPassword({ email: D.email, password: D.password })).error?.code === 'invalid_credentials'
    && !(await client().auth.signInWithPassword({ email: D.email, password: newD })).error);

  step('8. A pending-deletion account can recover its password (and stays pending)');
  const { error: schedErr } = await admin.rpc('schedule_account_deletion', { p_user_id: E.id });
  check('E is scheduled for deletion', !schedErr, schedErr?.message);
  const codeE = await requestCode(E);
  check('a pending account receives its code', /^\d{8}$/.test(codeE ?? ''));
  const recE = client();
  const vE = await recE.auth.verifyOtp({ email: E.email, token: codeE!, type: 'recovery' });
  const newE = pw();
  const upE = vE.error ? vE : await recE.auth.updateUser({ password: newE });
  check('the pending account resets its password', !vE.error && !upE.error, (vE.error ?? upE.error)?.code);
  const { data: lc } = await admin.from('account_lifecycle').select('state').eq('user_id', E.id).single();
  check('…and is still pending deletion (recovery doesn’t restore or delete it)', lc?.state === 'pending_deletion', lc);
  check('…and can sign in with the new password (the app then shows Pending Deletion, where it can cancel)',
    !(await client().auth.signInWithPassword({ email: E.email, password: newE })).error);

  step('9. An unfinished recovery session cannot export or delete (password-only recent sign-in)');
  const ping = await fetch(`${st.API_URL}/functions/v1/account-export`, { method: 'OPTIONS' }).catch(() => null);
  if (!ping || ping.status >= 500) throw new Error('Edge Functions are not served locally (supabase functions serve).');
  const F = await createUser('f'); // recovers, then acts legitimately
  const N = await createUser('n'); // normal password user, never recovers
  const G = await createUser('g'); // normal password user, deletes now
  const codeF = await requestCode(F);
  const recF = client();
  const vF = await recF.auth.verifyOtp({ email: F.email, token: codeF!, type: 'recovery' });
  check('F verifies its recovery code (password NOT changed yet)', !vF.error && !!vF.data.session, vF.error?.code);
  const recToken = vF.data.session!.access_token;
  check(`the recovery session records no password sign-in (amr: ${amrMethods(recToken).join(',')})`, !amrMethods(recToken).includes('password'));
  const before9 = await totals();
  const reqR = await fn('account-export', { action: 'request' }, recToken);
  check('recovery session: account-export request → 403 reauthentication_required', reqR.status === 403 && reqR.body.reason === 'reauthentication_required', reqR);
  const schR = await fn('account-deletion', { action: 'schedule', confirmation: 'DELETE' }, recToken);
  check('recovery session: account-deletion schedule → 403 reauthentication_required', schR.status === 403 && schR.body.reason === 'reauthentication_required', schR);
  const nowR = await fn('account-deletion', { action: 'delete_now', confirmation: 'DELETE' }, recToken);
  check('recovery session: account-deletion delete_now → 403 reauthentication_required', nowR.status === 403 && nowR.body.reason === 'reauthentication_required', nowR);
  await sleep(1500); // give any (wrongly) kicked worker time to show up
  check('…no export was created for F', (await countOf('account_exports', F.id)) === 0);
  const { data: lcF } = await admin.from('account_lifecycle').select('state').eq('user_id', F.id).maybeSingle();
  check('…F was not scheduled for deletion (no lifecycle change)', !lcF || lcF.state === 'active', lcF);
  check('…no deletion job was created for F', (await countOf('account_deletion_jobs', F.id)) === 0);
  check('…F still exists', !(await admin.auth.admin.getUserById(F.id)).error);
  const after9 = await totals();
  check('…no other records changed (exports, lifecycle, pending, deletion jobs, users)', JSON.stringify(before9) === JSON.stringify(after9), { before9, after9 });
  const stR = await fn('account-export', { action: 'status' }, recToken);
  check('the recovery session still reads export status (session itself is valid)', stR.status === 200, stR.status);
  const canRec = await fn('account-deletion', { action: 'cancel' }, recToken);
  check('cancel needs no recent password: the recovery session may call it (account active → nothing to restore)',
    canRec.status === 200 && canRec.body.restored === false, { status: canRec.status, restored: canRec.body.restored });

  const newF = pw();
  const upF = await recF.auth.updateUser({ password: newF });
  check('F saves its new password (recovery completed)', !upF.error, upF.error?.code);
  const refreshed = (await recF.auth.refreshSession()).data.session;
  const reqAfter = await fn('account-export', { action: 'request' }, refreshed?.access_token ?? recToken);
  check('the same recovery session, refreshed after the save, is still refused (403) — a password sign-in is required',
    reqAfter.status === 403 && reqAfter.body.reason === 'reauthentication_required', reqAfter.status);

  const pwF = (await client().auth.signInWithPassword({ email: F.email, password: newF })).data.session;
  check('F signs in with the new password (as the app\'s confirm-password step does)', !!pwF && amrMethods(pwF.access_token).includes('password'));
  const reqP = await fn('account-export', { action: 'request' }, pwF!.access_token);
  check('password session: account-export request → 200 (export queued)', reqP.status === 200 && (await countOf('account_exports', F.id)) === 1, reqP.status);
  const schP = await fn('account-deletion', { action: 'schedule', confirmation: 'DELETE' }, pwF!.access_token);
  check('password session: account-deletion schedule → 200 (pending deletion)', schP.status === 200 && schP.body.state === 'pending_deletion', { status: schP.status, state: schP.body.state });
  const exportF = await driveExport(pwF!.access_token);
  check(`F's legitimate export completes (${exportF})`, exportF === '200 ready', exportF);
  await sleep(9000); // past the local 8 s window (ACCOUNT_RECENT_AUTH_SECONDS=8 in the functions env)
  const lateReq = await fn('account-export', { action: 'request' }, pwF!.access_token);
  check('the same password session past the window: request → 403 reauthentication_required', lateReq.status === 403 && lateReq.body.reason === 'reauthentication_required', lateReq.status);
  const canP = await fn('account-deletion', { action: 'cancel' }, pwF!.access_token);
  const { data: lcF2 } = await admin.from('account_lifecycle').select('state').eq('user_id', F.id).maybeSingle();
  check('cancel still needs no fresh sign-in: the same (now stale) session restores F', canP.status === 200 && canP.body.restored === true && (!lcF2 || lcF2.state === 'active'),
    { status: canP.status, restored: canP.body.restored, lcF2 });

  step('10. Normal password users are unaffected');
  const tN = (await client().auth.signInWithPassword({ email: N.email, password: N.password })).data.session!.access_token;
  const schN = await fn('account-deletion', { action: 'schedule', confirmation: 'DELETE' }, tN);
  check('N (password sign-in): schedule → 200', schN.status === 200 && schN.body.state === 'pending_deletion', schN.status);
  const canN = await fn('account-deletion', { action: 'cancel' }, tN);
  check('N: cancel → 200, restored', canN.status === 200 && canN.body.restored === true, canN.status);
  const tG = (await client().auth.signInWithPassword({ email: G.email, password: G.password })).data.session!.access_token;
  const nowG = await fn('account-deletion', { action: 'delete_now', confirmation: 'DELETE' }, tG);
  check('G (password sign-in): delete_now → 200 (deleting)', nowG.status === 200 && nowG.body.state === 'deleting', { status: nowG.status, reason: nowG.body.reason, state: nowG.body.state });
  if (nowG.status === 200) deletedFixtures.push(G.id);
  let gone = false;
  for (let i = 0; i < 90 && nowG.status === 200 && !gone; i++) {
    gone = !!(await admin.auth.admin.getUserById(G.id)).error;
    if (!gone) await sleep(1000);
  }
  check('…and G is permanently deleted by the worker', gone);
}

console.log(`Local Supabase ${st.API_URL}, Mailpit ${MAIL} (run ${run})`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
let fatal: unknown = null;
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`\nAborted: ${(e as Error).message}`);
} finally {
  console.log(`\nCleanup: ${await sweep()} account(s) removed.`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
