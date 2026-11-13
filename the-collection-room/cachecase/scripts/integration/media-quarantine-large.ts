/// <reference types="node" />
// Large-file media quarantine and restoration (Phase 2B M2.3e: streaming
// worker) — end-to-end against the LOCAL Supabase stack with disposable
// collectors and objects from 200 KB to the supported 50 MB: quarantine and
// byte-identical restoration at every size, failure injection and
// interruption at 50 MB, concurrent workers and expired leases.
//
// Measures wall time per job (functions log), and the edge runtime
// container's memory (cgroup memory.current, sampled every ~10 ms while each
// job runs). The runtime's own limits: 256 MB memory, 2 s CPU per request.
//
// Prerequisites: local Supabase with migrations applied, and
//   supabase functions serve --env-file <file with CACHECASE_TEST_MQ_FAULTS=1>
//   FUNCTIONS_LOG=<serve log> node scripts/integration/media-quarantine-large.ts
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { removeQuarantineFixtures } from './quarantine-fixture-cleanup.ts';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'media-quarantine-large-it';
const MARK = 'mql-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const functionsLog = process.env.FUNCTIONS_LOG ?? '';
const EDGE = 'supabase_edge_runtime_cachecase';
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const MB = 1048576;

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}
const info = (s: string) => console.log(`  INFO  ${s}`);
const step = (s: string) => console.log(`\n${s}`);
const must = <T>(r: { data: T; error: unknown }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r.data;
};

// ── Edge runtime memory sampler (container cgroup) ─────────────────────────
let memMax = 0;
const sampler = spawn('docker', ['exec', EDGE, 'sh', '-c', 'while :; do cat /sys/fs/cgroup/memory.current; sleep 0.01; done']);
sampler.stdout.on('data', (d: Buffer) => {
  for (const line of d.toString().split('\n')) { const v = Number(line); if (v > memMax) memMax = v; }
});
const memNow = () => Number(execFileSync('docker', ['exec', EDGE, 'cat', '/sys/fs/cgroup/memory.current'], { encoding: 'utf8' }).trim());
async function withMemory<T>(work: () => Promise<T>): Promise<{ value: T; baseMb: number; peakMb: number }> {
  await new Promise((r) => setTimeout(r, 300));
  const base = memNow();
  memMax = base;
  const value = await work();
  await new Promise((r) => setTimeout(r, 100));
  return { value, baseMb: Math.round(base / MB), peakMb: Math.round(memMax / MB) };
}

type U = { id: string; token: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const username = `mql${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Mql-${randomBytes(9).toString('base64url')}`;
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
const jobFor = (bucket: string, path: string) =>
  psql(`SELECT id FROM private.media_quarantine WHERE source_bucket = ${lit(bucket)} AND source_path = ${lit(path)} ORDER BY created_at DESC LIMIT 1`);
const job = (id: string) => {
  const [state, attention, error] = psql(`SELECT concat_ws('|', state, needs_attention, coalesce(last_error, '')) FROM private.media_quarantine WHERE id = ${lit(id)}`).split('|');
  return { state, attention: attention === 't' || attention === 'true', error };
};
const qpath = (id: string) => psql(`SELECT quarantine_path FROM private.media_quarantine WHERE id = ${lit(id)}`);
const expireLease = (id: string) => psql(`UPDATE private.media_quarantine SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${lit(id)} AND lease_token IS NOT NULL`);
const due = (id: string) => psql(`UPDATE private.media_quarantine SET next_attempt_at = NULL WHERE id = ${lit(id)}`);
const retry = (id: string) => psql(`UPDATE private.media_quarantine SET needs_attention = false, attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ${lit(id)}`);

async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const qPaths = psql(`SELECT coalesce(string_agg(quarantine_path, ','), '') FROM private.media_quarantine
                        WHERE owner_id::text IN (${ids.length ? ids.map(lit).join(',') : "''"})`).split(',').filter(Boolean);
  if (qPaths.length) removeQuarantineFixtures(qPaths);
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
        COMMIT;`);
  for (const id of ids) {
    for (const b of ['item-images', 'share-snapshots']) {
      const files = await listDeep(b, id);
      if (files.length) await service.storage.from(b).remove(files);
    }
    await service.auth.admin.deleteUser(id);
  }
  return ids.length;
}

type R = { data: any; error: { message?: string } | null };
const rpc = (u: { db: SupabaseClient }, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const fn = async (name: string, token: string, body: unknown, fault?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${token}` };
  if (fault) headers['x-cachecase-local-fault'] = fault;
  const t0 = performance.now();
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, ms: Math.round(performance.now() - t0), text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const outcome = (r: { body: any }, id: string) => (r.body?.results ?? []).find((x: any) => x.id === id);
const jobMs = (id: string, fnName: string) => {
  if (!functionsLog) return null;
  const line = readFileSync(functionsLog, 'utf8').split('\n').reverse().find((l) => l.includes(id) && l.includes(`"fn":"${fnName}"`) && l.includes('"ms"'));
  return line ? (JSON.parse(line.slice(line.indexOf('{'))).ms as number) : null;
};
// Runtime limit events since a log line: hard = the worker was killed
// (memory limit, CPU hard limit, request cancelled); soft = the 1 s CPU soft
// limit (the isolate is retired after the request, which still completes).
const limitsSince = (marker: number) => {
  const lines = functionsLog ? readFileSync(functionsLog, 'utf8').split('\n').slice(marker) : [];
  return { hard: lines.filter((l) => /memory limit reached|CPU time hard limit|WorkerRequestCancelled/i.test(l)).length,
           soft: lines.filter((l) => /CPU time soft limit/i.test(l)).length };
};
const logLines = () => (functionsLog ? readFileSync(functionsLog, 'utf8').split('\n').length : 0);
const jpegHead = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const sized = (bytes: number) => Buffer.concat([jpegHead, randomBytes(bytes - jpegHead.length)]);
const publicStatus = async (bucket: string, path: string) => {
  const r = await fetch(`${st.API_URL}/storage/v1/object/public/${bucket}/${path}`, { headers: { 'cache-control': 'no-cache' } });
  await r.body?.cancel();
  return r.status;
};
const shaOf = async (bucket: string, path: string) => {
  const { data, error } = await service.storage.from(bucket).download(path).asStream();
  if (error || !data) return null;
  const h = createHash('sha256');
  for await (const c of data as unknown as AsyncIterable<Uint8Array>) h.update(c);
  return h.digest('hex');
};

async function main() {
  const A = await createUser('a');
  const M1 = await createUser('m1');
  const M2 = await createUser('m2');
  must(await service.from('admin_users').insert([{ user_id: M1.id }, { user_id: M2.id }]), 'admins');
  const pool = await Promise.all(Array.from({ length: 8 }, (_, k) => createUser(`p${k}`)));
  let turn = 0;
  const report = async (type: string, id: string, reason = 'hate') => {
    must(await pool[turn++ % pool.length].db.rpc('submit_report', { p_target_type: type, p_target_id: id, p_reason: reason, p_details: `${MARK} ${run}` }), 'report');
    return psql(`SELECT id FROM public.content_reports WHERE target_id = ${lit(id)} AND status = 'open' AND details LIKE '${MARK}%' ORDER BY created_at DESC LIMIT 1`);
  };
  const runQ = (fault?: string) => fn('admin-media-quarantine', M1.token, { limit: 10 }, fault);
  const restoreQ = (ids: string[], who: U = M2, fault?: string, confirm?: boolean) =>
    fn('admin-media-restore', who.token, confirm === undefined ? { job_ids: ids } : { job_ids: ids, confirm_child_safety: confirm }, fault);
  // A public share snapshot of `bytes`, on a post of A's, hidden by M1: one job.
  let n = 0;
  const snapJob = async (bytes: Buffer) => {
    const path = `${A.id}/mql/${++n}-${bytes.length}.jpg`;
    must(await service.storage.from('share-snapshots').upload(path, bytes, { contentType: 'image/jpeg' }), 'upload');
    const post = randomUUID();
    must(await A.db.from('posts').insert({ id: post, user_id: A.id, post_type: 'text', content: `mql ${n}`, image_url: anon.storage.from('share-snapshots').getPublicUrl(path).data.publicUrl }), 'post');
    const hide = await rpc(M1, 'admin_hide_content', { p_report_id: await report('post', post), p_reason_code: 'pending_review' });
    if (hide.error) throw new Error(`hide: ${JSON.stringify(hide.error)}`);
    return { path, bytes, id: jobFor('share-snapshots', path), moderation: hide.data.moderation_id as string };
  };
  const lift = (moderation: string) => rpc(M1, 'admin_restore_content', { p_moderation_id: moderation, p_reason_code: 'resolved_in_error', p_disposition: 'overturn' });
  const up = (await fn('admin-media-quarantine', 'x', {})).status;
  if (up >= 500) throw new Error('Edge Functions not served');

  step('1. Quarantine and restoration by size (one worker run each)');
  const table: string[] = [];
  for (const [label, size] of [['200 KB', 200 * 1024], ['5 MB', 5 * MB], ['10 MB', 10 * MB], ['25 MB', 25 * MB], ['40 MB', 40 * MB], ['50 MB', 50 * MB - 4096]] as const) {
    const j = await snapJob(sized(size));
    const mark = logLines();
    const q = await withMemory(() => runQ());
    const qo = outcome(q.value, j.id)?.outcome;
    const copySha = await shaOf('moderation-quarantine', qpath(j.id));
    check(`${label}: quarantined in a single run`, qo === 'quarantined' && q.value.status === 200, { status: q.value.status, qo, job: job(j.id) });
    check(`${label}: private copy byte-identical, original gone at the Storage origin`,
      copySha === sha(j.bytes) && !exists('share-snapshots', j.path) && (await publicStatus('share-snapshots', j.path)) !== 200);
    must(await lift(j.moderation) as any, 'lift');
    const r = await withMemory(() => restoreQ([j.id]));
    const ro = outcome(r.value, j.id)?.outcome;
    check(`${label}: restored byte-identical to its original path`,
      ro === 'restored' && (await shaOf('share-snapshots', j.path)) === sha(j.bytes) && (await publicStatus('share-snapshots', j.path)) === 200, { ro });
    const limits = limitsSince(mark);
    check(`${label}: the worker was never killed by a runtime limit`, limits.hard === 0, limits);
    table.push(`${label.padEnd(7)} quarantine ${String(jobMs(j.id, 'admin-media-quarantine') ?? '?').padStart(5)} ms (request ${q.value.ms} ms), `
      + `restore ${String(jobMs(j.id, 'admin-media-restore') ?? '?').padStart(5)} ms; container memory ${q.baseMb}→${q.peakMb} MB / ${r.baseMb}→${r.peakMb} MB; `
      + `CPU soft-limit notices ${limits.soft}`);
  }
  for (const line of table) info(line);

  step('2. A 50 MB child-safety item image (private media, second-admin restore)');
  const big = sized(50 * MB - 4096);
  const item = randomUUID(), img = randomUUID(), ipath = `${A.id}/mql/item-50mb.jpg`;
  const folder = randomUUID();
  must(await A.db.from('folders').insert({ id: folder, user_id: A.id, name: `mql ${run}`, is_public: true }), 'folder');
  must(await A.db.from('collection_items').insert({ id: item, folder_id: folder, user_id: A.id, title: 'mql big', is_public: true, collection_status: 'active', item_type: 'sports_card' }), 'item');
  must(await service.storage.from('item-images').upload(ipath, big, { contentType: 'image/jpeg' }), 'big upload');
  must(await A.db.from('collection_item_images').insert({ id: img, item_id: item, user_id: A.id, image_url: 'https://x.invalid', storage_path: ipath, sort_order: 0, is_primary: true }), 'image');
  const rm = await rpc(M2, 'admin_remove_content', { p_report_id: await report('collection_item', item, 'child_safety'), p_reason_code: 'child_safety', p_include_related: false });
  const itemJob = jobFor('item-images', ipath);
  const cs = await withMemory(() => runQ());
  check('50 MB child-safety item image: quarantined in one run, copy intact',
    outcome(cs.value, itemJob)?.outcome === 'quarantined' && !exists('item-images', ipath) && (await shaOf('moderation-quarantine', qpath(itemJob))) === sha(big));
  info(`50 MB item: container memory ${cs.baseMb}→${cs.peakMb} MB, request ${cs.value.ms} ms`);
  const csLift = await rpc(M1, 'admin_restore_content', { p_moderation_id: rm.data.moderation_id, p_reason_code: 'child_safety_review_cleared', p_note: 'second review', p_disposition: 'overturn', p_confirm_child_safety: true });
  check('…cleared by a second admin', !csLift.error, csLift.error);
  check('…restored by an admin who did not impose it, byte-identical',
    outcome(await restoreQ([itemJob], M1, undefined, true), itemJob)?.outcome === 'restored' && (await shaOf('item-images', ipath)) === sha(big));

  step('3. Failures and interruptions at 50 MB');
  const fifty = () => snapJob(sized(50 * MB - 4096));
  const f1 = await fifty();
  check('copy failure → retry scheduled, source intact', outcome(await runQ('copy_fail'), f1.id)?.outcome === 'retry_scheduled' && exists('share-snapshots', f1.path));
  due(f1.id);
  check('…then completes', outcome(await runQ(), f1.id)?.outcome === 'quarantined');
  const f2 = await fifty();
  check('corrupted copy → hash mismatch flagged, source NOT removed',
    outcome(await runQ('corrupt_copy'), f2.id)?.outcome === 'needs_attention' && job(f2.id).error === 'hash_mismatch' && exists('share-snapshots', f2.path), job(f2.id));
  const f3 = await fifty();
  check('checksum read failure → retry at "copied", source intact',
    outcome(await runQ('verify_read_fail'), f3.id)?.outcome === 'retry_scheduled' && job(f3.id).state === 'copied' && exists('share-snapshots', f3.path));
  due(f3.id);
  check('…then completes', outcome(await runQ(), f3.id)?.outcome === 'quarantined');
  const f4 = await fifty();
  check('a delete that leaves the object → never recorded as removed',
    outcome(await runQ('delete_noop'), f4.id)?.outcome === 'retry_scheduled' && job(f4.id).state === 'verified' && job(f4.id).error === 'delete_failed' && exists('share-snapshots', f4.path));
  due(f4.id);
  check('…then completes, the source really gone', outcome(await runQ(), f4.id)?.outcome === 'quarantined' && !exists('share-snapshots', f4.path));
  const f5 = await fifty();
  check('a lease about to expire → no source removal', outcome(await runQ('lease_nearly_expired'), f5.id)?.outcome === 'lease_lost'
    && job(f5.id).state === 'verified' && exists('share-snapshots', f5.path), job(f5.id));
  expireLease(f5.id);
  check('…the next worker, after the lease expires, finishes it', outcome(await runQ(), f5.id)?.outcome === 'quarantined');
  for (const [fault, at] of [['crash_after_copy', 'pending'], ['crash_after_verify', 'verified'], ['crash_after_delete', 'verified']] as const) {
    const f = await fifty();
    check(`${fault}: interrupted at "${at}"`, outcome(await runQ(fault), f.id)?.outcome === 'interrupted' && job(f.id).state === at);
    expireLease(f.id);
    check(`${fault}: resumed to a byte-identical quarantine`, outcome(await runQ(), f.id)?.outcome === 'quarantined'
      && (await shaOf('moderation-quarantine', qpath(f.id))) === sha(f.bytes) && !exists('share-snapshots', f.path));
  }
  const fr = await fifty();
  await runQ();
  must(await lift(fr.moderation) as any, 'lift fr');
  check('restore write failure → retry, nothing at the path', outcome(await restoreQ([fr.id], M2, 'restore_upload_fail'), fr.id)?.outcome === 'retry_scheduled'
    && !exists('share-snapshots', fr.path));
  retry(fr.id);
  check('restore interrupted after the copy-back', outcome(await restoreQ([fr.id], M2, 'crash_after_restore_upload'), fr.id)?.outcome === 'interrupted');
  expireLease(fr.id);
  check('…resumed: recognises its own bytes, restored without overwriting', outcome(await restoreQ([fr.id]), fr.id)?.outcome === 'restored'
    && (await shaOf('share-snapshots', fr.path)) === sha(fr.bytes));
  const fl = await fifty();
  await runQ();
  must(await lift(fl.moderation) as any, 'lift fl');
  check('restore with a lease about to expire → nothing written', outcome(await restoreQ([fl.id], M2, 'lease_nearly_expired'), fl.id)?.outcome === 'lease_lost'
    && !exists('share-snapshots', fl.path));
  expireLease(fl.id);
  check('…a later restore completes', outcome(await restoreQ([fl.id]), fl.id)?.outcome === 'restored');

  step('4. Concurrency, batching and expired leases at 50 MB');
  const [b1, b2] = [await fifty(), await fifty()];
  const firstRun = await runQ();
  const firstIds = (firstRun.body?.results ?? []).map((x: any) => x.id).filter((x: string) => x === b1.id || x === b2.id);
  check('a run stops taking work at its hashing budget: two queued 50 MB jobs need two runs', firstIds.length === 1, firstRun.body);
  const secondRun = await runQ();
  check('…and the next run finishes the other', (secondRun.body?.results ?? []).some((x: any) => (x.id === b1.id || x.id === b2.id) && x.outcome === 'quarantined')
    && [b1, b2].every((b) => job(b.id).state === 'quarantined'));
  const [c1, c2] = [await fifty(), await fifty()];
  const conc = await withMemory(() => Promise.all([runQ(), runQ()]));
  const all = conc.value.flatMap((r) => r.body?.results ?? []).filter((x: any) => x.id === c1.id || x.id === c2.id);
  check('two concurrent workers: each 50 MB job processed exactly once, both quarantined',
    all.length === 2 && new Set(all.map((x: any) => x.id)).size === 2 && [c1, c2].every((c) => job(c.id).state === 'quarantined'), all);
  info(`two concurrent 50 MB jobs: container memory ${conc.baseMb}→${conc.peakMb} MB`);
  check('…with one step sequence each', [c1, c2].every((c) => psql(`SELECT count(*) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(c.id)} AND event = 'worker_step'`) === '3'));
  const e1 = await fifty();
  must(await service.rpc('media_quarantine_claim', { p_limit: 10, p_lease_seconds: 30 }), 'abandoned claim');
  check('a job held by a dead worker\'s lease is not taken over early', !outcome(await runQ(), e1.id));
  expireLease(e1.id);
  check('…and completes once the lease expires', outcome(await runQ(), e1.id)?.outcome === 'quarantined');
  const order = psql(`SELECT string_agg(to_state, '>' ORDER BY id) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(f4.id)} AND event IN ('worker_step', 'worker_retry')`);
  check('source removal is recorded only after origin verification (the failed no-op delete stayed "verified")', order === 'copied>verified>verified>quarantined', order);
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
  sampler.kill();
  console.log(`\nCleanup: ${await sweep()} account(s) removed.`);
  console.log(`Fixture rows left: ${psql(`SELECT (SELECT count(*) FROM public.content_reports WHERE details LIKE '${MARK}%') || ' reports, '
    || (SELECT count(*) FROM auth.users WHERE raw_app_meta_data->>'fixture' = '${FIXTURE}') || ' users, '
    || (SELECT count(*) FROM private.media_quarantine) || ' jobs, '
    || (SELECT count(*) FROM storage.objects WHERE bucket_id = 'moderation-quarantine') || ' quarantine objects'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
