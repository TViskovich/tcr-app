// Moderation monitoring alerts (Phase 2B M4 step 5B). Server-to-server only:
// called by the database (private.run_moderation_monitor, pg_cron
// "moderation-monitor", every 5 minutes, created INACTIVE) or an operator.
//
// POST {}   Authorization: Bearer <MODERATION_MONITOR_SECRET>
// → { status, notices, summary, delivered, failed, delivery_error }   (counts and codes only)
//
// Each call:
//   1. reports which delivery channels are configured (status codes only);
//   2. moderation_monitoring_claim() — runs a check, and only when delivery
//      is switched on in the database claims the due notices (critical
//      first, at most 20) and the daily summary, if owed;
//   3. sends ONE message per channel: email (Resend) and/or a signed webhook;
//   4. records the outcome: delivered = acknowledged (2xx) by at least one
//      channel; otherwise a controlled error code — the database retries
//      with back-off and the issues stay visible to admins.
//
// Authorization: ONLY MODERATION_MONITOR_SECRET (≥ 32 characters), compared
// in constant time — no Supabase key, user token, account-maintenance or
// quarantine-worker secret. Gateway JWT verification is off (config.toml).
//
// Delivery is OFF by default twice over: the database switch
// (moderation_monitoring_state.delivery_enabled) and the channel secrets.
// Credentials are dedicated (see _shared/moderation-alerts.ts). On a local
// stack email goes only to a local mock (RESEND_API_URL) and webhooks only to
// local hosts.
//
// Privacy: the outgoing payload is built by an allow-list (buildPayload):
// environment, delivery id, time, and per issue its kind, category, code,
// severity, count, oldest age and admin page path. Logs carry codes and
// counts only — never the payload, recipients, URLs or secrets.

import { createClient } from 'npm:@supabase/supabase-js@2';

import { buildPayload, composeEmail, emailConfig, environmentLabel, signAlert, webhookConfig } from '../_shared/moderation-alerts.ts';
import { jsonResponse } from '../_shared/registry-image.ts';
import { sendResendEmail } from '../_shared/resend.ts';
import { tryResolveServiceKey } from '../_shared/service-key.ts';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024;
const env = (name: string) => Deno.env.get(name);
const SECRET = (() => {
  const value = env('MODERATION_MONITOR_SECRET') ?? '';
  return value.length >= 32 ? value : '';
})();
const SERVICE_KEY = tryResolveServiceKey();
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'moderation-monitor', ...fields }));

function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
function bearer(req: Request): string {
  const m = /^Bearer ([\x21-\x7e]{32,512})$/.exec(req.headers.get('Authorization') ?? '');
  return m ? m[1] : '';
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);
  if (!SECRET) {
    log({ outcome: 'not_configured' });
    return jsonResponse({ status: 'failed', reason: 'not_configured' }, 503);
  }
  if (!sameSecret(bearer(req), SECRET)) {
    log({ outcome: 'unauthorized' });
    return jsonResponse({ status: 'failed', reason: 'unauthorized' }, 401);
  }
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) {
    return jsonResponse({ status: 'failed', reason: 'payload_too_large' }, 413);
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jsonResponse({ status: 'failed', reason: 'payload_too_large' }, 413);
  if (raw.trim() && raw.trim() !== '{}') return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  const url = env('SUPABASE_URL');
  if (!SERVICE_KEY || !url) {
    log({ outcome: 'server_key_unavailable' });
    return jsonResponse({ status: 'failed', reason: 'server_misconfigured' }, 500);
  }
  const client = createClient(url, SERVICE_KEY.key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }) },
  });

  try {
    const email = emailConfig(env);
    const webhook = webhookConfig(env);
    const report = await client.rpc('moderation_monitoring_report_channels', { p_email: email.status, p_webhook: webhook.status });
    if (report.error) log({ outcome: 'channel_report_failed', db_code: report.error.code });

    const { data: claim, error } = await client.rpc('moderation_monitoring_claim');
    if (error) {
      log({ outcome: 'claim_failed', db_code: error.code });
      return jsonResponse({ status: 'failed', reason: 'server_error' }, 500);
    }
    if (claim?.status === 'busy') return jsonResponse({ status: 'skipped', reason: 'busy' }, 200);
    if (claim?.status === 'disabled') {
      log({ outcome: 'delivery_disabled', open: claim.open ?? null });
      return jsonResponse({ status: 'ok', delivery: 'disabled', notices: 0 }, 200);
    }
    if (!claim?.claim_id) return jsonResponse({ status: 'ok', notices: 0, summary: false }, 200);

    const payload = buildPayload(claim, environmentLabel(env), Date.now());
    const body = JSON.stringify(payload);
    const delivered: string[] = [];
    const failed: string[] = [];
    if (email.status === 'configured') {
      const message = composeEmail(payload);
      const result = await sendResendEmail({ apiKey: email.apiKey, to: email.to, from: email.from, ...message });
      if (result.sent) delivered.push('email');
      else failed.push(result.reason);
    }
    if (webhook.status === 'configured' && webhook.url) {
      const ts = Math.floor(Date.now() / 1000);
      try {
        const res = await fetch(webhook.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            'X-CacheCase-Timestamp': String(ts),
            'X-CacheCase-Delivery': payload.delivery_id,
            'X-CacheCase-Signature': await signAlert(webhook.secret, ts, payload.delivery_id, body),
          },
          body,
        });
        await res.body?.cancel();
        if (res.ok) delivered.push('webhook');
        else failed.push('webhook_rejected');
      } catch {
        failed.push('webhook_unreachable');
      }
    }
    const deliveryError = delivered.length ? null : failed[0]
      ?? (email.status === 'missing_recipients' ? 'alert_recipients_missing'
        : email.status === 'too_many_recipients' ? 'alert_too_many_recipients'
        : email.status === 'missing_sender' ? 'alert_sender_missing'
        : webhook.status === 'invalid_url' ? 'alert_webhook_invalid'
        : webhook.status === 'missing_secret' ? 'alert_webhook_unsigned'
        : 'alert_channel_not_configured');
    const rec = await client.rpc('moderation_monitoring_record_delivery', {
      p_claim_id: payload.delivery_id, p_error: deliveryError, p_channels: delivered,
    });
    if (rec.error) log({ outcome: 'delivery_report_failed', db_code: rec.error.code });
    log({
      outcome: 'delivery', notices: payload.notices.map((n) => `${n.kind}:${n.code}`), summary: payload.summary !== null,
      delivered, failed, delivery_error: deliveryError,
    });
    return jsonResponse({
      status: 'ok', notices: payload.notices.length, summary: payload.summary !== null, delivered, failed, delivery_error: deliveryError,
    }, 200);
  } catch (e) {
    log({ outcome: 'run_failed', error: (e as Error).name });
    return jsonResponse({ status: 'failed', reason: 'server_error' }, 500);
  }
});
