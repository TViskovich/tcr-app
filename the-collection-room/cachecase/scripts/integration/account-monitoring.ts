/// <reference types="node" />
// Account deletion monitoring (beta launch hardening) — end-to-end check
// through the REAL APIs (Edge Functions, PostgREST, Auth, pg_cron's call
// path via pg_net) against the LOCAL Supabase stack, with disposable
// collectors only. Alerts go to a webhook receiver this script runs; no
// email is sent.
//
// Covers: admin-only access; healthy; overdue, stuck, expired-lease and
// failed deletions; failed / abandoned / stuck exports; scheduler failures
// (failing calls, missing runs, invalid configuration, inactive); the
// monitor job (inactive by default) and its channel report; alert delivery
// and acknowledgement, no repeats, a webhook that rejects or is
// unreachable and the retry, resolution; Delete Now unaffected.
// Missing recipients / no valid channel: account-monitoring-channels.ts.
//
// Prerequisites (local only):
//   * Vault secrets username_reservation_key, project_url
//     (http://supabase_kong_cachecase:8000) and account_maintenance_secret;
//   * functions served with an env file containing
//       ACCOUNT_RECENT_AUTH_SECONDS=8
//       ACCOUNT_MAINTENANCE_SECRET=<same as the Vault secret>
//       ACCOUNT_ALERT_WEBHOOK_URL=http://host.docker.internal:54399/hook
//       ACCOUNT_ALERT_WEBHOOK_SECRET=<≥ 32 characters>
//       ACCOUNT_ALERT_ENVIRONMENT=local
//     and NO RESEND_API_KEY / ACCOUNT_ALERT_EMAIL_TO;
//   * MAINTENANCE_SECRET_FILE and ALERT_WEBHOOK_SECRET_FILE pointing at
//     files holding those two secrets.
// Run (Node 24 runs .ts directly):
//   MAINTENANCE_SECRET_FILE=… ALERT_WEBHOOK_SECRET_FILE=… node scripts/integration/account-monitoring.ts
//
// It resets the LOCAL monitoring history (runs, dispatches, alerts) and
// restores the cron jobs and Vault secret it changes.
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const secret = readFileSync(process.env.MAINTENANCE_SECRET_FILE ?? '', 'utf8').trim();
const hookSecret = readFileSync(process.env.ALERT_WEBHOOK_SECRET_FILE ?? '', 'utf8').trim();
const HOOK_PORT = 54399;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'account-monitoring-it';
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();

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

type User = { id: string; email: string; password: string; username: string; db: SupabaseClient; token: string };
const run = randomUUID().replace(/-/g, '').slice(0, 5);
const users: User[] = [];
async function createUser(key: string): Promise<User> {
  const username = `mo${run}${key}`;
  const email = `${username}@example.test`;
  const password = `mo-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const u: User = { id: data.user.id, email, password, username, db: createClient(st.API_URL, st.ANON_KEY, opts), token: '' };
  await signIn(u);
  users.push(u);
  return u;
}
async function signIn(u: User) {
  const { data, error } = await u.db.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw error;
  u.token = data.session.access_token;
}
async function fn(name: string, body: unknown, token: string | null) {
  const res = await fetch(`${st.API_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let json: Record<string, any> | null = null;
  try {
    json = (await res.json()) as Record<string, any>;
  } catch {}
  return { status: res.status, json };
}
const worker = () => fn('account-maintenance', {}, secret);

// ── Webhook receiver ──────────────────────────────────────────────────────
type Hook = { body: any; raw: string; signed: boolean };
const hooks: Hook[] = [];
let hookStatus = 200; // what the receiver answers
let server: Server | null = null;
function startHooks(): Promise<void> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const sig = String(req.headers['x-cachecase-signature'] ?? '');
      const want = `sha256=${createHmac('sha256', hookSecret).update(raw).digest('hex')}`;
      const signed = sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {}
      hooks.push({ body, raw, signed });
      res.writeHead(hookStatus, { 'content-type': 'application/json' }).end(hookStatus < 300 ? '{"ok":true}' : '{"ok":false}');
    });
  });
  return new Promise((resolve) => server!.listen(HOOK_PORT, '0.0.0.0', resolve));
}
const stopHooks = () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));

// Runs the monitor's scheduled call and waits for account-monitor's answer.
async function monitor(): Promise<{ request: string; status: number | null; body: any }> {
  const request = psql('select private.run_account_monitor()');
  if (!request) return { request: '', status: null, body: null };
  for (let i = 0; i < 60; i++) {
    const row = psql(`select status_code || E'\\t' || coalesce(content, '') from net._http_response where id = ${request}`);
    if (row) {
      const [status, content] = row.split('\t');
      let body: any = null;
      try {
        body = JSON.parse(content);
      } catch {}
      return { request, status: Number(status), body };
    }
    await sleep(250);
  }
  return { request, status: null, body: null };
}
async function summary(u: User) {
  const { data, error } = await u.db.rpc('account_deletion_admin_summary');
  return { data: data as Record<string, any> | null, error };
}
const issues = async (u: User) => (((await summary(u)).data?.issues ?? []) as string[]).slice().sort();

const cronWas = Object.fromEntries(psql(`select jobname || '=' || active from cron.job where jobname in ('account-maintenance', 'account-deletion-monitor')`)
  .split('\n').filter(Boolean).map((l) => l.split('=')).map(([k, v]) => [k, v === 'true']));
const setCron = (job: string, active: boolean) =>
  psql(`select cron.alter_job(job_id := jobid, active := ${active}) from cron.job where jobname = '${job}'`);
const setVaultSecret = (value: string) =>
  psql(`select vault.update_secret(id, '${value}') from vault.secrets where name = 'account_maintenance_secret'`);

let fatal: unknown = null;
try {
  // ── Setup ────────────────────────────────────────────────────────────────
  const busy = psql(`select (select count(*) from public.account_lifecycle) + (select count(*) from public.account_deletion_jobs where status <> 'completed')
    + (select count(*) from public.account_exports where status in ('queued','collecting','archiving','failed'))`);
  if (busy !== '0') throw new Error(`local database has ${busy} open lifecycle/job/export rows; this test needs a quiet baseline`);
  // The scheduled monitor would race this test; the test drives it itself.
  setCron('account-deletion-monitor', false);
  setCron('account-maintenance', true);
  psql(`delete from private.account_maintenance_runs; delete from private.account_maintenance_dispatches; delete from private.account_monitoring_alerts;
        update private.account_monitoring_state set scheduler_active_since = now(), last_delivery_at = null, last_delivery_error = null,
          last_delivery_channels = '{}', email_channel = null, webhook_channel = null, webhook_signed = null, channels_reported_at = null where id;`);
  await startHooks();
  const A = await createUser('a'); // a normal collector
  const M = await createUser('m'); // admin
  psql(`insert into public.admin_users (user_id) values ('${M.id}')`);
  const O = await createUser('o'); // overdue scheduled deletion
  const S = await createUser('s'); // stuck job
  const F = await createUser('f'); // failed job
  const X = await createUser('x'); // exports
  const D = await createUser('d'); // Delete Now regression
  const identities = users.flatMap((u) => [u.id, u.email, u.username]);
  const leaks = (text: string) => identities.filter((v) => text.includes(v));

  step('1. Monitoring data is admin-only');
  const notAdmin = await summary(A);
  check('a normal collector is refused the summary', !notAdmin.data && notAdmin.error?.code === '42501', notAdmin.error);
  const anon = await createClient(st.API_URL, st.ANON_KEY, opts).rpc('account_deletion_admin_summary');
  check('so is anon', !anon.data && !!anon.error);
  for (const [rpc, args] of [['account_monitoring_claim_notices', {}], ['account_monitoring_record_delivery', { p_claimed_at: new Date().toISOString(), p_error: null }],
    ['account_maintenance_record_run', { p_outcome: 'ok', p_duration_ms: 1, p_jobs_processed: 0, p_job_errors: 0, p_error_codes: [] }],
    ['account_monitoring_report_channels', { p_email: 'configured', p_webhook: 'configured', p_webhook_signed: true }]] as const) {
    const r = await A.db.rpc(rpc, args);
    check(`a collector cannot call ${rpc}`, !!r.error, r);
  }
  const priv = await A.db.schema('private' as any).from('account_maintenance_runs').select('*');
  check('monitoring tables are not reachable through the API', !!priv.error && !(priv.data as unknown[] | null)?.length, priv.error);
  check('account-monitor refuses a collector’s token', (await fn('account-monitor', {}, A.token)).status === 403);
  check('and no token', (await fn('account-monitor', {}, null)).status === 403);
  check('an admin can read the summary', !!(await summary(M)).data);

  step('2. Healthy');
  const firstRun = await worker();
  check('a scheduled maintenance run succeeds', firstRun.status === 200 && firstRun.json?.status === 'ok', firstRun);
  const healthy = (await summary(M)).data;
  check('status healthy, no issues', healthy?.status === 'healthy' && healthy?.issues?.length === 0, healthy);
  check('the last successful run is recent', Date.now() - Date.parse(healthy?.scheduler?.last_successful_run_at ?? '') < 60_000, healthy?.scheduler);
  check('with outcome ok', healthy?.scheduler?.last_run_outcome === 'ok');
  check('the earlier summary fields are still there', healthy?.failed === 0 && healthy?.in_progress === 0 && typeof healthy?.failure_codes === 'object');
  check('the monitor job is inactive (as migrated / restored by this test)', healthy?.alerts?.monitor_active === false, healthy?.alerts);
  check('delivery configuration unknown until account-monitor reports it', healthy?.alerts?.channel_configured === null);
  const report = await monitor();
  check('nothing due, no report yet: the monitor asks account-monitor for its channels', report.status === 200 && report.body?.notices === 0, report);
  check('it reports the webhook configured and signed, email not configured', report.body?.channels?.webhook === 'configured'
    && report.body?.channels?.webhook_signed === true && report.body?.channels?.email === 'not_configured', report.body?.channels);
  const cfg = (await summary(M)).data?.alerts;
  check('admins see a delivery channel configured', cfg?.channel_configured === true && cfg?.webhook === 'configured' && cfg?.email === 'not_configured', cfg);
  const quiet = await monitor();
  await sleep(1500);
  check('nothing due, fresh report: the monitor calls nothing and nothing is sent', quiet.request === '' && hooks.length === 0, { quiet, hooks: hooks.length });
  setCron('account-deletion-monitor', true);
  check('activating the monitor job shows in the summary', (await summary(M)).data?.alerts?.monitor_active === true);
  setCron('account-deletion-monitor', false);

  step('3. Deletion states');
  await signIn(O);
  const scheduled = await fn('account-deletion', { action: 'schedule', confirmation: 'DELETE' }, O.token);
  check('O schedules deletion (14 days)', scheduled.json?.state === 'pending_deletion', scheduled);
  psql(`alter table public.account_lifecycle disable trigger account_lifecycle_transition;
        update public.account_lifecycle set scheduled_for = now() - interval '2 hours' where user_id = '${O.id}';
        alter table public.account_lifecycle enable trigger account_lifecycle_transition;`);
  psql(`insert into public.account_deletion_jobs (user_id, mode, status, created_at, lease_until, next_attempt_at)
        values ('${S.id}', 'immediate', 'cleaning_storage', now() - interval '2 hours', now() - interval '30 minutes', now() + interval '1 day');
        insert into public.account_deletion_jobs (user_id, mode, status, failed_at, last_error_code, step_failures)
        values ('${F.id}', 'immediate', 'failed', now(), 'auth_delete_failed', 8);`);
  const del = (await summary(M)).data;
  check('one overdue scheduled deletion', del?.deletions?.overdue_scheduled === 1, del?.deletions);
  check('one job stuck in progress for over an hour', del?.deletions?.stuck_over_1h === 1);
  check('one expired lease', del?.deletions?.expired_leases === 1);
  check('one failed deletion, with its code', del?.deletions?.failed === 1 && del?.deletions?.failure_codes?.auth_delete_failed === 1);
  check('all four are issues', ['deletion_leases_expired', 'deletions_failed', 'deletions_overdue', 'deletions_stuck'].every((c) => del?.issues?.includes(c)), del?.issues);
  check('status attention', del?.status === 'attention');

  step('4. Export states');
  psql(`insert into public.account_exports (user_id, status, last_error_code, updated_at) values
        ('${X.id}', 'failed', 'archive_failed', now() - interval '1 hour'),
        ('${X.id}', 'failed', 'archive_failed', now() - interval '2 hours'),
        ('${X.id}', 'failed', 'collect_failed', now() - interval '3 hours'),
        ('${X.id}', 'failed', 'export_abandoned', now() - interval '4 hours'),
        ('${X.id}', 'archiving', null, now() - interval '26 hours');`);
  const ex = (await summary(M)).data?.exports;
  check('failed exports (24 h) counted apart from abandoned', ex?.failed_24h === 3 && ex?.abandoned_24h === 1, ex);
  check('a stuck export', ex?.stuck === 1);
  check('export issues raised', (await issues(M)).includes('exports_failing') && (await issues(M)).includes('exports_stuck'));

  step('5. Scheduler failures');
  // Repeated Edge Function failures: the scheduled call is refused (wrong secret).
  setVaultSecret(randomBytes(32).toString('hex'));
  const reqs: string[] = [];
  for (let i = 0; i < 3; i++) reqs.push(psql('select private.run_account_maintenance()'));
  for (let i = 0; i < 40 && psql(`select count(*) from net._http_response where id in (${reqs.join(',')})`) !== '3'; i++) await sleep(250);
  psql(`update private.account_maintenance_dispatches set dispatched_at = dispatched_at - interval '3 minutes'`);
  const sch = (await summary(M)).data?.scheduler;
  check('three refused calls in a row are counted', sch?.consecutive_failed_calls === 3 && sch?.last_call_status === 403, sch);
  check('failing calls are an issue', (await issues(M)).includes('maintenance_calls_failing'));
  // Missing runs: nothing successful for an hour.
  psql(`update private.account_maintenance_runs set finished_at = finished_at - interval '1 hour';
        update private.account_monitoring_state set scheduler_active_since = now() - interval '1 hour';`);
  check('no successful run for 30 min: missing runs', (await issues(M)).includes('maintenance_runs_missing'));
  // Invalid configuration (a secret too short to be accepted).
  setVaultSecret('short');
  check('invalid configuration is an issue', (await issues(M)).includes('scheduler_not_configured'));
  setVaultSecret(secret);
  check('valid again once fixed', !(await issues(M)).includes('scheduler_not_configured'));
  // Inactive with a deletion pending.
  setCron('account-maintenance', false);
  check('inactive scheduler with deletions pending is an issue', (await issues(M)).includes('scheduler_inactive'));
  check('and not "missing runs" (nothing should run)', !(await issues(M)).includes('maintenance_runs_missing'));
  setCron('account-maintenance', true);

  step('6. Alerts: delivery, no repeat');
  const expected = (await issues(M));
  const sent = await monitor();
  await sleep(500);
  check('the monitor calls account-monitor, which delivers', sent.status === 200 && sent.body?.delivered?.includes('webhook'), sent);
  check('one webhook digest arrives', hooks.length === 1, hooks.length);
  const hook = hooks[0]?.body;
  check('signed with the webhook secret', hooks[0]?.signed === true);
  check('one opened notice per issue', JSON.stringify((hook?.notices ?? []).map((n: any) => `${n.kind}:${n.code}`).sort())
    === JSON.stringify(expected.map((c) => `opened:${c}`).sort()), hook?.notices);
  check('a readable text message (Slack text / Discord content)', typeof hook?.text === 'string' && hook.text.includes('need attention') && typeof hook?.content === 'string');
  check('no emails, usernames or account ids in the alert', leaks(hooks[0]?.raw ?? '').length === 0, leaks(hooks[0]?.raw ?? ''));
  const after = (await summary(M)).data?.alerts;
  check('admins see the alerts delivered', after?.open === expected.length && after?.undelivered === 0 && !!after?.last_delivery_at, after);
  check('acknowledged by the webhook', JSON.stringify(after?.last_delivery_channels) === '["webhook"]', after?.last_delivery_channels);
  check('every alert is marked notified', psql(`select count(*) from private.account_monitoring_alerts where resolved_at is null and notified_at is null`) === '0');
  check('no identities in the admin summary either', leaks(JSON.stringify((await summary(M)).data)).length === 0);
  const again = await monitor();
  await sleep(1000);
  check('the next check sends nothing new', again.request === '' && hooks.length === 1, { again, hooks: hooks.length });

  step('7. Alerts: failed delivery, retry');
  psql(`update private.account_monitoring_alerts set notified_at = now() - interval '25 hours', last_attempt_at = now() - interval '25 hours'
        where code = 'deletions_failed'`);
  const notifiedBefore = psql(`select notified_at from private.account_monitoring_alerts where code = 'deletions_failed'`);
  hookStatus = 500;
  const rejected = await monitor();
  await sleep(300);
  check('a webhook answering 500 is not counted as delivered', rejected.status === 200 && rejected.body?.delivery_error === 'webhook_rejected'
    && rejected.body?.delivered?.length === 0, rejected.body);
  check('the request did reach the receiver', hooks.length === 2);
  check('the reminder is not acknowledged', psql(`select notified_at from private.account_monitoring_alerts where code = 'deletions_failed'`) === notifiedBefore);
  check('admins see webhook_rejected', (await summary(M)).data?.alerts?.last_delivery_error === 'webhook_rejected');
  hookStatus = 200;
  await stopHooks();
  psql(`update private.account_monitoring_alerts set last_attempt_at = now() - interval '61 minutes' where code = 'deletions_failed'`);
  const failedSend = await monitor();
  check('a reminder whose webhook is unreachable is reported as undelivered', failedSend.status === 200
    && failedSend.body?.delivery_error === 'webhook_unreachable', failedSend);
  const af = (await summary(M)).data?.alerts;
  check('admins see the delivery error', af?.last_delivery_error === 'webhook_unreachable' && af?.undelivered === 1, af);
  check('it is not retried within the hour', (await monitor()).request === '');
  await startHooks();
  psql(`update private.account_monitoring_alerts set last_attempt_at = now() - interval '61 minutes' where code = 'deletions_failed'`);
  const retried = await monitor();
  await sleep(500);
  check('after an hour it is retried and delivered', retried.body?.delivered?.includes('webhook') && hooks.at(-1)?.body?.notices?.[0]?.kind === 'reminder', retried);
  check('the error clears', (await summary(M)).data?.alerts?.last_delivery_error === null);
  check('and the reminder is acknowledged', psql(`select notified_at > now() - interval '1 minute' from private.account_monitoring_alerts where code = 'deletions_failed'`) === 't');

  step('8. Resolution');
  await signIn(O);
  check('O cancels', (await fn('account-deletion', { action: 'cancel' }, O.token)).json?.restored === true);
  psql(`delete from public.account_deletion_jobs where user_id in ('${S.id}', '${F.id}'); delete from public.account_exports where user_id = '${X.id}';
        delete from private.account_maintenance_dispatches;`);
  check('a successful run is recorded again', (await worker()).json?.status === 'ok');
  psql(`update private.account_monitoring_alerts set last_attempt_at = now() - interval '6 minutes'`);
  const before = hooks.length;
  const resolved = await monitor();
  await sleep(500);
  const rh = hooks.at(-1)?.body;
  check('a resolved digest is delivered', resolved.status === 200 && hooks.length === before + 1 && (rh?.notices ?? []).every((n: any) => n.kind === 'resolved'), rh?.notices);
  check('covering every issue', (rh?.notices ?? []).length === expected.length, rh?.notices);
  check('and says so', rh?.text?.includes('issues resolved') && rh?.status === 'healthy');
  const end = (await summary(M)).data;
  check('healthy again, nothing open or undelivered', end?.status === 'healthy' && end?.alerts?.open === 0 && end?.alerts?.undelivered === 0, end);

  step('9. Deletion still works, unaffected');
  const runsBefore = psql('select count(*) from private.account_maintenance_runs');
  await signIn(D);
  const now = await fn('account-deletion', { action: 'delete_now', confirmation: 'DELETE' }, D.token);
  check('Delete Now is accepted', now.status === 200, now);
  let job: Record<string, any> | null = null;
  for (let i = 0; i < 60; i++) {
    job = (await admin.from('account_deletion_jobs').select('status').eq('user_id', D.id).maybeSingle()).data;
    if (job?.status === 'completed') break;
    await sleep(500);
  }
  check('and completes', job?.status === 'completed', job);
  check('its kick-off run is not counted as a maintenance run', psql('select count(*) from private.account_maintenance_runs') === runsBefore);
  check('the summary stays healthy', (await summary(M)).data?.status === 'healthy');
} catch (e) {
  fatal = e;
  console.error(`Aborted: ${(e as Error).message}`);
} finally {
  await stopHooks();
  try {
    setVaultSecret(secret);
  } catch {}
  for (const u of users) {
    await admin.from('account_lifecycle').delete().eq('user_id', u.id);
    await admin.auth.admin.deleteUser(u.id); // disposable fixtures only
  }
  if (users.length) {
    const ids = users.map((u) => `'${u.id}'`).join(',');
    psql(`delete from public.admin_users where user_id in (${ids}); delete from public.account_exports where user_id in (${ids});
          delete from public.account_deletion_jobs where user_id in (${ids}) and status <> 'completed';`);
  }
  for (const [job, active] of Object.entries(cronWas)) setCron(job, active as boolean);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
process.exitCode = failed.length || fatal ? 1 : 0;
