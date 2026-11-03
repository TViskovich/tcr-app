// Account deletion monitoring alerts — beta launch hardening.
//
// Called by pg_cron (private.run_account_monitor, every 15 minutes, when a
// notice is due or the channel report below is over 6 h old;
// 20261108120000_account_deletion_monitoring.sql), or by an operator to
// verify the setup. Each call:
//   1. reports which channels are configured (status codes only), so
//      admins can see whether alerts can reach anyone;
//   2. claims the due notices (an issue opened, still open after 24 h, or
//      resolved), sends ONE digest through every configured channel, and
//      reports the outcome: delivered = acknowledged (2xx) by at least one
//      channel; otherwise a controlled error code, retried after an hour.
//
// Channels (each optional; none configured → the notice is logged and
// stays undelivered, visible to admins in the Dashboard):
//   email    RESEND_API_KEY (existing), ACCOUNT_ALERT_EMAIL_TO (comma-
//            separated, ≤ 5), ACCOUNT_ALERT_FROM_EMAIL (defaults to
//            WAITLIST_FROM_EMAIL, the existing verified sender)
//   webhook  ACCOUNT_ALERT_WEBHOOK_URL (https; http only for a local host)
//            and optionally ACCOUNT_ALERT_WEBHOOK_SECRET (≥ 32 characters):
//            the body is signed, X-CacheCase-Signature: sha256=<hex HMAC>
//   label    ACCOUNT_ALERT_ENVIRONMENT, e.g. "production" (subject line)
//
// {"action":"test"} (operators verifying delivery): sends one clearly
// labelled test notice through the configured channels and nothing else —
// no alert, job, monitoring or collector record is read or written. Only
// the maintenance secret is accepted; the service role key is not. Rate
// limited in the database (1 per 10 minutes, 5 per 24 hours;
// 20261109120000_account_monitoring_test_email.sql). The response names
// the channels that accepted it — never recipients, URLs or keys.
//
// Content: issue codes, counts and timestamps only — never emails,
// usernames, account or job ids. Recipients and URLs are never logged.
//
// Authorization: ACCOUNT_MAINTENANCE_SECRET (≥ 32 characters) or the
// service role key; gateway JWT verification is off (config.toml).

import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse } from '../_shared/registry-image.ts';
import { sendResendEmail } from '../_shared/resend.ts';

const REQUEST_TIMEOUT_MS = 10_000;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const client = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }) },
});
const MAINTENANCE_SECRET = (() => {
  const value = Deno.env.get('ACCOUNT_MAINTENANCE_SECRET') ?? '';
  return value.length >= 32 ? value : '';
})();
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'account-monitor', ...fields }));

type Notice = { code: string; kind: 'opened' | 'reminder' | 'resolved'; opened_at: string; resolved_at: string | null };
type Snapshot = {
  status: 'healthy' | 'attention';
  issues: string[];
  checked_at: string;
  scheduler: Record<string, unknown>;
  deletions: Record<string, unknown>;
  exports: Record<string, unknown>;
};

const ISSUE_TEXT: Record<string, string> = {
  scheduler_not_configured: 'The maintenance scheduler is not configured (Vault project_url / account_maintenance_secret, or the username reservation key).',
  scheduler_inactive: 'The maintenance scheduler is inactive while deletions are pending.',
  maintenance_runs_missing: 'No successful maintenance run for over 30 minutes.',
  maintenance_calls_failing: 'The last 3 scheduled calls to account-maintenance failed.',
  deletions_failed: 'One or more permanent deletions failed and need an admin.',
  deletions_overdue: 'Scheduled deletions have not started more than 1 hour after their recovery window ended.',
  deletions_stuck: 'Deletion jobs have been in progress for more than 1 hour.',
  deletion_leases_expired: 'Deletion jobs hold leases that expired over 15 minutes ago and were not picked up again.',
  exports_failing: 'Three or more Download My Data exports failed in the last 24 hours.',
  exports_stuck: 'Download My Data exports have been in progress, untouched, for over 25 hours.',
};

function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

type EmailStatus = 'configured' | 'not_configured' | 'missing_recipients' | 'missing_sender';
type WebhookStatus = 'configured' | 'not_configured' | 'invalid_url';

// Email needs the existing Resend key; with it, a sender and ≥ 1 valid
// recipient. Without the key email is simply not in use.
function emailConfig(): { status: EmailStatus; to: string[]; from: string } {
  const to = (Deno.env.get('ACCOUNT_ALERT_EMAIL_TO') ?? '').split(',').map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)).slice(0, 5);
  const from = Deno.env.get('ACCOUNT_ALERT_FROM_EMAIL') || Deno.env.get('WAITLIST_FROM_EMAIL') || '';
  const status: EmailStatus = !Deno.env.get('RESEND_API_KEY') ? 'not_configured'
    : to.length === 0 ? 'missing_recipients' : !from ? 'missing_sender' : 'configured';
  return { status, to, from };
}

function webhookConfig(): { status: WebhookStatus; url: URL | null } {
  const raw = Deno.env.get('ACCOUNT_ALERT_WEBHOOK_URL') ?? '';
  if (!raw) return { status: 'not_configured', url: null };
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return { status: 'configured', url };
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', 'host.docker.internal'].includes(url.hostname)) return { status: 'configured', url };
  } catch {}
  return { status: 'invalid_url', url: null };
}
const webhookSecret = () => {
  const value = Deno.env.get('ACCOUNT_ALERT_WEBHOOK_SECRET') ?? '';
  return value.length >= 32 ? value : '';
};

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function compose(notices: Notice[], snap: Snapshot) {
  const env = (Deno.env.get('ACCOUNT_ALERT_ENVIRONMENT') ?? '').replace(/[^\w .-]/g, '').slice(0, 30);
  const open = notices.filter((n) => n.kind !== 'resolved');
  const subject = `[CacheCase${env ? ` ${env}` : ''}] Account deletions: ${
    open.length ? `${open.length} issue${open.length === 1 ? '' : 's'} need attention` : 'issues resolved'}`;
  const d = snap.deletions;
  const e = snap.exports;
  const s = snap.scheduler;
  const lines = [
    subject,
    '',
    ...notices.map((n) => `${n.kind === 'resolved' ? 'RESOLVED' : n.kind === 'reminder' ? 'STILL OPEN' : 'NEW'}  ${n.code}: ${
      ISSUE_TEXT[n.code] ?? n.code} (since ${n.opened_at}${n.resolved_at ? `, resolved ${n.resolved_at}` : ''})`),
    '',
    `Overall: ${snap.status}${snap.issues.length ? ` (${snap.issues.join(', ')})` : ''}`,
    `Scheduler: ${s.active ? 'active' : 'inactive'}, ${s.configured ? 'configured' : 'NOT configured'}; last successful run ${
      s.last_successful_run_at ?? 'never'}; consecutive failed calls ${s.consecutive_failed_calls}`,
    `Deletions: ${d.pending} pending, ${d.overdue_scheduled} overdue, ${d.in_progress} in progress (${d.stuck_over_1h} over 1 h, ${
      d.expired_leases} expired leases), ${d.failed} failed`,
    `Exports (24 h): ${e.failed_24h} failed, ${e.abandoned_24h} abandoned; ${e.stuck} stuck`,
    '',
    'Details: Dashboard → Admin Tools → Account Deletions, the account-maintenance function logs, and',
    'docs/launch/account-deletion-deployment-runbook.md (Monitoring and alerts).',
    `Checked ${snap.checked_at}.`,
  ];
  const text = lines.join('\n');
  const escape = (v: string) => v.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return { subject, text, html: `<pre style="font-family:ui-monospace,monospace;font-size:13px">${escape(text)}</pre>` };
}

async function deliver(notices: Notice[], snap: Snapshot): Promise<{ delivered: string[]; failed: string[] }> {
  const message = compose(notices, snap);
  const delivered: string[] = [];
  const failed: string[] = [];

  const email = emailConfig();
  if (email.status === 'configured') {
    const result = await sendResendEmail({ to: email.to, from: email.from, subject: message.subject, text: message.text, html: message.html });
    if (result.sent) delivered.push('email');
    else failed.push(result.reason);
  }

  const { url } = webhookConfig();
  if (url) {
    const body = JSON.stringify({
      source: 'cachecase-account-monitoring',
      text: message.text,
      content: message.text.slice(0, 1900),
      status: snap.status,
      issues: snap.issues,
      notices: notices.map((n) => ({ code: n.code, kind: n.kind, opened_at: n.opened_at, resolved_at: n.resolved_at })),
      scheduler: snap.scheduler,
      deletions: snap.deletions,
      exports: snap.exports,
      checked_at: snap.checked_at,
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const secret = webhookSecret();
    if (secret) headers['X-CacheCase-Signature'] = `sha256=${await sign(body, secret)}`;
    try {
      const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      await res.body?.cancel();
      if (res.ok) delivered.push('webhook');
      else failed.push('webhook_rejected');
    } catch {
      failed.push('webhook_unreachable');
    }
  }
  return { delivered, failed };
}

const TEST_BODY = 'This is a test of CacheCase\'s account-deletion monitoring alerts. No account deletion or data changes were triggered.';

function testMessage() {
  const env = (Deno.env.get('ACCOUNT_ALERT_ENVIRONMENT') ?? '').replace(/[^\w .-]/g, '').slice(0, 30);
  const subject = `[CacheCase${env ? ` ${env}` : ''}] Monitoring Test`;
  const escape = (v: string) => v.replace(/[&<>']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;' })[c]!);
  return { subject, text: TEST_BODY, html: `<p>${escape(TEST_BODY)}</p>` };
}

// The test operation: takes a rate-limit slot, sends, records the outcome.
async function sendTest(): Promise<Response> {
  const email = emailConfig();
  const webhook = webhookConfig();
  const channels = { email: email.status, webhook: webhook.status };
  if (email.status !== 'configured' && webhook.status !== 'configured') {
    // Nothing would be sent: answer without taking a slot.
    const reason = email.status === 'missing_recipients' ? 'alert_recipients_missing'
      : email.status === 'missing_sender' ? 'alert_sender_missing'
      : webhook.status === 'invalid_url' ? 'alert_webhook_invalid'
      : 'alert_channel_not_configured';
    log({ outcome: 'test_not_configured', reason, ...channels });
    return jsonResponse({ status: 'failed', test: true, reason, accepted: [], failed: [], channels }, 409);
  }

  const { data: slot, error: slotError } = await client.rpc('account_monitoring_take_test_slot');
  if (slotError) {
    log({ outcome: 'test_slot_failed', db_code: slotError.code });
    return jsonResponse({ status: 'failed', test: true, reason: 'server_error' }, 500);
  }
  const s = slot as { allowed: boolean; slot?: number; retry_after_seconds?: number };
  if (!s.allowed) {
    log({ outcome: 'test_rate_limited', retry_after_seconds: s.retry_after_seconds });
    return new Response(JSON.stringify({ status: 'failed', test: true, reason: 'rate_limited', retry_after_seconds: s.retry_after_seconds }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(s.retry_after_seconds ?? 600) },
    });
  }

  const message = testMessage();
  const accepted: string[] = [];
  const failed: string[] = [];
  if (email.status === 'configured') {
    const result = await sendResendEmail({ to: email.to, from: email.from, ...message });
    if (result.sent) accepted.push('email');
    else failed.push(result.reason);
  }
  if (webhook.url) {
    const body = JSON.stringify({ source: 'cachecase-account-monitoring', test: true, subject: message.subject, text: message.text, content: message.text });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const secret = webhookSecret();
    if (secret) headers['X-CacheCase-Signature'] = `sha256=${await sign(body, secret)}`;
    try {
      const res = await fetch(webhook.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      await res.body?.cancel();
      if (res.ok) accepted.push('webhook');
      else failed.push('webhook_rejected');
    } catch {
      failed.push('webhook_unreachable');
    }
  }
  const outcome = accepted.length ? 'delivered' : failed[0] ?? 'not_delivered';
  const { error: recordError } = await client.rpc('account_monitoring_record_test', { p_slot: s.slot, p_outcome: outcome, p_channels: accepted });
  if (recordError) log({ outcome: 'test_record_failed', db_code: recordError.code });
  log({ outcome: 'test', delivered: accepted, failed });
  return jsonResponse({ status: accepted.length ? 'ok' : 'failed', test: true, accepted, failed, channels }, accepted.length ? 200 : 502);
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  let body: { action?: unknown } = {};
  try {
    body = await req.json();
  } catch {}
  if (body?.action === 'test') {
    // Maintenance secret only; checked before anything else happens.
    if (!sameSecret(token, MAINTENANCE_SECRET)) return jsonResponse({ status: 'failed', reason: 'forbidden' }, 403);
    try {
      return await sendTest();
    } catch (e) {
      log({ outcome: 'test_failed', error: (e as Error).message.slice(0, 160) });
      return jsonResponse({ status: 'failed', test: true, reason: 'server_error' }, 500);
    }
  }
  if (!sameSecret(token, MAINTENANCE_SECRET) && !sameSecret(token, SERVICE_KEY)) {
    return jsonResponse({ status: 'failed', reason: 'forbidden' }, 403);
  }
  if (body?.action !== undefined) return jsonResponse({ status: 'failed', reason: 'invalid_action' }, 400);
  try {
    const email = emailConfig().status;
    const webhook = webhookConfig().status;
    const channels = { email, webhook, webhook_signed: webhook === 'configured' && !!webhookSecret() };
    const { error: reportError } = await client.rpc('account_monitoring_report_channels', {
      p_email: email, p_webhook: webhook, p_webhook_signed: channels.webhook_signed,
    });
    if (reportError) log({ outcome: 'channel_report_failed', db_code: reportError.code });
    if (email !== 'configured' && webhook !== 'configured') {
      log({ alert: 'account_monitoring_no_channel', email, webhook });
    }

    const { data, error } = await client.rpc('account_monitoring_claim_notices');
    if (error) {
      log({ outcome: 'claim_failed', db_code: error.code });
      return jsonResponse({ status: 'failed', reason: 'server_error' }, 500);
    }
    const { claimed_at, notices, snapshot } = data as { claimed_at: string; notices: Notice[]; snapshot: Snapshot };
    if (notices.length === 0) return jsonResponse({ status: 'ok', notices: 0, channels }, 200);

    const { delivered, failed } = await deliver(notices, snapshot);
    // Acknowledged by at least one channel counts as delivered.
    const deliveryError = delivered.length ? null : failed[0]
      ?? (email === 'missing_recipients' ? 'alert_recipients_missing'
        : email === 'missing_sender' ? 'alert_sender_missing'
        : webhook === 'invalid_url' ? 'alert_webhook_invalid'
        : 'alert_channel_not_configured');
    const { error: recordError } = await client.rpc('account_monitoring_record_delivery', {
      p_claimed_at: claimed_at, p_error: deliveryError, p_channels: delivered,
    });
    if (recordError) log({ outcome: 'delivery_report_failed', db_code: recordError.code });
    // The log line is itself an alert channel (Supabase logs / log drains).
    log({
      alert: 'account_deletion_monitoring', status: snapshot.status, issues: snapshot.issues,
      notices: notices.map((n) => `${n.kind}:${n.code}`), delivered, failed, delivery_error: deliveryError,
    });
    return jsonResponse({ status: 'ok', notices: notices.length, channels, delivered, failed, delivery_error: deliveryError }, 200);
  } catch (e) {
    log({ outcome: 'run_failed', error: (e as Error).message.slice(0, 160) });
    return jsonResponse({ status: 'failed', reason: 'server_error' }, 500);
  }
});
