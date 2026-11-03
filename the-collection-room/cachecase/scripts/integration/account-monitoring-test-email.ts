/// <reference types="node" />
// account-monitor {"action":"test"} — LOCAL Supabase only. No real email is
// ever sent: the functions are served with a placeholder Resend key and
// RESEND_API_URL pointing at a mock provider this script runs on the host.
//
// Modes (each needs the functions served with its own env file):
//   MODE=mock      ACCOUNT_MAINTENANCE_SECRET=<Vault secret>
//                  RESEND_API_KEY=re_local_placeholder
//                  RESEND_API_URL=http://host.docker.internal:54398/emails
//                  WAITLIST_FROM_EMAIL=waitlist@example.test
//                  ACCOUNT_ALERT_EMAIL_TO=ops@example.test
//                  ACCOUNT_ALERT_ENVIRONMENT=production
//     → wrong / missing / service-role credentials (403, nothing sent);
//       delivery to the mock provider; the response names the channel, not
//       the recipient; rate limiting (10 min, 5 per day); a Resend failure;
//       the normal alert path unchanged; no deletion, monitoring or
//       collector record touched.
//   MODE=missing   as mock, without ACCOUNT_ALERT_EMAIL_TO
//     → missing recipients: refused before any send, no rate-limit slot.
//   MODE=override  as mock, plus ACCOUNT_ALERT_FROM_EMAIL=alerts@example.test
//     → the explicit sender replaces WAITLIST_FROM_EMAIL.
// Run:  MODE=… MAINTENANCE_SECRET_FILE=… node scripts/integration/account-monitoring-test-email.ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const MODE = process.env.MODE ?? 'mock';
const secret = readFileSync(process.env.MAINTENANCE_SECRET_FILE ?? '', 'utf8').trim();
const MOCK_PORT = 54398;
const SUBJECT = '[CacheCase production] Monitoring Test';
const BODY = 'This is a test of CacheCase\'s account-deletion monitoring alerts. No account deletion or data changes were triggered.';
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
}

// ── Mock Resend provider ─────────────────────────────────────────────────
type Sent = { auth: string; body: any };
const sent: Sent[] = [];
let providerStatus = 200;
let server: Server | null = null;
function startProvider(): Promise<void> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {}
      sent.push({ auth: String(req.headers.authorization ?? ''), body });
      res.writeHead(providerStatus, { 'content-type': 'application/json' })
        .end(providerStatus < 300 ? '{"id":"mock-email-id"}' : '{"name":"internal_server_error","message":"mock failure"}');
    });
  });
  return new Promise((resolve) => server!.listen(MOCK_PORT, '0.0.0.0', resolve));
}

async function call(body: unknown, token: string | null) {
  const res = await fetch(`${st.API_URL}/functions/v1/account-monitor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let json: Record<string, any> | null = null;
  try {
    json = (await res.json()) as Record<string, any>;
  } catch {}
  return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
}
const test = (token: string | null = secret) => call({ action: 'test' }, token);
const noAddresses = (j: unknown) => !/@|example\.test|re_local_placeholder|host\.docker\.internal/.test(JSON.stringify(j));

// Everything a test must never touch: deletion, export, lifecycle,
// monitoring and account records.
const fingerprint = () => psql(`select md5(concat_ws('|',
  (select coalesce(string_agg(t::text, ',' order by t.code), '') from private.account_monitoring_alerts t),
  (select coalesce(string_agg(t::text, ',' order by t.id), '') from private.account_maintenance_runs t),
  (select coalesce(string_agg(t::text, ',' order by t.id), '') from private.account_maintenance_dispatches t),
  (select coalesce(string_agg(t::text, ','), '') from private.account_monitoring_state t),
  (select coalesce(string_agg(t::text, ',' order by t.id), '') from public.account_deletion_jobs t),
  (select coalesce(string_agg(t::text, ',' order by t.job_id, t.path), '') from public.account_deletion_storage_queue t),
  (select coalesce(string_agg(t::text, ',' order by t.user_id), '') from public.account_lifecycle t),
  (select coalesce(string_agg(t::text, ',' order by t.id), '') from public.account_exports t),
  (select count(*)::text from auth.users), (select count(*)::text from public.profiles)))`);
const slots = () => Number(psql('select count(*) from private.account_monitoring_test_sends'));
const resetSlots = () => psql('delete from private.account_monitoring_test_sends');

let fatal: unknown = null;
try {
  await startProvider();
  resetSlots();

  if (MODE === 'mock') {
    console.log('\n1. Authorization');
    // The normal path still answers (it reports channels, so run it before
    // taking the fingerprint).
    const normal = await call({}, secret);
    // (Any notices already due locally are delivered here, to the mock.)
    check('the normal monitoring call is unchanged', normal.status === 200 && normal.json?.status === 'ok' && typeof normal.json?.notices === 'number'
      && normal.json?.channels?.email === 'configured' && normal.json?.test === undefined, normal);
    check('an unknown action is refused', (await call({ action: 'bogus' }, secret)).status === 400);
    sent.length = 0; // a real notice due locally would have gone to the mock too
    const before = fingerprint();
    for (const [name, token] of [['a wrong secret', 'x'.repeat(64)], ['no credentials', null], ['the anon key', st.ANON_KEY],
      ['the service role key (test is maintenance-secret only)', st.SERVICE_ROLE_KEY]] as const) {
      const r = await test(token);
      check(`${name}: 403`, r.status === 403 && r.json?.reason === 'forbidden', r);
    }
    check('nothing was sent, no rate-limit slot taken', sent.length === 0 && slots() === 0);

    console.log('\n2. Successful test delivery (mock provider)');
    const ok = await test();
    check('200, accepted by email', ok.status === 200 && ok.json?.status === 'ok' && JSON.stringify(ok.json?.accepted) === '["email"]', ok);
    check('the response holds no addresses, URLs or keys', noAddresses(ok.json), ok.json);
    check('exactly one email reached the provider', sent.length === 1);
    const m = sent[0]?.body;
    check(`subject "${SUBJECT}"`, m?.subject === SUBJECT, m?.subject);
    check('the test body, exactly', m?.text === BODY, m?.text);
    check('to the configured alert recipient', JSON.stringify(m?.to) === '["ops@example.test"]', m?.to);
    check('from WAITLIST_FROM_EMAIL (no ACCOUNT_ALERT_FROM_EMAIL set)', m?.from === 'waitlist@example.test', m?.from);
    check('with the configured Resend key', sent[0]?.auth === 'Bearer re_local_placeholder');
    check('the attempt is recorded as delivered by email', psql(`select outcome || ':' || array_to_string(channels, ',') from private.account_monitoring_test_sends`) === 'delivered:email');

    console.log('\n3. Rate limiting');
    const again = await test();
    check('a second test within 10 minutes: 429', again.status === 429 && again.json?.reason === 'rate_limited', again);
    check('with a retry time (≈10 minutes) and Retry-After', again.json?.retry_after_seconds > 500 && again.json?.retry_after_seconds <= 600 && again.retryAfter === String(again.json?.retry_after_seconds));
    check('and nothing sent', sent.length === 1);
    resetSlots();
    psql(`insert into private.account_monitoring_test_sends (requested_at, outcome) select now() - make_interval(hours => h), 'delivered' from generate_series(1, 5) h`);
    const daily = await test();
    check('five tests in 24 hours: 429 until the oldest is a day old', daily.status === 429 && daily.json?.retry_after_seconds > 18 * 3600, daily.json);
    check('still nothing sent', sent.length === 1);

    console.log('\n4. Resend failure');
    resetSlots();
    providerStatus = 500;
    const bad = await test();
    check('502, not accepted, with the provider failure', bad.status === 502 && bad.json?.status === 'failed'
      && JSON.stringify(bad.json?.accepted) === '[]' && JSON.stringify(bad.json?.failed) === '["resend_rejected"]', bad.json);
    check('the response holds no addresses, URLs or keys', noAddresses(bad.json));
    check('the attempt is recorded as resend_rejected', psql('select outcome from private.account_monitoring_test_sends') === 'resend_rejected');
    check('a failed attempt still counts toward the limit', (await test()).status === 429);
    providerStatus = 200;

    console.log('\n5. No deletion, monitoring or collector records touched');
    check('deletion jobs, lifecycle, exports, monitoring alerts / runs / dispatches / state, users and profiles unchanged', fingerprint() === before);
  } else if (MODE === 'missing') {
    console.log('\nMissing email configuration');
    const before = fingerprint();
    const r = await test();
    check('409 alert_recipients_missing', r.status === 409 && r.json?.reason === 'alert_recipients_missing' && r.json?.channels?.email === 'missing_recipients', r);
    check('nothing sent', sent.length === 0);
    check('no rate-limit slot taken', slots() === 0);
    check('no addresses in the response', noAddresses(r.json));
    check('no other record touched', fingerprint() === before);
    check('wrong secret still 403 first', (await test('y'.repeat(64))).status === 403);
  } else if (MODE === 'override') {
    console.log('\nExplicit sender');
    const r = await test();
    check('delivered', r.status === 200 && JSON.stringify(r.json?.accepted) === '["email"]', r);
    check('from ACCOUNT_ALERT_FROM_EMAIL', sent[0]?.body?.from === 'alerts@example.test', sent[0]?.body?.from);
    check('same subject and body', sent[0]?.body?.subject === SUBJECT && sent[0]?.body?.text === BODY);
  } else {
    throw new Error(`unknown MODE ${MODE}`);
  }
} catch (e) {
  fatal = e;
  console.error(`Aborted: ${(e as Error).message}`);
} finally {
  await sleep(100);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  resetSlots();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${MODE}: ${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
process.exitCode = failed.length || fatal ? 1 : 0;
