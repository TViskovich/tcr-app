// Moderation alerts (Phase 2B M4 step 5B): channel configuration, the
// outgoing payload, email text and webhook signatures. Used by
// moderation-monitor; pure functions, unit-tested in
// moderation-alerts.test.ts.
//
// Privacy: buildPayload() is an allow-list. Whatever the database returns,
// only these fields leave: environment, delivery id, time sent, and per
// notice its kind, category, code, severity, count, age of the oldest
// affected record and a fixed admin page path. No names, ids, paths, URLs,
// text, hashes, evidence or notes can be represented.
//
// Credentials are dedicated to moderation alerts (never the account-
// monitoring ones): MODERATION_ALERT_RESEND_API_KEY, MODERATION_ALERT_EMAIL_TO
// (1-5 addresses), MODERATION_ALERT_FROM_EMAIL, MODERATION_ALERT_WEBHOOK_URL,
// MODERATION_ALERT_WEBHOOK_SECRET (≥ 32 characters; a webhook is never sent
// unsigned), MODERATION_ALERT_ENVIRONMENT (label).

type Env = (name: string) => string | undefined;

const LOCAL_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'];
const KONG_HOST = /^supabase_kong_[a-z0-9_-]+$/;
export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.includes(host) || host === 'kong' || KONG_HOST.test(host);
}
function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}
// This function runs against a local Supabase stack.
export function isLocalStack(env: Env): boolean {
  const h = hostOf(env('SUPABASE_URL'));
  return h !== null && isLocalHost(h);
}

// ── Channels ────────────────────────────────────────────────────────────────
export type EmailStatus = 'configured' | 'not_configured' | 'missing_recipients' | 'too_many_recipients' | 'missing_sender';
export type WebhookStatus = 'configured' | 'not_configured' | 'invalid_url' | 'missing_secret';
const EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
export const MAX_RECIPIENTS = 5;

export function emailConfig(env: Env): { status: EmailStatus; to: string[]; from: string; apiKey: string } {
  const apiKey = env('MODERATION_ALERT_RESEND_API_KEY') ?? '';
  const none = { to: [], from: '', apiKey: '' };
  if (!apiKey) return { status: 'not_configured', ...none };
  // A local stack never talks to the real provider: only a local mock.
  if (isLocalStack(env) && !isLocalHost(hostOf(env('RESEND_API_URL')) ?? '')) return { status: 'not_configured', ...none };
  const to = (env('MODERATION_ALERT_EMAIL_TO') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (to.length > MAX_RECIPIENTS) return { status: 'too_many_recipients', ...none };
  if (to.length === 0 || !to.every((a) => EMAIL.test(a))) return { status: 'missing_recipients', ...none };
  const from = (env('MODERATION_ALERT_FROM_EMAIL') ?? '').trim();
  if (!EMAIL.test(from)) return { status: 'missing_sender', ...none };
  return { status: 'configured', to, from, apiKey };
}

export function webhookConfig(env: Env): { status: WebhookStatus; url: URL | null; secret: string } {
  const raw = env('MODERATION_ALERT_WEBHOOK_URL') ?? '';
  if (!raw) return { status: 'not_configured', url: null, secret: '' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { status: 'invalid_url', url: null, secret: '' };
  }
  const local = isLocalHost(url.hostname);
  const allowed = url.protocol === 'https:' ? (!isLocalStack(env) || local) : (url.protocol === 'http:' && local);
  if (!allowed || url.username || url.password) return { status: 'invalid_url', url: null, secret: '' };
  const secret = env('MODERATION_ALERT_WEBHOOK_SECRET') ?? '';
  if (secret.length < 32) return { status: 'missing_secret', url: null, secret: '' };
  return { status: 'configured', url, secret };
}

// ── Payload ─────────────────────────────────────────────────────────────────
const CODE = /^[a-z_]{1,48}$/;
const ADMIN_REF = /^\/admin\/[a-z/-]{1,60}$/;
const KINDS = new Set(['opened', 'worsened', 'reminder', 'resolved']);
const SEVERITIES = new Set(['critical', 'high', 'routine']);
const CATEGORIES = new Set(['quarantine', 'integrity', 'storage', 'scheduler', 'reports', 'restore', 'purge']);

export type AlertNotice = {
  kind: string; category: string; code: string; severity: string; count: number;
  oldest_age_seconds: number | null; admin_ref: string;
};
export type AlertSummaryItem = {
  category: string; code: string; severity: string; count: number; oldest_age_seconds: number | null; acknowledged: boolean;
};
export type AlertPayload = {
  source: 'cachecase-moderation-monitoring';
  version: 1;
  environment: string;
  sent_at: string;
  delivery_id: string;
  notices: AlertNotice[];
  summary: { issues: AlertSummaryItem[] } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function age(oldest: unknown, now: number): number | null {
  if (typeof oldest !== 'string') return null;
  const t = Date.parse(oldest);
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null;
}
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : null;
}
export function environmentLabel(env: Env): string {
  return (env('MODERATION_ALERT_ENVIRONMENT') ?? '').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 30);
}

// deno-lint-ignore no-explicit-any
export function buildPayload(claim: any, environment: string, now: number): AlertPayload {
  const delivery = typeof claim?.claim_id === 'string' && UUID.test(claim.claim_id) ? claim.claim_id : null;
  if (!delivery) throw new Error('invalid_claim');
  const notices: AlertNotice[] = [];
  for (const n of Array.isArray(claim.notices) ? claim.notices : []) {
    const c = count(n?.count);
    if (!KINDS.has(n?.kind) || !CODE.test(n?.code ?? '') || !SEVERITIES.has(n?.severity) || !CATEGORIES.has(n?.category)
        || c === null || !ADMIN_REF.test(n?.admin_ref ?? '')) continue;
    notices.push({ kind: n.kind, category: n.category, code: n.code, severity: n.severity, count: c,
                   oldest_age_seconds: age(n.oldest_at, now), admin_ref: n.admin_ref });
  }
  let summary: AlertPayload['summary'] = null;
  if (Array.isArray(claim.summary)) {
    const issues: AlertSummaryItem[] = [];
    for (const s of claim.summary) {
      const c = count(s?.count);
      if (!CODE.test(s?.code ?? '') || !SEVERITIES.has(s?.severity) || !CATEGORIES.has(s?.category) || c === null) continue;
      issues.push({ category: s.category, code: s.code, severity: s.severity, count: c,
                    oldest_age_seconds: age(s.oldest_at, now), acknowledged: s.acknowledged === true });
    }
    summary = { issues };
  }
  return {
    source: 'cachecase-moderation-monitoring', version: 1, environment,
    sent_at: new Date(now).toISOString(), delivery_id: delivery, notices, summary,
  };
}

// Fixed wording per code; nothing in an email comes from user data.
export const DESCRIPTIONS: Record<string, string> = {
  child_safety_unquarantined: 'Child-safety media not yet quarantined more than 5 minutes after the decision.',
  public_removal_overdue: 'Public media still at its public source more than 15 minutes after a removal decision.',
  integrity_failure: 'A checksum, copy or object-identity check failed and was flagged for review.',
  public_origin_reachable: 'A removed public original is still served by the Storage origin or CDN.',
  scheduler_stalled: 'The quarantine scheduler is on but has not completed a run while work waits.',
  quarantine_attempts_exhausted: 'Quarantine jobs used their whole retry budget and need an admin.',
  quarantine_needs_attention: 'Quarantine jobs are flagged for an admin.',
  urgent_reports_overdue: 'Urgent reports are waiting longer than the review threshold.',
  restore_conflict: 'Restorations are blocked by a conflict.',
  quarantine_lease_stale: 'Quarantine leases expired and were not picked up again.',
  purge_approval_pending: 'Manual purge runs are waiting for a second administrator.',
  purge_run_incomplete: 'Manual purge runs expired, ran out of time or have items needing attention.',
};
const KIND_LABEL: Record<string, string> = { opened: 'NEW', worsened: 'WORSE', reminder: 'STILL OPEN', resolved: 'RESOLVED' };
function ageText(s: number | null): string {
  if (s === null) return 'age unknown';
  if (s < 3600) return `oldest ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 172800) return `oldest ${Math.round(s / 3600)} h`;
  return `oldest ${Math.round(s / 86400)} d`;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function composeEmail(p: AlertPayload): { subject: string; text: string; html: string } {
  const open = p.notices.filter((n) => n.kind !== 'resolved');
  const critical = open.filter((n) => n.severity === 'critical').length;
  const high = open.filter((n) => n.severity === 'high').length;
  const head = `[CacheCase${p.environment ? ` ${p.environment}` : ''}] Moderation`;
  const subject = critical ? `${head}: ${critical} CRITICAL issue${critical === 1 ? '' : 's'}`
    : high ? `${head}: ${high} issue${high === 1 ? '' : 's'} need attention`
    : open.length === 0 && p.notices.length ? `${head}: issues resolved`
    : `${head}: daily summary`;
  const lines = [subject, '', `Sent ${p.sent_at}. Open the admin pages below for details; this message carries counts only.`, ''];
  for (const n of p.notices) {
    lines.push(`${KIND_LABEL[n.kind]}  [${n.severity}] ${n.code}: ${DESCRIPTIONS[n.code] ?? n.code} (${n.count}, ${ageText(n.oldest_age_seconds)}) — ${n.admin_ref}`);
  }
  if (p.summary) {
    lines.push('', 'Daily summary of open issues:');
    if (!p.summary.issues.length) lines.push('  none');
    for (const s of p.summary.issues) {
      lines.push(`  [${s.severity}] ${s.code}: ${s.count}, ${ageText(s.oldest_age_seconds)}${s.acknowledged ? ' (acknowledged)' : ''}`);
    }
  }
  lines.push('', `Delivery ${p.delivery_id}`);
  const text = lines.join('\n');
  return { subject, text, html: `<pre style="font-family:monospace">${esc(text)}</pre>` };
}

// ── Webhook signatures ──────────────────────────────────────────────────────
// X-CacheCase-Timestamp: unix seconds; X-CacheCase-Delivery: the delivery id;
// X-CacheCase-Signature: v1=<hex HMAC-SHA256(secret, "<ts>.<delivery>.<body>")>.
// Receivers reject a timestamp outside ±5 minutes and a delivery id they have
// already accepted (replay).
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const enc = new TextEncoder();
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function signAlert(secret: string, timestamp: number, deliveryId: string, body: string): Promise<string> {
  return `v1=${await hmacHex(secret, `${timestamp}.${deliveryId}.${body}`)}`;
}
function sameText(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
export type VerifyResult = { ok: true } | { ok: false; reason: 'missing_headers' | 'stale' | 'replayed' | 'bad_signature' };
export async function verifyAlert(o: {
  secret: string; body: string; timestamp: string | null; delivery: string | null; signature: string | null;
  nowSeconds: number; seen: Set<string>;
}): Promise<VerifyResult> {
  if (!o.timestamp || !o.delivery || !o.signature || !/^\d{1,12}$/.test(o.timestamp)) return { ok: false, reason: 'missing_headers' };
  if (Math.abs(o.nowSeconds - Number(o.timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };
  const expected = await signAlert(o.secret, Number(o.timestamp), o.delivery, o.body);
  if (!sameText(expected, o.signature)) return { ok: false, reason: 'bad_signature' };
  if (o.seen.has(o.delivery)) return { ok: false, reason: 'replayed' };
  o.seen.add(o.delivery);
  return { ok: true };
}
