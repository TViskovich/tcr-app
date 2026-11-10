/// <reference types="node" />
// Media quarantine and restoration workers (Phase 2B M2.3c,
// 20261120120000_media_quarantine_worker.sql, admin-media-quarantine,
// admin-media-restore) — end-to-end against the LOCAL Supabase stack with
// disposable collectors and Storage objects: real copies, real deletions,
// real restorations, every interruption point and failure mode.
//
// Failure injection uses the local-only x-cachecase-local-fault header, which
// the functions honour only on a local stack served with
// CACHECASE_TEST_MQ_FAULTS=1 (a hosted project ignores it).
//
// Cleanup: restrictions, jobs and audit rows are append-only for every API
// role, so this script removes ITS OWN fixture rows through a local superuser
// psql session (session_replication_role = replica), scoped to its marker, and
// removes Storage objects only under its own accounts' prefixes and its own
// jobs' quarantine paths.
//
// Prerequisites: local Supabase with the migrations applied, and
// `supabase functions serve --env-file <file with CACHECASE_TEST_MQ_FAULTS=1>`.
// Run:  node scripts/integration/media-quarantine-worker.ts
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'media-quarantine-worker-it';
const MARK = 'mqw-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

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

type U = { id: string; token: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const username = `mqw${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Mqw-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, token: s.session!.access_token, db };
}

async function listDeep(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const { data } = await service.storage.from(bucket).list(prefix, { limit: 1000 });
  for (const e of data ?? []) {
    const p = `${prefix}/${e.name}`;
    if (e.id === null) out.push(...await listDeep(bucket, p)); else out.push(p);
  }
  return out;
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
// Drift outside the app, as only a database operator can now cause it at a
// held path (20261121120000 refuses every API role, the service role
// included): the object row via SQL as postgres, and its blob in the local
// file backend.
const SAFE = /^[A-Za-z0-9._\/-]+$/;
const operatorDelete = (bucket: string, path: string) => {
  if (!SAFE.test(bucket) || !SAFE.test(path) || path.includes('..')) throw new Error('unsafe path');
  psql(`BEGIN; SET LOCAL storage.allow_delete_query = 'true';
        DELETE FROM storage.objects WHERE bucket_id = ${lit(bucket)} AND name = ${lit(path)}; COMMIT;`);
  execFileSync('docker', ['exec', 'supabase_storage_cachecase', 'rm', '-rf', `/mnt/stub/stub/${bucket}/${path}`]);
};
const operatorReplace = (bucket: string, path: string) =>
  psql(`UPDATE storage.objects SET version = gen_random_uuid()::text WHERE bucket_id = ${lit(bucket)} AND name = ${lit(path)}`);
const quarantinePaths: string[] = [];
const deletedPrefixes: string[] = [];

async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const qPaths = psql(`SELECT coalesce(string_agg(q.quarantine_path, ','), '') FROM private.media_quarantine q WHERE q.id IN (
      SELECT h.quarantine_id FROM private.media_quarantine_holds h JOIN public.moderated_content m ON m.id = h.moderation_id
       JOIN public.content_reports r ON r.id = m.report_id WHERE r.details LIKE '${MARK}%')`).split(',').filter(Boolean);
  const q = [...new Set([...qPaths, ...quarantinePaths.splice(0)])];
  if (q.length) await service.storage.from('moderation-quarantine').remove(q);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fx ON COMMIT DROP AS SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%';
        CREATE TEMP TABLE fq ON COMMIT DROP AS SELECT DISTINCT h.quarantine_id AS id FROM private.media_quarantine_holds h
          WHERE h.moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM fq)
          OR moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_holds WHERE quarantine_id IN (SELECT id FROM fq);
        DELETE FROM private.media_quarantine WHERE id IN (SELECT id FROM fq);
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.moderated_profile_fields WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.moderated_content WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.content_reports WHERE id IN (SELECT id FROM fx);
        COMMIT;`);
  const conversations = ids.length
    ? ((await service.from('conversation_participants').select('conversation_id').in('user_id', ids)).data ?? []).map((p) => p.conversation_id as string)
    : [];
  for (const id of [...ids, ...deletedPrefixes.splice(0)]) {
    for (const b of ['item-images', 'avatars', 'share-snapshots']) {
      const files = await listDeep(b, id);
      if (files.length) await service.storage.from(b).remove(files);
    }
  }
  for (const c of new Set(conversations)) {
    const files = await listDeep('dm-attachments', c);
    if (files.length) await service.storage.from('dm-attachments').remove(files);
    await service.from('conversations').delete().eq('id', c);
  }
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

type R = { data: any; error: { message?: string } | null };
const rpc = (u: { db: SupabaseClient }, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const fn = async (name: string, token: string | null, body: unknown, fault?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: st.ANON_KEY };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (fault) headers['x-cachecase-local-fault'] = fault;
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const jpeg = (tag: string) => Buffer.concat([Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), Buffer.from(tag)]);
const publicStatus = async (bucket: string, path: string) => {
  const r = await fetch(`${st.API_URL}/storage/v1/object/public/${bucket}/${path}`, { headers: { 'cache-control': 'no-cache' } });
  await r.body?.cancel();
  return r.status;
};

async function main() {
  const A = await createUser('a');   // the reported collector
  const B = await createUser('b');   // reposts A's items (owns the public copies)
  const C = await createUser('c');   // unrelated collector
  const Rp = await createUser('r');  // reporter / DM partner
  const M1 = await createUser('m1');
  const M2 = await createUser('m2');
  must(await service.from('admin_users').insert([{ user_id: M1.id }, { user_id: M2.id }]), 'admins');
  // submit_report allows 5 reports per reporter per 10 minutes: rotate.
  const pool = await Promise.all(Array.from({ length: 10 }, (_, k) => createUser(`p${k}`)));
  let turn = 0;
  const reporter = () => pool[turn++ % pool.length];
  const up = (await fn('get-collection-item-image-signed-url', null, { image_ids: [randomUUID()] })).status;
  if (up >= 500) throw new Error(`Edge Functions not served (status ${up})`);
  const runQ = async (fault?: string, who: U = M1) => fn('admin-media-quarantine', who.token, { limit: 10 }, fault);
  const restoreQ = async (ids: string[], who: U = M2, confirm?: boolean, fault?: string) =>
    fn('admin-media-restore', who.token, confirm === undefined ? { job_ids: ids } : { job_ids: ids, confirm_child_safety: confirm }, fault);
  const outcome = (r: { body: any }, id: string) => (r.body?.results ?? []).find((x: any) => x.id === id);

  const F = randomUUID();
  must(await A.db.from('folders').insert({ id: F, user_id: A.id, name: `mqw ${run}`, is_public: true, cover_source: 'first_card' }), 'folder');
  let n = 0;
  // A fresh item of A's, reposted by B (a public share-snapshots copy owned by
  // B), then removed by M1: exactly one queued job, on B's copy.
  const scenario = async (reason = 'hate') => {
    const key = `s${++n}`;
    const id = randomUUID(), img = randomUUID(), path = `${A.id}/mqw/${key}.jpg`, bytes = jpeg(`${run}-${key}`);
    must(await A.db.from('collection_items').insert({ id, folder_id: F, user_id: A.id, title: `mqw ${key} ${run}`, is_public: true, collection_status: 'active', item_type: 'sports_card' }), 'item');
    must(await A.db.storage.from('item-images').upload(path, bytes, { contentType: 'image/jpeg' }), 'upload');
    must(await A.db.from('collection_item_images').insert({ id: img, item_id: id, user_id: A.id, image_url: 'https://x.invalid', storage_path: path, sort_order: 0, is_primary: true }), 'image');
    const rep = await fn('copy-share-snapshot-image', B.token, { item_id: id, snapshot_type: 'post', target_id: randomUUID() });
    if (rep.body?.status !== 'ok') throw new Error(`repost: ${rep.text}`);
    must(await reporter().db.rpc('submit_report', { p_target_type: 'collection_item', p_target_id: id, p_reason: reason, p_details: `${MARK} ${run}` }), 'report');
    const report = psql(`SELECT id FROM public.content_reports WHERE target_id = ${lit(id)} AND status = 'open'`);
    const rm = await rpc(M1, 'admin_remove_content', { p_report_id: report, p_reason_code: reason, p_include_related: false });
    if (rm.error) throw new Error(`remove: ${JSON.stringify(rm.error)}`);
    const snap = rep.body.storage_path as string;
    const jobId = jobFor('share-snapshots', snap);
    quarantinePaths.push(job(jobId).qpath);
    return { item: id, img, itemPath: path, snap, bytes, jobId, moderation: rm.data.moderation_id as string };
  };

  step('1. Authorization and input');
  const s1 = await scenario();
  check('signed out → 401', (await fn('admin-media-quarantine', null, {})).status === 401);
  check('an invalid token → 401', (await fn('admin-media-quarantine', 'not.a.jwt', {})).status === 401);
  check('an ordinary collector → 403', (await fn('admin-media-quarantine', A.token, {})).status === 403);
  check('restore: an ordinary collector → 403', (await fn('admin-media-restore', B.token, { job_ids: [s1.jobId] })).status === 403);
  check('invalid limit → 400', (await fn('admin-media-quarantine', M1.token, { limit: 50 })).status === 400);
  check('restore: malformed ids → 400', (await fn('admin-media-restore', M1.token, { job_ids: ['../x'] })).status === 400);
  check('collectors cannot claim, inspect, advance or authorize jobs',
    (await Promise.all([rpc(A, 'media_quarantine_claim', { p_limit: 1, p_lease_seconds: 60 }),
                        rpc(A, 'media_quarantine_claim_restore', { p_job_ids: [s1.jobId], p_lease_seconds: 60 }),
                        rpc(A, 'media_quarantine_inspect', { p_id: s1.jobId, p_lease: randomUUID() }),
                        rpc(A, 'media_quarantine_advance', { p_id: s1.jobId, p_lease: randomUUID(), p_to_state: 'copied' }),
                        rpc(A, 'media_quarantine_authorize', { p_admin: A.id, p_action: 'quarantine' })])).every((r) => !!r.error));
  check('collectors cannot read the queue overview or retry jobs',
    !!(await rpc(A, 'admin_media_quarantine_overview')).error && !!(await rpc(A, 'admin_media_quarantine_retry', { p_job_id: s1.jobId })).error);
  check('nothing was touched by refused calls', job(s1.jobId).state === 'pending' && exists('share-snapshots', s1.snap));

  step('2. Successful public-media quarantine');
  check('before: the public URL resolves at the Storage origin', (await publicStatus('share-snapshots', s1.snap)) === 200);
  const r1 = await runQ();
  check('the worker quarantines it', outcome(r1, s1.jobId)?.outcome === 'quarantined', r1.text);
  check('the response carries no paths', !r1.text.includes(s1.snap) && !r1.text.includes('moderation-quarantine'));
  check('the source object is gone from Storage', !exists('share-snapshots', s1.snap));
  const after = await publicStatus('share-snapshots', s1.snap);
  check('the original public URL no longer resolves at the local Storage origin', after !== 200, after);
  const copy = await service.storage.from('moderation-quarantine').download(job(s1.jobId).qpath);
  const copyBytes = copy.data ? new Uint8Array(await copy.data.arrayBuffer()) : new Uint8Array();
  check('the private copy is byte-identical to the original', sha(copyBytes) === sha(s1.bytes) && copy.data?.type === 'image/jpeg');
  check('the job records matching checksums',
    psql(`SELECT source_sha256 = quarantine_sha256 AND source_sha256 = ${lit(sha(s1.bytes))} FROM private.media_quarantine WHERE id = ${lit(s1.jobId)}`) === 't');
  check('collectors cannot download the private copy',
    !!(await A.db.storage.from('moderation-quarantine').download(job(s1.jobId).qpath)).error
      && !!(await B.db.storage.from('moderation-quarantine').download(job(s1.jobId).qpath)).error
      && !!(await anon.storage.from('moderation-quarantine').download(job(s1.jobId).qpath)).error);
  check('nor list the quarantine bucket', ((await B.db.storage.from('moderation-quarantine').list('q')).data ?? []).length === 0);
  check('B can no longer re-upload at the original path', !!(await B.db.storage.from('share-snapshots').upload(s1.snap, jpeg('again'), { contentType: 'image/jpeg' })).error);
  const events = psql(`SELECT string_agg(coalesce(from_state, '-') || '>' || coalesce(to_state, '-') || ':' || (actor_id = ${lit(M1.id)})::text, ',' ORDER BY id)
                         FROM private.media_quarantine_events WHERE quarantine_id = ${lit(s1.jobId)} AND event = 'worker_step'`);
  check('audit: pending→copied→verified→quarantined, each by the admin', events === 'pending>copied:true,copied>verified:true,verified>quarantined:true', events);
  check('the item-images original (private, not child safety) is untouched', exists('item-images', s1.itemPath));

  step('3. Source validation');
  const s3 = await scenario();
  // A tampered record (simulated with superuser rights) pointing at C's file.
  const cFile = `${C.id}/${Date.now()}.jpg`;
  must(await C.db.storage.from('avatars').upload(cFile, jpeg('c'), { contentType: 'image/jpeg' }), 'c file');
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE private.media_quarantine SET source_bucket = 'avatars', source_path = ${lit(cFile)} WHERE id = ${lit(s3.jobId)}; COMMIT;`);
  const r3 = await runQ();
  check('a record pointing at another collector\'s file is refused', outcome(r3, s3.jobId)?.outcome === 'needs_attention' && job(s3.jobId).error === 'invalid_source', job(s3.jobId));
  check('…and that file is untouched', exists('avatars', cFile) && (await publicStatus('avatars', cFile)) === 200);
  const s4 = await scenario();
  const svcRemove = await service.storage.from('share-snapshots').remove([s4.snap]);
  check('even the service role cannot delete a held file', !!svcRemove.error && exists('share-snapshots', s4.snap), svcRemove.error?.message);
  operatorDelete('share-snapshots', s4.snap);
  const r4 = await runQ();
  check('missing source → source_missing, no copy made', outcome(r4, s4.jobId)?.outcome === 'source_missing' && !exists('moderation-quarantine', job(s4.jobId).qpath));
  check('…and the path stays reserved', !!(await B.db.storage.from('share-snapshots').upload(s4.snap, jpeg('x'), { contentType: 'image/jpeg' })).error);
  const s5 = await scenario();
  check('even the service role cannot overwrite a held file',
    !!(await service.storage.from('share-snapshots').upload(s5.snap, jpeg('replaced'), { contentType: 'image/jpeg', upsert: true })).error);
  operatorReplace('share-snapshots', s5.snap);
  const r5 = await runQ();
  check('a source replaced since it was queued → flagged, not removed',
    outcome(r5, s5.jobId)?.outcome === 'needs_attention' && job(s5.jobId).error === 'source_changed' && exists('share-snapshots', s5.snap));
  const s6 = await scenario();
  must(await service.storage.from('moderation-quarantine').upload(job(s6.jobId).qpath, jpeg('squatter'), { contentType: 'image/jpeg' }), 'occupy destination');
  const r6 = await runQ();
  check('an occupied quarantine destination with different bytes → flagged, never overwritten',
    outcome(r6, s6.jobId)?.outcome === 'needs_attention' && job(s6.jobId).error === 'destination_conflict' && exists('share-snapshots', s6.snap));
  const squat = await service.storage.from('moderation-quarantine').download(job(s6.jobId).qpath);
  check('…the existing object is unchanged', !!squat.data && sha(new Uint8Array(await squat.data.arrayBuffer())) === sha(jpeg('squatter')));

  step('4. Failures');
  const s7 = await scenario();
  const r7 = await runQ('copy_fail');
  check('copy failure → retry scheduled, source intact', outcome(r7, s7.jobId)?.outcome === 'retry_scheduled' && job(s7.jobId).state === 'pending' && exists('share-snapshots', s7.snap));
  check('…and not retried before its back-off', !outcome(await runQ(), s7.jobId));
  due(s7.jobId);
  check('after the back-off it completes', outcome(await runQ(), s7.jobId)?.outcome === 'quarantined');
  const s8 = await scenario();
  const r8 = await runQ('corrupt_copy');
  check('a corrupted copy (hash mismatch) → flagged, source NOT removed',
    outcome(r8, s8.jobId)?.outcome === 'needs_attention' && job(s8.jobId).error === 'hash_mismatch' && exists('share-snapshots', s8.snap), job(s8.jobId));
  const s9 = await scenario();
  const r9 = await runQ('verify_read_fail');
  check('verification failure → retry scheduled at "copied", source intact',
    outcome(r9, s9.jobId)?.outcome === 'retry_scheduled' && job(s9.jobId).state === 'copied' && exists('share-snapshots', s9.snap), job(s9.jobId));
  due(s9.jobId);
  check('…then completes', outcome(await runQ(), s9.jobId)?.outcome === 'quarantined');
  const s10 = await scenario();
  const r10 = await runQ('delete_noop');
  check('a delete that "succeeds" but leaves the object → detected, not recorded as quarantined',
    outcome(r10, s10.jobId)?.outcome === 'retry_scheduled' && job(s10.jobId).state === 'verified' && job(s10.jobId).error === 'delete_failed'
      && exists('share-snapshots', s10.snap), job(s10.jobId));
  due(s10.jobId);
  check('…then completes', outcome(await runQ(), s10.jobId)?.outcome === 'quarantined' && !exists('share-snapshots', s10.snap));
  const s11 = await scenario();
  let last: Job = job(s11.jobId);
  for (let k = 0; k < 6 && !last.attention; k++) {
    due(s11.jobId);
    await runQ('copy_fail');
    last = job(s11.jobId);
  }
  check('retries are bounded: flagged after the attempt budget', last.attention && last.attempts === 5 && exists('share-snapshots', s11.snap), last);
  const ov = await rpc(M1, 'admin_media_quarantine_overview');
  check('admins see flagged jobs in the overview', (ov.data?.needs_attention ?? []).some((j: any) => j.id === s11.jobId && j.last_error === 'copy_failed'), ov.error);
  check('flagged jobs leave the queue', !outcome(await runQ(), s11.jobId));
  check('an admin retry returns it (audited)', (await rpc(M2, 'admin_media_quarantine_retry', { p_job_id: s11.jobId })).data?.changed === true
    && psql(`SELECT count(*) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(s11.jobId)} AND event = 'retry_requested' AND actor_id = ${lit(M2.id)}`) === '1');
  check('…and it completes', outcome(await runQ(), s11.jobId)?.outcome === 'quarantined');

  step('5. Interruptions and retries at every state');
  const s12 = await scenario();
  must(await service.rpc('media_quarantine_claim', { p_limit: 10, p_lease_seconds: 30 }), 'abandoned claim');
  check('a job claimed by a worker that died before copying is not handed out again while leased', !outcome(await runQ(), s12.jobId));
  expireLease(s12.jobId);
  check('…and completes once its lease expires', outcome(await runQ(), s12.jobId)?.outcome === 'quarantined');
  for (const fault of ['crash_after_copy', 'crash_after_verify', 'crash_after_delete']) {
    const s = await scenario();
    const r = await runQ(fault);
    const mid = job(s.jobId);
    const expected = { crash_after_copy: 'pending', crash_after_verify: 'verified', crash_after_delete: 'verified' }[fault];
    check(`${fault}: interrupted in state ${expected}`, outcome(r, s.jobId)?.outcome === 'interrupted' && mid.state === expected && mid.lease, mid);
    if (fault === 'crash_after_delete') check('…with the source already removed', !exists('share-snapshots', s.snap));
    else check('…with the source still in place', exists('share-snapshots', s.snap));
    expireLease(s.jobId);
    const again = await runQ();
    check(`${fault}: the retry finishes it`, outcome(again, s.jobId)?.outcome === 'quarantined' && !exists('share-snapshots', s.snap));
    const c2 = await service.storage.from('moderation-quarantine').download(job(s.jobId).qpath);
    check(`${fault}: the private copy is intact`, !!c2.data && sha(new Uint8Array(await c2.data.arrayBuffer())) === sha(s.bytes));
  }

  step('6. Concurrent workers');
  const batch = await Promise.all([scenario(), scenario(), scenario()]);
  const [w1, w2] = await Promise.all([runQ(), runQ()]);
  const all = [...(w1.body?.results ?? []), ...(w2.body?.results ?? [])].filter((x: any) => batch.some((b) => b.jobId === x.id));
  check('two workers at once: each job processed exactly once', all.length === 3 && new Set(all.map((x: any) => x.id)).size === 3, all);
  check('…all quarantined, no stray copies', batch.every((b) => job(b.jobId).state === 'quarantined' && !exists('share-snapshots', b.snap)));
  check('…each with one clean step sequence',
    batch.every((b) => psql(`SELECT count(*) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(b.jobId)} AND event = 'worker_step'`) === '3'));

  step('7. Restoration');
  const r1x = await restoreQ([s1.jobId]);
  check('restore before any hold ends → refused (not_released)', outcome(r1x, s1.jobId)?.outcome === 'refused' && outcome(r1x, s1.jobId)?.reason === 'not_released');
  // A second restriction on the same file: the item's folder.
  must(await reporter().db.rpc('submit_report', { p_target_type: 'folder', p_target_id: F, p_reason: 'hate', p_details: `${MARK} ${run}` }), 'folder report');
  const rF = psql(`SELECT id FROM public.content_reports WHERE target_id = ${lit(F)} AND status = 'open'`);
  const hF = await rpc(M1, 'admin_hide_content', { p_report_id: rF, p_reason_code: 'pending_review' });
  check('a second restriction (the folder) holds the same quarantined file',
    !hF.error && psql(`SELECT count(*) FROM private.media_quarantine_holds WHERE quarantine_id = ${lit(s1.jobId)} AND ended_at IS NULL`) === '2');
  check('restoring the item alone leaves it quarantined', !(await rpc(M1, 'admin_restore_content', { p_moderation_id: s1.moderation, p_reason_code: 'resolved_in_error', p_disposition: 'overturn' })).error
    && job(s1.jobId).state === 'quarantined');
  check('…and the restore worker still refuses', outcome(await restoreQ([s1.jobId]), s1.jobId)?.reason === 'not_released');
  check('restoring the folder ends the last hold', !(await rpc(M1, 'admin_restore_content', { p_moderation_id: hF.data.moderation_id, p_reason_code: 'resolved_in_error', p_disposition: 'overturn' })).error
    && job(s1.jobId).state === 'restore_pending');
  check('nothing restores automatically', !exists('share-snapshots', s1.snap));
  const [ra, rb] = await Promise.all([restoreQ([s1.jobId]), restoreQ([s1.jobId], M1)]);
  const outs = [outcome(ra, s1.jobId)?.outcome, outcome(rb, s1.jobId)?.outcome].sort();
  check('two concurrent restore requests: one restores, the other is busy or refused',
    outs.includes('restored') && outs.filter((o) => o === 'restored').length === 1, outs);
  const back = await service.storage.from('share-snapshots').download(s1.snap);
  check('the exact original bytes are back at the original path', !!back.data && sha(new Uint8Array(await back.data.arrayBuffer())) === sha(s1.bytes));
  check('…and its public URL resolves again', (await publicStatus('share-snapshots', s1.snap)) === 200);
  check('the private copy is retained (no purge), with a retention date',
    exists('moderation-quarantine', job(s1.jobId).qpath) && psql(`SELECT retain_until IS NOT NULL FROM private.media_quarantine WHERE id = ${lit(s1.jobId)}`) === 't');
  check('a repeated restore is refused as already restored', outcome(await restoreQ([s1.jobId]), s1.jobId)?.reason === 'already_restored');
  check('audit: every event on the job names an admin; restore requested and performed by named admins',
    Number(psql(`SELECT count(*) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(s1.jobId)} AND event = 'restore_requested' AND actor_id IS NOT NULL`)) >= 1
      && psql(`SELECT count(*) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(s1.jobId)} AND event = 'worker_step' AND to_state = 'restored' AND actor_id IS NOT NULL`) === '1'
      && psql(`SELECT count(*) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(s1.jobId)} AND actor_id IS NULL`) === '0');

  const s13 = await scenario();
  await runQ();
  must(await rpc(M1, 'admin_restore_content', { p_moderation_id: s13.moderation, p_reason_code: 'resolved_in_error', p_disposition: 'overturn' }) as any, 'restore s13');
  check('even the service role cannot occupy a path awaiting restore',
    !!(await service.storage.from('share-snapshots').upload(s13.snap, jpeg('occupier'), { contentType: 'image/jpeg' })).error);
  psql(`INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('share-snapshots', ${lit(s13.snap)}, '{"size": 1, "mimetype": "image/jpeg"}')`);
  const r13 = await restoreQ([s13.jobId]);
  check('restore into an occupied path → flagged, the occupant untouched',
    outcome(r13, s13.jobId)?.outcome === 'needs_attention' && job(s13.jobId).error === 'destination_occupied', job(s13.jobId));
  check('…still the other object', psql(`SELECT metadata->>'size' FROM storage.objects WHERE bucket_id = 'share-snapshots' AND name = ${lit(s13.snap)}`) === '1');

  const s14 = await scenario();
  await runQ();
  must(await rpc(M1, 'admin_restore_content', { p_moderation_id: s14.moderation, p_reason_code: 'resolved_in_error', p_disposition: 'overturn' }) as any, 'restore s14');
  const r14 = await restoreQ([s14.jobId], M2, undefined, 'crash_after_restore_upload');
  check('restore interrupted after writing the file back', outcome(r14, s14.jobId)?.outcome === 'interrupted' && job(s14.jobId).state === 'restoring');
  expireLease(s14.jobId);
  check('…the retry recognises its own bytes and finishes (no overwrite)', outcome(await restoreQ([s14.jobId]), s14.jobId)?.outcome === 'restored');

  step('8. Child safety (private DM and item media)');
  const conv = must(await A.db.rpc('get_or_create_conversation', { other_user_id: Rp.id }), 'conversation') as string;
  const msg = randomUUID(), dmPath = `${conv}/${msg}/image.jpg`, dmBytes = jpeg(`dm-${run}`);
  must(await A.db.storage.from('dm-attachments').upload(dmPath, dmBytes, { contentType: 'image/jpeg' }), 'dm');
  must(await A.db.from('messages').insert({ id: msg, conversation_id: conv, sender_id: A.id, body: null, attachment_type: 'image', attachment_storage_path: dmPath, attachment_width: 1, attachment_height: 1 }), 'msg');
  must(await Rp.db.rpc('submit_report', { p_target_type: 'message', p_target_id: msg, p_reason: 'child_safety', p_details: `${MARK} ${run}` }), 'dm report');
  const rDm = psql(`SELECT id FROM public.content_reports WHERE target_id = ${lit(msg)} AND status = 'open'`);
  const hDm = await rpc(M1, 'admin_hide_content', { p_report_id: rDm, p_reason_code: 'urgent_risk' });
  const dmJob = jobFor('dm-attachments', dmPath);
  quarantinePaths.push(job(dmJob).qpath);
  check('child-safety DM photo: quarantined first, ahead of other work', outcome(await runQ(), dmJob)?.outcome === 'quarantined' && !exists('dm-attachments', dmPath));
  check('…its copy carries a legal hold and no retention date',
    psql(`SELECT legal_hold AND retain_until IS NULL FROM private.media_quarantine WHERE id = ${lit(dmJob)}`) === 't');
  const lift = await rpc(M2, 'admin_restore_content', { p_moderation_id: hDm.data.moderation_id, p_reason_code: 'child_safety_review_cleared',
    p_note: 'second review cleared', p_disposition: 'overturn', p_confirm_child_safety: true });
  check('a second admin clears the child-safety restriction (M2.1 rules)', !lift.error && job(dmJob).state === 'restore_pending', lift.error);
  check('the file is still NOT restored automatically', !exists('dm-attachments', dmPath));
  check('restore without explicit child-safety confirmation → refused', outcome(await restoreQ([dmJob], M2), dmJob)?.reason === 'child_safety_confirmation_required');
  check('restore by the admin who imposed the restriction → refused', outcome(await restoreQ([dmJob], M1, true), dmJob)?.reason === 'second_admin_required');
  check('restore by a second admin with confirmation → restored', outcome(await restoreQ([dmJob], M2, true), dmJob)?.outcome === 'restored');
  const dmBack = await service.storage.from('dm-attachments').download(dmPath);
  check('…exact bytes back; the legal-hold copy is retained',
    !!dmBack.data && sha(new Uint8Array(await dmBack.data.arrayBuffer())) === sha(dmBytes) && exists('moderation-quarantine', job(dmJob).qpath));

  const sCs = await scenario('child_safety');
  const itemJob = jobFor('item-images', sCs.itemPath);
  quarantinePaths.push(job(itemJob).qpath);
  await runQ();
  check('child-safety item image (private) and its public copy are both quarantined',
    job(itemJob).state === 'quarantined' && job(sCs.jobId).state === 'quarantined' && !exists('item-images', sCs.itemPath) && !exists('share-snapshots', sCs.snap));

  step('9. Account deletion and export');
  const exp = psql(`SELECT count(*) FROM public.export_owned_storage_objects(${lit(A.id)}) WHERE name IN (${lit(sCs.itemPath)})`);
  check('Download My Data no longer lists quarantined files', exp === '0');
  const s15 = await scenario();
  await runQ();
  must(await rpc(M1, 'admin_restore_content', { p_moderation_id: s15.moderation, p_reason_code: 'resolved_in_error', p_disposition: 'overturn' }) as any, 'restore s15');
  deletedPrefixes.push(B.id);
  must(await service.auth.admin.deleteUser(B.id) as any, 'delete B');
  check('restore into a deleted account → refused', outcome(await restoreQ([s15.jobId]), s15.jobId)?.reason === 'owner_deleted' && !exists('share-snapshots', s15.snap));
  check('the owner\'s deletion keeps every job and every private copy',
    [s15, s10, sCs].every((s) => exists('moderation-quarantine', job(s.jobId).qpath)) && exists('moderation-quarantine', job(itemJob).qpath));

  step('10. No unauthorized public copies survive');
  const leftover = psql(`SELECT count(*) FROM private.media_quarantine q JOIN storage.objects o ON o.bucket_id = q.source_bucket AND o.name = q.source_path
                          WHERE q.state = 'quarantined' AND q.id IN (SELECT h.quarantine_id FROM private.media_quarantine_holds h
                            JOIN public.moderated_content m ON m.id = h.moderation_id JOIN public.content_reports r ON r.id = m.report_id WHERE r.details LIKE '${MARK}%')`);
  check('no quarantined job\'s source object still exists', leftover === '0');
  const stillPublic = psql(`SELECT count(*) FROM private.media_quarantine q JOIN storage.objects o ON o.bucket_id = q.source_bucket AND o.name = q.source_path
                             WHERE q.desired IN ('quarantine', 'retain') AND q.state <> 'quarantined' AND NOT q.needs_attention AND q.id IN (
                               SELECT h.quarantine_id FROM private.media_quarantine_holds h JOIN public.moderated_content m ON m.id = h.moderation_id
                               JOIN public.content_reports r ON r.id = m.report_id WHERE r.details LIKE '${MARK}%')`);
  check('every still-public restricted file is a flagged job awaiting an admin (reported, not silent)', stillPublic === '0', stillPublic);
  const actorless = psql(`SELECT count(*) FROM private.media_quarantine_events e WHERE e.event IN ('worker_step', 'worker_retry', 'needs_attention') AND e.actor_id IS NULL
                           AND e.quarantine_id IN (SELECT h.quarantine_id FROM private.media_quarantine_holds h JOIN public.moderated_content m ON m.id = h.moderation_id
                             JOIN public.content_reports r ON r.id = m.report_id WHERE r.details LIKE '${MARK}%')`);
  check('audit completeness: every worker step names its admin', actorless === '0', actorless);
}

console.log(`Local Supabase ${st.API_URL} (run ${run})`);
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
  console.log(`Fixture rows left: ${psql(`SELECT (SELECT count(*) FROM public.content_reports WHERE details LIKE '${MARK}%') || ' reports, '
    || (SELECT count(*) FROM auth.users WHERE raw_app_meta_data->>'fixture' = '${FIXTURE}') || ' users, '
    || (SELECT count(*) FROM private.media_quarantine) || ' jobs, ' || (SELECT count(*) FROM private.media_quarantine_events) || ' events, '
    || (SELECT count(*) FROM storage.objects WHERE bucket_id = 'moderation-quarantine') || ' quarantine objects, '
    || (SELECT count(*) FROM private.share_snapshot_copies) || ' ledger rows'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
