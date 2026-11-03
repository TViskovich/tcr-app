/// <reference types="node" />
// Signed-out deletion status (status capability) — end-to-end through the
// REAL Edge Functions, Auth and database on the LOCAL Supabase stack, with
// disposable collectors only.
//
// Covers: a capability is issued by Delete Now (and again on request while
// deleting, e.g. after a lost answer), stored only as a hash; it reports
// processing → completed before and after the Auth account is deleted, and
// failed for a failed job; missing, malformed, guessed and expired
// capabilities are refused alike; one collector's capability never reports
// another's job, whatever else is sent; the capability can't act on
// account-deletion or account-export; per-capability and per-client rate
// limits; at most 5 live per job; answers and logs hold no personal data.
//
// Prerequisites (local only): Vault secrets as for account-permanent-
// deletion.ts; functions served with ACCOUNT_RECENT_AUTH_SECONDS=8 and
// ACCOUNT_MAINTENANCE_SECRET; MAINTENANCE_SECRET_FILE; optionally
// FUNCTIONS_LOG pointing at the `supabase functions serve` output.
// Run:  MAINTENANCE_SECRET_FILE=… FUNCTIONS_LOG=… node scripts/integration/account-deletion-status.ts
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const secret = readFileSync(process.env.MAINTENANCE_SECRET_FILE ?? '', 'utf8').trim();
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'deletion-status-it';
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();

const results: { name: string; ok: boolean }[] = [];
let section = '';
const step = (s: string) => {
  section = s;
  console.log(`\n${s}`);
};
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name: `[${section}] ${name}`, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
}

type User = { id: string; email: string; password: string; username: string; db: SupabaseClient; token: string };
const run = randomUUID().replace(/-/g, '').slice(0, 5);
const users: User[] = [];
async function createUser(key: string): Promise<User> {
  const username = `ds${run}${key}`;
  const email = `${username}@example.test`;
  const password = `ds-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const u: User = { id: data.user.id, email, password, username, db: createClient(st.API_URL, st.ANON_KEY, opts), token: '' };
  await signIn(u);
  users.push(u);
  return u;
}
async function signIn(u: User) {
  const { data, error } = await u.db.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw error;
  u.token = data.session.access_token;
}
async function fn(name: string, body: unknown, bearer: string | null, apikey = st.ANON_KEY) {
  const res = await fetch(`${st.API_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, retryAfter: res.headers.get('retry-after') };
}
// Signed out: only the publishable key, as the app sends it after the
// session is gone (not a JWT).
const statusOf = (token: unknown, extra: Record<string, unknown> = {}) =>
  fn('account-deletion-status', { token, ...extra }, st.PUBLISHABLE_KEY, st.PUBLISHABLE_KEY);
// One check per capability every 2 seconds.
const settle = () => sleep(2100);
const worker = () => fn('account-maintenance', {}, secret);
const jobOf = async (userId: string) =>
  (await admin.from('account_deletion_jobs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle()).data as Record<string, any> | null;
const resetThrottle = () => psql('delete from private.account_deletion_status_throttle');
const sha256hex = (v: string) => createHash('sha256').update(v).digest('hex');
const onlyKeys = (j: Record<string, any> | null, keys: string[]) => !!j && Object.keys(j).every((k) => keys.includes(k));

let fatal: unknown = null;
try {
  resetThrottle();
  const D1 = await createUser('a');
  const D2 = await createUser('b');
  const identities = users.flatMap((u) => [u.id, u.email, u.username]);

  step('1. Missing, malformed and guessed capabilities');
  const missing = await statusOf(undefined);
  const malformed = await statusOf('not-a-capability');
  const guessed = await statusOf(randomBytes(32).toString('base64url'));
  check('missing: 401 invalid_capability', missing.status === 401 && missing.json?.reason === 'invalid_capability', missing);
  check('malformed: the same 401', malformed.status === 401 && malformed.text === missing.text);
  check('guessed (well-formed, random): the same 401', guessed.status === 401 && guessed.text === missing.text);
  check('reachable without a session (gateway JWT check off for this endpoint only)', missing.status !== 403);
  const activeStatus = await fn('account-deletion', { action: 'status', want_status_token: true }, D1.token);
  check('an active account gets no capability, even when asking', activeStatus.json?.state === 'active' && !('status_token' in (activeStatus.json ?? {})), activeStatus.json);
  resetThrottle();

  step('2. Delete Now issues a capability, stored only as a hash');
  await signIn(D1);
  const del1 = await fn('account-deletion', { action: 'delete_now', confirmation: 'DELETE' }, D1.token);
  const T1 = del1.json?.status_token as string;
  check('Delete Now is accepted with a capability', del1.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(T1 ?? ''), del1.json);
  const exp = Date.parse(del1.json?.status_token_expires_at);
  check('it expires in 72 hours', Math.abs(exp - Date.now() - 72 * 3600_000) < 120_000, del1.json?.status_token_expires_at);
  const job1 = del1.json?.job?.id as string;
  check('the server stores its SHA-256 for D1’s job', psql(`select job_id from private.account_deletion_status_tokens where token_hash = '\\x${sha256hex(T1)}'::bytea`) === job1);
  check('and never the capability itself', psql(`select count(*) from private.account_deletion_status_tokens t where t::text like '%${T1}%'`) === '0');
  check('the job id is not the capability (no relation)', !T1.includes(job1.replace(/-/g, '').slice(0, 8)));

  step('3. Valid capability before the Auth account is deleted');
  const s1 = await statusOf(T1);
  check('200 with a generic state', s1.status === 200 && ['processing', 'completed'].includes(s1.json?.state), s1);
  check('the answer holds only status and state', onlyKeys(s1.json, ['status', 'state']), s1.json);
  const fast = await statusOf(T1);
  check('a second check within 2 s: 429 with Retry-After', fast.status === 429 && fast.json?.reason === 'rate_limited' && fast.retryAfter === '2', fast);

  step('4. The capability can’t act');
  for (const action of ['status', 'cancel', 'schedule', 'delete_now']) {
    const r = await fn('account-deletion', { action, confirmation: 'DELETE' }, T1);
    check(`as a bearer on account-deletion (${action}): 401`, r.status === 401, r.status);
  }
  const exp1 = await fn('account-export', { action: 'request' }, T1);
  check('as a bearer on account-export: 401', exp1.status === 401, exp1.status);
  await settle();
  const restart = await statusOf(T1, { action: 'delete_now', confirmation: 'DELETE' });
  check('extra fields on the status endpoint are ignored (it only reads)', restart.status === 200 && onlyKeys(restart.json, ['status', 'state']), restart.json);

  step('5. Lost Delete Now answer: a new capability on request');
  // Hold D2's deletion (the worker waits while a Download My Data step holds
  // its lease), so D2 is still signed in and deleting for this step.
  psql(`insert into public.account_exports (user_id, status, lease_until) values ('${D2.id}', 'collecting', now() + interval '10 minutes')`);
  await signIn(D2);
  const del2 = await fn('account-deletion', { action: 'delete_now', confirmation: 'DELETE' }, D2.token);
  const T2 = del2.json?.status_token as string; // as if this answer never arrived
  const job2 = del2.json?.job?.id as string;
  const re = await fn('account-deletion', { action: 'status', want_status_token: true }, D2.token);
  const T2b = re.json?.status_token as string;
  check('status with want_status_token while deleting issues a new one', re.json?.state === 'deleting' && /^[A-Za-z0-9_-]{43}$/.test(T2b ?? '') && T2b !== T2, re.json);
  const plain = await fn('account-deletion', { action: 'status' }, D2.token);
  check('a plain status call issues none', !('status_token' in (plain.json ?? {})));
  check('both of D2’s capabilities point at D2’s job', psql(`select count(*) from private.account_deletion_status_tokens where job_id = '${job2}'`) === '2');
  const issued: string[] = [];
  for (let i = 0; i < 5; i++) issued.push((await fn('account-deletion', { action: 'status', want_status_token: true }, D2.token)).json?.status_token);
  check('at most 5 live capabilities per job', psql(`select count(*) from private.account_deletion_status_tokens where job_id = '${job2}'`) === '5');
  const T2c = (await fn('account-deletion', { action: 'status', want_status_token: true }, D2.token)).json?.status_token as string;
  const revoked = await statusOf(T2);
  check('the oldest is revoked (same 401 as any invalid one)', revoked.status === 401 && revoked.text === missing.text, revoked);
  const T2d = issued[issued.length - 1]; // a newer, still-live capability
  resetThrottle();

  step('6. Cross-account isolation');
  psql(`update public.account_deletion_jobs set status = 'failed', failed_at = now(), last_error_code = 'auth_delete_failed', lease_until = null where id = '${job2}'`);
  await settle();
  const crossA = await statusOf(T1, { job_id: job2, user_id: D2.id });
  const crossB = await statusOf(T2c, { job_id: job1, user_id: D1.id });
  check('D1’s capability reports D1’s job, whatever ids are sent', crossA.json?.state !== 'failed' && crossA.status === 200, crossA.json);
  check('D2’s capability reports D2’s job (failed)', crossB.json?.state === 'failed', crossB.json);
  check('no failure detail or ids in the answer', !crossB.text.includes('auth_delete_failed') && !crossB.text.includes(job2));

  step('7. After the Auth account is deleted: completed');
  let j1 = await jobOf(D1.id);
  for (let i = 0; i < 30 && j1?.status !== 'completed'; i++) {
    await worker();
    j1 = await jobOf(D1.id);
    if (j1?.status !== 'completed') await sleep(300);
  }
  check('D1’s deletion completes', j1?.status === 'completed', j1);
  check('D1’s Auth account is gone', !(await admin.auth.admin.getUserById(D1.id)).data?.user);
  const oldSession = await fn('account-deletion', { action: 'status' }, D1.token);
  check('D1’s old session can no longer call account-deletion', oldSession.status === 401);
  await settle();
  const done = await statusOf(T1);
  check('the capability still works, with no session (publishable key only): completed', done.status === 200 && done.json?.state === 'completed', done);

  step('8. Failed, then recovered');
  await settle();
  check('a failed job reads failed', (await statusOf(T2d)).json?.state === 'failed');
  psql(`delete from public.account_exports where user_id = '${D2.id}';
        update public.account_deletion_jobs set status = 'queued', step_failures = 0, failed_at = null, next_attempt_at = now() where id = '${job2}'`);
  let j2 = await jobOf(D2.id);
  for (let i = 0; i < 30 && j2?.status !== 'completed'; i++) {
    await worker();
    j2 = await jobOf(D2.id);
    if (j2?.status !== 'completed') await sleep(300);
  }
  await settle();
  check('once an operator re-queues it and it completes: completed', j2?.status === 'completed' && (await statusOf(T2d)).json?.state === 'completed', j2?.status);

  step('9. Expired');
  psql(`update private.account_deletion_status_tokens set expires_at = now() - interval '1 second' where token_hash = '\\x${sha256hex(T2d)}'::bytea`);
  const expired = await statusOf(T2d);
  check('an expired capability: the same 401 as any invalid one', expired.status === 401 && expired.text === missing.text, expired);
  await settle();
  check('D2’s other live capability still works', (await statusOf(T2c)).json?.state === 'completed');

  step('10. Per-client limit on failed checks');
  resetThrottle();
  for (let i = 0; i < 20; i++) await statusOf(randomBytes(32).toString('base64url'));
  await settle();
  const limited = await statusOf(T1);
  check('after 20 failed checks the client is refused, even with a valid capability', limited.status === 429 && Number(limited.json?.retry_after_seconds) > 0, limited);
  psql(`update private.account_deletion_status_throttle set window_start = now() - interval '11 minutes'`);
  check('after the 10-minute window it may check again', (await statusOf(T1)).json?.state === 'completed');
  check('clients are stored only as a hash', psql(`select count(*) from private.account_deletion_status_throttle t where t::text like '%172.%' or t::text like '%127.0.0.1%'`) === '0');

  step('11. No personal data');
  const all = [missing, malformed, guessed, s1, fast, restart, revoked, crossA, crossB, done, expired, limited].map((r) => r.text).join('\n');
  check('no account ids, emails or usernames in any answer', identities.every((v) => !all.includes(v)));
  check('no job ids in any answer', !all.includes(job1) && !all.includes(job2));
  if (process.env.FUNCTIONS_LOG) {
    const log = readFileSync(process.env.FUNCTIONS_LOG, 'utf8');
    check('no capability appears in the function logs', ![T1, T2, T2b, T2c, ...issued].some((t) => log.includes(t)));
  }
} catch (e) {
  fatal = e;
  console.error(`Aborted: ${(e as Error).message}`);
} finally {
  for (const u of users) {
    await admin.from('account_lifecycle').delete().eq('user_id', u.id);
    await admin.auth.admin.deleteUser(u.id).catch(() => {}); // disposable fixtures only
  }
  if (users.length) {
    const ids = users.map((u) => `'${u.id}'`).join(',');
    psql(`delete from public.account_exports where user_id in (${ids}); delete from public.account_deletion_jobs where user_id in (${ids})`);
  }
  resetThrottle();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
process.exitCode = failed.length || fatal ? 1 : 0;
