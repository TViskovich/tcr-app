/// <reference types="node" />
// Account deletion monitoring — alert channels misconfigured (beta launch
// hardening). LOCAL Supabase only, one disposable admin; nothing is sent
// anywhere (no recipient is valid, the webhook URL is refused).
//
// Checks that account-monitor reports missing recipients and an invalid
// webhook URL, that a due notice is then NOT acknowledged but recorded as
// undelivered with a specific error admins can see, and that it is retried
// only after an hour.
//
// Prerequisites (local only): Vault as for account-monitoring.ts, and
// functions served with an env file containing
//   ACCOUNT_MAINTENANCE_SECRET=<same as the Vault secret>
//   RESEND_API_KEY=re_local_placeholder          (never used: no recipient)
//   ACCOUNT_ALERT_FROM_EMAIL=alerts@example.test
//   ACCOUNT_ALERT_EMAIL_TO=not-an-address
//   ACCOUNT_ALERT_WEBHOOK_URL=http://example.com/hook   (http, not local → refused)
// Run:  MAINTENANCE_SECRET_FILE=… node scripts/integration/account-monitoring-channels.ts
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
}
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

const monitorWas = psql(`select active from cron.job where jobname = 'account-deletion-monitor'`) === 't';
const busy = psql(`select (select count(*) from public.account_lifecycle) + (select count(*) from public.account_deletion_jobs where status <> 'completed')`);
if (busy !== '0') throw new Error(`local database has ${busy} open lifecycle/job rows; this test needs a quiet baseline`);
psql(`select cron.alter_job(job_id := jobid, active := false) from cron.job where jobname = 'account-deletion-monitor'`);
psql(`delete from private.account_monitoring_alerts;
      update private.account_monitoring_state set last_delivery_at = null, last_delivery_error = null, last_delivery_channels = '{}',
        email_channel = null, webhook_channel = null, webhook_signed = null, channels_reported_at = null where id;`);

const username = `mc${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const email = `${username}@example.test`;
const password = `mc-${randomUUID()}`;
const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username } });
if (created.error || !created.data.user) throw new Error(`user: ${created.error?.message}`);
const adminId = created.data.user.id;
const jobUser = randomUUID(); // a failed deletion with no account behind it
let fatal: unknown = null;
try {
  psql(`insert into public.admin_users (user_id) values ('${adminId}');
        insert into public.account_deletion_jobs (user_id, mode, status, failed_at, last_error_code, step_failures)
        values ('${jobUser}', 'immediate', 'failed', now(), 'auth_delete_failed', 8);`);
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const signedIn = await db.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  const summary = async () => (await db.rpc('account_deletion_admin_summary')).data as Record<string, any>;

  console.log('\nMissing recipients, invalid webhook URL');
  const first = await monitor();
  check('account-monitor answers', first.status === 200, first);
  check('it reports email recipients missing', first.body?.channels?.email === 'missing_recipients', first.body?.channels);
  check('and the webhook URL invalid (http to a non-local host)', first.body?.channels?.webhook === 'invalid_url' && first.body?.channels?.webhook_signed === false);
  check('nothing is attempted or delivered', first.body?.delivered?.length === 0 && first.body?.failed?.length === 0, first.body);
  check('the delivery error names the missing recipients', first.body?.delivery_error === 'alert_recipients_missing', first.body);
  const s = await summary();
  check('admins see no delivery channel configured', s?.alerts?.channel_configured === false && s?.alerts?.email === 'missing_recipients'
    && s?.alerts?.webhook === 'invalid_url', s?.alerts);
  check('the alert is open and undelivered', s?.alerts?.open === 1 && s?.alerts?.undelivered === 1 && s?.alerts?.last_delivery_error === 'alert_recipients_missing', s?.alerts);
  check('it is not acknowledged', psql(`select notified_at is null from private.account_monitoring_alerts where code = 'deletions_failed'`) === 't');
  check('no retry within the hour (the channel report is fresh)', (await monitor()).request === '');
  psql(`update private.account_monitoring_alerts set last_attempt_at = now() - interval '61 minutes'`);
  const retry = await monitor();
  check('after an hour it is retried, still undelivered', retry.body?.delivery_error === 'alert_recipients_missing'
    && psql(`select notified_at is null from private.account_monitoring_alerts where code = 'deletions_failed'`) === 't', retry.body);
} catch (e) {
  fatal = e;
  console.error(`Aborted: ${(e as Error).message}`);
} finally {
  psql(`delete from public.account_deletion_jobs where user_id = '${jobUser}'; delete from public.admin_users where user_id = '${adminId}';
        select private.account_monitoring_check();`);
  await admin.auth.admin.deleteUser(adminId); // disposable fixture
  psql(`select cron.alter_job(job_id := jobid, active := ${monitorWas}) from cron.job where jobname = 'account-deletion-monitor'`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
process.exitCode = failed.length || fatal ? 1 : 0;
