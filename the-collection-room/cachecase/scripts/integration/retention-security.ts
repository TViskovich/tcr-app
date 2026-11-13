/// <reference types="node" />
// Retention security hardening (Phase 2B M4 step 4A,
// 20261124120000_retention_security_hardening.sql) — end-to-end against the
// LOCAL stack: direct service-role bypass attempts through PostgREST and the
// real Storage API, forged / expired / reused / mis-scoped purge claims,
// concurrent legal-hold placement against claims and deletions, and the G6
// deleted-owner rule with a real account deletion.
//
// No purge executor exists. Claims are inserted here the way the future
// approved executor would (a superuser psql session, two fixture admins),
// only for this script's own synthetic fixtures. Cleanup uses the same
// operator path (session_replication_role = replica) plus the shared
// quarantine fixture cleanup.
//
// Run:  node scripts/integration/retention-security.ts
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { localStack } from './local-stack.ts';
import { removeQuarantineFixtures } from './quarantine-fixture-cleanup.ts';

// Exercises claimed deletions of its own synthetic fixtures: run it on an
// isolated stack (CACHECASE_STACK_WORKDIR) unless explicitly told otherwise.
const stack = localStack();
const st = stack.st;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'retention-security-it';
const MARK = 'rsec-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psqlArgs = (sql: string) => ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql];
const psql = (sql: string) => execFileSync('docker', psqlArgs(sql), { encoding: 'utf8' }).trim();
const psqlAsync = async (sql: string) => {
  try { return { ok: true, out: (await promisify(execFile)('docker', psqlArgs(sql), { encoding: 'utf8' })).stdout.trim() }; }
  catch (e) { return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) }; }
};
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);

type U = { id: string; db: SupabaseClient };
type R = { data: any; error: { message?: string } | null };
async function createUser(key: string): Promise<U> {
  const username = `rs${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Rs-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, db };
}
const rpc = (u: U, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const errMsg = (r: { error: { message?: string } | null }) => r.error?.message ?? null;

let A1: U, A2: U;
const qPaths: string[] = [];
function report(owner: string, due = true): string {
  const id = randomUUID();
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.content_reports (id, target_type, target_id, target_owner_id, reason, details, evidence, status, created_at,
                                        reviewed_at, evidence_purge_after, resolution, resolution_reason)
    VALUES (${lit(id)}, 'post', gen_random_uuid(), ${lit(owner)}, 'spam', ${lit(`${MARK} ${run}`)}, '{"text":"rsec"}', 'dismissed',
            now() - interval '120 days', now() - interval '100 days', now() ${due ? '-' : '+'} interval '10 days', 'no_violation', 'within_guidelines');
    COMMIT;`);
  return id;
}
async function copy(owner: string, opts: { childSafety?: boolean } = {}): Promise<{ id: string; path: string }> {
  const id = randomUUID();
  const path = `q/${randomUUID()}/original`;
  qPaths.push(path);
  const up = await service.storage.from('moderation-quarantine').upload(path, new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const cs = opts.childSafety ? 'true' : 'false';
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id,
                                          source_sha256, quarantine_sha256, quarantine_path, state, desired, child_safety, legal_hold,
                                          retain_until, source_removed_at)
    VALUES (${lit(id)}, 'avatars', ${lit(`${owner}/rsec-${id}.jpg`)}, ${lit(owner)}, 'avatar', 'profile', ${lit(owner)},
            repeat('a', 64), repeat('a', 64), ${lit(path)}, 'restored', 'restore', ${cs}, ${cs},
            ${opts.childSafety ? 'NULL' : "now() - interval '5 days'"}, now() - interval '100 days');
    COMMIT;`);
  return { id, path };
}
const claimSql = (kind: string, id: string, path?: string) =>
  `INSERT INTO private.retention_purge_claims (subject_kind, subject_id, object_bucket, object_path, prepared_by, approved_by, lease_expires_at)
   VALUES (${lit(kind)}, ${lit(id)}, ${path ? "'moderation-quarantine'" : 'NULL'}, ${path ? lit(path) : 'NULL'},
           ${lit(A1.id)}, ${lit(A2.id)}, clock_timestamp() + interval '2 minutes')`;
const claim = async (kind: string, id: string, path?: string) => psqlAsync(claimSql(kind, id, path));
const present = (path: string) => psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = ${lit(path)}`) === '1';
const remove = (...paths: string[]) => service.storage.from('moderation-quarantine').remove(paths);
const removedOk = (r: { data: unknown[] | null; error: unknown }) => !r.error && (r.data?.length ?? 0) > 0;
const candidate = (id: string) =>
  psql(`SELECT status || ':' || array_to_string(blockers, '+') FROM private.retention_candidates() WHERE record_id = ${lit(id)}`);
const evidencePresent = (id: string) => psql(`SELECT evidence IS NOT NULL FROM public.content_reports WHERE id = ${lit(id)}`) === 't';

async function sweep(): Promise<number> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const idList = ids.length ? ids.map(lit).join(',') : "''";
  const jobPaths = psql(`SELECT coalesce(string_agg(quarantine_path, ','), '') FROM private.media_quarantine WHERE source_path LIKE '%/rsec-%'`)
    .split(',').filter(Boolean);
  removeQuarantineFixtures([...new Set([...jobPaths, ...qPaths])]);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fx ON COMMIT DROP AS SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%';
        CREATE TEMP TABLE fq ON COMMIT DROP AS SELECT id FROM private.media_quarantine WHERE source_path LIKE '%/rsec-%';
        DELETE FROM private.retention_purge_claims WHERE subject_id IN (SELECT id FROM fx UNION ALL SELECT id FROM fq)
          OR prepared_by::text IN (${idList}) OR approved_by::text IN (${idList});
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
  const users = await Promise.all(['a1', 'a2', 'a3', 'c', 'd'].map(createUser));
  [A1, A2] = users;
  const [, , A3, C, D] = users;
  psql(`INSERT INTO public.admin_users (user_id) VALUES ${[A1, A2, A3].map((a) => `(${lit(a.id)})`).join(',')}`);
  const hold = (u: U, kind: string, id: string) => rpc(u, 'admin_place_legal_hold', {
    p_subject_kind: kind, p_subject_id: id, p_basis_code: 'litigation', p_basis_note: `${MARK} hold`, p_expires_at: days(30) });

  step('1. Direct service-role attempts on reports (G1, G2)');
  const r0 = report(C.id);
  const u0 = await service.from('content_reports').update({ evidence: null }).eq('id', r0).select('id');
  check('the service role cannot clear due evidence through the API', !!u0.error && evidencePresent(r0), errMsg(u0));
  const d0 = await service.from('content_reports').delete().eq('id', r0).select('id');
  check('the service role cannot delete a report through the API', !!d0.error && psql(`SELECT count(*) FROM public.content_reports WHERE id = ${lit(r0)}`) === '1', errMsg(d0));
  const f0 = await service.schema('private' as never).from('retention_purge_claims').insert({ subject_kind: 'report_evidence', subject_id: r0 });
  check('the service role cannot forge a purge claim', !!f0.error);
  const a0 = await A1.db.from('content_reports').update({ evidence: null }).eq('id', r0).select('id');
  check('an admin session cannot clear evidence directly', !!a0.error || (a0.data?.length ?? 0) === 0);
  check('evidence is intact after every attempt', evidencePresent(r0));

  step('2. Quarantine copies through the real Storage API (G3)');
  const q1 = await copy(C.id);
  const q2 = await copy(C.id);
  const q3 = await copy(C.id);
  const qcs = await copy(C.id, { childSafety: true });
  const qd = await copy(D.id);
  const n0 = await remove(q1.path);
  check('no claim: the service role cannot delete a quarantine copy', !removedOk(n0) && present(q1.path), n0);
  const ncs = await remove(qcs.path);
  check('child-safety copy: delete refused', !removedOk(ncs) && present(qcs.path), ncs);
  check('child-safety copy: no claim can be created', !(await claim('quarantine_copy', qcs.id, qcs.path)).ok);
  check('another collector\'s copy: delete refused', !removedOk(await remove(qd.path)) && present(qd.path));
  check('a claim must name the job\'s own object', !(await claim('quarantine_copy', q1.id, q2.path)).ok);
  check('claim on copy 1 (two admins)', (await claim('quarantine_copy', q1.id, q1.path)).ok);
  const mixed = await remove(q1.path, q2.path);
  check('a delete mixing the claimed copy with an unclaimed one fails as a whole', !removedOk(mixed) && present(q1.path) && present(q2.path), mixed);
  check('the claim does not unlock a different copy', !removedOk(await remove(q2.path)) && present(q2.path));
  const ok1 = await remove(q1.path);
  check('with the claim, exactly that copy is deleted', removedOk(ok1) && !present(q1.path) && present(q2.path) && present(q3.path), ok1);
  check('the claim is consumed', psql(`SELECT close_reason FROM private.retention_purge_claims WHERE subject_id = ${lit(q1.id)}`) === 'consumed');
  await service.storage.from('moderation-quarantine').upload(q1.path, new Uint8Array([9]), { contentType: 'image/jpeg' });
  check('a consumed claim cannot be reused', !removedOk(await remove(q1.path)) && present(q1.path));
  check('claim on copy 3', (await claim('quarantine_copy', q3.id, q3.path)).ok);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE private.retention_purge_claims SET claimed_at = clock_timestamp() - interval '10 minutes', lease_expires_at = clock_timestamp() - interval '6 minutes'
         WHERE subject_id = ${lit(q3.id)} AND closed_at IS NULL; COMMIT;`);
  check('an expired claim cannot authorise a delete', !removedOk(await remove(q3.path)) && present(q3.path));
  const mv = await service.storage.from('moderation-quarantine').move(q2.path, `q/${randomUUID()}/original`);
  check('a verified copy cannot be moved', !!mv.error && present(q2.path), errMsg(mv));
  const ow = await service.storage.from('moderation-quarantine').upload(q2.path, new Uint8Array([7]), { upsert: true, contentType: 'image/jpeg' });
  check('a verified copy cannot be overwritten', !!ow.error, errMsg(ow));
  const dl = await service.storage.from('moderation-quarantine').download(q2.path);
  check('the service role can still read a copy (workers, restore)', !dl.error && !!dl.data, errMsg(dl));

  step('3. Legal holds racing claims and deletions');
  // a) Report: the claim's transaction holds the hold lock; a hold placed
  //    meanwhile waits, then finds the evidence gone.
  const r1 = report(C.id);
  const tx = psqlAsync(`BEGIN; ${claimSql('report_evidence', r1)}; SELECT pg_sleep(3);
                        UPDATE public.content_reports SET evidence = NULL WHERE id = ${lit(r1)}; COMMIT;`);
  await sleep(1000);
  const t0 = Date.now();
  const h1 = await hold(A3, 'report', r1);
  const waited = Date.now() - t0;
  const txr = await tx;
  check('purge-in-progress vs hold: the hold waits for the purge transaction', waited >= 1200, waited);
  check('…the purge commits and the late hold finds nothing to preserve',
    txr.ok && !evidencePresent(r1) && errMsg(h1) === 'evidence_unavailable', { tx: txr.out.slice(0, 200), h: errMsg(h1) });
  // b) Hold first: the claim is refused.
  const r2 = report(C.id);
  check('hold first', !(await hold(A3, 'report', r2)).error);
  const c2 = await claim('report_evidence', r2);
  check('…then a claim is refused and evidence stays', !c2.ok && /claim_subject_not_eligible/.test(c2.out) && evidencePresent(r2));
  // c) Claim committed, hold placed before the purge transaction runs.
  const r3 = report(C.id);
  const late = await psqlAsync(`BEGIN; ${claimSql('report_evidence', r3)}; COMMIT;`);
  check('claim committed in its own transaction', late.ok);
  const u3 = await psqlAsync(`UPDATE public.content_reports SET evidence = NULL WHERE id = ${lit(r3)}`);
  check('a claim from another transaction cannot be used', !u3.ok && /evidence_purge_claim_required/.test(u3.out) && evidencePresent(r3));
  // d) Storage: hold vs delete under a live claim, 5 rounds — never both.
  let raceOk = true;
  for (let i = 0; i < 5; i++) {
    const q = await copy(C.id);
    if (!(await claim('quarantine_copy', q.id, q.path)).ok) { raceOk = false; continue; }
    const [h, rm] = await Promise.all([hold(A3, 'quarantine_copy', q.id), remove(q.path)]);
    const held = !h.error;
    const gone = !present(q.path);
    const consistent = (held && !gone && !removedOk(rm)) || (!held && gone && removedOk(rm));
    if (!consistent) { raceOk = false; console.log('   ', i, errMsg(h), rm.error, held, gone); }
  }
  check('5 rounds of hold vs delete: exactly one wins; a held copy is never deleted', raceOk);
  // e) Discovery while holds are placed concurrently.
  const rs = [report(C.id), report(C.id), report(C.id), report(C.id)];
  await Promise.all([...rs.map((r) => hold(A3, 'report', r)), ...rs.map(() => psqlAsync('SELECT count(*) FROM private.retention_candidates()'))]);
  check('after concurrent holds, every held report is blocked', rs.every((r) => candidate(r) === 'blocked:legal_hold'), rs.map(candidate));

  step('4. G6: an account hold on a deleted account');
  const rd = report(D.id);
  const rc = report(C.id);
  const hd = await hold(A1, 'account', D.id);
  check('account hold on D', !hd.error, errMsg(hd));
  const del = await service.auth.admin.deleteUser(D.id);
  check('D\'s account is deleted (report owner id becomes NULL)', !del.error
    && psql(`SELECT target_owner_id IS NULL FROM public.content_reports WHERE id = ${lit(rd)}`) === 't');
  check('D\'s report: blocked, the hold can no longer be matched (fail closed)', candidate(rd) === 'blocked:deleted_owner_hold_ambiguous', candidate(rd));
  check('…and cannot be claimed', !(await claim('report_evidence', rd)).ok);
  check('an unrelated report with a known, unheld owner stays eligible', candidate(rc) === 'eligible:', candidate(rc));
  check('D\'s quarantine copy keeps its owner id, so the account hold still applies precisely',
    psql(`SELECT 'legal_hold' = ANY (private.quarantine_copy_purge_blockers(${lit(qd.id)}))`) === 't');
  const rel = await rpc(A2, 'admin_release_legal_hold', { p_hold_id: hd.data.id, p_reason_code: 'no_longer_required', p_note: 'done' });
  check('once the orphaned hold is released by another admin, D\'s report is eligible again', !rel.error && candidate(rd) === 'eligible:', candidate(rd));

  step('5. Nothing purged except the one authorised copy and the one authorised report');
  check('report evidence cleared only where claimed (r1)', psql(`SELECT count(*) FROM public.content_reports WHERE details LIKE '${MARK}%' AND evidence IS NULL`) === '1');
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
    || (SELECT count(*) FROM private.moderation_legal_holds) || ' holds, ' || (SELECT count(*) FROM private.retention_purge_claims) || ' claims, '
    || (SELECT count(*) FROM private.media_quarantine) || ' jobs, '
    || (SELECT count(*) FROM storage.objects WHERE bucket_id = 'moderation-quarantine') || ' quarantine objects'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
