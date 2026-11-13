/// <reference types="node" />
// Purge privileges, single-object Storage deletion and erasure evidence
// (Phase 2B M4 step 5D, 20261129120000_purge_privileges_and_erasure_evidence.sql,
// admin-retention-purge) — end to end through PostgREST, the Edge Function and
// the REAL Storage API, on synthetic fixtures.
//
// DESTRUCTIVE on synthetic fixtures only; REFUSES to run anywhere but an
// isolated disposable local stack, served with CACHECASE_TEST_RP_FAULTS=1:
//   CACHECASE_STACK_WORKDIR=<isolated workdir> node scripts/integration/retention-purge-authorization.ts
// Privileges are granted the only way they can be: by an operator (psql as
// postgres) on behalf of a different administrator.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from './local-stack.ts';
import { removeQuarantineFixtures } from './quarantine-fixture-cleanup.ts';

const stack = requireIsolatedStack();
const st = stack.st;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'retention-purge-authorization-it';
const MARK = 'rpa-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psql = (sql: string) =>
  execFileSync('docker', ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);

type U = { id: string; db: SupabaseClient; token: string };
type R = { data: any; error: { message?: string } | null };
async function createUser(key: string): Promise<U> {
  const username = `rpa${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Rpa-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE } });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, db, token: s.session!.access_token };
}
const rpc = (u: U, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const errMsg = (r: { error: { message?: string } | null }) => r.error?.message ?? null;
async function purgeFn(u: U, body: unknown, fault?: string) {
  const res = await fetch(`${st.API_URL}/functions/v1/admin-retention-purge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${u.token}`, ...(fault ? { 'x-cachecase-local-fault': fault } : {}) },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
const grant = (who: U, priv: 'preparer' | 'approver', by: U) =>
  psql(`SELECT private.grant_admin_privilege(${lit(who.id)}, 'retention_purge_${priv}', ${lit(by.id)}, 'integration fixture')`);
const revoke = (who: U, priv: 'preparer' | 'approver', by: U) =>
  psql(`SELECT private.revoke_admin_privilege(${lit(who.id)}, 'retention_purge_${priv}', ${lit(by.id)}, 'integration fixture')`);

function report(owner: string): string {
  const id = randomUUID();
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.content_reports (id, target_type, target_id, target_owner_id, reason, details, evidence, status, created_at,
                                        reviewed_at, evidence_purge_after, resolution, resolution_reason)
    VALUES (${lit(id)}, 'post', gen_random_uuid(), ${lit(owner)}, 'spam', ${lit(`${MARK} ${run}`)}, '{"text":"rpa evidence"}', 'dismissed',
            now() - interval '120 days', now() - interval '100 days', now() - interval '10 days', 'no_violation', 'within_guidelines');
    COMMIT;`);
  return id;
}
const qPaths: string[] = [];
async function copy(owner: string, opts: { childSafety?: boolean } = {}): Promise<{ id: string; path: string; src: string }> {
  const id = randomUUID();
  const path = `q/${randomUUID()}/original`;
  const src = `${owner}/rpa-${id}.jpg`;
  const bytes = new Uint8Array([7, 8, 9]);
  qPaths.push(path);
  const up = await service.storage.from('moderation-quarantine').upload(path, bytes, { contentType: 'image/jpeg' });
  if (up.error) throw new Error(`upload copy: ${up.error.message}`);
  const us = await service.storage.from('avatars').upload(src, bytes, { contentType: 'image/jpeg' });
  if (us.error) throw new Error(`upload source: ${us.error.message}`);
  const cs = !!opts.childSafety;
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id, size_bytes,
                                          source_sha256, quarantine_sha256, quarantine_path, state, desired, child_safety, legal_hold,
                                          retain_until, source_removed_at)
    VALUES (${lit(id)}, 'avatars', ${lit(src)}, ${lit(owner)}, 'avatar', 'profile', ${lit(owner)}, 3, repeat('e', 64), repeat('e', 64),
            ${lit(path)}, 'restored', 'restore', ${cs}, ${cs}, ${cs ? 'NULL' : "now() - interval '5 days'"}, now() - interval '100 days');
    COMMIT;`);
  return { id, path, src };
}
const present = (bucket: string, path: string) =>
  psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = ${lit(bucket)} AND name = ${lit(path)}`) === '1';
const itemState = (subject: string) => psql(`SELECT state FROM private.retention_purge_items WHERE subject_id = ${lit(subject)} ORDER BY updated_at DESC LIMIT 1`);
const evidence = (subject: string) => psql(`SELECT e.classification || ':' || e.api_outcome || ':' || e.unavailable_check
  FROM private.retention_purge_erasure_records e WHERE e.item_id = (SELECT id FROM private.retention_purge_items WHERE subject_id = ${lit(subject)} ORDER BY updated_at DESC LIMIT 1)
  ORDER BY e.id DESC LIMIT 1`);
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
// The Storage single-object route, called directly (as a misbehaving server would).
async function storageDelete(path: string): Promise<number> {
  const res = await fetch(`${st.API_URL}/storage/v1/object/moderation-quarantine/${path}`, {
    method: 'DELETE', headers: { apikey: st.SERVICE_ROLE_KEY, Authorization: `Bearer ${st.SERVICE_ROLE_KEY}` },
  });
  await res.body?.cancel();
  return res.status;
}

async function sweep(): Promise<number> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const idList = ids.length ? ids.map(lit).join(',') : "''";
  const jobPaths = psql(`SELECT coalesce(string_agg(quarantine_path, ','), '') FROM private.media_quarantine WHERE source_path LIKE '%/rpa-%'`).split(',').filter(Boolean);
  const live = [...new Set([...jobPaths, ...qPaths])].filter((p) => present('moderation-quarantine', p));
  if (live.length) removeQuarantineFixtures(live);
  const srcs = psql(`SELECT coalesce(string_agg(name, ','), '') FROM storage.objects WHERE bucket_id IN ('avatars', 'item-images') AND name LIKE '%/rpa-%'`).split(',').filter(Boolean);
  for (const b of ['avatars', 'item-images']) {
    const mine = srcs.filter((n) => psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = ${lit(b)} AND name = ${lit(n)}`) === '1');
    if (mine.length) await service.storage.from(b).remove(mine);
  }
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fx ON COMMIT DROP AS SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%';
        CREATE TEMP TABLE fq ON COMMIT DROP AS SELECT id FROM private.media_quarantine WHERE source_path LIKE '%/rpa-%';
        CREATE TEMP TABLE fr ON COMMIT DROP AS SELECT DISTINCT run_id AS id FROM private.retention_purge_items
          WHERE subject_id IN (SELECT id FROM fx UNION ALL SELECT id FROM fq);
        DELETE FROM private.retention_purge_erasure_records WHERE run_id IN (SELECT id FROM fr);
        DELETE FROM private.retention_purge_events WHERE run_id IN (SELECT id FROM fr);
        DELETE FROM private.retention_purge_tombstones WHERE run_id IN (SELECT id FROM fr);
        DELETE FROM private.retention_purge_items WHERE run_id IN (SELECT id FROM fr);
        DELETE FROM private.retention_purge_runs WHERE id IN (SELECT id FROM fr) OR prepared_by::text IN (${idList});
        DELETE FROM private.retention_purge_claims WHERE subject_id IN (SELECT id FROM fx UNION ALL SELECT id FROM fq);
        DELETE FROM private.moderation_legal_holds WHERE subject_id IN (SELECT id FROM fx UNION ALL SELECT id FROM fq) OR placed_by::text IN (${idList});
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM fx) OR admin_id::text IN (${idList});
        DELETE FROM public.content_reports WHERE id IN (SELECT id FROM fx);
        DELETE FROM private.media_quarantine WHERE id IN (SELECT id FROM fq);
        DELETE FROM private.admin_privilege_events WHERE user_id::text IN (${idList}) OR actor_id::text IN (${idList});
        DELETE FROM private.admin_privileges WHERE user_id::text IN (${idList}) OR granted_by::text IN (${idList});
        DELETE FROM public.admin_users WHERE user_id::text IN (${idList});
        COMMIT;`);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

async function main() {
  const [A1, A2, A3, A4, C, X] = await Promise.all(['a1', 'a2', 'a3', 'a4', 'c', 'x'].map(createUser));
  psql(`INSERT INTO public.admin_users (user_id) VALUES ${[A1, A2, A3, A4].map((a) => `(${lit(a.id)})`).join(',')}`);
  const unrelatedItem = `${X.id}/rpa-unrelated.jpg`;
  const ui = await service.storage.from('item-images').upload(unrelatedItem, new Uint8Array([1]), { contentType: 'image/jpeg' });
  if (ui.error) throw new Error('unrelated upload');

  step('1. Privileges: nobody holds one until an operator grants it');
  const r1 = report(C.id);
  check('an admin without the preparer privilege cannot prepare', errMsg(await rpc(A1, 'admin_retention_prepare_run', { p_category: 'report_evidence', p_subject_ids: [r1] })) === 'purge_preparer_privilege_required');
  check('privileges cannot be granted through the API (service role or user)',
    !!(await service.rpc('grant_admin_privilege', { p_user: A1.id, p_privilege: 'retention_purge_preparer', p_granted_by: A2.id, p_reason: 'x' })).error
    && !!(await service.schema('private' as never).rpc('grant_admin_privilege', { p_user: A1.id, p_privilege: 'retention_purge_preparer', p_granted_by: A2.id, p_reason: 'x' })).error
    && !!(await rpc(A2, 'grant_admin_privilege', { p_user: A1.id, p_privilege: 'retention_purge_preparer', p_granted_by: A2.id, p_reason: 'x' })).error);
  let self = '';
  try { grant(A1, 'preparer', A1); } catch (e) { self = String((e as Error).message); }
  check('an operator cannot self-grant on someone\'s behalf', /self_grant_refused/.test(self));
  grant(A1, 'preparer', A2);
  check('with no other approver, preparation fails closed', errMsg(await rpc(A1, 'admin_retention_prepare_run', { p_category: 'report_evidence', p_subject_ids: [r1] })) === 'insufficient_purge_administrators');
  grant(A2, 'approver', A1);
  grant(A3, 'approver', A1);
  const p1 = await rpc(A1, 'admin_retention_prepare_run', { p_category: 'report_evidence', p_subject_ids: [r1] });
  check('once an approver exists, the preparer prepares', !p1.error, p1.error);
  check('an admin without the approver privilege cannot approve',
    errMsg(await rpc(A4, 'admin_retention_approve_run', { p_run_id: p1.data.id, p_set_digest: p1.data.set_digest, p_item_count: 1 })) === 'purge_approver_privilege_required');
  check('self-approval refused', errMsg(await rpc(A1, 'admin_retention_approve_run', { p_run_id: p1.data.id, p_set_digest: p1.data.set_digest, p_item_count: 1 })) === 'self_approval_refused');
  check('a privileged second admin approves', !(await rpc(A2, 'admin_retention_approve_run', { p_run_id: p1.data.id, p_set_digest: p1.data.set_digest, p_item_count: 1 })).error);
  check('an admin without a purge privilege cannot execute', errMsg(await rpc(A4, 'admin_retention_execute_reports', { p_run_id: p1.data.id })) === 'purge_executor_privilege_required');
  const ex1 = await rpc(A3, 'admin_retention_execute_reports', { p_run_id: p1.data.id });
  check('a privileged approver (not the preparer) executes the report purge', ex1.data?.processed?.completed === 1, ex1.error);
  check('…classified database_cleared', evidence(r1) === 'database_cleared:not_applicable:not_applicable');

  step('2. Approved single-object deletion through the Edge Function');
  const q = await Promise.all(Array.from({ length: 9 }, () => copy(C.id)));
  const other = await copy(X.id);
  const run2 = await prepareApprove(A1, A2, 'quarantine_copy', [q[0].id, q[1].id]);
  const f2 = await purgeFn(A3, { run_id: run2, limit: 10 });
  check('both copies purged', f2.status === 200 && f2.json?.results?.filter((r: any) => r.outcome === 'completed').length === 2, f2.json);
  check('exactly those objects are gone', !present('moderation-quarantine', q[0].path) && !present('moderation-quarantine', q[1].path));
  check('the single-object delete was accepted and the object then read as not found → unavailable_via_api',
    evidence(q[0].id) === 'unavailable_via_api:accepted:not_found' && evidence(q[1].id) === 'unavailable_via_api:accepted:not_found', [evidence(q[0].id), evidence(q[1].id)]);
  check('sources, other copies and unrelated media untouched', q.every((x) => present('avatars', x.src)) && present('moderation-quarantine', other.path)
    && present('item-images', unrelatedItem) && q.slice(2).every((x) => present('moderation-quarantine', x.path)));

  step('3. Failed, timed-out and "successful" requests that deleted nothing');
  const run3 = await prepareApprove(A1, A2, 'quarantine_copy', [q[2].id, q[3].id, q[4].id, q[5].id]);
  const f500 = await purgeFn(A3, { run_id: run3, limit: 1 }, 'storage_500');
  check('HTTP error: nothing deleted, item left in flight, outcome recorded', f500.json?.results?.[0]?.outcome === 'in_flight'
    && [q[2], q[3], q[4], q[5]].every((x) => present('moderation-quarantine', x.path)) && /api_failed:http_error/.test(psql(`SELECT string_agg(classification || ':' || api_outcome, ',')
      FROM private.retention_purge_erasure_records WHERE run_id = ${lit(run3)}`)), f500.json);
  const firstClaimed = psql(`SELECT subject_id FROM private.retention_purge_items WHERE run_id = ${lit(run3)} AND state = 'deleting'`);
  expireLeases([firstClaimed]);
  const fto = await purgeFn(A3, { run_id: run3, limit: 1 }, 'storage_timeout');
  check('after the lease, a timed-out attempt is also left in flight (never assumed deleted)',
    fto.json?.results?.[0]?.outcome === 'in_flight' && present('moderation-quarantine', q[2].path), fto.json);
  expireLeases([q[2].id, q[3].id, q[4].id, q[5].id]);
  const fnoop = await purgeFn(A3, { run_id: run3, limit: 1 }, 'storage_noop');
  const noopItem = fnoop.json?.results?.[0]?.item_id;
  check('an "accepted" response that deleted nothing completes nothing', fnoop.json?.results?.[0]?.outcome === 'in_flight'
    && psql(`SELECT count(*) FROM private.retention_purge_tombstones WHERE item_id = ${lit(noopItem ?? randomUUID())}`) === '0', fnoop.json);
  expireLeases([q[2].id, q[3].id, q[4].id, q[5].id]);
  const flost = await purgeFn(A3, { run_id: run3, limit: 1 }, 'storage_timeout_after_delete');
  const lostItem = flost.json?.results?.[0]?.item_id as string;
  const lostSubject = psql(`SELECT subject_id FROM private.retention_purge_items WHERE id = ${lit(lostItem)}`);
  check('the delete happened but its response was lost: the database proves it → completed, metadata_removed (api timeout)',
    flost.json?.results?.[0]?.outcome === 'completed' && evidence(lostSubject) === 'metadata_removed:timeout:not_checked', { r: flost.json, e: evidence(lostSubject) });
  expireLeases([q[2].id, q[3].id, q[4].id, q[5].id]);
  const fok = await purgeFn(A3, { run_id: run3, limit: 10 });
  const run3Copies = [q[2], q[3], q[4], q[5]];
  const done3 = run3Copies.filter((x) => itemState(x.id) === 'completed');
  const flagged3 = run3Copies.filter((x) => itemState(x.id) === 'needs_attention');
  check('the other copies complete exactly once each', done3.length === 3 && done3.every((x) => !present('moderation-quarantine', x.path) && tombstones(x.id) === 1), fok.json);
  check('the copy whose three attempts failed (HTTP error, timeout, empty success) is flagged, classified incomplete, and still present',
    flagged3.length === 1 && psql(`SELECT attempts FROM private.retention_purge_items WHERE subject_id = ${lit(flagged3[0].id)}`) === '3'
      && evidence(flagged3[0].id).startsWith('incomplete:') && present('moderation-quarantine', flagged3[0].path) && tombstones(flagged3[0].id) === 0,
    flagged3.map((x) => evidence(x.id)));

  step('4. Storage success, then a database failure (crash before confirmation)');
  const run4 = await prepareApprove(A1, A2, 'quarantine_copy', [q[6].id]);
  const cr = await purgeFn(A3, { run_id: run4 }, 'crash_after_delete');
  check('object gone, completion not recorded', cr.json?.status === 'interrupted' && !present('moderation-quarantine', q[6].path) && itemState(q[6].id) === 'deleting');
  const rec = await rpc(A2, 'admin_retention_purge_reconciliation', { p_run_id: run4 });
  check('reconciliation shows it in flight with the claim consumed and no metadata', (rec.data?.items ?? []).some((i: any) =>
    i.subject_id === q[6].id && i.state === 'deleting' && i.claim_state === 'consumed' && i.storage_metadata_present === false), rec.data);
  const cr2 = await purgeFn(A3, { run_id: run4 });
  check('the next run settles it as completed from the database\'s evidence', itemState(q[6].id) === 'completed' && tombstones(q[6].id) === 1
    && evidence(q[6].id) === 'metadata_removed:unknown:not_checked', { j: cr2.json, e: evidence(q[6].id) });

  step('5. New legal hold, missing object, child safety');
  const run5 = await prepareApprove(A1, A2, 'quarantine_copy', [q[7].id]);
  const claimed = await rpc(A3, 'admin_retention_claim_copy', { p_run_id: run5 });
  check('claimed', claimed.data?.outcome === 'claimed');
  check('a legal hold is placed mid-purge', !(await rpc(A1, 'admin_place_legal_hold', { p_subject_kind: 'quarantine_copy', p_subject_id: q[7].id,
    p_basis_code: 'litigation', p_basis_note: `${MARK} hold`, p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() })).error);
  const blocked = await storageDelete(q[7].path);
  check('the single-object DELETE is refused by the guard (the hold wins)', blocked >= 400 && present('moderation-quarantine', q[7].path), blocked);
  expireLeases([q[7].id]);
  await purgeFn(A3, { run_id: run5 });
  check('the retry re-checks and skips it; never deleted', itemState(q[7].id) === 'skipped' && present('moderation-quarantine', q[7].path));
  const run6 = await prepareApprove(A1, A2, 'quarantine_copy', [q[8].id]);
  removeQuarantineFixtures([q[8].path]);   // gone before deletion (operator)
  const f6 = await purgeFn(A3, { run_id: run6 });
  check('an object missing before deletion is skipped, never counted as purged', itemState(q[8].id) === 'skipped' && tombstones(q[8].id) === 0, f6.json);
  const cs = await copy(C.id, { childSafety: true });
  check('child-safety copies cannot be prepared', errMsg(await rpc(A1, 'admin_retention_prepare_run', { p_category: 'quarantine_copy', p_subject_ids: [cs.id] })) === 'candidate_not_eligible');

  step('6. Ambiguous outcome and reconciliation');
  const amb = await copy(C.id);
  const run7 = await prepareApprove(A1, A2, 'quarantine_copy', [amb.id]);
  const c7 = await rpc(A3, 'admin_retention_claim_copy', { p_run_id: run7 });
  removeQuarantineFixtures([amb.path]);   // disappears outside the authorised delete
  const conf = await rpc(A3, 'admin_retention_confirm_copy', { p_run_id: run7, p_item_id: c7.data?.item_id, p_storage_error: 'storage_not_found',
    p_result: { api: 'not_found', unavailable: 'not_checked' } });
  check('flagged needs_attention as ambiguous, never purged', conf.data?.outcome === 'needs_attention' && tombstones(amb.id) === 0
    && evidence(amb.id) === 'ambiguous_missing_unverified:not_found:not_checked', { c: conf, e: evidence(amb.id) });
  const rec7 = await rpc(A4, 'admin_retention_purge_reconciliation', { p_run_id: run7 });
  const ri = (rec7.data?.items ?? [])[0];
  check('any admin can see it with a recommended next step, no path', ri?.recommended_action === 'investigate_unverified_disappearance'
    && ri?.claim_state === 'withdrawn' && rec7.data?.physical_erasure_verifiable === false && !JSON.stringify(rec7.data).includes('q/'), rec7.data);
  const reco = await rpc(A3, 'admin_retention_reconcile_run', { p_run_id: run7 });
  check('reconciling never clears needs_attention', !reco.error && itemState(amb.id) === 'needs_attention');

  step('7. Revocation, concurrency, removal');
  const rv = await copy(C.id);
  const run8 = await prepareApprove(A1, A2, 'quarantine_copy', [rv.id]);
  revoke(A2, 'approver', A1);
  const f8 = await purgeFn(A3, { run_id: run8 });
  check('approver revoked after approval: execution refused, object intact', f8.status === 409 && f8.json?.reason === 'run_admins_not_authorized'
    && present('moderation-quarantine', rv.path), f8.json);
  grant(A2, 'approver', A3);
  const p9 = await rpc(A1, 'admin_retention_prepare_run', { p_category: 'report_evidence', p_subject_ids: [report(C.id)] });
  // An operator revokes A2's approver privilege in a transaction that holds
  // for ~3 s while A2 approves: the approval waits for it, then is refused.
  const slow = spawn('docker', ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc',
    `BEGIN; SELECT private.revoke_admin_privilege(${lit(A2.id)}, 'retention_purge_approver', ${lit(A1.id)}, 'concurrency test'); SELECT pg_sleep(3); COMMIT;`]);
  const slowDone = new Promise((r) => slow.on('close', r));
  await sleep(700);
  const t0 = Date.now();
  const a9 = await rpc(A2, 'admin_retention_approve_run', { p_run_id: p9.data.id, p_set_digest: p9.data.set_digest, p_item_count: 1 });
  const waited = Date.now() - t0;
  await slowDone;
  check('a concurrent revocation is serialised: the approval waited and was refused', errMsg(a9) === 'purge_approver_privilege_required' && waited > 1500, { e: errMsg(a9), waited });
  grant(A2, 'approver', A3);
  psql(`DELETE FROM public.admin_users WHERE user_id = ${lit(A3.id)}`);
  const f10 = await purgeFn(A3, { run_id: run8 });
  check('a removed admin cannot execute, whatever the grant table says', f10.status === 403 || f10.status === 409, f10);
  check('…the object is still there', present('moderation-quarantine', rv.path));
  psql(`INSERT INTO public.admin_users (user_id) VALUES (${lit(A3.id)})`);

  step('8. No destructive access from the dashboard');
  const client = readFileSync(new URL('../../lib/admin-monitoring.ts', import.meta.url), 'utf8');
  check('the dashboard client calls no approve, execute, claim, confirm or reconcile RPC',
    !/approve_run|execute_reports|claim_copy|confirm_copy|reconcile_run|grant_admin_privilege|revoke_admin_privilege/.test(client));
  const dash = await rpc(A4, 'admin_retention_purge_dashboard', { p_status: null, p_limit: 50, p_before: null });
  check('the dashboard shows the viewer has no purge privilege, and nothing as approvable', dash.data?.viewer_privileges?.approver === false
    && (dash.data?.items ?? []).every((r: any) => r.viewer_may_approve === false), dash.data?.viewer_privileges);
  check('no live claim remains', psql(`SELECT count(*) FROM private.retention_purge_claims WHERE closed_at IS NULL AND lease_expires_at > clock_timestamp()`) === '0');
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
  console.log(`Fixture rows left: ${psql(`SELECT (SELECT count(*) FROM private.retention_purge_runs) || ' runs, ' || (SELECT count(*) FROM private.retention_purge_claims) || ' claims, '
    || (SELECT count(*) FROM private.admin_privileges) || ' privileges, ' || (SELECT count(*) FROM private.retention_purge_erasure_records) || ' erasure records, '
    || (SELECT count(*) FROM storage.objects WHERE bucket_id IN ('moderation-quarantine', 'avatars', 'item-images')) || ' objects'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
