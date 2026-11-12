/// <reference types="node" />
// Moderation retention foundation (Phase 2B M4 steps 1–3,
// 20261123120000_moderation_retention_foundation.sql) — end-to-end against
// the LOCAL Supabase stack through PostgREST: API exposure, concurrent admins
// on legal holds (placement, release, renewal, child-safety approval), expired
// holds, and read-only purge candidate discovery. Disposable accounts only.
//
// Cleanup: holds, reports and audit rows are append-only for every API role,
// so this script removes ITS OWN fixture rows through a local superuser psql
// session (session_replication_role = replica), scoped to its accounts and
// marker. Nothing here purges, and no executor exists to call.
//
// Run:  node scripts/integration/moderation-retention.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'moderation-retention-it';
const MARK = 'rt-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);

type U = { id: string; db: SupabaseClient };
type R = { data: any; error: { message?: string; code?: string } | null };
async function createUser(key: string): Promise<U> {
  const username = `rt${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Rt-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, db };
}
const rpc = (u: U | SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  ('db' in u ? u.db : u).rpc(fn, args) as unknown as Promise<R>;
const errMsg = (r: R) => r.error?.message ?? null;
const oks = (rs: R[]) => rs.filter((r) => !r.error).length;

// A resolved report about `owner`, due for purge (evidence_purge_after in the past).
function report(owner: string, opts: { status?: string; purgeDaysAgo?: number; reason?: string } = {}): string {
  const id = randomUUID();
  const status = opts.status ?? 'dismissed';
  const resolved = status === 'dismissed';
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.content_reports (id, target_type, target_id, target_owner_id, reason, details, evidence, status, created_at,
                                        reviewed_at, evidence_purge_after, resolution, resolution_reason)
    VALUES (${lit(id)}, 'post', gen_random_uuid(), ${lit(owner)}, ${lit(opts.reason ?? 'spam')}, ${lit(`${MARK} ${run}`)}, '{"text":"rt"}',
            ${lit(status)}, now() - interval '120 days',
            ${resolved ? "now() - interval '100 days'" : 'NULL'},
            ${resolved ? `now() - interval '${opts.purgeDaysAgo ?? 10} days'` : 'NULL'},
            ${resolved ? "'no_violation'" : 'NULL'}, ${resolved ? "'within_guidelines'" : 'NULL'});
    COMMIT;`);
  return id;
}
const openHolds = (subject: string) =>
  Number(psql(`SELECT count(*) FROM private.moderation_legal_holds WHERE subject_id = ${lit(subject)} AND released_at IS NULL`));
const candidate = (id: string) =>
  psql(`SELECT status || ':' || array_to_string(blockers, '+') FROM private.retention_candidates() WHERE record_id = ${lit(id)}`);

async function sweep(): Promise<number> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const idList = ids.length ? ids.map(lit).join(',') : "''";
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fx ON COMMIT DROP AS SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%';
        DELETE FROM private.moderation_legal_holds WHERE subject_id IN (SELECT id FROM fx) OR subject_owner_id::text IN (${idList})
          OR placed_by::text IN (${idList});
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM fx) OR admin_id::text IN (${idList});
        DELETE FROM public.content_reports WHERE id IN (SELECT id FROM fx);
        DELETE FROM public.account_lifecycle WHERE user_id::text IN (${idList});
        DELETE FROM public.admin_users WHERE user_id::text IN (${idList});
        COMMIT;`);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

async function main() {
  const [A1, A2, A3, A4, A5, C, X] = await Promise.all(['a1', 'a2', 'a3', 'a4', 'a5', 'c', 'x'].map(createUser));
  psql(`INSERT INTO public.admin_users (user_id) VALUES ${[A1, A2, A3, A4, A5].map((a) => `(${lit(a.id)})`).join(',')}`);

  step('1. API exposure');
  const r0 = report(C.id);
  check('signed out: refused', !!(await rpc(anon, 'admin_retention_summary')).error);
  check('a collector is refused (forbidden)', errMsg(await rpc(X, 'admin_place_legal_hold', {
    p_subject_kind: 'report', p_subject_id: r0, p_basis_code: 'litigation', p_basis_note: 'x', p_expires_at: days(30) })) === 'forbidden');
  check('the service role cannot place holds', !!(await rpc(service, 'admin_place_legal_hold', {
    p_subject_kind: 'report', p_subject_id: r0, p_basis_code: 'litigation', p_basis_note: 'x', p_expires_at: days(30) })).error);
  check('the service role cannot list candidates', !!(await rpc(service, 'admin_retention_candidates')).error);
  check('private tables are not reachable through the API', !!(await service.schema('private' as never).from('moderation_legal_holds').select('id')).error
    && !!(await A1.db.schema('private' as never).from('retention_policy').select('key')).error);
  psql(`INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for) VALUES (${lit(A5.id)}, 'pending_deletion', 'scheduled', now() + interval '14 days')`);
  check('an admin whose account is pending deletion is refused', errMsg(await rpc(A5, 'admin_retention_summary')) === 'account_inactive');

  step('2. Concurrent placement');
  let placeOk = true;
  for (let i = 0; i < 5; i++) {
    const r = report(C.id);
    const rs = await Promise.all([A1, A2, A3].map((a) => rpc(a, 'admin_place_legal_hold', {
      p_subject_kind: 'report', p_subject_id: r, p_basis_code: 'litigation', p_basis_note: `race ${i}`, p_expires_at: days(30) })));
    if (oks(rs) !== 1 || rs.filter((x) => errMsg(x) === 'already_held').length !== 2 || openHolds(r) !== 1) placeOk = false;
  }
  check('3 admins × 5 rounds, same subject and basis: exactly one hold each time, the others already_held', placeOk);
  const r1 = report(C.id);
  const bases = ['litigation', 'regulatory_inquiry', 'internal_investigation'];
  const diff = await Promise.all([A1, A2, A3].map((a, i) => rpc(a, 'admin_place_legal_hold', {
    p_subject_kind: 'report', p_subject_id: r1, p_basis_code: bases[i], p_basis_note: 'parallel', p_expires_at: days(30) })));
  check('different bases in parallel all succeed', oks(diff) === 3 && openHolds(r1) === 3, diff.map(errMsg));

  step('3. Concurrent release');
  const r2 = report(C.id);
  const h2 = (await rpc(A1, 'admin_place_legal_hold', { p_subject_kind: 'report', p_subject_id: r2, p_basis_code: 'litigation', p_basis_note: 'x', p_expires_at: days(30) })).data;
  const rel = await Promise.all([A2, A3, A4].map((a) => rpc(a, 'admin_release_legal_hold', { p_hold_id: h2.id, p_reason_code: 'no_longer_required', p_note: 'race' })));
  check('three admins release at once: exactly one succeeds, the rest hold_not_active',
    oks(rel) === 1 && rel.filter((x) => errMsg(x) === 'hold_not_active').length === 2, rel.map(errMsg));
  check('exactly one release audit row', psql(`SELECT count(*) FROM public.moderation_actions WHERE action = 'release_legal_hold' AND metadata->>'hold_id' = ${lit(h2.id)}`) === '1');

  step('4. Renewal racing release');
  let raceOk = true;
  for (let i = 0; i < 5; i++) {
    const r = report(C.id);
    const h = (await rpc(A1, 'admin_place_legal_hold', { p_subject_kind: 'report', p_subject_id: r, p_basis_code: 'litigation', p_basis_note: 'x', p_expires_at: days(30) })).data;
    const [ren, re] = await Promise.all([
      rpc(A1, 'admin_renew_legal_hold', { p_hold_id: h.id, p_expires_at: days(200), p_note: 'renew' }),
      rpc(A2, 'admin_release_legal_hold', { p_hold_id: h.id, p_reason_code: 'no_longer_required', p_note: 'release' })]);
    const open = openHolds(r);
    const consistent = (!ren.error && re.error && open === 1) || (ren.error && !re.error && open === 0);
    if (!consistent) { raceOk = false; console.log('   ', i, errMsg(ren), errMsg(re), open); }
  }
  check('renew vs release, 5 rounds: exactly one wins and the open-hold count matches the winner', raceOk);

  step('5. Child-safety release under concurrency');
  const r3 = report(C.id, { reason: 'child_safety' });
  const h3 = (await rpc(A1, 'admin_place_legal_hold', { p_subject_kind: 'report', p_subject_id: r3, p_basis_code: 'law_enforcement_request', p_basis_note: 'preserve' })).data;
  check('child-safety report → child-safety hold with no expiry', h3?.hold_type === 'child_safety' && h3?.expires_at === null, h3);
  const req = await Promise.all([A2, A3].map((a) => rpc(a, 'admin_request_legal_hold_release', { p_hold_id: h3.id, p_legal_review_ref: 'LR-IT-1', p_note: 'req' })));
  check('two simultaneous release requests: exactly one recorded', oks(req) === 1 && req.some((x) => errMsg(x) === 'release_already_requested'), req.map(errMsg));
  const requester = req[0].error ? A3 : A2;
  const approvers = [A2, A3, A4].filter((a) => a !== requester);
  const appr = await Promise.all([...approvers, requester, A1].map((a) => rpc(a, 'admin_approve_legal_hold_release', { p_hold_id: h3.id, p_note: 'ok', p_confirm_child_safety: true })));
  check('approvals racing: exactly one approver wins; requester and placer are always refused',
    oks(appr) === 1 && !!appr[2].error && !!appr[3].error && ['second_admin_required', 'hold_not_active'].includes(errMsg(appr[2])!), appr.map(errMsg));
  check('released child-safety evidence is still blocked from purge', candidate(r3).startsWith('blocked:child_safety'), candidate(r3));

  step('6. Expired holds');
  const r4 = report(C.id);
  const h4 = (await rpc(A1, 'admin_place_legal_hold', { p_subject_kind: 'report', p_subject_id: r4, p_basis_code: 'litigation', p_basis_note: 'x', p_expires_at: days(30) })).data;
  check('held report is blocked', candidate(r4) === 'blocked:legal_hold', candidate(r4));
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE private.moderation_legal_holds SET placed_at = now() - interval '40 days', expires_at = now() - interval '1 second' WHERE id = ${lit(h4.id)};
        COMMIT;`);
  check('once expired, it is eligible again without any job running', candidate(r4) === 'eligible:', candidate(r4));
  const ex = await Promise.all([A2, A3].map((a) => rpc(a, 'admin_place_legal_hold', {
    p_subject_kind: 'report', p_subject_id: r4, p_basis_code: 'litigation', p_basis_note: 're-hold', p_expires_at: days(30) })));
  check('two admins re-hold the expired subject at once: one succeeds', oks(ex) === 1 && openHolds(r4) === 1, ex.map(errMsg));
  check('the lapsed hold was closed as expired exactly once',
    psql(`SELECT release_reason FROM private.moderation_legal_holds WHERE id = ${lit(h4.id)}`) === 'expired');

  step('7. Read-only discovery');
  const before = psql(`SELECT (SELECT count(*) FROM public.content_reports WHERE evidence IS NOT NULL) || '/' || (SELECT count(*) FROM private.moderation_legal_holds)`);
  const reads = await Promise.all([
    rpc(A1, 'admin_retention_candidates', { p_category: 'report_evidence', p_limit: 200 }),
    rpc(A2, 'admin_retention_summary'), rpc(A3, 'admin_retention_candidates', { p_status: 'eligible', p_limit: 200 }),
    rpc(A4, 'admin_list_legal_holds', { p_state: 'all', p_limit: 100 })]);
  check('admins read candidates, summary and holds in parallel without error', reads.every((r) => !r.error), reads.map(errMsg));
  const mine = (reads[0].data as any[]).filter((c) => c.owner_id === C.id);
  check('candidates separate eligible from blocked for the fixture reports',
    mine.some((c) => c.status === 'eligible') && mine.some((c) => c.status === 'blocked' && c.blockers.includes('legal_hold')));
  check('no candidate or summary payload carries evidence text', !JSON.stringify(reads.slice(0, 3).map((r) => r.data)).includes('"text":"rt"'));
  check('summary reports policy conformance ok', reads[1].data?.policy_conformance?.ok === true, reads[1].data?.policy_conformance);
  check('nothing was purged by reading', psql(`SELECT (SELECT count(*) FROM public.content_reports WHERE evidence IS NOT NULL) || '/' || (SELECT count(*) FROM private.moderation_legal_holds)`) === before);
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
    || (SELECT count(*) FROM private.moderation_legal_holds) || ' holds, '
    || (SELECT count(*) FROM public.moderation_actions) || ' audit rows'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
