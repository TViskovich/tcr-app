/// <reference types="node" />
// Admin monitoring dashboard (Phase 2B M4 step 5C,
// 20261128120000_admin_monitoring_dashboard.sql, app/admin/monitoring*,
// lib/admin-monitoring.ts) — the dashboard's API exactly as the app calls it
// (PostgREST RPCs with a user session), on an ISOLATED disposable local stack
// with synthetic fixtures: two admins, a collector and an anonymous client.
//
// Nothing here changes a scheduler, sends an alert, approves or executes a
// purge. It refuses to run against the primary local stack.
// Run:  CACHECASE_STACK_WORKDIR=<workdir> node scripts/integration/admin-monitoring-dashboard.ts
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from './local-stack.ts';

const stack = requireIsolatedStack();
const st = stack.st;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'admin-monitoring-dashboard-it';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const SECRET_TEXT = `PRIVATE-REPORT-TEXT-${run}`;
const psql = (sql: string) =>
  execFileSync('docker', ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);

type U = { id: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const username = `dsh${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Dsh-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE } });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, db };
}

// The dashboard's read RPCs (lib/admin-monitoring.ts) with valid arguments.
const READS: [string, Record<string, unknown>][] = [
  ['admin_moderation_monitoring_overview', {}],
  ['admin_media_quarantine_overview', {}],
  ['admin_media_quarantine_scheduler_status', {}],
  ['admin_media_quarantine_scheduler_runs', { p_limit: 10, p_before: null }],
  ['admin_moderation_delivery_history', { p_limit: 10, p_before: null }],
  ['admin_retention_purge_dashboard', { p_status: null, p_limit: 10, p_before: null }],
  ['admin_moderation_issue_history', { p_status: 'all', p_limit: 10, p_before: null }],
];

let owner = '';
const jobIds: string[] = [];
function job(opts: { bucket?: string; cs?: boolean; ageMin: number; attention?: boolean; error?: string }) {
  const id = randomUUID();
  jobIds.push(id);
  const bucket = opts.bucket ?? 'item-images';
  psql(`INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id, quarantine_path,
          child_safety, legal_hold, state, needs_attention, last_error, attempts, created_at, source_sha256, quarantine_sha256)
        VALUES (${lit(id)}, ${lit(bucket)}, ${lit(`${owner}/dsh-${run}-${jobIds.length}.jpg`)}, ${lit(owner)}, ${lit(bucket === 'avatars' ? 'avatar' : 'item_image')},
                'profile', ${lit(owner)}, ${lit(`q/${id}/original`)}, ${!!opts.cs}, ${!!opts.cs}, ${opts.attention ? "'copied'" : "'pending'"}, ${!!opts.attention},
                ${opts.error ? lit(opts.error) : 'NULL'}, ${opts.attention ? 5 : 0}, now() - make_interval(mins => ${opts.ageMin}), repeat('c', 64), repeat('c', 64))`);
  return id;
}

async function cleanup(): Promise<number> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const users = ids.map(lit).join(',') || 'NULL';
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM private.media_quarantine WHERE owner_id IN (${users}));
        DELETE FROM private.media_quarantine WHERE owner_id IN (${users});
        DELETE FROM public.content_reports WHERE reporter_id IN (${users}) OR target_id IN (${users});
        DELETE FROM private.retention_purge_runs WHERE prepared_by IN (${users});
        DELETE FROM private.admin_privilege_events WHERE user_id IN (${users}); DELETE FROM private.admin_privileges WHERE user_id IN (${users});
        DELETE FROM private.moderation_monitoring_events; DELETE FROM private.moderation_monitoring_issues;
        DELETE FROM private.media_quarantine_scheduler_runs;
        COMMIT;`);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

async function main() {
  const A1 = await createUser('a1');
  const A2 = await createUser('a2');
  const C = await createUser('c');
  const O = await createUser('o');
  const R = await createUser('r');
  owner = O.id;
  const ins = await service.from('admin_users').insert([{ user_id: A1.id }, { user_id: A2.id }]);
  if (ins.error) throw new Error('admins');
  // 20261129120000: purge privileges (operator-granted, by a different admin).
  psql(`SELECT private.grant_admin_privilege(${lit(A1.id)}, 'retention_purge_preparer', ${lit(A2.id)}, 'integration fixture')`);
  psql(`SELECT private.grant_admin_privilege(${lit(A2.id)}, 'retention_purge_approver', ${lit(A1.id)}, 'integration fixture')`);

  step('1. Access');
  for (const [fn, args] of READS) {
    const a = await A1.db.rpc(fn, args);
    check(`admin: ${fn} → data`, !a.error && a.data !== null, a.error);
  }
  for (const [fn, args] of READS) {
    const c = await C.db.rpc(fn, args);
    check(`collector: ${fn} → refused`, !!c.error && c.data === null, c.status);
  }
  for (const [fn, args] of READS) {
    const n = await anon.rpc(fn, args);
    check(`anonymous: ${fn} → refused`, !!n.error && n.data === null, n.status);
  }
  const priv = await C.db.schema('private' as never).from('moderation_monitoring_issues').select('*');
  check('collector: the private monitoring tables are not reachable over the API', !!priv.error && !priv.data);
  const svc = await service.rpc('admin_moderation_monitoring_overview');
  check('the service role cannot call the admin dashboard RPCs (no service-role endpoint)', !!svc.error);

  step('2. Disabled states (nothing is assumed running)');
  const sched = await A1.db.rpc('admin_media_quarantine_scheduler_status');
  check('scheduler: switch off and sweep inactive are reported as such', sched.data?.enabled === false && sched.data?.sweep_active === false, sched.data);
  const ov0 = await A1.db.rpc('admin_moderation_monitoring_overview');
  check('monitoring: delivery disabled, monitor job inactive', ov0.data?.delivery_enabled === false && ov0.data?.monitor_active === false, ov0.data);
  check('no open issues with an empty queue', Array.isArray(ov0.data?.open) && ov0.data.open.length === 0);

  step('3. Issues appear on refresh; one per condition');
  const csJob = job({ cs: true, ageMin: 15 });
  job({ cs: true, ageMin: 12 });
  const flagged = job({ ageMin: 60, attention: true, error: 'hash_mismatch' });
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, reason, details, priority, status, created_at, updated_at)
        VALUES (gen_random_uuid(), ${lit(R.id)}, 'profile', ${lit(O.id)}, 'harassment', ${lit(SECRET_TEXT)}, 'urgent', 'open', now() - interval '3 hours', now()); COMMIT;`);
  const ov1 = await A1.db.rpc('admin_moderation_monitoring_overview');
  const open = (ov1.data?.open ?? []) as any[];
  check('refresh shows the new critical issues', open.some((i) => i.code === 'child_safety_unquarantined' && i.severity === 'critical' && i.count === 2)
    && open.some((i) => i.code === 'integrity_failure'), open.map((i) => `${i.code}:${i.count}`));
  check('critical issues come first', open[0]?.severity === 'critical');
  const ov2 = await A1.db.rpc('admin_moderation_monitoring_overview');
  check('refreshing again does not duplicate issues', (ov2.data?.open ?? []).filter((i: any) => i.code === 'child_safety_unquarantined').length === 1);
  const csIssue = open.find((i) => i.code === 'child_safety_unquarantined')?.id as string;

  step('4. Investigation');
  const d = await A1.db.rpc('admin_moderation_issue_detail', { p_issue_id: csIssue, p_offset: 0, p_limit: 25 });
  check('detail lists the affected jobs by internal reference', (d.data?.affected?.items ?? []).some((x: any) => x.ref_id === csJob && x.ref_kind === 'quarantine_job'), d.error);
  const urgent = open.find((i) => i.code === 'urgent_reports_overdue')?.id as string;
  const du = await A1.db.rpc('admin_moderation_issue_detail', { p_issue_id: urgent, p_offset: 0, p_limit: 25 });
  const everything = JSON.stringify([ov1.data, d.data, du.data]);
  check('no report text, reporter, owner, paths or hashes anywhere', ![SECRET_TEXT, R.id, O.id, `dsh-${run}`, 'cccccccc'].some((x) => everything.includes(x)));
  const dc = await C.db.rpc('admin_moderation_issue_detail', { p_issue_id: csIssue, p_offset: 0, p_limit: 25 });
  check('a collector cannot open the detail even with the issue id', !!dc.error && dc.data === null);

  step('5. Acknowledgement without resolution');
  const ackC = await C.db.rpc('admin_acknowledge_moderation_issue', { p_issue_id: csIssue });
  check('a collector cannot acknowledge', !!ackC.error);
  const ack = await A2.db.rpc('admin_acknowledge_moderation_issue', { p_issue_id: csIssue });
  check('an admin acknowledges', ack.data?.acknowledged === true && ack.data?.resolved === false, ack.error);
  const d2 = await A1.db.rpc('admin_moderation_issue_detail', { p_issue_id: csIssue, p_offset: 0, p_limit: 25 });
  check('…the issue is acknowledged, unresolved, still affecting 2 jobs',
    d2.data?.issue?.status === 'acknowledged' && d2.data?.issue?.resolved_at === null && d2.data?.affected?.total === 2, d2.data?.issue);

  step('6. Worker failures');
  psql(`INSERT INTO private.media_quarantine_scheduler_runs (trigger, status, started_at, finished_at, jobs, outcomes, error_code, duration_ms)
        VALUES ('sweep', 'failed', now() - interval '1 minute', now(), 1, '{"interrupted": 1}', 'worker_error', 300)`);
  psql(`INSERT INTO private.media_quarantine_scheduler_runs (trigger, status, started_at) VALUES ('kick', 'running', now() - interval '10 minutes')`);
  const runs = await A1.db.rpc('admin_media_quarantine_scheduler_runs', { p_limit: 10, p_before: null });
  const statuses = (runs.data?.items ?? []).map((r: any) => r.status);
  check('failed and stale scheduled runs are visible', statuses.includes('failed') && statuses.includes('stale'), statuses);
  const q = await A1.db.rpc('admin_media_quarantine_overview');
  check('flagged jobs are listed in the queue health', (q.data?.needs_attention ?? []).some((j: any) => j.id === flagged && j.last_error === 'hash_mismatch'));

  step('7. Purge approvals (read-only)');
  const runId = randomUUID();
  const lapsed = randomUUID();
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO private.retention_purge_runs (id, category, policy_key, policy_period, item_count, set_digest, prepared_by, prepared_at, approval_expires_at, status) VALUES
          (${lit(runId)}, 'report_evidence', 'report_evidence_after_resolution', interval '90 days', 3, md5(${lit(run)}), ${lit(A1.id)}, now() - interval '2 minutes', now() + interval '28 minutes', 'prepared'),
          (${lit(lapsed)}, 'report_evidence', 'report_evidence_after_resolution', interval '90 days', 1, md5(${lit(run + 'x')}), ${lit(A1.id)}, now() - interval '45 minutes', now() - interval '15 minutes', 'prepared');
        COMMIT;`);
  const p1 = await A1.db.rpc('admin_retention_purge_dashboard', { p_status: null, p_limit: 10, p_before: null });
  const p2 = await A2.db.rpc('admin_retention_purge_dashboard', { p_status: null, p_limit: 10, p_before: null });
  const mine = (p1.data?.items ?? []).find((r: any) => r.id === runId);
  const theirs = (p2.data?.items ?? []).find((r: any) => r.id === runId);
  check('pending approval visible immediately, with the exact count and the expiry', mine?.status === 'prepared' && mine?.item_count === 3 && !!mine?.approval_expires_at);
  check('the preparer is told they cannot approve; another admin is told they may', mine?.prepared_by_viewer === true && mine?.viewer_may_approve === false
    && theirs?.prepared_by_viewer === false && theirs?.viewer_may_approve === true);
  check('a lapsed window shows as expired', (p1.data?.items ?? []).find((r: any) => r.id === lapsed)?.status === 'expired');
  const self = await A1.db.rpc('admin_retention_approve_run', { p_run_id: runId, p_set_digest: psql(`SELECT md5(${lit(run)})`), p_item_count: 3 });
  check('the server still refuses self-approval', /self_approval_refused/.test(self.error?.message ?? ''), self.error);
  check('the run is unchanged', psql(`SELECT status FROM private.retention_purge_runs WHERE id = ${lit(runId)}`) === 'prepared');

  step('8. The app client offers no destructive action');
  const client = readFileSync(new URL('../../lib/admin-monitoring.ts', import.meta.url), 'utf8');
  const screens = ['../../app/admin/monitoring.tsx', '../../app/admin/issue/[id].tsx'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n');
  const rpcs = [...client.matchAll(/'((?:admin|media|moderation)_[a-z_]+)'/g)].map((m) => m[1]);
  check('the dashboard client calls only read RPCs and acknowledge',
    rpcs.length > 0 && rpcs.every((n) => /_(overview|status|runs|history|dashboard|detail)$/.test(n) || n === 'admin_acknowledge_moderation_issue'), rpcs);
  check('no approve, execute, cancel, claim, purge or scheduler-switch calls in the screens',
    !/approve_run|execute_reports|claim_copy|cancel_run|purge_run\(|retention_purge_run'|scheduler_config|delivery_enabled\s*=/.test(client + screens));
}

const stale = await cleanup();
if (stale) console.log(`(removed ${stale} stale fixture account(s) first)`);
try {
  await main();
} catch (e) {
  check('script ran to completion', false, (e as Error).message);
} finally {
  console.log(`\nCleanup: ${await cleanup()} account(s) removed.`);
  const state = psql(`SELECT (SELECT bool_or(active) FROM cron.job)::text || ',' || (SELECT delivery_enabled FROM private.moderation_monitoring_state)::text || ','
                             || (SELECT enabled FROM private.media_quarantine_scheduler_config)::text || ',' || (SELECT count(*) FROM private.moderation_monitoring_issues)`);
  check('nothing switched on; no issues left', state === 'false,false,false,0', state);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exitCode = failed.length ? 1 : 0;
}
