/// <reference types="node" />
// Account deletion (Dashboard Milestone 2, Checkpoint 2) — end-to-end check
// of the account-deletion Edge Function and everything around it, through
// the REAL APIs against the LOCAL Supabase stack, with disposable accounts:
//   A — schedules deletion, is checked while pending, then cancels
//   B — has a DM conversation with A; tries to reach A while pending
//   C — put into the 'deleting' state to prove it can't be cancelled
//
// Prerequisite: the functions are served with a SHORT recent-sign-in window
// so a stale sign-in can be produced by waiting:
//   echo ACCOUNT_RECENT_AUTH_SECONDS=8 > /tmp/fn.env
//   supabase functions serve --env-file /tmp/fn.env
// Run (Node 24 runs .ts directly):
//   node scripts/integration/account-deletion.ts
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'account-deletion-it';
const WINDOW_SECONDS = 8; // must match the served ACCOUNT_RECENT_AUTH_SECONDS

const results: { name: string; ok: boolean }[] = [];
let section = '';
const step = (s: string) => {
  section = s;
  console.log(`\n${s}`);
};
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name: `[${section}] ${name}`, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}

type User = { id: string; email: string; password: string; username: string };
const run = randomUUID().replace(/-/g, '').slice(0, 5);

async function createUser(key: string): Promise<User> {
  const username = `ad${run}${key}`;
  const email = `${username}@example.test`;
  const password = `ad-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  return { id: data.user.id, email, password, username };
}
// A fresh session (its own client, its own refresh token).
async function signIn(u: User): Promise<{ db: SupabaseClient; token: string; refresh: string }> {
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data, error } = await db.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw error;
  return { db, token: data.session.access_token, refresh: data.session.refresh_token };
}

async function sweep() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const ids = data.users.filter((u) => u.app_metadata?.fixture === FIXTURE).map((u) => u.id);
  // Pending rows cancel cleanly; a 'deleting' row goes with its auth user.
  await admin.from('account_lifecycle').delete().in('user_id', ids).eq('state', 'pending_deletion');
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}

async function fn(body: unknown, token: string | null, method = 'POST') {
  const res = await fetch(`${st.API_URL}/functions/v1/account-deletion`, {
    method,
    headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${token ?? st.ANON_KEY}` },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {}
  return { status: res.status, json };
}
const count = async (c: SupabaseClient, table: string, col: string, val: string) => {
  const { count: n, error } = await c.from(table).select('*', { count: 'exact', head: true }).eq(col, val);
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
};

async function main() {
  const A = await createUser('a');
  const B = await createUser('b');
  const C = await createUser('c');
  const b = await signIn(B);

  // A DM conversation between A and B, created through their own clients.
  const a0 = await signIn(A);
  const conv = await a0.db.rpc('get_or_create_conversation', { other_user_id: B.id });
  if (conv.error) throw conv.error;
  const convId = conv.data as string;
  for (const [db, id, body] of [[a0.db, A.id, 'hi B'], [b.db, B.id, 'hi A']] as const) {
    const { error } = await db.from('messages').insert({ id: randomUUID(), conversation_id: convId, sender_id: id, body });
    if (error) throw error;
  }
  const { data: before } = await b.db.from('messages').select('id, body, sender_id, created_at').eq('conversation_id', convId).order('id');

  step('1. Request validation and authorization');
  check('GET is rejected', (await fn(null, a0.token, 'GET')).status === 405);
  check('an unknown action is rejected', (await fn({ action: 'erase' }, a0.token)).json?.reason === 'invalid_action');
  check('no user token (public key only) is rejected', (await fn({ action: 'status' }, null)).json?.reason === 'invalid_token');
  check('a garbage token is rejected', (await fn({ action: 'status' }, 'not-a-token')).status === 401);
  const statusA = await fn({ action: 'status' }, a0.token);
  check('status: an active account reports active', statusA.json?.state === 'active', statusA.json);
  const spoof = await fn({ action: 'status', user_id: A.id }, b.token);
  check('a client-supplied user_id is ignored (B gets B’s own state)', spoof.json?.state === 'active');
  const spoofSchedule = await fn({ action: 'schedule', confirmation: 'DELETE', user_id: A.id }, b.token);
  const bState = await admin.from('account_lifecycle').select('user_id').in('user_id', [A.id, B.id]);
  check('B scheduling with A’s user_id never touches A', (bState.data ?? []).every((r) => r.user_id !== A.id), bState.data);
  if (spoofSchedule.json?.state === 'pending_deletion') {
    // It scheduled B (the token's owner): undo it for the rest of the run.
    await fn({ action: 'cancel' }, b.token);
  }

  step('2. Scheduling requires typed confirmation and a recent sign-in');
  const noWord = await fn({ action: 'schedule' }, a0.token);
  check('no confirmation word → confirmation_required', noWord.status === 400 && noWord.json?.reason === 'confirmation_required', noWord);
  const wrongWord = await fn({ action: 'schedule', confirmation: 'delete' }, a0.token);
  check('a different word (lowercase) → confirmation_required', wrongWord.json?.reason === 'confirmation_required', wrongWord);
  const other = await signIn(A); // another device, signed in before scheduling
  await sleep((WINDOW_SECONDS + 2) * 1000);
  const stale = await fn({ action: 'schedule', confirmation: 'DELETE' }, a0.token);
  check('a sign-in older than the window → reauthentication_required', stale.status === 403 && stale.json?.reason === 'reauthentication_required', stale);
  check('…and nothing was scheduled', (await count(admin, 'account_lifecycle', 'user_id', A.id)) === 0);

  step('3. Schedule');
  const a1 = await signIn(A); // the fresh password sign-in the app performs
  const t0 = Date.now();
  const sched = await fn({ action: 'schedule', confirmation: 'DELETE' }, a1.token);
  check('scheduled: state pending_deletion', sched.status === 200 && sched.json?.state === 'pending_deletion', sched);
  const scheduledFor = Date.parse(String(sched.json?.scheduled_for));
  check('the exact deletion time is 14 days from now', Math.abs(scheduledFor - t0 - 14 * 86_400_000) < 120_000, sched.json?.scheduled_for);
  check('first request: already_scheduled false', sched.json?.already_scheduled === false);
  check('other sessions were signed out', sched.json?.other_sessions_signed_out === true, sched.json);
  const again = await fn({ action: 'schedule', confirmation: 'DELETE' }, a1.token);
  check('repeating is safe: same timestamp, already_scheduled true', again.json?.already_scheduled === true && again.json?.scheduled_for === sched.json?.scheduled_for, again.json);
  const status2 = await fn({ action: 'status' }, a1.token);
  check('status reports pending with the same timestamp', status2.json?.state === 'pending_deletion' && status2.json?.scheduled_for === sched.json?.scheduled_for, status2.json);

  step('4. Sessions');
  const otherRefresh = await other.db.auth.refreshSession({ refresh_token: other.refresh });
  check('the other device can no longer refresh its session', !!otherRefresh.error, otherRefresh.error?.message);
  const otherWrite = await other.db.from('posts').insert({ user_id: A.id, content: 'x', post_type: 'text' });
  check('the other device’s still-unexpired token can’t write (account_inactive)', otherWrite.error?.message === 'account_inactive', otherWrite.error);
  const a2 = await signIn(A);
  check('A can still sign in while pending', !!a2.token);
  const own = await a2.db.from('account_lifecycle').select('state, scheduled_for');
  check('A reads own pending state after signing in again', (own.data ?? [])[0]?.state === 'pending_deletion');

  step('5. No bypass through direct API requests (as A)');
  const tries: [string, () => PromiseLike<{ error: { message: string } | null }>][] = [
    ['post', () => a2.db.from('posts').insert({ user_id: A.id, content: 'x', post_type: 'text' })],
    ['edit profile', () => a2.db.from('profiles').update({ bio: 'x' }).eq('id', A.id)],
    ['follow', () => a2.db.from('follows').insert({ follower_id: A.id, following_id: B.id })],
    ['message', () => a2.db.from('messages').insert({ id: randomUUID(), conversation_id: convId, sender_id: A.id, body: 'x' })],
    ['open a DM', () => a2.db.rpc('get_or_create_conversation', { other_user_id: B.id })],
    ['create a collection', () => a2.db.from('folders').insert({ user_id: A.id, name: 'x' })],
  ];
  for (const [label, attempt] of tries) {
    const { error } = await attempt();
    check(`${label} → account_inactive`, error?.message === 'account_inactive', error);
  }
  const selfCancel = await a2.db.from('account_lifecycle').delete().eq('user_id', A.id);
  const stillPending = await count(admin, 'account_lifecycle', 'user_id', A.id);
  check('A cannot delete their own lifecycle row to self-restore', stillPending === 1, selfCancel.error);
  const directRpc = await a2.db.rpc('cancel_account_deletion', { p_user_id: A.id });
  check('A cannot call the cancel function directly', !!directRpc.error);
  const bCancelA = await b.db.rpc('cancel_account_deletion', { p_user_id: A.id });
  check('B cannot cancel A’s deletion', !!bCancelA.error && (await count(admin, 'account_lifecycle', 'user_id', A.id)) === 1);
  check('A sees no content (not even B’s public profile)', (await count(a2.db, 'profiles', 'id', B.id)) === 0);

  step('6. B and A’s existing DMs');
  check('B: the conversation is gone from B’s inbox', (await count(b.db, 'conversation_participants', 'conversation_id', convId)) === 0);
  check('B: no messages, B’s own included', (await count(b.db, 'messages', 'conversation_id', convId)) === 0);
  const reopen = await b.db.rpc('get_or_create_conversation', { other_user_id: A.id });
  check('B cannot reopen it (account_unavailable)', reopen.error?.message === 'account_unavailable', reopen.error);
  const send = await b.db.from('messages').insert({ id: randomUUID(), conversation_id: convId, sender_id: B.id, body: 'x' });
  check('B cannot send into it (account_unavailable)', send.error?.message === 'account_unavailable', send.error);
  check('B cannot see A’s profile', (await count(b.db, 'profiles', 'id', A.id)) === 0);

  step('7. Cancel (no password prompt)');
  const cancel = await fn({ action: 'cancel' }, a2.token);
  check('cancel: restored, state active', cancel.json?.state === 'active' && cancel.json?.restored === true, cancel.json);
  const cancelAgain = await fn({ action: 'cancel' }, a2.token);
  check('repeating is safe: restored false', cancelAgain.json?.restored === false, cancelAgain.json);
  check('B sees A again', (await count(b.db, 'profiles', 'id', A.id)) === 1);
  const { data: after } = await b.db.from('messages').select('id, body, sender_id, created_at').eq('conversation_id', convId).order('id');
  check('B sees the same messages, unchanged', JSON.stringify(after) === JSON.stringify(before), { before, after });
  const sendBack = await b.db.from('messages').insert({ id: randomUUID(), conversation_id: convId, sender_id: B.id, body: 'welcome back' });
  check('B can message A again', !sendBack.error, sendBack.error);
  const postBack = await a2.db.from('posts').insert({ user_id: A.id, content: 'back', post_type: 'text' });
  check('A can post again', !postBack.error, postBack.error);

  step('8. Deleting can never be revived');
  const c = await signIn(C);
  await admin.rpc('begin_account_deletion', { p_user_id: C.id, p_mode: 'immediate' });
  const cCancel = await fn({ action: 'cancel' }, c.token);
  check('cancel while deleting → 409 deletion_in_progress', cCancel.status === 409 && cCancel.json?.reason === 'deletion_in_progress', cCancel);
  const cSched = await fn({ action: 'schedule', confirmation: 'DELETE' }, c.token);
  check('schedule while deleting → deletion_in_progress', cSched.json?.reason === 'deletion_in_progress', cSched);
  const cStatus = await fn({ action: 'status' }, c.token);
  check('status reports deleting', cStatus.json?.state === 'deleting', cStatus.json);
}

console.log(`Supabase ${st.API_URL} (run ${run})`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
let fatal: unknown = null;
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${section}": ${(e as Error).message}`);
} finally {
  console.log(`\nCleanup: ${await sweep()} disposable accounts removed.`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
