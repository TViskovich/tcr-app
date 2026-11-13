/// <reference types="node" />
// In-flight purge authorization (Phase 2B M4 step 5D.1,
// 20261130120000_inflight_purge_authorization.sql) — real races between a
// live purge claim and an administrator losing standing (suspension, removal,
// account deletion, privilege revocation), through the REAL Storage API
// single-object route, the Edge Function and concurrent database sessions.
//
// DESTRUCTIVE on synthetic fixtures only; REFUSES to run anywhere but an
// isolated disposable local stack, served with CACHECASE_TEST_RP_FAULTS=1:
//   CACHECASE_STACK_WORKDIR=<isolated workdir> node scripts/integration/retention-purge-inflight.ts
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from './local-stack.ts';
import { removeQuarantineFixtures } from './quarantine-fixture-cleanup.ts';

const stack = requireIsolatedStack();
const st = stack.st;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'retention-purge-inflight-it';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psqlArgs = (sql: string) => ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql];
const psql = (sql: string) => execFileSync('docker', psqlArgs(sql), { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A database session held open in the background (e.g. BEGIN; …; pg_sleep; COMMIT).
function held(sql: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('docker', psqlArgs(sql));
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);

type U = { id: string; db: SupabaseClient; token: string };
type R = { data: any; error: { message?: string } | null };
async function createUser(key: string): Promise<U> {
  const username = `rpi${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Rpi-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE } });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, db, token: s.session!.access_token };
}
const rpc = (u: U, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
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
const suspendSql = (who: U, by: U) => `INSERT INTO public.account_suspensions (user_id, reason_code, created_by) VALUES (${lit(who.id)}, 'terms_violation', ${lit(by.id)})`;

const qPaths: string[] = [];
async function copy(owner: string): Promise<{ id: string; path: string; src: string }> {
  const id = randomUUID();
  const path = `q/${randomUUID()}/original`;
  const src = `${owner}/rpi-${id}.jpg`;
  const bytes = new Uint8Array([4, 5, 6]);
  qPaths.push(path);
  const up = await service.storage.from('moderation-quarantine').upload(path, bytes, { contentType: 'image/jpeg' });
  if (up.error) throw new Error(`upload copy: ${up.error.message}`);
  const us = await service.storage.from('avatars').upload(src, bytes, { contentType: 'image/jpeg' });
  if (us.error) throw new Error(`upload source: ${us.error.message}`);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id, size_bytes,
                                          source_sha256, quarantine_sha256, quarantine_path, state, desired, child_safety, legal_hold,
                                          retain_until, source_removed_at)
    VALUES (${lit(id)}, 'avatars', ${lit(src)}, ${lit(owner)}, 'avatar', 'profile', ${lit(owner)}, 3, repeat('a', 64), repeat('a', 64),
            ${lit(path)}, 'restored', 'restore', false, false, now() - interval '5 days', now() - interval '100 days');
    COMMIT;`);
  return { id, path, src };
}
const present = (path: string) => psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = ${lit(path)}`) === '1';
const claimState = (subject: string) => psql(`SELECT COALESCE(close_reason, CASE WHEN lease_expires_at > clock_timestamp() THEN 'live' ELSE 'lease_over' END)
  FROM private.retention_purge_claims WHERE subject_id = ${lit(subject)} ORDER BY claimed_at DESC LIMIT 1`);
const itemState = (subject: string) => psql(`SELECT state FROM private.retention_purge_items WHERE subject_id = ${lit(subject)} ORDER BY updated_at DESC LIMIT 1`);
const tombstones = (subject: string) => Number(psql(`SELECT count(*) FROM private.retention_purge_tombstones WHERE subject_id = ${lit(subject)}`));
const itemOf = (subject: string) => psql(`SELECT id FROM private.retention_purge_items WHERE subject_id = ${lit(subject)} ORDER BY updated_at DESC LIMIT 1`);
async function ready(prep: U, appr: U, exec: U | null, copies: { id: string }[]): Promise<string> {
  const p = await rpc(prep, 'admin_retention_prepare_run', { p_category: 'quarantine_copy', p_subject_ids: copies.map((c) => c.id) });
  if (p.error) throw new Error(`prepare: ${p.error.message}`);
  const a = await rpc(appr, 'admin_retention_approve_run', { p_run_id: p.data.id, p_set_digest: p.data.set_digest, p_item_count: p.data.item_count });
  if (a.error) throw new Error(`approve: ${a.error.message}`);
  if (!exec) return p.data.id;
  const c = await rpc(exec, 'admin_retention_claim_copy', { p_run_id: p.data.id, p_item_id: itemOf(copies[0].id) });
  if (c.data?.outcome !== 'claimed') throw new Error(`claim: ${JSON.stringify(c)}`);
  return p.data.id;
}
// The Storage single-object route, called directly with the service key.
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
  const jobPaths = psql(`SELECT coalesce(string_agg(quarantine_path, ','), '') FROM private.media_quarantine WHERE source_path LIKE '%/rpi-%'`).split(',').filter(Boolean);
  const all = [...new Set([...jobPaths, ...qPaths])];
  if (all.length) removeQuarantineFixtures(all);   // rows (if any) and blobs
  const srcs = psql(`SELECT coalesce(string_agg(name, ','), '') FROM storage.objects WHERE bucket_id = 'avatars' AND name LIKE '%/rpi-%'`).split(',').filter(Boolean);
  if (srcs.length) await service.storage.from('avatars').remove(srcs);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fq ON COMMIT DROP AS SELECT id FROM private.media_quarantine WHERE source_path LIKE '%/rpi-%';
        CREATE TEMP TABLE fr ON COMMIT DROP AS SELECT DISTINCT run_id AS id FROM private.retention_purge_items WHERE subject_id IN (SELECT id FROM fq);
        DELETE FROM private.retention_purge_erasure_records WHERE run_id IN (SELECT id FROM fr);
        DELETE FROM private.retention_purge_events WHERE run_id IN (SELECT id FROM fr);
        DELETE FROM private.retention_purge_tombstones WHERE run_id IN (SELECT id FROM fr);
        DELETE FROM private.retention_purge_items WHERE run_id IN (SELECT id FROM fr);
        DELETE FROM private.retention_purge_runs WHERE id IN (SELECT id FROM fr) OR prepared_by::text IN (${idList});
        DELETE FROM private.retention_purge_claims WHERE subject_id IN (SELECT id FROM fq);
        DELETE FROM private.moderation_legal_holds WHERE subject_id IN (SELECT id FROM fq) OR placed_by::text IN (${idList});
        DELETE FROM public.moderation_actions WHERE admin_id::text IN (${idList});
        DELETE FROM private.media_quarantine WHERE id IN (SELECT id FROM fq);
        DELETE FROM public.account_suspensions WHERE user_id::text IN (${idList});
        DELETE FROM public.account_lifecycle WHERE user_id::text IN (${idList});
        DELETE FROM private.admin_privilege_events WHERE user_id::text IN (${idList}) OR actor_id::text IN (${idList});
        DELETE FROM private.admin_privileges WHERE user_id::text IN (${idList}) OR granted_by::text IN (${idList});
        DELETE FROM public.admin_users WHERE user_id::text IN (${idList});
        COMMIT;`);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

async function main() {
  // P1, P2, P3 preparers; A1..A6 approvers (executors are approvers too); C owner.
  const U = await Promise.all(['p1', 'p2', 'p3', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'c'].map(createUser));
  const [P1, P2, P3, A1, A2, A3, A4, A5, A6, C] = U;
  psql(`INSERT INTO public.admin_users (user_id) VALUES ${U.slice(0, 9).map((a) => `(${lit(a.id)})`).join(',')}`);
  for (const p of [P1, P2, P3]) grant(p, 'preparer', A1);
  for (const a of [A1, A2, A3, A4, A5, A6]) grant(a, 'approver', a === P1 ? P2 : P1);
  const copies = await Promise.all(Array.from({ length: 12 }, () => copy(C.id)));
  const [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12] = copies;

  step('1. Losing standing immediately before the Storage delete');
  await ready(P1, A2, A1, [c1]);
  psql(suspendSql(A2, P1));
  const s1 = await storageDelete(c1.path);
  check('approver suspended → claim withdrawn, the real single-object DELETE refused, object kept',
    claimState(c1.id) === 'withdrawn' && s1 >= 400 && present(c1.path), { s1, claim: claimState(c1.id) });
  await ready(P2, A3, A1, [c2]);
  psql(`DELETE FROM public.admin_users WHERE user_id = ${lit(P2.id)}`);
  const s2 = await storageDelete(c2.path);
  check('preparer removed from admin_users → refused, object kept', claimState(c2.id) === 'withdrawn' && s2 >= 400 && present(c2.path), { s2 });
  await ready(P3, A3, A1, [c3]);
  psql(`INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for) VALUES (${lit(P3.id)}, 'pending_deletion', 'scheduled', now() + interval '30 days')`);
  const s3 = await storageDelete(c3.path);
  check('preparer begins account deletion while the claim is live → refused, object kept', claimState(c3.id) === 'withdrawn' && s3 >= 400 && present(c3.path), { s3 });

  step('2. Suspension racing an in-flight Storage delete');
  // (a) the delete takes its locks first and holds its transaction ~3 s;
  //     the suspension must wait for it, and the delete stands.
  await ready(P1, A3, A1, [c4]);
  const del = held(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL storage.allow_delete_query = 'true';
    DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = ${lit(c4.path)}; SELECT pg_sleep(3); COMMIT;`);
  await sleep(700);
  const t0 = Date.now();
  psql(suspendSql(A3, P1));
  const waitedA = Date.now() - t0;
  const delOut = await del;
  check('delete first: the suspension waited for the in-flight delete', waitedA > 1500 && delOut.code === 0, { waitedA, out: delOut.out.slice(-200) });
  check('…the delete committed under its claim (consumed); nothing to withdraw afterwards', !present(c4.path) && claimState(c4.id) === 'consumed');
  const rec4 = await rpc(A4, 'admin_retention_reconcile_run', { p_run_id: psql(`SELECT run_id FROM private.retention_purge_items WHERE subject_id = ${lit(c4.id)}`) });
  check('…and another approver settles it as purged (metadata_removed)', !rec4.error && itemState(c4.id) === 'completed' && tombstones(c4.id) === 1
    && psql(`SELECT classification FROM private.retention_purge_erasure_records WHERE item_id = ${lit(itemOf(c4.id))} ORDER BY id DESC LIMIT 1`) === 'metadata_removed', rec4.error);
  // (b) the suspension takes its locks first and holds ~3 s; the real Storage
  //     delete must wait, then see the suspension and be refused.
  await ready(P1, A4, A1, [c5]);
  const sus = held(`BEGIN; ${suspendSql(A4, P1)}; SELECT pg_sleep(3); COMMIT;`);
  await sleep(700);
  const t1 = Date.now();
  const s5 = await storageDelete(c5.path);
  const waitedB = Date.now() - t1;
  await sus;
  check('suspension first: the Storage delete waited, then was refused; object kept', waitedB > 1500 && s5 >= 400 && present(c5.path)
    && claimState(c5.id) === 'withdrawn', { waitedB, s5, claim: claimState(c5.id) });

  step('3. Revocation racing claim consumption');
  await ready(P1, A5, A1, [c6]);
  const rev = held(`BEGIN; SELECT private.revoke_admin_privilege(${lit(A5.id)}, 'retention_purge_approver', ${lit(P1.id)}, 'race test'); SELECT pg_sleep(3); COMMIT;`);
  await sleep(700);
  const t2 = Date.now();
  const s6 = await storageDelete(c6.path);
  const waitedC = Date.now() - t2;
  await rev;
  check('revocation first: the delete waited, then was refused; object kept', waitedC > 1500 && s6 >= 400 && present(c6.path), { waitedC, s6 });
  grant(A5, 'approver', P1);
  await ready(P1, A5, A1, [c7]);
  const del7 = held(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL storage.allow_delete_query = 'true';
    DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = ${lit(c7.path)}; SELECT pg_sleep(3); COMMIT;`);
  await sleep(700);
  const t3 = Date.now();
  psql(`SELECT private.revoke_admin_privilege(${lit(A5.id)}, 'retention_purge_approver', ${lit(P1.id)}, 'race test')`);
  const waitedD = Date.now() - t3;
  await del7;
  check('consumption first: the revocation waited; the delete stands and its claim stays consumed',
    waitedD > 1500 && !present(c7.path) && claimState(c7.id) === 'consumed', { waitedD, claim: claimState(c7.id) });

  step('4. Storage already deleted, then the executor loses standing');
  const run8 = await ready(P1, A6, null, [c8, c9]);
  const crash = await purgeFn(A1, { run_id: run8, limit: 1 }, 'crash_after_delete');
  check('A1\'s delete of one copy reached Storage, then A1 "crashed" before confirming', crash.json?.status === 'interrupted'
    && [c8, c9].filter((x) => !present(x.path)).length === 1, crash.json);
  const gone = [c8, c9].find((x) => !present(x.path))!;
  const kept = [c8, c9].find((x) => present(x.path))!;
  check('…its item is in flight with the claim consumed', itemState(gone.id) === 'deleting' && claimState(gone.id) === 'consumed');
  psql(suspendSql(A1, P1));
  const blocked = await purgeFn(A1, { run_id: run8 });
  check('the suspended executor can no longer act (refused: 401/403/409)', [401, 403, 409].includes(blocked.status), blocked);
  check('…and nothing was settled or lost in the meantime', itemState(gone.id) === 'deleting' && present(kept.path));
  const settle = await purgeFn(A6, { run_id: run8, limit: 10 });
  check('a valid approver (not the preparer) settles the performed delete and finishes the run', settle.status === 200
    && itemState(gone.id) === 'completed' && itemState(kept.id) === 'completed' && !present(kept.path), settle.json);
  check('…each copy purged exactly once; the settled one classified metadata_removed (API outcome unknown)',
    tombstones(gone.id) === 1 && tombstones(kept.id) === 1
    && psql(`SELECT classification || ':' || api_outcome FROM private.retention_purge_erasure_records WHERE item_id = ${lit(itemOf(gone.id))} ORDER BY id DESC LIMIT 1`) === 'metadata_removed:unknown'
    && psql(`SELECT executed_by FROM private.retention_purge_tombstones WHERE subject_id = ${lit(gone.id)}`) === A6.id);

  step('5. No re-authorisation around the two-person approval');
  grant(A5, 'approver', P1);
  const run10 = await ready(P1, A5, null, [c10]);
  psql(suspendSql(A5, P1));
  const carry = await purgeFn(A6, { run_id: run10 });
  check('the run\'s approver loses standing: another valid approver cannot carry the run on', carry.status === 409
    && /run_admins_inactive|run_admins_not_authorized/.test(carry.json?.reason ?? '') && present(c10.path), carry.json);
  check('…the run can be cancelled', !(await rpc(P1, 'admin_retention_cancel_run', { p_run_id: run10 })).error);
  const run10b = await ready(P1, A6, null, [c10]);
  const fresh = await purgeFn(A6, { run_id: run10b });
  check('…and only a fresh run, approved by a valid second admin, deletes the copy', fresh.status === 200 && !present(c10.path) && tombstones(c10.id) === 1, fresh.json);

  step('6. Unrelated objects, holds, retry safety');
  check('the refused copies (1, 2, 3, 5, 6) and the untouched ones are all still present',
    [c1, c2, c3, c5, c6, c11, c12].every((x) => present(x.path)));
  check('no live claim names an administrator who lost standing',
    psql(`SELECT count(*) FROM private.retention_purge_claims c WHERE c.closed_at IS NULL AND c.lease_expires_at > clock_timestamp()
           AND (NOT private.has_purge_privilege(c.prepared_by, 'retention_purge_preparer') OR NOT private.has_purge_privilege(c.approved_by, 'retention_purge_approver'))`) === '0');
  check('source files untouched', copies.every((x) => psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'avatars' AND name = ${lit(x.src)}`) === '1'));
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
    || (SELECT count(*) FROM private.admin_privileges) || ' privileges, ' || (SELECT count(*) FROM public.account_suspensions) || ' suspensions, '
    || (SELECT count(*) FROM storage.objects WHERE bucket_id IN ('moderation-quarantine', 'avatars')) || ' objects'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
