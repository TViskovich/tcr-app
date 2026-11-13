/// <reference types="node" />
// Permanent account deletion (Dashboard Milestone 2, Checkpoint 4) — end-to-
// end check through the REAL APIs (Edge Functions, PostgREST, Storage, Auth,
// pg_net) against the LOCAL Supabase stack, with disposable collectors only.
//
// Prerequisites (local only):
//   * Vault secrets username_reservation_key, project_url
//     (http://supabase_kong_cachecase:8000) and account_maintenance_secret;
//   * functions served with an env file containing
//       ACCOUNT_RECENT_AUTH_SECONDS=8
//       ACCOUNT_MAINTENANCE_SECRET=<same as the Vault secret>
//       ACCOUNT_EXPORT_PART_BYTES=3145728
//     and MAINTENANCE_SECRET_FILE pointing at a file holding that secret.
// Run (Node 24 runs .ts directly):
//   MAINTENANCE_SECRET_FILE=… node scripts/integration/account-permanent-deletion.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { localStack } from './local-stack.ts';

const stack = localStack();   // primary by default; CACHECASE_STACK_WORKDIR selects an isolated stack
const st = stack.st;
const secret = readFileSync(process.env.MAINTENANCE_SECRET_FILE ?? '', 'utf8').trim();
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'permanent-deletion-it';
const WINDOW_SECONDS = 8;
const work = mkdtempSync(join(tmpdir(), 'cachecase-pd-'));
const psql = (sql: string) =>
  execFileSync('docker', ['exec', stack.db, 'psql', '-U', 'postgres', '-Atc', sql], { encoding: 'utf8' }).trim();

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
const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

type User = { id: string; email: string; password: string; username: string; db: SupabaseClient; token: string };
const run = randomUUID().replace(/-/g, '').slice(0, 5);
async function createUser(key: string): Promise<User> {
  const username = `pd${run}${key}`;
  const email = `${username}@example.test`;
  const password = `pd-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const u: User = { id: data.user.id, email, password, username, db: createClient(st.API_URL, st.ANON_KEY, opts), token: '' };
  await signIn(u);
  return u;
}
async function signIn(u: User) {
  const { data, error } = await u.db.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw error;
  u.token = data.session.access_token;
}
async function removeAll(bucket: string, prefix: string) {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  const files = (data ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
  for (const dir of (data ?? []).filter((o) => !o.id)) await removeAll(bucket, `${prefix}/${dir.name}`);
  if (files.length) await admin.storage.from(bucket).remove(files);
}
async function sweep() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const ids = data.users.filter((u) => u.app_metadata?.fixture === FIXTURE).map((u) => u.id);
  for (const id of ids) {
    await admin.from('account_lifecycle').delete().eq('user_id', id).eq('state', 'pending_deletion');
    for (const bucket of ['item-images', 'avatars', 'share-snapshots', 'account-exports']) await removeAll(bucket, id);
    await admin.from('registered_cards').delete().eq('created_by', id);
    await admin.auth.admin.deleteUser(id); // disposable fixtures only
  }
  await admin.from('account_deletion_jobs').delete().in('user_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  return ids.length;
}
const listAll = async (bucket: string, prefix: string): Promise<string[]> => {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  const out = (data ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
  for (const dir of (data ?? []).filter((o) => !o.id)) out.push(...(await listAll(bucket, `${prefix}/${dir.name}`)));
  return out;
};

async function fn(name: string, body: unknown, token: string | null) {
  const res = await fetch(`${st.API_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${token ?? st.ANON_KEY}` },
    body: JSON.stringify(body),
  });
  let json: Record<string, any> | null = null;
  try {
    json = (await res.json()) as Record<string, any>;
  } catch {}
  return { status: res.status, json };
}
const worker = (body: Record<string, unknown> = {}) => fn('account-maintenance', body, secret);
const jobOf = async (userId: string) =>
  (await admin.from('account_deletion_jobs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle()).data as Record<string, any> | null;
async function workUntil(userId: string, done: (j: Record<string, any> | null) => boolean, runs = 20) {
  for (let i = 0; i < runs; i++) {
    await worker();
    const j = await jobOf(userId);
    if (done(j)) return j;
    await sleep(300);
  }
  return jobOf(userId);
}
const reachable = (url: string) => url.replace(/^https?:\/\/[^/]+/, st.API_URL);
function zipNames(path: string): { bad: string | null; names: string[]; manifest: any } {
  return JSON.parse(execFileSync('python3', ['-I', '-c', `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
print(json.dumps({'bad': z.testzip(), 'names': names, 'manifest': json.loads(z.read('manifest.json')) if 'manifest.json' in names else None}))
`, path], { encoding: 'utf8', maxBuffer: 1 << 28 }));
}

async function seed(u: User, photos: number, size: number) {
  const folder = randomUUID();
  const item = randomUUID();
  must(await u.db.from('folders').insert({ id: folder, user_id: u.id, name: `${u.username} binder`, is_public: true }), 'folder');
  must(await u.db.from('collection_items').insert({ id: item, folder_id: folder, user_id: u.id, title: `${u.username} card`, item_type: 'sports_card', is_public: true, collection_status: 'active' }), 'item');
  for (let i = 0; i < photos; i++) {
    const path = `${u.id}/${item}/p${i}.jpg`;
    must(await u.db.storage.from('item-images').upload(path, randomBytes(size), { contentType: 'image/jpeg' }), 'photo');
    must(await u.db.from('collection_item_images').insert({ item_id: item, user_id: u.id, image_url: path, storage_path: path, sort_order: i }), 'image row');
  }
  must(await u.db.storage.from('avatars').upload(`${u.id}/avatar.jpg`, randomBytes(2000), { contentType: 'image/jpeg' }), 'avatar');
  return { folder, item };
}

async function main() {
  const [A, B, C, E, F, G] = await Promise.all(['a', 'b', 'c', 'e', 'f', 'g'].map((k) => createUser(k)));

  // ── A's content, and B's copies of it ──
  const a = await seed(A, 4, 1_200_000);
  const b = await seed(B, 1, 5000);
  const snapPath = `${B.id}/snap-of-a.jpg`;
  // Written by the sharing Edge Functions with the service role in the app.
  must(await admin.storage.from('share-snapshots').upload(snapPath, randomBytes(3000), { contentType: 'image/jpeg' }), 'B snapshot');
  const snapUrl = admin.storage.from('share-snapshots').getPublicUrl(snapPath).data.publicUrl;
  const sharePost = randomUUID();
  must(await B.db.from('posts').insert({ id: sharePost, user_id: B.id, post_type: 'card_share', content: 'B shares A' }), 'share post');
  must(await admin.from('card_share_items').insert([
    { post_id: sharePost, item_id: a.item, snapshot_image_url: snapUrl, snapshot_title: `${A.username} card` },
    { post_id: sharePost, item_id: b.item, snapshot_image_url: null, snapshot_title: `${B.username} card` },
  ]), 'share items');
  const conv = must(await A.db.rpc('get_or_create_conversation', { other_user_id: B.id }), 'conv') as string;
  must(await A.db.from('messages').insert({ id: randomUUID(), conversation_id: conv, sender_id: A.id, body: 'A hello' }), 'A msg');
  must(await B.db.from('messages').insert({ id: randomUUID(), conversation_id: conv, sender_id: B.id, body: 'B hello' }), 'B msg');
  const card = must(await A.db.rpc('register_card', { p_collection_item_id: a.item, p_visibility: 'public' }), 'register') as string | { id: string };
  const cardId = typeof card === 'string' ? card : card.id;
  const bCard = must(await B.db.rpc('register_card', { p_collection_item_id: b.item, p_visibility: 'public' }), 'register B') as string | { id: string };
  const bCardId = typeof bCard === 'string' ? bCard : bCard.id;
  must(await B.db.rpc('initiate_ownership_transfer', { p_registered_card_id: bCardId, p_recipient_username: A.username, p_reason: 'gift' }), 'pending transfer to A');
  // A exports first (must be removed by deletion).
  await signIn(A);
  await fn('account-export', { action: 'request' }, A.token);
  for (let i = 0; i < 60; i++) {
    const r = await fn('account-export', { action: 'advance' }, A.token);
    if (r.json?.export?.state !== 'preparing') break;
  }

  step('1. Delete Now: checks before anything irreversible');
  const noWord = await fn('account-deletion', { action: 'delete_now' }, A.token);
  check('the typed confirmation is required', noWord.json?.reason === 'confirmation_required', noWord);
  // Checkpoint 5: the scheduler starts inactive; until an operator
  // activates it, Delete Now is neither offered nor accepted.
  psql(`select cron.alter_job(job_id := jobid, active := false) from cron.job where jobname = 'account-maintenance'`);
  await signIn(A);
  const inactive = await fn('account-deletion', { action: 'status' }, A.token);
  check('with the scheduler inactive, Delete Now is not offered', inactive.json?.delete_now_available === false, inactive.json);
  const refused = await fn('account-deletion', { action: 'delete_now', confirmation: 'DELETE' }, A.token);
  check('…and is refused without changing anything', refused.status === 503 && refused.json?.reason === 'deletion_unavailable' && (await jobOf(A.id)) === null, refused);
  psql(`select cron.alter_job(job_id := jobid, active := true) from cron.job where jobname = 'account-maintenance'`);
  const status0 = await fn('account-deletion', { action: 'status' }, A.token);
  check('the backend reports Delete Now available (worker configured)', status0.json?.delete_now_available === true, status0.json);
  await sleep((WINDOW_SECONDS + 2) * 1000);
  const stale = await fn('account-deletion', { action: 'delete_now', confirmation: 'DELETE' }, A.token);
  check('a stale sign-in is refused', stale.status === 403 && stale.json?.reason === 'reauthentication_required', stale);
  check('…and nothing started', (await jobOf(A.id)) === null);
  const spoof = await fn('account-deletion', { action: 'status', user_id: A.id }, B.token);
  check('a supplied user_id is ignored (B sees B’s own state)', spoof.json?.state === 'active' && spoof.json?.job === null);
  check('the old job-id lookup is gone (no status by job id)', (await fn('account-deletion', { action: 'job_status', job_id: randomUUID() }, B.token)).json?.reason === 'invalid_action');
  check('signed-out status needs a capability', (await fn('account-deletion-status', {}, null)).status === 401);

  step('2. Delete Now');
  const exportFiles = await listAll('account-exports', A.id);
  check('(A has an export archive before deleting)', exportFiles.length > 0, exportFiles);
  // Storage goes down first, so the run Delete Now triggers fails safely.
  const storageDown = () => execFileSync('docker', ['stop', stack.storage], { stdio: 'ignore' });
  const storageUp = async () => {
    execFileSync('docker', ['start', stack.storage], { stdio: 'ignore' });
    for (let i = 0; i < 30; i++) {
      try {
        if ((await fetch(`${st.API_URL}/storage/v1/version`)).ok) break;
      } catch {}
      await sleep(1000);
    }
    await sleep(2000);
  };
  storageDown();
  await signIn(A);
  const del = await fn('account-deletion', { action: 'delete_now', confirmation: 'DELETE' }, A.token);
  check('accepted: the account is deleting, with a job', del.json?.state === 'deleting' && typeof del.json?.job?.id === 'string', del.json);
  const jobId = del.json?.job?.id as string;
  const aStatusToken = del.json?.status_token as string;
  check('Delete Now issues a status capability', /^[A-Za-z0-9_-]{43}$/.test(aStatusToken ?? ''), del.json);
  const again = await fn('account-deletion', { action: 'delete_now', confirmation: 'DELETE' }, A.token);
  check('repeating returns the same job', again.json?.job?.id === jobId, again.json);
  const cancel = await fn('account-deletion', { action: 'cancel' }, A.token);
  check('cancellation is refused once deleting', cancel.status === 409 && cancel.json?.reason === 'deletion_in_progress', cancel);
  check('A’s new export requests are refused while deleting', (await fn('account-export', { action: 'request' }, A.token)).json?.reason === 'account_deleting');

  step('3. Concurrent workers, Storage outage and retry');
  // Let the run Delete Now triggered finish (it fails: Storage is down;
  // requests time out after 20 s).
  for (let i = 0; i < 120; i++) {
    const j = await jobOf(A.id);
    if (j && j.step_failures >= 1 && !j.lease_until) break;
    await sleep(500);
  }
  psql(`update public.account_deletion_jobs set next_attempt_at = now() where id = '${jobId}'`);
  let workers: { status: number; json: Record<string, any> | null }[] = [];
  try {
    workers = await Promise.all([worker(), worker()]);
  } finally {
    await storageUp();
  }
  check('two concurrent workers both answer', workers.every((w) => w.status === 200), workers.map((w) => w.status));
  const touched = workers.flatMap((w) => (w.json?.processed ?? []) as { job_id: string }[]).filter((p) => p.job_id === jobId);
  check('only one of them processed A’s job', touched.length === 1, workers.map((w) => w.json?.processed));
  let job = await jobOf(A.id);
  check('the Storage failure is recorded and retried later (backoff), not reported as done',
    job?.status !== 'completed' && job?.step_failures >= 2 && Date.parse(job?.next_attempt_at) > Date.now(), job);
  psql(`update public.account_deletion_jobs set next_attempt_at = now() where id = '${jobId}'`);

  step('4. Interrupted between file cleanup and account deletion');
  // Run until the files are gone, then "crash": delete the auth user
  // directly, as if the worker died right after deleteUser.
  job = await workUntil(A.id, (j) => j?.status === 'deleting_account' || j?.status === 'completed');
  check('the cleanup stage completes after the retry', job?.status === 'deleting_account' || job?.status === 'completed', job);
  if (job?.status === 'deleting_account') {
    await admin.auth.admin.deleteUser(A.id);
    job = await workUntil(A.id, (j) => j?.status === 'completed');
  }
  check('the job completes (the already-deleted account is verified, not deleted twice)', job?.status === 'completed', job);
  check('completion is recorded with a 30-day purge date', Math.abs(Date.parse(job?.purge_after) - Date.parse(job?.completed_at) - 30 * 86_400_000) < 5000);

  step('5. A is gone; others are intact');
  const { data: gone } = await admin.auth.admin.getUserById(A.id);
  check('A’s auth account is gone', !gone?.user);
  check('the status capability reports completed for the app', (await fn('account-deletion-status', { token: aStatusToken }, null)).json?.state === 'completed');
  check('A’s own files are all removed', (await listAll('item-images', A.id)).length === 0 && (await listAll('avatars', A.id)).length === 0
    && (await listAll('account-exports', A.id)).length === 0);
  check('the copy of A’s photo in B’s post is removed', !(await listAll('share-snapshots', B.id)).includes(snapPath));
  check('B’s own files are intact', (await listAll('item-images', B.id)).length === 1 && (await listAll('avatars', B.id)).length === 1);
  const items = (await admin.from('card_share_items').select('snapshot_title').eq('post_id', sharePost)).data ?? [];
  check('B’s post stays, without A’s copied card', items.length === 1 && items[0].snapshot_title === `${B.username} card`, items);
  const bMsgs = (await B.db.from('messages').select('body').eq('conversation_id', conv)).data ?? [];
  check('B keeps their own message; A’s are deleted', bMsgs.length === 1 && bMsgs[0].body === 'B hello', bMsgs);
  const closed = await B.db.from('messages').insert({ id: randomUUID(), conversation_id: conv, sender_id: B.id, body: 'hello?' });
  check('the conversation is read-only (conversation_closed)', closed.error?.message === 'conversation_closed', closed.error);
  const regCard = (await admin.from('registered_cards').select('status, visibility, current_owner_id').eq('id', cardId).single()).data;
  check('A’s registry card is owner_account_deleted and private', regCard?.status === 'owner_account_deleted' && regCard?.visibility === 'private' && !regCard?.current_owner_id, regCard);
  const tr = (await admin.from('ownership_transfers').select('status, closed_reason, from_owner_id, to_owner_id').eq('registered_card_id', bCardId).single()).data;
  check('B’s pending transfer to A is cancelled (account_deleted) and B keeps it', tr?.status === 'cancelled' && tr?.closed_reason === 'account_deleted'
    && tr?.from_owner_id === B.id && tr?.to_owner_id === null, tr);
  const reserved = await admin.rpc('username_is_reserved', { p_username: A.username });
  check('A’s username is reserved', reserved.data === true, reserved);
  const imposter = await admin.auth.admin.createUser({ email: `imp${run}@example.test`, password: 'pw-123456789', email_confirm: true,
    user_metadata: { username: A.username }, app_metadata: { fixture: FIXTURE } });
  check('nobody can sign up with it for 90 days', !!imposter.error, imposter.error?.message);

  // Checkpoint 5: a file that lands in A's folders after completion (e.g.
  // an upload that was in flight) is found and removed by the next run.
  must(await admin.storage.from('account-exports').upload(`${A.id}/late/part.zip`, randomBytes(1000), { contentType: 'application/zip' }), 'late file');
  await worker();
  check('a late file in a deleted collector’s folder is removed by the next run', (await listAll('account-exports', A.id)).length === 0);
  check('…and the job stays completed', (await jobOf(A.id))?.status === 'completed');

  step('6. Delete After 14 Days, and cancelling first');
  await signIn(E);
  check('E schedules (14 days)', (await fn('account-deletion', { action: 'schedule', confirmation: 'DELETE' }, E.token)).json?.state === 'pending_deletion');
  await signIn(F);
  check('F schedules', (await fn('account-deletion', { action: 'schedule', confirmation: 'DELETE' }, F.token)).json?.state === 'pending_deletion');
  check('F cancels before the window ends', (await fn('account-deletion', { action: 'cancel' }, F.token)).json?.restored === true);
  await worker();
  check('while the window runs, the worker deletes nobody', (await jobOf(E.id)) === null && !!(await admin.auth.admin.getUserById(E.id)).data?.user);
  // The window ends (simulated locally by moving the date).
  psql(`alter table public.account_lifecycle disable trigger account_lifecycle_transition;
        update public.account_lifecycle set scheduled_for = now() - interval '1 minute' where user_id = '${E.id}';
        alter table public.account_lifecycle enable trigger account_lifecycle_transition;`);
  const eJob = await workUntil(E.id, (j) => j?.status === 'completed');
  check('after the window the scheduler deletes E', eJob?.status === 'completed' && eJob?.mode === 'scheduled', eJob);
  check('E is gone', !(await admin.auth.admin.getUserById(E.id)).data?.user);
  check('F (cancelled) is untouched', !!(await admin.auth.admin.getUserById(F.id)).data?.user && (await jobOf(F.id)) === null);

  step('7. Permanent failure: admin indicator, then recovery');
  must(await G.db.storage.from('avatars').upload(`${G.id}/avatar.jpg`, randomBytes(2000), { contentType: 'image/jpeg' }), 'G avatar');
  await signIn(G);
  storageDown();
  let gJob = '';
  let gStatusToken = '';
  try {
    const gDel = await fn('account-deletion', { action: 'delete_now', confirmation: 'DELETE' }, G.token);
    gJob = gDel.json?.job?.id as string;
    gStatusToken = gDel.json?.status_token as string;
    // Wait for the triggered run to fail and release its lease; never
    // override a live lease.
    for (let i = 0; i < 120; i++) {
      const j = await jobOf(G.id);
      if (j && j.step_failures >= 1 && !j.lease_until) break;
      await sleep(500);
    }
    psql(`update public.account_deletion_jobs set step_failures = 7, next_attempt_at = now() where id = '${gJob}'`);
    await worker();
  } finally {
    await storageUp();
  }
  const failedJob = (await admin.from('account_deletion_jobs').select('*').eq('id', gJob).single()).data;
  check('after repeated failures the job is failed — never reported as deleted', failedJob?.status === 'failed' && !!failedJob?.last_error_code, failedJob);
  check('G’s account still exists (nothing half-reported)', !!(await admin.auth.admin.getUserById(G.id)).data?.user);
  check('the status capability says failed', (await fn('account-deletion-status', { token: gStatusToken }, null)).json?.state === 'failed');
  must(await admin.from('admin_users').insert({ user_id: C.id }), 'admin');
  const summary = await C.db.rpc('account_deletion_admin_summary');
  check('the admin indicator shows the failure without identities', (summary.data as any)?.failed >= 1 && !JSON.stringify(summary.data).includes(G.id), summary);
  const notAdmin = await B.db.rpc('account_deletion_admin_summary');
  check('non-admins cannot see it', !!notAdmin.error);
  // Runbook: an operator re-queues the failed job after fixing the cause.
  psql(`update public.account_deletion_jobs set status = 'queued', step_failures = 0, failed_at = null, next_attempt_at = now() where id = '${gJob}'`);
  const recovered = await workUntil(G.id, (j) => j?.status === 'completed');
  check('re-queued, it completes', recovered?.status === 'completed', recovered);

  step('7b. Delete Now while a Download My Data step is running (Checkpoint 5)');
  const W = await createUser('w');
  await seed(W, 1, 5000);
  await signIn(W);
  await fn('account-export', { action: 'request' }, W.token);
  const wExport = (await admin.from('account_exports').select('id').eq('user_id', W.id).single()).data!.id as string;
  // As if a step had just taken the lease and is still writing.
  psql(`update public.account_exports set status = 'collecting', lease_until = now() + interval '1 minute' where id = '${wExport}'`);
  const wDel = await fn('account-deletion', { action: 'delete_now', confirmation: 'DELETE' }, W.token);
  const wJob = wDel.json?.job?.id as string;
  const wRun = await worker({ job_id: wJob });
  const wOutcome = (wRun.json?.processed ?? []).find((p: any) => p.job_id === wJob)?.outcome;
  check('the deletion waits for the running export step (not a failure)', wOutcome === 'waiting_for_export' || (await jobOf(W.id))?.status === 'queued', wRun.json);
  const wState = await jobOf(W.id);
  check('…the job stays queued with no failure recorded', wState?.status === 'queued' && wState?.step_failures === 0, wState);
  psql(`update public.account_exports set lease_until = now() - interval '1 second' where id = '${wExport}'`);
  const advanceAfter = await fn('account-export', { action: 'advance' }, W.token);
  check('no new export step can start once the account is deleting', advanceAfter.json?.reason === 'account_deleting', advanceAfter.json);
  psql(`update public.account_deletion_jobs set next_attempt_at = now() where id = '${wJob}'`);
  const wDone = await workUntil(W.id, (j) => j?.status === 'completed');
  check('once the step has ended, the deletion completes', wDone?.status === 'completed', wDone);
  check('W’s export staging files are gone too', (await listAll('account-exports', W.id)).length === 0);

  step('8. Scheduled call path (pg_cron → pg_net → worker)');
  const reqId = psql('select private.run_account_maintenance()');
  let http = '';
  for (let i = 0; i < 30 && !http; i++) {
    await sleep(1000);
    http = psql(`select status_code || ' ' || coalesce(left(content, 60), '') from net._http_response where id = ${reqId}`);
  }
  check('the scheduled call reaches the worker and succeeds', http.startsWith('200 '), http);

  step('9. Multipart exports, expiry and abandoned jobs');
  const P = await createUser('p');
  await seed(P, 6, 1_400_000); // ~8.4 MB of photos, 3 MB parts
  await signIn(P);
  await fn('account-export', { action: 'request' }, P.token);
  let exp: Record<string, any> | null = null;
  for (let i = 0; i < 120; i++) {
    exp = (await fn('account-export', { action: 'advance' }, P.token)).json;
    if (exp?.export?.state !== 'preparing') break;
    await sleep(100);
  }
  check('the export completes in several parts', exp?.export?.state === 'ready' && exp?.export?.part_count >= 3, exp?.export);
  const dl = await fn('account-export', { action: 'download' }, P.token);
  const parts = (dl.json?.parts ?? []) as { part: number; of: number; file_name: string; url: string; bytes: number }[];
  check('download returns one short-lived link per part', parts.length === exp?.export?.part_count && parts.every((p) => p.url && p.of === parts.length), parts.map((p) => p.file_name));
  const allNames: string[] = [];
  let manifest: any = null;
  let partsValid = true;
  for (const p of parts) {
    const bytes = Buffer.from(await (await fetch(reachable(p.url))).arrayBuffer());
    const file = join(work, p.file_name);
    writeFileSync(file, bytes);
    const z = zipNames(file);
    if (z.bad !== null || bytes.length !== p.bytes || bytes.length > 3_145_728) partsValid = false;
    allNames.push(...z.names);
    if (z.manifest) manifest = z.manifest;
  }
  check('every part is a complete, valid ZIP within the part size', partsValid);
  check('part 1 holds the manifest, which names every part', !!manifest && manifest.parts.length === parts.length);
  const listed = (manifest?.files ?? []).map((f: any) => f.name).concat(['manifest.json']).sort();
  check('together the parts hold exactly the files in the manifest, none twice', JSON.stringify([...allNames].sort()) === JSON.stringify(listed),
    { inZip: allNames.length, inManifest: listed.length });
  check('the manifest says which part holds each file', (manifest?.files ?? []).every((f: any) => f.part >= 1 && f.part <= parts.length));
  const pJob = (await admin.from('account_exports').select('id').eq('user_id', P.id).eq('status', 'ready').single()).data!;
  psql(`update public.account_exports set expires_at = now() - interval '1 day' where id = '${pJob.id}'`);
  await worker();
  const expired = (await admin.from('account_exports').select('status').eq('id', pJob.id).single()).data;
  check('the scheduled worker expires the export', expired?.status === 'expired', expired);
  check('…and removes every part', (await listAll('account-exports', `${P.id}/${pJob.id}`)).length === 0);
  await signIn(P);
  await fn('account-export', { action: 'request' }, P.token);
  await fn('account-export', { action: 'advance' }, P.token);
  const abandonedId = (await admin.from('account_exports').select('id').eq('user_id', P.id).in('status', ['collecting', 'archiving']).single()).data?.id;
  psql(`update public.account_exports set updated_at = now() - interval '25 hours' where id = '${abandonedId}'`);
  await worker();
  const abandoned = (await admin.from('account_exports').select('status, last_error_code').eq('id', abandonedId).single()).data;
  check('an abandoned export is failed and cleaned up by the worker', abandoned?.status === 'failed' && abandoned?.last_error_code === 'export_abandoned'
    && (await listAll('account-exports', `${P.id}/${abandonedId}`)).length === 0, abandoned);
}

console.log(`Supabase ${st.API_URL} (run ${run}); files in ${work}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
// Section 1 switches the local account-maintenance job off and on to test
// Delete Now; whatever it was before this run is restored afterwards.
const maintenanceWas = psql(`select active from cron.job where jobname = 'account-maintenance'`) === 't';
let fatal: unknown = null;
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${section}": ${(e as Error).message}`);
} finally {
  try {
    execFileSync('docker', ['start', stack.storage], { stdio: 'ignore' });
  } catch {}
  console.log(`\nCleanup: ${await sweep()} disposable accounts removed.`);
  psql(`select cron.alter_job(job_id := jobid, active := ${maintenanceWas}) from cron.job where jobname = 'account-maintenance'`);
  console.log(`account-maintenance schedule restored to ${maintenanceWas ? 'active' : 'inactive'}.`);
}
const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failedChecks) console.log(`  FAIL ${f.name}`);
process.exitCode = failedChecks.length || fatal ? 1 : 0;
