/// <reference types="node" />
// Automatic media-quarantine scheduler (Phase 2B M4 step 5A,
// 20261126120000_media_quarantine_scheduler.sql, media-quarantine-scheduled)
// — end to end on an ISOLATED, disposable local stack: real pg_net requests,
// the real Edge runtime and real Storage copies/removals of disposable
// fixtures.
//
// This script turns the scheduler switch ON (and briefly the sweep cron job)
// on the isolated stack only, and restores both to OFF before it exits. It
// refuses to run against the primary local stack.
//
// Prerequisites (isolated stack, e.g. CACHECASE_STACK_WORKDIR=<workdir>):
//   supabase functions serve --workdir <workdir> --env-file <file> with
//   CACHECASE_TEST_MQ_FAULTS=1 and MEDIA_QUARANTINE_WORKER_SECRET (≥ 32);
//   the same secret in this process's MEDIA_QUARANTINE_WORKER_SECRET.
// The secret is never printed; it reaches the database through psql's stdin.
// Run:  CACHECASE_STACK_WORKDIR=<workdir> node scripts/integration/media-quarantine-scheduler.ts
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from './local-stack.ts';
import { removeQuarantineFixtures } from './quarantine-fixture-cleanup.ts';

const stack = requireIsolatedStack();
const st = stack.st;
const SECRET = process.env.MEDIA_QUARANTINE_WORKER_SECRET ?? '';
if (SECRET.length < 32) throw new Error('MEDIA_QUARANTINE_WORKER_SECRET (≥ 32 characters) must be set for this process.');
const KONG = `http://supabase_kong_${stack.project}:8000`;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'media-quarantine-scheduler-it';
const MARK = 'mqs-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psql = (sql: string) =>
  execFileSync('docker', ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
// SQL through stdin (keeps values such as the secret out of process arguments).
const psqlIn = (sql: string) =>
  execFileSync('docker', ['exec', '-i', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], { encoding: 'utf8', input: sql }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);
const must = <T>(r: { data: T; error: unknown }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r.data;
};
async function until(cond: () => boolean, seconds: number): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > end) return false;
    await sleep(500);
  }
}

type U = { id: string; token: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const username = `mqs${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Mqs-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, token: s.session!.access_token, db };
}

const exists = (bucket: string, path: string) =>
  psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = ${lit(bucket)} AND name = ${lit(path)}`) === '1';
type Job = { id: string; state: string; desired: string; attention: boolean; error: string; qpath: string; attempts: number; lease: boolean };
const job = (id: string): Job => {
  const [state, desired, attention, error, qpath, attempts, lease] = psql(
    `SELECT concat_ws('|', state, desired, needs_attention, coalesce(last_error, ''), quarantine_path, attempts, lease_token IS NOT NULL)
       FROM private.media_quarantine WHERE id = ${lit(id)}`).split('|');
  return { id, state, desired, attention: attention === 't' || attention === 'true', error, qpath, attempts: Number(attempts), lease: lease === 't' || lease === 'true' };
};
const jobFor = (bucket: string, path: string) =>
  psql(`SELECT id FROM private.media_quarantine WHERE source_bucket = ${lit(bucket)} AND source_path = ${lit(path)} ORDER BY created_at DESC LIMIT 1`);
const expireLease = (id: string) =>
  psql(`UPDATE private.media_quarantine SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${lit(id)} AND lease_token IS NOT NULL`);
const due = (id: string) => psql(`UPDATE private.media_quarantine SET next_attempt_at = NULL WHERE id = ${lit(id)}`);
// This script starts far more runs than the database allows per minute (20,
// asserted in step 13 and in pgTAP); finished runs are aged out of that
// window before each call so the other steps test what they mean to.
const unthrottle = () =>
  psql(`UPDATE private.media_quarantine_scheduler_runs SET started_at = started_at - interval '2 minutes' WHERE status <> 'running'`);
const setSwitch = (on: boolean) => {
  if (on) unthrottle();
  return psql(`UPDATE private.media_quarantine_scheduler_config SET enabled = ${on}`);
};
const setCron = (on: boolean) =>
  psql(`SELECT cron.alter_job(job_id := jobid, active := ${on}) FROM cron.job WHERE jobname = 'media-quarantine-worker'`);
const count = (sql: string) => Number(psql(sql));
const dispatches = (source: string) => count(`SELECT count(*) FROM private.media_quarantine_dispatches WHERE source = ${lit(source)} AND request_id IS NOT NULL`);
const steps = (id: string, kind: string) =>
  count(`SELECT count(*) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(id)} AND event = 'worker_step' AND actor_kind = ${lit(kind)}`);
const copiedTransitions = (id: string) =>
  count(`SELECT count(*) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(id)} AND event = 'worker_step' AND to_state = 'copied'`);
const quarantinePaths: string[] = [];

async function listDeep(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const { data } = await service.storage.from(bucket).list(prefix, { limit: 1000 });
  for (const e of data ?? []) {
    const p = `${prefix}/${e.name}`;
    if (e.id === null) out.push(...await listDeep(bucket, p)); else out.push(p);
  }
  return out;
}

// Restores the scheduler to OFF and removes this script's fixtures only.
async function cleanup(): Promise<number> {
  setSwitch(false);
  setCron(false);
  psql(`DELETE FROM vault.secrets WHERE name IN ('project_url', 'media_quarantine_worker_secret')`);
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const qPaths = psql(`SELECT coalesce(string_agg(q.quarantine_path, ','), '') FROM private.media_quarantine q WHERE q.id IN (
      SELECT h.quarantine_id FROM private.media_quarantine_holds h JOIN public.moderated_content m ON m.id = h.moderation_id
       JOIN public.content_reports r ON r.id = m.report_id WHERE r.details LIKE '${MARK}%')`).split(',').filter(Boolean);
  const q = [...new Set([...qPaths, ...quarantinePaths.splice(0)])].filter((p) => exists('moderation-quarantine', p));
  if (q.length) removeQuarantineFixtures(q);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fx ON COMMIT DROP AS SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%';
        CREATE TEMP TABLE fq ON COMMIT DROP AS SELECT DISTINCT h.quarantine_id AS id FROM private.media_quarantine_holds h
          WHERE h.moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM fq)
          OR moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_holds WHERE quarantine_id IN (SELECT id FROM fq);
        DELETE FROM private.media_quarantine WHERE id IN (SELECT id FROM fq);
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.moderated_content WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.content_reports WHERE id IN (SELECT id FROM fx);
        DELETE FROM private.media_quarantine_dispatches;
        DELETE FROM private.media_quarantine_scheduler_runs;
        COMMIT;`);
  for (const id of ids) {
    for (const b of ['item-images', 'avatars', 'share-snapshots']) {
      const files = await listDeep(b, id);
      if (files.length) await service.storage.from(b).remove(files);
    }
  }
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

type R = { data: any; error: { message?: string } | null };
const rpc = (u: { db: SupabaseClient }, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
type Res = { status: number; text: string; body: any };
async function call(name: string, init: { method?: string; auth?: string | null; body?: string; fault?: string }): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: st.ANON_KEY };
  if (init.auth !== null && init.auth !== undefined) headers.Authorization = init.auth;
  if (init.fault) headers['x-cachecase-local-fault'] = init.fault;
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: init.method ?? 'POST', headers, body: init.method === 'GET' ? undefined : (init.body ?? '{}') });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const scheduled = (body: Record<string, unknown> = {}, fault?: string) =>
  (unthrottle(), call('media-quarantine-scheduled', { auth: `Bearer ${SECRET}`, body: JSON.stringify({ trigger: 'operator', ...body }), fault }));
const jpeg = (tag: string) => Buffer.concat([Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), Buffer.from(tag)]);
const publicStatus = async (bucket: string, path: string) => {
  const r = await fetch(`${st.API_URL}/storage/v1/object/public/${bucket}/${path}`, { headers: { 'cache-control': 'no-cache' } });
  await r.body?.cancel();
  return r.status;
};

async function main() {
  const A = await createUser('a');
  const B = await createUser('b');
  const M1 = await createUser('m1');
  must(await service.from('admin_users').insert([{ user_id: M1.id }]), 'admin');
  const pool = await Promise.all(Array.from({ length: 10 }, (_, k) => createUser(`p${k}`)));
  let turn = 0;
  const reporter = () => pool[turn++ % pool.length];
  const up = await call('media-quarantine-scheduled', { auth: null });
  if (up.status >= 500 && up.status !== 503) throw new Error(`Edge Functions not served (status ${up.status})`);
  if (up.status === 503) throw new Error('media-quarantine-scheduled is served without MEDIA_QUARANTINE_WORKER_SECRET');

  const F = randomUUID();
  must(await A.db.from('folders').insert({ id: F, user_id: A.id, name: `mqs ${run}`, is_public: true, cover_source: 'first_card' }), 'folder');
  let n = 0;
  // A reported item of A's, reposted by B (a public share-snapshots copy).
  // remove() is the moderation decision that queues exactly one job.
  type Prep = { item: string; snap: string; bytes: Buffer; report: string };
  const prepare = async (reason = 'hate'): Promise<Prep> => {
    const key = `s${++n}`;
    const id = randomUUID(), path = `${A.id}/mqs/${key}.jpg`, bytes = jpeg(`${run}-${key}`);
    must(await A.db.from('collection_items').insert({ id, folder_id: F, user_id: A.id, title: `mqs ${key} ${run}`, is_public: true, collection_status: 'active', item_type: 'sports_card' }), 'item');
    must(await A.db.storage.from('item-images').upload(path, bytes, { contentType: 'image/jpeg' }), 'upload');
    must(await A.db.from('collection_item_images').insert({ id: randomUUID(), item_id: id, user_id: A.id, image_url: 'https://x.invalid', storage_path: path, sort_order: 0, is_primary: true }), 'image');
    const rep = await call('copy-share-snapshot-image', { auth: `Bearer ${B.token}`, body: JSON.stringify({ item_id: id, snapshot_type: 'post', target_id: randomUUID() }) });
    if (rep.body?.status !== 'ok') throw new Error(`repost: ${rep.text}`);
    must(await reporter().db.rpc('submit_report', { p_target_type: 'collection_item', p_target_id: id, p_reason: reason, p_details: `${MARK} ${run}` }), 'report');
    const report = psql(`SELECT id FROM public.content_reports WHERE target_id = ${lit(id)} AND status = 'open'`);
    return { item: id, snap: rep.body.storage_path as string, bytes, report };
  };
  const remove = async (p: Prep, reason = 'hate') => {
    const rm = await rpc(M1, 'admin_remove_content', { p_report_id: p.report, p_reason_code: reason, p_include_related: false });
    if (rm.error) throw new Error(`remove: ${JSON.stringify(rm.error)}`);
    const jobId = jobFor('share-snapshots', p.snap);
    quarantinePaths.push(job(jobId).qpath);
    return { ...p, jobId, moderation: rm.data.moderation_id as string };
  };
  const scenario = async (reason = 'hate') => remove(await prepare(reason), reason);
  const drain = async () => {
    for (let k = 0; k < 6 && psql(`SELECT private.media_quarantine_claimable()`) === 't'; k++) await scheduled();
  };

  // Vault for THIS isolated project only (values through stdin).
  psqlIn(`SELECT vault.create_secret(${lit(KONG)}, 'project_url');
          SELECT vault.create_secret(${lit(SECRET)}, 'media_quarantine_worker_secret');`);
  const responsesBefore = count(`SELECT count(*) FROM net._http_response`);

  step('1. Defaults: everything OFF');
  check('the switch is OFF', psql(`SELECT enabled FROM private.media_quarantine_scheduler_config`) === 'f');
  check('the sweep job exists, every minute, INACTIVE',
    psql(`SELECT schedule || '|' || active FROM cron.job WHERE jobname = 'media-quarantine-worker'`) === '* * * * *|false');
  const s0 = await scenario();
  await sleep(4000);
  check('OFF: a committed removal queues the job but dispatches nothing',
    job(s0.jobId).state === 'pending' && count(`SELECT count(*) FROM private.media_quarantine_dispatches`) === 0
      && count(`SELECT count(*) FROM net._http_response`) === responsesBefore);
  check('OFF: no run was started', count(`SELECT count(*) FROM private.media_quarantine_scheduler_runs WHERE status <> 'refused'`) === 0);
  const off = await scheduled();
  check('OFF: even a correctly authenticated call is refused by the database', off.status === 200 && off.body?.status === 'skipped' && off.body?.reason === 'disabled', off.text);
  check('…and the job is untouched', job(s0.jobId).state === 'pending' && exists('share-snapshots', s0.snap));

  step('2. Authentication and input');
  const wrong = SECRET.split('').map((c) => (c === 'a' ? 'b' : 'a')).join('');
  check('GET → 405', (await call('media-quarantine-scheduled', { method: 'GET', auth: `Bearer ${SECRET}` })).status === 405);
  check('no credentials → 401', (await call('media-quarantine-scheduled', { auth: null })).status === 401);
  check('malformed (Basic) → 401', (await call('media-quarantine-scheduled', { auth: `Basic ${SECRET}` })).status === 401);
  check('too short → 401', (await call('media-quarantine-scheduled', { auth: 'Bearer abc' })).status === 401);
  check('wrong secret of the same length → 401', (await call('media-quarantine-scheduled', { auth: `Bearer ${wrong}` })).status === 401);
  check('the secret with extra characters → 401', (await call('media-quarantine-scheduled', { auth: `Bearer ${SECRET}x` })).status === 401);
  check('the service role key → 401', (await call('media-quarantine-scheduled', { auth: `Bearer ${st.SERVICE_ROLE_KEY}` })).status === 401);
  check('an admin\'s user JWT → 401', (await call('media-quarantine-scheduled', { auth: `Bearer ${M1.token}` })).status === 401);
  check('the anon key → 401', (await call('media-quarantine-scheduled', { auth: `Bearer ${st.ANON_KEY}` })).status === 401);
  check('payload over 1 KB → 413', (await call('media-quarantine-scheduled', { auth: `Bearer ${SECRET}`, body: JSON.stringify({ trigger: 'x'.repeat(2000) }) })).status === 413);
  check('unknown fields → 400', (await call('media-quarantine-scheduled', { auth: `Bearer ${SECRET}`, body: '{"path":"x"}' })).status === 400);
  check('limit above 5 → 400', (await scheduled({ limit: 6 })).status === 400);
  check('a restore "trigger" → 400', (await scheduled({ trigger: 'restore' })).status === 400);
  const other = await Promise.all(['admin-media-restore', 'admin-retention-purge', 'admin-media-quarantine']
    .map((f) => call(f, { auth: `Bearer ${SECRET}`, body: '{"job_ids":[],"run_id":"00000000-0000-4000-8000-000000000000"}' })));
  check('the worker secret opens no other function (restore, purge, admin quarantine)', other.every((r) => r.status === 401 || r.status === 403), other.map((r) => r.status));
  check('no response ever echoes the secret', [off, ...other].every((r) => !r.text.includes(SECRET)));
  check('refused requests start no run', count(`SELECT count(*) FROM private.media_quarantine_scheduler_runs WHERE status <> 'refused'`) === 0);

  step('3. Switch ON: event kick after a committed decision');
  setSwitch(true);
  const s1 = await scenario();
  check('a committed removal sends one kick', await until(() => dispatches('kick') === 1, 5));
  check('…the scheduler quarantines it without an admin', await until(() => job(s1.jobId).state === 'quarantined', 30), job(s1.jobId));
  check('…and also drains the job that waited while OFF', await until(() => job(s0.jobId).state === 'quarantined', 30), job(s0.jobId));
  check('the source is gone and its public URL no longer resolves', !exists('share-snapshots', s1.snap) && (await publicStatus('share-snapshots', s1.snap)) !== 200);
  const copy = await service.storage.from('moderation-quarantine').download(job(s1.jobId).qpath);
  check('the private copy is byte-identical (SHA-256)', !!copy.data && sha(new Uint8Array(await copy.data.arrayBuffer())) === sha(s1.bytes));
  check('every step is the scheduler\'s: actor_kind scheduler, a run id, no user id',
    steps(s1.jobId, 'scheduler') === 3 && count(`SELECT count(*) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(s1.jobId)}
      AND event = 'worker_step' AND (actor_id IS NOT NULL OR scheduler_run_id IS NULL)`) === 0);
  check('the run is recorded completed, with codes and counts only',
    await until(() => psql(`SELECT count(*) FROM private.media_quarantine_scheduler_runs WHERE trigger = 'kick' AND status = 'completed'
      AND outcomes ->> 'quarantined' = '2' AND duration_ms >= 0`) === '1', 10));

  step('4. A rolled-back decision sends nothing');
  const pr = await prepare();
  psql(`UPDATE private.media_quarantine_dispatches SET dispatched_at = dispatched_at - interval '60 seconds'`);
  const kicksBefore = dispatches('kick');
  const runsBefore = count(`SELECT count(*) FROM private.media_quarantine_scheduler_runs`);
  const respBefore = count(`SELECT count(*) FROM net._http_response`);
  const inside = psql(`BEGIN;
    SELECT set_config('request.jwt.claims', json_build_object('sub', ${lit(M1.id)}, 'role', 'authenticated')::text, true);
    SELECT set_config('request.jwt.claim.sub', ${lit(M1.id)}, true);
    SET LOCAL ROLE authenticated;
    SELECT (public.admin_remove_content(p_report_id => ${lit(pr.report)}::uuid, p_reason_code => 'hate', p_include_related => false) ->> 'moderation_id') IS NOT NULL;
    RESET ROLE;
    SELECT count(*) FROM private.media_quarantine_dispatches WHERE request_id IS NOT NULL;
    ROLLBACK;`).split('\n').filter((l) => /^(t|f|\d+)$/.test(l));
  check('inside the transaction the kick was queued', inside[0] === 't' && Number(inside[1]) === kicksBefore + 1, inside);
  await sleep(5000);
  check('after ROLLBACK: no dispatch, no request, no run', dispatches('kick') === kicksBefore
    && count(`SELECT count(*) FROM net._http_response`) === respBefore && count(`SELECT count(*) FROM private.media_quarantine_scheduler_runs`) === runsBefore);
  check('…and no job exists for it', psql(`SELECT count(*) FROM private.media_quarantine WHERE source_path = ${lit(pr.snap)}`) === '0');

  step('5. Throttling');
  setSwitch(false);
  const preps = [await prepare(), await prepare(), await prepare()];
  setSwitch(true);
  psql(`UPDATE private.media_quarantine_dispatches SET dispatched_at = dispatched_at - interval '60 seconds'`);
  const k0 = dispatches('kick');
  const burst: Awaited<ReturnType<typeof remove>>[] = [];
  for (const p of preps) burst.push(await remove(p));
  check('three decisions within 10 s → one kick', dispatches('kick') === k0 + 1, dispatches('kick') - k0);
  await drain();
  check('…and all three are quarantined (the worker or the next sweep picks up the rest)',
    await until(() => burst.every((s) => job(s.jobId).state === 'quarantined'), 30), burst.map((s) => job(s.jobId).state));

  step('6. Child-safety priority');
  setSwitch(false);
  const normals = [await scenario(), await scenario()];
  const cs = await scenario('child_safety');
  check('the child-safety job is flagged and held', psql(`SELECT child_safety AND legal_hold FROM private.media_quarantine WHERE id = ${lit(cs.jobId)}`) === 't');
  setSwitch(true);
  const one = await scheduled({ limit: 1 });
  check('a one-job run takes the newer child-safety job before older ones', one.body?.processed === 1 && job(cs.jobId).state === 'quarantined'
    && normals.every((s) => job(s.jobId).state === 'pending'), one.text);
  await drain();
  check('…the rest follow', await until(() => normals.every((s) => job(s.jobId).state === 'quarantined'), 30));

  step('7. Two concurrent scheduled workers');
  setSwitch(false);
  const four = [await scenario(), await scenario(), await scenario(), await scenario()];
  setSwitch(true);
  const trio = await Promise.all([scheduled(), scheduled(), scheduled()]);
  const busy = trio.filter((r) => r.body?.status === 'skipped' && r.body?.reason === 'busy').length;
  const done = trio.filter((r) => r.body?.status === 'ok');
  check('three at once: two run, the third is refused as busy', busy === 1 && done.length === 2, trio.map((r) => r.text));
  check('together they processed each job once', done.reduce((a, r) => a + (r.body?.processed ?? 0), 0) === 4, done.map((r) => r.text));
  check('every job quarantined; each copied exactly once; none flagged',
    four.every((s) => job(s.jobId).state === 'quarantined' && !job(s.jobId).attention && copiedTransitions(s.jobId) === 1));

  step('8. Concurrent manual (admin) and scheduled workers');
  setSwitch(false);
  const mix = [await scenario(), await scenario(), await scenario(), await scenario()];
  setSwitch(true);
  const [manual, sched] = await Promise.all([
    call('admin-media-quarantine', { auth: `Bearer ${M1.token}`, body: JSON.stringify({ limit: 10 }) }),
    scheduled(),
  ]);
  check('both complete', manual.status === 200 && sched.body?.status === 'ok', [manual.status, sched.text]);
  check('every job quarantined; each copied exactly once; none flagged',
    mix.every((s) => job(s.jobId).state === 'quarantined' && !job(s.jobId).attention && copiedTransitions(s.jobId) === 1));
  check('each job\'s steps belong to exactly one kind of worker, admin steps name the admin',
    mix.every((s) => (steps(s.jobId, 'admin') === 0) !== (steps(s.jobId, 'scheduler') === 0))
      && mix.every((s) => count(`SELECT count(*) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(s.jobId)}
           AND actor_kind = 'admin' AND actor_id IS DISTINCT FROM ${lit(M1.id)}`) === 0));

  step('9. Interruption, lease expiry, dead runs');
  setSwitch(false);
  const sI = await scenario();
  setSwitch(true);
  const crash = await scheduled({}, 'crash_after_copy');
  check('a worker dying after the copy leaves the job leased, the run open', crash.body?.status === 'interrupted' && job(sI.jobId).lease
    && psql(`SELECT status FROM private.media_quarantine_scheduler_runs WHERE id = ${lit(crash.body?.run_id ?? randomUUID())}`) === 'running', crash.text);
  check('the leased job is not taken by another run', (await scheduled()).body?.processed === 0 && job(sI.jobId).state === 'pending');
  expireLease(sI.jobId);
  check('after the lease expires the next run resumes and completes it', (await scheduled()).body?.outcomes?.quarantined === 1 && job(sI.jobId).state === 'quarantined');
  check('…copied once (the existing copy was compared, not remade)', copiedTransitions(sI.jobId) === 1);
  psql(`UPDATE private.media_quarantine_scheduler_runs SET started_at = started_at - interval '200 seconds' WHERE id = ${lit(crash.body.run_id)}`);
  await scheduled();
  check('the dead run is reaped as abandoned', psql(`SELECT status || ':' || error_code FROM private.media_quarantine_scheduler_runs WHERE id = ${lit(crash.body.run_id)}`) === 'abandoned:stale');
  setSwitch(false);
  const sD = await scenario();
  setSwitch(true);
  const crashDel = await scheduled({}, 'crash_after_delete');
  check('a worker dying right after removing the source', crashDel.body?.status === 'interrupted' && !exists('share-snapshots', sD.snap) && job(sD.jobId).state === 'verified');
  expireLease(sD.jobId);
  await scheduled();
  check('…is completed by the next run, from the verified copy', job(sD.jobId).state === 'quarantined');

  step('10. Integrity and retries');
  setSwitch(false);
  const sH = await scenario();
  setSwitch(true);
  await scheduled({}, 'corrupt_copy');
  check('a corrupted copy → hash_mismatch, flagged, source NOT removed', job(sH.jobId).attention && job(sH.jobId).error === 'hash_mismatch' && exists('share-snapshots', sH.snap));
  setSwitch(false);
  const sN = await scenario();
  setSwitch(true);
  await scheduled({}, 'delete_noop');
  check('a delete that leaves the object → retry, not recorded quarantined', job(sN.jobId).state === 'verified' && job(sN.jobId).error === 'delete_failed' && exists('share-snapshots', sN.snap));
  check('…not retried before its back-off', (await scheduled()).body?.processed === 0);
  due(sN.jobId);
  await scheduled();
  check('…then completes', job(sN.jobId).state === 'quarantined' && !exists('share-snapshots', sN.snap));
  setSwitch(false);
  const sX = await scenario();
  setSwitch(true);
  for (let k = 0; k < 7 && !job(sX.jobId).attention; k++) {
    due(sX.jobId);
    await scheduled({}, 'copy_fail');
  }
  check('retries are bounded: needs_attention after the attempt budget, source intact', job(sX.jobId).attention && job(sX.jobId).attempts === 5 && exists('share-snapshots', sX.snap), job(sX.jobId));
  check('a flagged job is not claimable: the sweep sends nothing for it', psql(`SELECT private.media_quarantine_claimable()`) === 'f'
    && psql(`SELECT private.run_media_quarantine_sweep() IS NULL`) === 't');
  const ov = await rpc(M1, 'admin_media_quarantine_overview');
  check('admins see it in the overview', (ov.data?.needs_attention ?? []).some((j: any) => j.id === sX.jobId), ov.error);

  step('11. Never restoration');
  setSwitch(false);
  const sR = await scenario();
  setSwitch(true);
  await scheduled();
  must(await rpc(M1, 'admin_restore_content', { p_moderation_id: sR.moderation, p_reason_code: 'resolved_in_error', p_disposition: 'overturn' }) as any, 'overturn');
  check('an overturned removal waits for an admin restore', job(sR.jobId).state === 'restore_pending');
  await sleep(3000);
  const rr = await scheduled();
  check('the scheduler does not restore it', rr.body?.processed === 0 && job(sR.jobId).state === 'restore_pending' && !exists('share-snapshots', sR.snap));
  check('no scheduler event ever moved a job to restoring or restored',
    count(`SELECT count(*) FROM private.media_quarantine_events WHERE actor_kind = 'scheduler' AND to_state IN ('restoring', 'restored')`) === 0);

  step('12. The real sweep (cron) on the isolated stack');
  setSwitch(false);
  const sC = await scenario();
  setSwitch(true);
  const sweepsBefore = dispatches('sweep');
  setCron(true);
  const swept = await until(() => job(sC.jobId).state === 'quarantined', 90);
  setCron(false);
  check('with cron and switch on, a minute tick quarantines waiting work', swept && dispatches('sweep') > sweepsBefore, job(sC.jobId));
  check('the sweep job is inactive again', psql(`SELECT active FROM cron.job WHERE jobname = 'media-quarantine-worker'`) === 'f');

  step('13. Records and reach');
  check('every pg_net request reached this project\'s worker (2xx)',
    count(`SELECT count(*) FROM net._http_response WHERE status_code IS DISTINCT FROM 200`) === 0, psql(`SELECT string_agg(coalesce(status_code::text, error_msg), ',') FROM net._http_response`));
  check('Vault points only at this isolated project', psql(`SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url'`) === KONG);
  const bodies = psql(`SELECT coalesce(string_agg(content, ' '), '') FROM net._http_response`);
  check('worker responses carry no paths, buckets or secret', !/share-snapshots|item-images|moderation-quarantine|q\//.test(bodies) && !bodies.includes(SECRET));
  check('run records hold outcome codes only',
    count(`SELECT count(*) FROM private.media_quarantine_scheduler_runs r, jsonb_object_keys(r.outcomes) k
            WHERE k NOT IN ('quarantined','restore_pending','source_missing','cancelled','retry_scheduled','needs_attention','lease_lost','interrupted','skipped')`) === 0);
  psql(`INSERT INTO private.media_quarantine_scheduler_runs (trigger, status, finished_at, duration_ms)
        SELECT 'kick', 'completed', clock_timestamp(), 1 FROM generate_series(1, 20)`);
  const limited = await call('media-quarantine-scheduled', { auth: `Bearer ${SECRET}`, body: '{"trigger":"operator"}' });
  check('above 20 runs a minute the database refuses: rate_limited', limited.body?.status === 'skipped' && limited.body?.reason === 'rate_limited', limited.text);
  const status = await rpc(M1, 'admin_media_quarantine_scheduler_status');
  check('admins see the scheduler state', status.data?.enabled === true && status.data?.sweep_active === false && typeof status.data?.runs_24h === 'object', status.error);
}

const stale = await cleanup();
if (stale) console.log(`(removed ${stale} stale fixture account(s) first)`);
try {
  await main();
} catch (e) {
  check('script ran to completion', false, (e as Error).message);
} finally {
  console.log(`\nCleanup: ${await cleanup()} account(s) removed.`);
  const state = psql(`SELECT (SELECT enabled FROM private.media_quarantine_scheduler_config)::text || ',' ||
                             (SELECT active FROM cron.job WHERE jobname = 'media-quarantine-worker')::text || ',' ||
                             (SELECT count(*) FROM vault.secrets WHERE name IN ('project_url', 'media_quarantine_worker_secret'))`);
  check('scheduler restored: switch OFF, sweep inactive, Vault entries removed', state === 'false,false,0', state);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exitCode = failed.length ? 1 : 0;
}
