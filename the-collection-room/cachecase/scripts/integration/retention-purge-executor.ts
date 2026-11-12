/// <reference types="node" />
// Two-administrator manual retention purge executor (Phase 2B M4 step 4B,
// 20261125120000_retention_purge_executor.sql + admin-retention-purge) —
// end-to-end through PostgREST, the REAL Storage API and the Edge Function.
//
// DESTRUCTIVE on synthetic fixtures only, and it REFUSES to run anywhere but
// an isolated disposable local stack:
//   CACHECASE_STACK_WORKDIR=<isolated workdir> node scripts/integration/retention-purge-executor.ts
// The isolated stack must serve its functions with CACHECASE_TEST_RP_FAULTS=1
// (local-only fault injection). Time is "advanced" for fixtures through a
// superuser psql session (session_replication_role = replica); cleanup uses
// the same operator path.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from './local-stack.ts';
import { removeQuarantineFixtures } from './quarantine-fixture-cleanup.ts';

const stack = requireIsolatedStack();
const st = stack.st;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'retention-purge-executor-it';
const MARK = 'rpx-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psqlArgs = (sql: string) => ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql];
const psql = (sql: string) => execFileSync('docker', psqlArgs(sql), { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);

type U = { id: string; db: SupabaseClient; token: string };
type R = { data: any; error: { message?: string } | null };
async function createUser(key: string): Promise<U> {
  const username = `rx${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Rx-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, db, token: s.session!.access_token };
}
const rpc = (u: U, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const errMsg = (r: { error: { message?: string } | null }) => r.error?.message ?? null;
async function purgeFn(u: U | null, body: unknown, fault?: string) {
  const res = await fetch(`${st.API_URL}/functions/v1/admin-retention-purge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: st.ANON_KEY, ...(u ? { Authorization: `Bearer ${u.token}` } : {}),
               ...(fault ? { 'x-cachecase-local-fault': fault } : {}) },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

function report(owner: string): string {
  const id = randomUUID();
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.content_reports (id, target_type, target_id, target_owner_id, reason, details, evidence, status, created_at,
                                        reviewed_at, evidence_purge_after, resolution, resolution_reason)
    VALUES (${lit(id)}, 'post', gen_random_uuid(), ${lit(owner)}, 'spam', ${lit(`${MARK} ${run}`)}, '{"text":"rpx evidence"}', 'dismissed',
            now() - interval '120 days', now() - interval '100 days', now() - interval '10 days', 'no_violation', 'within_guidelines');
    COMMIT;`);
  return id;
}
const sources: string[] = [];
const qPaths: string[] = [];
// A terminal (restored) job with a real private copy AND its restored source.
async function copy(owner: string, opts: { state?: string; sourcePath?: string } = {}): Promise<{ id: string; path: string; src: string }> {
  const id = randomUUID();
  const path = `q/${randomUUID()}/original`;
  const src = opts.sourcePath ?? `${owner}/rpx-${id}.jpg`;
  const bytes = new Uint8Array([1, 2, 3]);
  qPaths.push(path);
  const up = await service.storage.from('moderation-quarantine').upload(path, bytes, { contentType: 'image/jpeg' });
  if (up.error) throw new Error(`upload copy: ${up.error.message}`);
  if (!opts.sourcePath) {
    const us = await service.storage.from('avatars').upload(src, bytes, { contentType: 'image/jpeg' });
    if (us.error) throw new Error(`upload source: ${us.error.message}`);
    sources.push(src);
  }
  const state = opts.state ?? 'restored';
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id, size_bytes,
                                          source_sha256, quarantine_sha256, quarantine_path, state, desired, child_safety, legal_hold,
                                          retain_until, source_removed_at)
    VALUES (${lit(id)}, 'avatars', ${lit(src)}, ${lit(owner)}, 'avatar', 'profile', ${lit(owner)}, 3, repeat('c', 64), repeat('c', 64),
            ${lit(path)}, ${lit(state)}, ${state === 'quarantined' ? "'quarantine'" : "'restore'"}, false, false,
            ${state === 'quarantined' ? 'NULL' : "now() - interval '5 days'"}, now() - interval '100 days');
    COMMIT;`);
  return { id, path, src };
}
const present = (bucket: string, path: string) =>
  psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = ${lit(bucket)} AND name = ${lit(path)}`) === '1';
const itemState = (subject: string) =>
  psql(`SELECT string_agg(state, ',' ORDER BY updated_at) FROM private.retention_purge_items WHERE subject_id = ${lit(subject)}`);
const tombstones = (subject: string) => Number(psql(`SELECT count(*) FROM private.retention_purge_tombstones WHERE subject_id = ${lit(subject)}`));
const expireLeases = (subjects: string[]) => psql(`BEGIN; SET LOCAL session_replication_role = replica;
  UPDATE private.retention_purge_claims SET claimed_at = clock_timestamp() - interval '10 minutes', lease_expires_at = clock_timestamp() - interval '6 minutes'
   WHERE subject_id IN (${subjects.map(lit).join(',')}) AND closed_at IS NULL;
  UPDATE private.retention_purge_items SET lease_expires_at = clock_timestamp() - interval '6 minutes'
   WHERE subject_id IN (${subjects.map(lit).join(',')}) AND state = 'deleting';
  COMMIT;`);

async function prepareApprove(prep: U, appr: U, category: string, ids: string[]): Promise<string> {
  const p = await rpc(prep, 'admin_retention_prepare_run', { p_category: category, p_subject_ids: ids });
  if (p.error) throw new Error(`prepare: ${p.error.message}`);
  const a = await rpc(appr, 'admin_retention_approve_run', { p_run_id: p.data.id, p_set_digest: p.data.set_digest, p_item_count: p.data.item_count });
  if (a.error) throw new Error(`approve: ${a.error.message}`);
  return p.data.id;
}

async function sweep(): Promise<number> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const idList = ids.length ? ids.map(lit).join(',') : "''";
  const jobPaths = psql(`SELECT coalesce(string_agg(quarantine_path, ','), '') FROM private.media_quarantine WHERE source_path LIKE '%/rpx-%' OR source_path LIKE '%rpx-shared%'`)
    .split(',').filter(Boolean);
  removeQuarantineFixtures([...new Set([...jobPaths, ...qPaths])]);
  const srcs = psql(`SELECT coalesce(string_agg(name, ','), '') FROM storage.objects WHERE bucket_id = 'avatars' AND (name LIKE '%/rpx-%' OR name LIKE '%rpx-shared%')`)
    .split(',').filter(Boolean);
  if (srcs.length) await service.storage.from('avatars').remove(srcs);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fx ON COMMIT DROP AS SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%';
        CREATE TEMP TABLE fq ON COMMIT DROP AS SELECT id FROM private.media_quarantine WHERE source_path LIKE '%/rpx-%' OR source_path LIKE '%rpx-shared%';
        CREATE TEMP TABLE fr ON COMMIT DROP AS SELECT DISTINCT run_id AS id FROM private.retention_purge_items
          WHERE subject_id IN (SELECT id FROM fx UNION ALL SELECT id FROM fq);
        DELETE FROM private.retention_purge_events WHERE run_id IN (SELECT id FROM fr);
        DELETE FROM private.retention_purge_tombstones WHERE run_id IN (SELECT id FROM fr);
        DELETE FROM private.retention_purge_items WHERE run_id IN (SELECT id FROM fr);
        DELETE FROM private.retention_purge_runs WHERE id IN (SELECT id FROM fr) OR prepared_by::text IN (${idList});
        DELETE FROM private.retention_purge_claims WHERE subject_id IN (SELECT id FROM fx UNION ALL SELECT id FROM fq);
        DELETE FROM private.moderation_legal_holds WHERE subject_id IN (SELECT id FROM fx UNION ALL SELECT id FROM fq)
          OR subject_owner_id::text IN (${idList}) OR placed_by::text IN (${idList}) OR basis_note LIKE '${MARK}%';
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM fx) OR admin_id::text IN (${idList});
        DELETE FROM public.content_reports WHERE id IN (SELECT id FROM fx);
        DELETE FROM private.media_quarantine WHERE id IN (SELECT id FROM fq);
        DELETE FROM public.admin_users WHERE user_id::text IN (${idList});
        COMMIT;`);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

async function main() {
  const users = await Promise.all(['a1', 'a2', 'a3', 'a4', 'c', 'd', 'x'].map(createUser));
  const [A1, A2, A3, A4, C, D, X] = users;
  psql(`INSERT INTO public.admin_users (user_id) VALUES ${[A1, A2, A3, A4].map((a) => `(${lit(a.id)})`).join(',')}`);
  const hold = (u: U, kind: string, id: string) => rpc(u, 'admin_place_legal_hold', {
    p_subject_kind: kind, p_subject_id: id, p_basis_code: 'litigation', p_basis_note: `${MARK} hold`, p_expires_at: days(30) });

  step('1. Authorisation');
  check('the Edge Function refuses a call with no session', (await purgeFn(null, { run_id: randomUUID() })).status === 401);
  const fx = await purgeFn(X, { run_id: randomUUID() });
  check('…and a collector', fx.status === 403, fx);
  const r0 = report(C.id);
  check('a collector cannot prepare a run', errMsg(await rpc(X, 'admin_retention_prepare_run', { p_category: 'report_evidence', p_subject_ids: [r0] })) === 'forbidden');
  check('the service role cannot call the executor RPCs', !!(await service.rpc('admin_retention_prepare_run', { p_category: 'report_evidence', p_subject_ids: [r0] })).error);
  check('runs and tombstones are not reachable through the API', !!(await service.schema('private' as never).from('retention_purge_runs').select('id')).error);

  step('2. Two admins prepare the same evidence at once');
  const rr = [report(C.id), report(C.id)];
  const both = await Promise.all([A1, A2].map((a) => rpc(a, 'admin_retention_prepare_run', { p_category: 'report_evidence', p_subject_ids: rr })));
  check('exactly one run is prepared; the other is refused (already in an open run)',
    both.filter((x) => !x.error).length === 1 && both.some((x) => errMsg(x) === 'candidate_not_eligible'), both.map(errMsg));
  const winner = both.find((x) => !x.error)!.data;
  const preparer = both[0].error ? A2 : A1;
  check('the preparer cannot approve it', errMsg(await rpc(preparer, 'admin_retention_approve_run', {
    p_run_id: winner.id, p_set_digest: winner.set_digest, p_item_count: winner.item_count })) === 'self_approval_refused');
  const appr = await Promise.all([A3, A4].map((a) => rpc(a, 'admin_retention_approve_run', {
    p_run_id: winner.id, p_set_digest: winner.set_digest, p_item_count: winner.item_count })));
  check('two simultaneous approvals: exactly one succeeds (duplicate refused)',
    appr.filter((x) => !x.error).length === 1 && appr.some((x) => errMsg(x) === 'run_not_pending'), appr.map(errMsg));

  step('3. Two executors race on one report run');
  const ex = await Promise.all([A3, A4].map((a) => rpc(a, 'admin_retention_execute_reports', { p_run_id: winner.id })));
  const completedCount = ex.reduce((n, x) => n + Number(x.data?.processed?.completed ?? 0), 0);
  check('between them each item is purged exactly once', completedCount === 2 && rr.every((r) => tombstones(r) === 1), { completedCount, err: ex.map(errMsg) });
  check('one audit row per purged item', Number(psql(`SELECT count(*) FROM public.moderation_actions WHERE action = 'purge_report_evidence' AND report_id IN (${rr.map(lit).join(',')})`)) === 2);
  check('only evidence was cleared (details and status kept)',
    psql(`SELECT bool_and(evidence IS NULL AND details LIKE '${MARK}%' AND status = 'dismissed') FROM public.content_reports WHERE id IN (${rr.map(lit).join(',')})`) === 't');
  check('the preparer cannot execute', errMsg(await rpc(preparer, 'admin_retention_execute_reports', { p_run_id: winner.id })) === 'self_execution_refused');

  step('4. Account deletion during a purge');
  const rc = report(C.id);
  const rd = report(D.id);
  const run4 = await prepareApprove(A1, A2, 'report_evidence', [rc, rd]);
  check('account hold on D, then D deletes their account mid-run', !(await hold(A3, 'account', D.id)).error
    && !(await service.auth.admin.deleteUser(D.id)).error);
  const e4 = await rpc(A3, 'admin_retention_execute_reports', { p_run_id: run4 });
  check('D\'s report is skipped: its hold can no longer be matched (G6, fail closed)',
    psql(`SELECT array_to_string(skip_reasons, ',') FROM private.retention_purge_items WHERE run_id = ${lit(run4)} AND subject_id = ${lit(rd)}`) === 'deleted_owner_hold_ambiguous', e4);
  check('C\'s report (known owner, no hold) is purged', tombstones(rc) === 1);

  step('5. Quarantine copies through the Edge Function and the real Storage API');
  const q = await Promise.all([copy(C.id), copy(C.id), copy(C.id), copy(C.id), copy(C.id), copy(C.id)]);
  const qOther = await copy(X.id);   // another collector's copy, not in the run
  const qRun = await prepareApprove(A1, A2, 'quarantine_copy', q.slice(0, 2).map((x) => x.id));
  check('the preparer cannot run the purge', (await purgeFn(A1, { run_id: qRun })).json?.reason === 'self_execution_refused');
  const f1 = await purgeFn(A3, { run_id: qRun, limit: 10 });
  check('the approved run purges both copies', f1.status === 200 && f1.json?.results?.filter((r: any) => r.outcome === 'completed').length === 2, f1);
  check('exactly those private objects are gone', q.slice(0, 2).every((x) => !present('moderation-quarantine', x.path)));
  check('the collector\'s restored source files are untouched', q.every((x) => present('avatars', x.src)));
  check('another collector\'s copy is untouched', present('moderation-quarantine', qOther.path));
  check('copy tombstones have no path', psql(`SELECT bool_and(to_jsonb(t)::text !~ 'q/') FROM private.retention_purge_tombstones t WHERE subject_id IN (${q.slice(0, 2).map((x) => lit(x.id)).join(',')})`) === 't');

  step('6. Storage failure, crash after delete, expired claim');
  const qRun2 = await prepareApprove(A2, A1, 'quarantine_copy', [q[2].id]);
  const sf = await purgeFn(A3, { run_id: qRun2 }, 'storage_error');
  check('Storage failure: nothing deleted, item left in flight', sf.json?.results?.[0]?.outcome === 'in_flight' && present('moderation-quarantine', q[2].path), sf.json);
  expireLeases([q[2].id]);
  const sf2 = await purgeFn(A3, { run_id: qRun2 });
  check('after the lease, the next run reconciles, retries and completes (attempt 2)',
    sf2.json?.results?.[0]?.outcome === 'completed' && !present('moderation-quarantine', q[2].path)
    && psql(`SELECT attempts FROM private.retention_purge_items WHERE subject_id = ${lit(q[2].id)}`) === '2', sf2.json);
  const qRun3 = await prepareApprove(A1, A2, 'quarantine_copy', [q[3].id]);
  const cr = await purgeFn(A3, { run_id: qRun3 }, 'crash_after_delete');
  check('crash after the Storage delete: object gone, completion not yet recorded',
    cr.json?.status === 'interrupted' && !present('moderation-quarantine', q[3].path) && itemState(q[3].id) === 'deleting', cr.json);
  const cr2 = await purgeFn(A4, { run_id: qRun3 });
  check('the next run reconciles it as completed (claim consumed + object gone), with one tombstone',
    itemState(q[3].id) === 'completed' && tombstones(q[3].id) === 1, cr2.json);
  const qRun4 = await prepareApprove(A1, A2, 'quarantine_copy', [q[4].id]);
  const cb = await purgeFn(A3, { run_id: qRun4 }, 'crash_before_delete');
  check('crash before the delete: the claim is held, the object is still there', cb.json?.status === 'interrupted' && present('moderation-quarantine', q[4].path));
  const other = await service.storage.from('moderation-quarantine').remove([qOther.path]);
  check('…its live claim does not unlock any other object', !!other.error && present('moderation-quarantine', qOther.path), other);
  expireLeases([q[4].id]);
  const cb2 = await purgeFn(A3, { run_id: qRun4 });
  check('after the claim expires, the next run settles it (not deleted), re-checks, re-claims and completes exactly once',
    itemState(q[4].id) === 'completed' && !present('moderation-quarantine', q[4].path) && tombstones(q[4].id) === 1
    && psql(`SELECT attempts FROM private.retention_purge_items WHERE subject_id = ${lit(q[4].id)}`) === '2'
    && psql(`SELECT string_agg(close_reason, ',' ORDER BY claimed_at) FROM private.retention_purge_claims WHERE subject_id = ${lit(q[4].id)}`) === 'expired,consumed',
    { s: itemState(q[4].id), j: cb2.json });

  step('7. Legal hold placed mid-execution; concurrent executors');
  const qRun5 = await prepareApprove(A1, A2, 'quarantine_copy', [q[5].id]);
  const claimed = await rpc(A3, 'admin_retention_claim_copy', { p_run_id: qRun5 });
  check('copy claimed for deletion', claimed.data?.outcome === 'claimed', claimed);
  check('a legal hold is placed on it mid-purge', !(await hold(A1, 'quarantine_copy', q[5].id)).error);
  const del5 = await service.storage.from('moderation-quarantine').remove([q[5].path]);
  check('the Storage delete is refused by the guard: the hold wins', !!del5.error && present('moderation-quarantine', q[5].path), del5);
  expireLeases([q[5].id]);
  const h5 = await purgeFn(A4, { run_id: qRun5 });
  check('the retry re-checks and skips the held copy; it is never deleted',
    itemState(q[5].id) === 'skipped' && present('moderation-quarantine', q[5].path), h5.json);
  const more = await Promise.all([copy(C.id), copy(C.id), copy(C.id), copy(C.id)]);
  const qRun6 = await prepareApprove(A2, A1, 'quarantine_copy', more.map((x) => x.id));
  const [p1, p2] = await Promise.all([purgeFn(A3, { run_id: qRun6, limit: 10 }), purgeFn(A4, { run_id: qRun6, limit: 10 })]);
  check('two Edge Function executions on one run: every copy purged exactly once',
    more.every((x) => !present('moderation-quarantine', x.path) && tombstones(x.id) === 1), { p1: p1.json, p2: p2.json });

  step('8. Concurrent cleanup and restoration on the same source');
  const shared = `${C.id}/rpx-shared.jpg`;
  const old = await copy(C.id, { sourcePath: shared });
  const fresh = await copy(C.id, { sourcePath: shared, state: 'quarantined' });   // re-moderated: a new live copy
  const qRun7 = await prepareApprove(A1, A2, 'quarantine_copy', [old.id]);
  check('the new live job\'s copy cannot be prepared', errMsg(await rpc(A1, 'admin_retention_prepare_run', { p_category: 'quarantine_copy', p_subject_ids: [fresh.id] })) === 'candidate_not_eligible');
  const [run7, attack] = await Promise.all([purgeFn(A3, { run_id: qRun7 }), service.storage.from('moderation-quarantine').remove([fresh.path])]);
  check('purging the old copy leaves the new live copy in place (and it can\'t be deleted meanwhile)',
    !present('moderation-quarantine', old.path) && present('moderation-quarantine', fresh.path) && !!attack.error, { run7: run7.json });

  step('9. Missing object without an authorised delete');
  const lost = await copy(C.id);
  const qRun8 = await prepareApprove(A1, A2, 'quarantine_copy', [lost.id]);
  check('claimed', (await rpc(A3, 'admin_retention_claim_copy', { p_run_id: qRun8 })).data?.outcome === 'claimed');
  removeQuarantineFixtures([lost.path]);   // out-of-band loss (operator), not through the claim
  const c8 = await rpc(A3, 'admin_retention_confirm_copy', { p_run_id: qRun8, p_item_id: psql(`SELECT id FROM private.retention_purge_items WHERE subject_id = ${lit(lost.id)}`) });
  check('it is flagged for manual investigation, never counted as purged', c8.data?.outcome === 'needs_attention' && tombstones(lost.id) === 0, c8);
  const list = await rpc(A2, 'admin_list_retention_purge_runs', { p_limit: 100 });
  check('the run list surfaces it', (list.data as any[]).some((r) => r.id === qRun8 && Number(r.needs_attention) === 1));

  step('10. Nothing outside the approved sets was touched');
  check('no live claim remains', psql(`SELECT count(*) FROM private.retention_purge_claims WHERE closed_at IS NULL AND lease_expires_at > clock_timestamp()`) === '0');
  check('every tombstone has two distinct admins and an executor who did not prepare it',
    psql(`SELECT bool_and(prepared_by <> approved_by AND executed_by <> prepared_by) FROM private.retention_purge_tombstones`) === 't');
}

console.log(`Isolated local Supabase ${st.API_URL} [${stack.project}] (run ${run})`);
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
    || (SELECT count(*) FROM private.retention_purge_runs) || ' runs, ' || (SELECT count(*) FROM private.retention_purge_claims) || ' claims, '
    || (SELECT count(*) FROM private.media_quarantine) || ' jobs, '
    || (SELECT count(*) FROM storage.objects WHERE bucket_id IN ('moderation-quarantine', 'avatars')) || ' objects'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
