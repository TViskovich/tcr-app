/// <reference types="node" />
// Moderation monitoring and alerting (Phase 2B M4 step 5B,
// 20261127120000_moderation_monitoring.sql, moderation-monitor) — end to end
// on an ISOLATED, disposable local stack: real pg_net requests and the real
// Edge runtime, delivering ONLY to two sinks run by this script on this
// machine (a webhook receiver that verifies signatures, and a Resend mock).
// Nothing is sent to any real recipient or provider.
//
// This script turns alert delivery ON (and briefly the quarantine scheduler
// switch) on the isolated stack only, and restores both before it exits. It
// refuses to run against the primary local stack. Fixtures are synthetic rows.
//
// Prerequisites (isolated stack, e.g. CACHECASE_STACK_WORKDIR=<workdir>):
//   supabase functions serve --workdir <workdir> --env-file <file> with
//     MODERATION_MONITOR_SECRET, MODERATION_ALERT_WEBHOOK_SECRET (same values
//     as this process), MODERATION_ALERT_WEBHOOK_URL=http://host.docker.internal:<HOOK_PORT>/hook,
//     MODERATION_ALERT_RESEND_API_KEY=re_local_mock_only,
//     RESEND_API_URL=http://host.docker.internal:<MAIL_PORT>/emails,
//     MODERATION_ALERT_EMAIL_TO (2 test addresses), MODERATION_ALERT_FROM_EMAIL;
//   this process: MODERATION_MONITOR_SECRET, MODERATION_ALERT_WEBHOOK_SECRET,
//     and (negative tests) MEDIA_QUARANTINE_WORKER_SECRET, MAINTENANCE_SECRET_FILE.
// Secrets are never printed; they reach the database through psql's stdin.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { createClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from './local-stack.ts';

const stack = requireIsolatedStack();
const st = stack.st;
const SECRET = process.env.MODERATION_MONITOR_SECRET ?? '';
const HOOK_SECRET = process.env.MODERATION_ALERT_WEBHOOK_SECRET ?? '';
if (SECRET.length < 32 || HOOK_SECRET.length < 32) throw new Error('MODERATION_MONITOR_SECRET and MODERATION_ALERT_WEBHOOK_SECRET (≥ 32) must be set.');
const WORKER_SECRET = process.env.MEDIA_QUARANTINE_WORKER_SECRET ?? '';
const MAINT_SECRET = process.env.MAINTENANCE_SECRET_FILE ? readFileSync(process.env.MAINTENANCE_SECRET_FILE, 'utf8').trim() : '';
const HOOK_PORT = Number(process.env.HOOK_PORT ?? 56398);
const MAIL_PORT = Number(process.env.MAIL_PORT ?? 56399);
const SINK_BIND = process.env.SINK_BIND ?? '127.0.0.1';
const MOCK_KEY = 're_local_mock_only';
const KONG = `http://supabase_kong_${stack.project}:8000`;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'moderation-monitoring-it';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const SENSITIVE = `SENSITIVE-DETAIL-${run}`;
const psql = (sql: string) =>
  execFileSync('docker', ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const psqlIn = (sql: string) =>
  execFileSync('docker', ['exec', '-i', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], { encoding: 'utf8', input: sql }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (sql: string) => Number(psql(sql));

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);
async function until(cond: () => boolean, seconds: number): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > end) return false;
    await sleep(300);
  }
}

// ── Local sinks ─────────────────────────────────────────────────────────────
type Hook = { body: string; json: any; ts: string; delivery: string; signature: string; verdict: string; accepted: boolean };
type Mail = { body: any; auth: string };
const hooks: Hook[] = [];
const mails: Mail[] = [];
const seen = new Set<string>();
let hookStatus = 200;
let mailStatus = 200;
const readAll = (req: IncomingMessage) => new Promise<string>((resolve) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});
// The receiver's side of the contract, implemented independently of the
// function: HMAC-SHA256 over "<ts>.<delivery>.<body>", ±5 min, no replay.
function verify(body: string, ts: string, delivery: string, signature: string): string {
  if (!ts || !delivery || !signature) return 'missing_headers';
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return 'stale';
  const expected = Buffer.from(`v1=${createHmac('sha256', HOOK_SECRET).update(`${ts}.${delivery}.${body}`).digest('hex')}`);
  const got = Buffer.from(signature);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return 'bad_signature';
  if (seen.has(delivery)) return 'replayed';
  seen.add(delivery);
  return 'ok';
}
let hookServer: Server | null = null;
let mailServer: Server | null = null;
async function startSinks() {
  hookServer = createServer(async (req, res) => {
    const body = await readAll(req);
    const h = (k: string) => String(req.headers[k] ?? '');
    const verdict = verify(body, h('x-cachecase-timestamp'), h('x-cachecase-delivery'), h('x-cachecase-signature'));
    let json: any = null;
    try { json = JSON.parse(body); } catch { /* recorded as null */ }
    const status = verdict !== 'ok' ? 401 : hookStatus;
    hooks.push({ body, json, ts: h('x-cachecase-timestamp'), delivery: h('x-cachecase-delivery'), signature: h('x-cachecase-signature'), verdict, accepted: status === 200 });
    res.statusCode = status;
    res.end();
  });
  mailServer = createServer(async (req, res) => {
    const body = await readAll(req);
    let json: any = null;
    try { json = JSON.parse(body); } catch { /* recorded as null */ }
    mails.push({ body: json, auth: String(req.headers.authorization ?? '') });
    res.statusCode = mailStatus;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(mailStatus === 200 ? { id: `mock-${mails.length}` } : { name: 'mock_failure' }));
  });
  await new Promise<void>((r) => hookServer!.listen(HOOK_PORT, SINK_BIND, r));
  await new Promise<void>((r) => mailServer!.listen(MAIL_PORT, SINK_BIND, r));
}
const stopSinks = () => Promise.all([hookServer, mailServer].map((s) => new Promise<void>((r) => (s ? s.close(() => r()) : r()))));

// ── Calls ───────────────────────────────────────────────────────────────────
type Res = { status: number; text: string; body: any };
async function call(init: { method?: string; auth?: string | null; body?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: st.ANON_KEY };
  if (init.auth !== null) headers.Authorization = init.auth ?? `Bearer ${SECRET}`;
  const r = await fetch(`${st.API_URL}/functions/v1/moderation-monitor`, { method: init.method ?? 'POST', headers, body: init.method === 'GET' ? undefined : (init.body ?? '{}') });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const setDelivery = (on: boolean) => psql(`UPDATE private.moderation_monitoring_state SET delivery_enabled = ${on} WHERE id`);
const issue = (code: string) => psql(`SELECT concat_ws('|', item_count, coalesce(notified_at::text, ''), delivery_failures, coalesce(last_delivery_error, ''))
                                        FROM private.moderation_monitoring_issues WHERE issue_key = ${lit(code)} AND resolved_at IS NULL`);
const backdate = (code: string, col: 'notified_at' | 'last_attempt_at', minutes: number) =>
  psql(`UPDATE private.moderation_monitoring_issues SET ${col} = ${col} - make_interval(mins => ${minutes}) WHERE issue_key = ${lit(code)} AND resolved_at IS NULL`);

// Synthetic fixtures (ids recorded for cleanup).
const jobs: string[] = [];
const reports: string[] = [];
const runs: string[] = [];
let owner = '';
let reporter = '';
function job(opts: { bucket?: string; cs?: boolean; ageMin: number; state?: string; attention?: boolean; error?: string; attempts?: number; leaseAgeMin?: number }) {
  const id = randomUUID();
  jobs.push(id);
  const bucket = opts.bucket ?? 'item-images';
  psql(`INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id, quarantine_path,
          child_safety, legal_hold, state, needs_attention, last_error, attempts, lease_token, lease_expires_at, created_at, source_sha256, quarantine_sha256)
        VALUES (${lit(id)}, ${lit(bucket)}, ${lit(`${owner}/mon-${run}-${jobs.length}.jpg`)}, ${lit(owner)}, ${lit(bucket === 'avatars' ? 'avatar' : 'item_image')},
                'profile', ${lit(owner)}, ${lit(`q/${id}/original`)}, ${!!opts.cs}, ${!!opts.cs}, ${lit(opts.state ?? 'pending')}, ${!!opts.attention},
                ${opts.error ? lit(opts.error) : 'NULL'}, ${opts.attempts ?? 0},
                ${opts.leaseAgeMin !== undefined ? 'gen_random_uuid()' : 'NULL'},
                ${opts.leaseAgeMin !== undefined ? `now() - make_interval(mins => ${opts.leaseAgeMin})` : 'NULL'},
                now() - make_interval(mins => ${opts.ageMin}), repeat('a', 64), repeat('a', 64))`);
  return id;
}
const dropJob = (id: string) => psql(`BEGIN; SET LOCAL session_replication_role = replica;
  DELETE FROM private.media_quarantine_events WHERE quarantine_id = ${lit(id)}; DELETE FROM private.media_quarantine WHERE id = ${lit(id)}; COMMIT;`);
function urgentReport(ageMin: number) {
  const id = randomUUID();
  reports.push(id);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, reason, details, priority, status, created_at, updated_at)
        VALUES (${lit(id)}, ${lit(reporter)}, 'profile', ${lit(owner)}, 'child_safety', ${lit(SENSITIVE)}, 'urgent', 'open',
                now() - make_interval(mins => ${ageMin}), now()); COMMIT;`);
  return id;
}

async function cleanup(): Promise<number> {
  setDelivery(false);
  psql(`UPDATE private.media_quarantine_scheduler_config SET enabled = false`);
  psql(`SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname IN ('moderation-monitor', 'media-quarantine-worker')`);
  psql(`DELETE FROM vault.secrets WHERE name IN ('project_url', 'moderation_monitor_secret')`);
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const owners = ids.map(lit).join(',') || 'NULL';
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM private.media_quarantine WHERE owner_id IN (${owners}));
        DELETE FROM private.media_quarantine WHERE owner_id IN (${owners});
        DELETE FROM public.content_reports WHERE reporter_id IN (${owners}) OR target_id IN (${owners});
        DELETE FROM private.retention_purge_runs WHERE prepared_by IN (${owners});
        DELETE FROM private.moderation_monitoring_events;
        DELETE FROM private.moderation_monitoring_issues;
        DELETE FROM private.moderation_monitoring_deliveries;
        DELETE FROM private.moderation_monitoring_dispatches;
        DELETE FROM private.media_quarantine_scheduler_runs;
        UPDATE private.moderation_monitoring_state SET summary_sent_at = NULL, summary_claim_id = NULL, summary_claimed_at = NULL,
               summary_failed = false, last_delivery_at = NULL, last_delivery_error = NULL, last_delivery_channels = '{}' WHERE id;
        COMMIT;`);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

async function createUser(key: string) {
  const username = `mon${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Mon-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE } });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, email, token: s.session!.access_token, db };
}

// Everything a sink received must be free of these.
const leaks = () => [owner, reporter, ...jobs, ...reports, ...runs, SENSITIVE, `mon-${run}`, 'q/', 'example.test"', '@example.test', 'item-images', 'avatars']
  .filter((x) => x && x.length > 3);
function leaked(text: string, allowRecipients = false): string[] {
  return leaks().filter((x) => text.includes(x) && !(allowRecipients && x.includes('example.test')));
}

async function main() {
  const O = await createUser('o');
  const R = await createUser('r');
  const A = await createUser('a');
  owner = O.id;
  reporter = R.id;
  const ins = await service.from('admin_users').insert({ user_id: A.id });
  if (ins.error) throw new Error('admin');
  const probe = await call({ auth: null });
  if (probe.status === 503) throw new Error('moderation-monitor is served without MODERATION_MONITOR_SECRET');
  if (probe.status >= 500) throw new Error(`Edge Functions not served (status ${probe.status})`);
  psqlIn(`SELECT vault.create_secret(${lit(KONG)}, 'project_url');
          SELECT vault.create_secret(${lit(SECRET)}, 'moderation_monitor_secret');`);

  step('1. Defaults: delivery OFF, monitor job inactive');
  check('delivery is off', psql(`SELECT delivery_enabled FROM private.moderation_monitoring_state`) === 'f');
  check('the monitor job is inactive', psql(`SELECT active FROM cron.job WHERE jobname = 'moderation-monitor'`) === 'f');
  const cs = job({ cs: true, ageMin: 12 });
  const off = await call();
  check('a correctly authenticated call with delivery off sends nothing', off.status === 200 && off.body?.delivery === 'disabled', off.text);
  check('…but the critical issue is recorded', issue('child_safety_unquarantined').startsWith('1|'));
  check('the scheduled path dispatches nothing while off', psql(`SELECT private.run_moderation_monitor() IS NULL`) === 't');
  await sleep(2500);
  check('no sink received anything', hooks.length === 0 && mails.length === 0);
  const ov = await A.db.rpc('admin_moderation_monitoring_overview');
  check('admins see the open critical issue with delivery off', (ov.data?.open ?? []).some((i: any) => i.code === 'child_safety_unquarantined' && i.severity === 'critical'), ov.error);

  step('2. Authentication and input');
  check('GET → 405', (await call({ method: 'GET' })).status === 405);
  check('no credentials → 401', (await call({ auth: null })).status === 401);
  check('wrong secret of the same length → 401', (await call({ auth: `Bearer ${SECRET.replace(/./g, (c) => (c === 'z' ? 'y' : 'z'))}` })).status === 401);
  check('the account-maintenance secret → 401', !MAINT_SECRET || (await call({ auth: `Bearer ${MAINT_SECRET}` })).status === 401);
  check('the quarantine-worker secret → 401', !WORKER_SECRET || (await call({ auth: `Bearer ${WORKER_SECRET}` })).status === 401);
  check('the service role key → 401', (await call({ auth: `Bearer ${st.SERVICE_ROLE_KEY}` })).status === 401);
  check('an admin user JWT → 401', (await call({ auth: `Bearer ${A.token}` })).status === 401);
  check('unexpected body → 400', (await call({ body: '{"action":"test"}' })).status === 400);
  check('payload over 1 KB → 413', (await call({ body: JSON.stringify({ x: 'y'.repeat(2000) }) })).status === 413);
  check('nothing was sent by refused calls', hooks.length === 0 && mails.length === 0);

  step('3. Delivery ON: a critical issue, end to end');
  urgentReport(120);                                   // high, carries sensitive report text
  setDelivery(true);
  const req1 = psql(`SELECT private.run_moderation_monitor()`);
  check('the scheduled path queues one pg_net request', /^\d+$/.test(req1));
  check('…both channels receive one message', await until(() => hooks.length === 1 && mails.length === 1, 20), { hooks: hooks.length, mails: mails.length });
  const h1 = hooks[0];
  check('the webhook is signed, fresh and verifies', h1?.verdict === 'ok', h1?.verdict);
  check('payload: only the allowed top-level fields', JSON.stringify(Object.keys(h1?.json ?? {}).sort())
    === JSON.stringify(['delivery_id', 'environment', 'notices', 'sent_at', 'source', 'summary', 'version']));
  const n1 = (h1?.json?.notices ?? []) as any[];
  check('payload: each notice has exactly kind, category, code, severity, count, age, admin page',
    n1.length > 0 && n1.every((n) => JSON.stringify(Object.keys(n).sort()) === JSON.stringify(['admin_ref', 'category', 'code', 'count', 'kind', 'oldest_age_seconds', 'severity'])));
  check('critical child safety first, then the urgent reports', n1[0]?.code === 'child_safety_unquarantined' && n1[0]?.severity === 'critical'
    && n1.some((n) => n.code === 'urgent_reports_overdue' && n.severity === 'high'), n1);
  check('the first delivery includes the daily summary', Array.isArray(h1?.json?.summary?.issues));
  check('the webhook carries no ids, paths, report text, emails or buckets', leaked(h1?.body ?? '').length === 0, leaked(h1?.body ?? ''));
  const m1 = mails[0];
  check('email: the dedicated (mock) key, the configured recipients, a critical subject',
    m1?.auth === `Bearer ${MOCK_KEY}` && Array.isArray(m1?.body?.to) && m1.body.to.length === 2 && /CRITICAL/.test(m1?.body?.subject ?? ''), m1?.body?.subject);
  check('email carries no ids, paths, report text or buckets', leaked(JSON.stringify({ s: m1?.body?.subject, t: m1?.body?.text, h: m1?.body?.html }), true).length === 0);
  check('delivery recorded on both channels',
    await until(() => psql(`SELECT outcome || ':' || array_to_string(channels, ',') FROM private.moderation_monitoring_deliveries ORDER BY claimed_at DESC LIMIT 1`) === 'delivered:email,webhook', 10));
  check('the issue is marked notified', issue('child_safety_unquarantined').split('|')[1] !== '');

  step('4. Duplicate suppression');
  const again = await call();
  check('an unchanged issue is not sent again', again.body?.notices === 0 && again.body?.summary === false && hooks.length === 1 && mails.length === 1, again.text);
  check('the scheduled path has nothing to send either', psql(`SELECT private.run_moderation_monitor() IS NULL`) === 't');

  step('5. Receiver contract: invalid signature and replay');
  const tamper = await fetch(`http://127.0.0.1:${HOOK_PORT}/hook`, { method: 'POST', body: h1.body.replace('"count":1', '"count":9'),
    headers: { 'x-cachecase-timestamp': h1.ts, 'x-cachecase-delivery': h1.delivery, 'x-cachecase-signature': h1.signature } });
  check('a tampered body is rejected by the receiver', tamper.status === 401 && hooks.at(-1)?.verdict === 'bad_signature');
  const forged = await fetch(`http://127.0.0.1:${HOOK_PORT}/hook`, { method: 'POST', body: h1.body,
    headers: { 'x-cachecase-timestamp': h1.ts, 'x-cachecase-delivery': randomUUID(), 'x-cachecase-signature': h1.signature } });
  check('a signature moved to another delivery id is rejected', forged.status === 401 && hooks.at(-1)?.verdict === 'bad_signature');
  const replay = await fetch(`http://127.0.0.1:${HOOK_PORT}/hook`, { method: 'POST', body: h1.body,
    headers: { 'x-cachecase-timestamp': h1.ts, 'x-cachecase-delivery': h1.delivery, 'x-cachecase-signature': h1.signature } });
  check('an exact replay is rejected', replay.status === 401 && hooks.at(-1)?.verdict === 'replayed');
  const sinkCount = () => hooks.filter((h) => h.accepted).length;

  step('6. Failed delivery and retry');
  hookStatus = 500;
  mailStatus = 500;
  job({ ageMin: 60, state: 'pending', attention: true, error: 'copy_failed', attempts: 5 });  // high: attempts exhausted
  const f1 = await call();
  check('both channels failing → recorded as failed, not delivered', f1.body?.delivered?.length === 0 && !!f1.body?.delivery_error, f1.text);
  check('…the issue records the failure', issue('quarantine_attempts_exhausted').split('|')[2] === '1');
  const okBefore = sinkCount();
  const mailsBefore = mails.length;
  const f2 = await call();
  check('no immediate resend (back-off)', f2.body?.notices === 0 && sinkCount() === okBefore && mails.length === mailsBefore, f2.text);
  hookStatus = 200;
  mailStatus = 200;
  backdate('quarantine_attempts_exhausted', 'last_attempt_at', 16);
  const f3 = await call();
  check('after the back-off it is retried and delivered', f3.body?.delivered?.length === 2 && issue('quarantine_attempts_exhausted').split('|')[2] === '0', f3.text);
  mailStatus = 500;
  job({ ageMin: 60, state: 'pending', attention: true, error: 'source_read_failed', attempts: 1 });  // high: needs attention
  const f4 = await call();
  check('one channel accepting is enough (email down, webhook up)', JSON.stringify(f4.body?.delivered) === '["webhook"]' && f4.body?.delivery_error === null, f4.text);
  mailStatus = 200;

  step('7. Child safety repeats hourly; resolution is announced');
  const before7 = sinkCount();
  backdate('child_safety_unquarantined', 'notified_at', 61);
  await call();
  const r7 = hooks.filter((h) => h.accepted).at(-1)?.json?.notices ?? [];
  check('unresolved child safety is reminded after an hour', sinkCount() === before7 + 1 && r7.some((n: any) => n.code === 'child_safety_unquarantined' && n.kind === 'reminder'), r7);
  dropJob(cs);
  await call();
  const r8 = hooks.filter((h) => h.accepted).at(-1)?.json?.notices ?? [];
  check('when it clears, a "resolved" notice is sent', r8.some((n: any) => n.code === 'child_safety_unquarantined' && n.kind === 'resolved'), r8);

  step('8. Concurrent monitor runs');
  job({ ageMin: 60, state: 'copied', attention: true, error: 'hash_mismatch', attempts: 1 });   // critical: integrity
  const before8 = sinkCount();
  const trio = await Promise.all([call(), call(), call()]);
  await sleep(1000);
  const integrityNotices = hooks.filter((h) => h.accepted).slice(before8)
    .flatMap((h) => h.json?.notices ?? []).filter((n: any) => n.code === 'integrity_failure');
  check('three at once: the new critical issue is delivered exactly once', integrityNotices.length === 1, { notices: integrityNotices.length, trio: trio.map((t) => t.text) });
  check('…the others found it busy or already claimed', trio.filter((t) => t.body?.status === 'skipped' || t.body?.notices === 0).length === 2);

  step('9. Scheduler stalled with pending work');
  job({ ageMin: 20 });                                  // claimable, waiting 20 minutes
  psql(`UPDATE private.media_quarantine_scheduler_config SET enabled = true`);
  const before9 = sinkCount();
  await call();
  const n9 = hooks.filter((h) => h.accepted).at(-1)?.json?.notices ?? [];
  check('scheduler on, no completed run, work waiting → high "scheduler_stalled" sent', sinkCount() === before9 + 1
    && n9.some((n: any) => n.code === 'scheduler_stalled' && n.severity === 'high' && n.kind === 'opened'), n9);
  psql(`UPDATE private.media_quarantine_scheduler_config SET enabled = false`);
  await call();
  const n9b = hooks.filter((h) => h.accepted).at(-1)?.json?.notices ?? [];
  check('…and resolved when the condition clears', n9b.some((n: any) => n.code === 'scheduler_stalled' && n.kind === 'resolved'), n9b);

  step('10. Worker crash and routine issues (daily summary only)');
  job({ ageMin: 30, state: 'copied', leaseAgeMin: 20 });  // a worker died holding the lease
  const prep = randomUUID();
  runs.push(prep);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO private.retention_purge_runs (id, category, policy_key, policy_period, item_count, set_digest, prepared_by, prepared_at, approval_expires_at, status)
        VALUES (${lit(prep)}, 'report_evidence', 'report_evidence_after_resolution', interval '90 days', 1, md5(${lit(run)}), ${lit(A.id)},
                now() - interval '2 minutes', now() + interval '28 minutes', 'prepared'); COMMIT;`);
  const before10 = sinkCount();
  const r10 = await call();
  check('routine issues (stale lease, purge awaiting approval) are not sent individually', r10.body?.notices === 0 && sinkCount() === before10, r10.text);
  check('…but are recorded', issue('quarantine_lease_stale').startsWith('1|') && issue('purge_approval_pending').startsWith('1|'));
  psql(`UPDATE private.moderation_monitoring_state SET summary_sent_at = now() - interval '25 hours', summary_claimed_at = now() - interval '25 hours' WHERE id`);
  await call();
  const sum = hooks.filter((h) => h.accepted).at(-1)?.json?.summary?.issues ?? [];
  check('the daily summary lists them with their severity', sum.some((s: any) => s.code === 'quarantine_lease_stale' && s.severity === 'routine')
    && sum.some((s: any) => s.code === 'purge_approval_pending' && s.severity === 'routine'), sum);
  check('the summary also carries no identifiers', leaked(hooks.at(-1)?.body ?? '').length === 0);

  step('11. A rolled-back transaction delivers nothing');
  const before11 = { hooks: hooks.length, mails: mails.length, deliveries: count(`SELECT count(*) FROM private.moderation_monitoring_deliveries`) };
  const pubId = randomUUID();
  const inside = psql(`BEGIN;
    INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id, quarantine_path, created_at)
    VALUES (${lit(pubId)}, 'avatars', ${lit(`${owner}/mon-${run}-rb.jpg`)}, ${lit(owner)}, 'avatar', 'profile', ${lit(owner)}, ${lit(`q/${pubId}/original`)}, now() - interval '30 minutes');
    SELECT (private.run_moderation_monitor() IS NOT NULL)::text;
    ROLLBACK;`).split('\n').filter((l) => l === 'true' || l === 'false');
  check('inside the transaction a request was queued', inside[0] === 'true', inside);
  await sleep(5000);
  check('after ROLLBACK: nothing delivered, no delivery record, no issue', hooks.length === before11.hooks && mails.length === before11.mails
    && count(`SELECT count(*) FROM private.moderation_monitoring_deliveries`) === before11.deliveries
    && count(`SELECT count(*) FROM private.moderation_monitoring_issues WHERE issue_key = 'public_removal_overdue'`) === 0);

  step('12. Acknowledgement and records');
  const openIssue = psql(`SELECT id FROM private.moderation_monitoring_issues WHERE issue_key = 'quarantine_needs_attention' AND resolved_at IS NULL`);
  const ack = await A.db.rpc('admin_acknowledge_moderation_issue', { p_issue_id: openIssue });
  check('an admin acknowledges; the issue stays open', ack.data?.acknowledged === true && ack.data?.resolved === false
    && psql(`SELECT resolved_at IS NULL FROM private.moderation_monitoring_issues WHERE id = ${lit(openIssue)}`) === 't', ack.error);
  check('collectors cannot read or acknowledge', !!(await O.db.rpc('admin_moderation_monitoring_overview')).error
    && !!(await O.db.rpc('admin_acknowledge_moderation_issue', { p_issue_id: openIssue })).error);
  check('every pg_net request reached this project\'s monitor (2xx)',
    count(`SELECT count(*) FROM net._http_response WHERE status_code IS DISTINCT FROM 200`) === 0, psql(`SELECT string_agg(coalesce(status_code::text, error_msg), ',') FROM net._http_response`));
  const bodies = psql(`SELECT coalesce(string_agg(content, ' '), '') FROM net._http_response`);
  check('monitor responses carry codes and counts only', leaked(bodies).length === 0 && !bodies.includes(SECRET) && !bodies.includes(HOOK_SECRET));
  check('every delivery went to a local sink (deliveries = accepted webhooks)',
    count(`SELECT count(*) FROM private.moderation_monitoring_deliveries WHERE 'webhook' = ANY (channels)`) === sinkCount());
  check('channel status reported as configured (codes only)', psql(`SELECT email_channel || ',' || webhook_channel FROM private.moderation_monitoring_state`) === 'configured,configured');
}

await startSinks();
const stale = await cleanup();
if (stale) console.log(`(removed ${stale} stale fixture account(s) first)`);
try {
  await main();
} catch (e) {
  check('script ran to completion', false, (e as Error).message);
} finally {
  console.log(`\nCleanup: ${await cleanup()} account(s) removed.`);
  await stopSinks();
  const state = psql(`SELECT (SELECT delivery_enabled FROM private.moderation_monitoring_state)::text || ',' ||
                             (SELECT enabled FROM private.media_quarantine_scheduler_config)::text || ',' ||
                             (SELECT bool_or(active) FROM cron.job)::text || ',' ||
                             (SELECT count(*) FROM vault.secrets WHERE name IN ('project_url', 'moderation_monitor_secret')) || ',' ||
                             (SELECT count(*) FROM private.moderation_monitoring_issues)`);
  check('restored: delivery OFF, scheduler OFF, every job inactive, Vault entries and issues removed', state === 'false,false,false,0,0', state);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exitCode = failed.length ? 1 : 0;
}
