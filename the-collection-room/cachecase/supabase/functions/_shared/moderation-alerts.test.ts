import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1';

import {
  buildPayload, composeEmail, emailConfig, MAX_RECIPIENTS, signAlert, verifyAlert, webhookConfig,
} from './moderation-alerts.ts';

const envOf = (vars: Record<string, string>) => (k: string) => vars[k];
const HOSTED = { SUPABASE_URL: 'https://abc.supabase.co' };
const LOCAL = { SUPABASE_URL: 'http://kong:8000' };
const SECRET = 's'.repeat(40);
const CLAIM_ID = '00000000-0000-4000-8000-00000000c1a1';

Deno.test('email: off without the dedicated key (the account-alert key is ignored)', () => {
  assertEquals(emailConfig(envOf({ ...HOSTED, RESEND_API_KEY: 're_x', ACCOUNT_ALERT_EMAIL_TO: 'a@b.co' })).status, 'not_configured');
});

Deno.test('email: at most five recipients, all valid, plus a sender', () => {
  const base = { ...HOSTED, MODERATION_ALERT_RESEND_API_KEY: 're_x', MODERATION_ALERT_FROM_EMAIL: 'alerts@example.test' };
  const five = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `m${i}@example.test`).join(',');
  assertEquals(emailConfig(envOf({ ...base, MODERATION_ALERT_EMAIL_TO: five })).status, 'configured');
  assertEquals(emailConfig(envOf({ ...base, MODERATION_ALERT_EMAIL_TO: `${five},x@example.test` })).status, 'too_many_recipients');
  assertEquals(emailConfig(envOf({ ...base, MODERATION_ALERT_EMAIL_TO: 'a@example.test,not-an-address' })).status, 'missing_recipients');
  assertEquals(emailConfig(envOf({ ...base, MODERATION_ALERT_EMAIL_TO: '' })).status, 'missing_recipients');
  assertEquals(emailConfig(envOf({ ...base, MODERATION_ALERT_FROM_EMAIL: '', MODERATION_ALERT_EMAIL_TO: 'a@example.test' })).status, 'missing_sender');
});

Deno.test('email: a local stack sends only to a local mock, never the real provider', () => {
  const base = { ...LOCAL, MODERATION_ALERT_RESEND_API_KEY: 're_x', MODERATION_ALERT_FROM_EMAIL: 'a@example.test', MODERATION_ALERT_EMAIL_TO: 'b@example.test' };
  assertEquals(emailConfig(envOf(base)).status, 'not_configured');
  assertEquals(emailConfig(envOf({ ...base, RESEND_API_URL: 'https://api.resend.com/emails' })).status, 'not_configured');
  assertEquals(emailConfig(envOf({ ...base, RESEND_API_URL: 'http://host.docker.internal:1/emails' })).status, 'configured');
});

Deno.test('webhook: https (or a local host), always signed', () => {
  assertEquals(webhookConfig(envOf({ ...HOSTED })).status, 'not_configured');
  assertEquals(webhookConfig(envOf({ ...HOSTED, MODERATION_ALERT_WEBHOOK_URL: 'https://hooks.example.test/x' })).status, 'missing_secret');
  assertEquals(webhookConfig(envOf({ ...HOSTED, MODERATION_ALERT_WEBHOOK_URL: 'https://hooks.example.test/x', MODERATION_ALERT_WEBHOOK_SECRET: 'short' })).status, 'missing_secret');
  assertEquals(webhookConfig(envOf({ ...HOSTED, MODERATION_ALERT_WEBHOOK_URL: 'https://hooks.example.test/x', MODERATION_ALERT_WEBHOOK_SECRET: SECRET })).status, 'configured');
  assertEquals(webhookConfig(envOf({ ...HOSTED, MODERATION_ALERT_WEBHOOK_URL: 'http://hooks.example.test/x', MODERATION_ALERT_WEBHOOK_SECRET: SECRET })).status, 'invalid_url');
  assertEquals(webhookConfig(envOf({ ...HOSTED, MODERATION_ALERT_WEBHOOK_URL: 'https://u:p@hooks.example.test/x', MODERATION_ALERT_WEBHOOK_SECRET: SECRET })).status, 'invalid_url');
  assertEquals(webhookConfig(envOf({ ...HOSTED, MODERATION_ALERT_WEBHOOK_URL: 'not a url', MODERATION_ALERT_WEBHOOK_SECRET: SECRET })).status, 'invalid_url');
});

Deno.test('webhook: a local stack only posts to local hosts', () => {
  assertEquals(webhookConfig(envOf({ ...LOCAL, MODERATION_ALERT_WEBHOOK_URL: 'https://hooks.example.test/x', MODERATION_ALERT_WEBHOOK_SECRET: SECRET })).status, 'invalid_url');
  assertEquals(webhookConfig(envOf({ ...LOCAL, MODERATION_ALERT_WEBHOOK_URL: 'http://host.docker.internal:9/hook', MODERATION_ALERT_WEBHOOK_SECRET: SECRET })).status, 'configured');
});

Deno.test('payload: allow-list only, whatever the claim contains', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const claim = {
    claim_id: CLAIM_ID, status: 'ok',
    notices: [
      { kind: 'opened', code: 'child_safety_unquarantined', category: 'quarantine', severity: 'critical', count: 2,
        oldest_at: '2026-11-12T11:50:00Z', admin_ref: '/admin/moderation/quarantine',
        // anything else is dropped:
        owner_id: 'u-123', source_path: 'abc/def.jpg', reporter_id: 'r-1', details: 'secret text', sha256: 'f'.repeat(64) },
      { kind: 'opened', code: 'BAD CODE', category: 'quarantine', severity: 'critical', count: 1, admin_ref: '/admin/x' },
      { kind: 'opened', code: 'x', category: 'quarantine', severity: 'critical', count: 1, admin_ref: 'https://evil.example/x' },
    ],
    summary: [{ code: 'restore_conflict', category: 'restore', severity: 'routine', count: 1, oldest_at: null, acknowledged: true, note: 'n' }],
  };
  const p = buildPayload(claim, 'local', now);
  assertEquals(p.notices.length, 1);
  assertEquals(Object.keys(p.notices[0]).sort(), ['admin_ref', 'category', 'code', 'count', 'kind', 'oldest_age_seconds', 'severity']);
  assertEquals(p.notices[0].oldest_age_seconds, 600);
  assertEquals(Object.keys(p.summary!.issues[0]).sort(), ['acknowledged', 'category', 'code', 'count', 'oldest_age_seconds', 'severity']);
  const text = JSON.stringify(p) + JSON.stringify(composeEmail(p));
  for (const leak of ['u-123', 'abc/def.jpg', 'r-1', 'secret text', 'f'.repeat(64), 'evil.example', '"note"']) assert(!text.includes(leak), leak);
  assertThrows(() => buildPayload({ notices: [] }, '', now));
});

Deno.test('email text: subject reflects severity; counts only', () => {
  const p = buildPayload({ claim_id: CLAIM_ID, notices: [
    { kind: 'opened', code: 'integrity_failure', category: 'integrity', severity: 'critical', count: 1, oldest_at: null, admin_ref: '/admin/moderation/quarantine' }],
  }, 'staging', Date.now());
  const m = composeEmail(p);
  assert(m.subject.startsWith('[CacheCase staging] Moderation: 1 CRITICAL'));
  assert(m.html.startsWith('<pre'));
});

Deno.test('signature: valid once; tampering, wrong secret, stale or replayed are refused', async () => {
  const body = '{"a":1}';
  const ts = 1_800_000_000;
  const sig = await signAlert(SECRET, ts, CLAIM_ID, body);
  const seen = new Set<string>();
  const base = { secret: SECRET, body, timestamp: String(ts), delivery: CLAIM_ID, signature: sig, nowSeconds: ts + 10, seen };
  assertEquals(await verifyAlert(base), { ok: true });
  assertEquals(await verifyAlert(base), { ok: false, reason: 'replayed' });
  const fresh = () => new Set<string>();
  assertEquals(await verifyAlert({ ...base, seen: fresh(), body: '{"a":2}' }), { ok: false, reason: 'bad_signature' });
  assertEquals(await verifyAlert({ ...base, seen: fresh(), secret: 't'.repeat(40) }), { ok: false, reason: 'bad_signature' });
  assertEquals(await verifyAlert({ ...base, seen: fresh(), delivery: '00000000-0000-4000-8000-00000000c1a2' }), { ok: false, reason: 'bad_signature' });
  assertEquals(await verifyAlert({ ...base, seen: fresh(), nowSeconds: ts + 301 }), { ok: false, reason: 'stale' });
  assertEquals(await verifyAlert({ ...base, seen: fresh(), nowSeconds: ts - 301 }), { ok: false, reason: 'stale' });
  assertEquals(await verifyAlert({ ...base, seen: fresh(), signature: null }), { ok: false, reason: 'missing_headers' });
});
