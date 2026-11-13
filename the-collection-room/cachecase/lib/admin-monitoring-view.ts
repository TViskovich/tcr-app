// Pure view logic for the admin monitoring dashboard (app/admin/monitoring*).
// No React Native or Supabase imports, so it is unit-tested with Node's test
// runner (lib/admin-monitoring-view.test.ts).
//
// Everything here only decides how server data is SHOWN. Authorization,
// eligibility and every action are decided by the server; a label such as
// "eligible to approve" is a hint, never a permission.

export type Severity = 'critical' | 'high' | 'routine';
export type IssueStatus = 'active' | 'acknowledged' | 'resolved';
export type Tone = 'critical' | 'warning' | 'ok' | 'neutral' | 'off';

export type OpenIssue = {
  id: string;
  code: string;
  category: string;
  severity: Severity;
  count: number;
  peak_count?: number;
  oldest_at: string | null;
  opened_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  notified_at: string | null;
  last_delivery_error: string | null;
  admin_ref?: string;
};

export const ISSUE_TITLES: Record<string, string> = {
  child_safety_unquarantined: 'Child-safety media not quarantined',
  public_removal_overdue: 'Public media removal overdue',
  integrity_failure: 'Integrity check failed',
  public_origin_reachable: 'Removed original still reachable',
  scheduler_stalled: 'Quarantine scheduler stalled',
  quarantine_attempts_exhausted: 'Quarantine retries exhausted',
  quarantine_needs_attention: 'Quarantine jobs need attention',
  urgent_reports_overdue: 'Urgent reports overdue',
  restore_conflict: 'Restore conflicts',
  quarantine_lease_stale: 'Stale quarantine leases',
  purge_approval_pending: 'Purge runs awaiting approval',
  purge_run_incomplete: 'Purge runs incomplete',
};
export const issueTitle = (code: string) => ISSUE_TITLES[code] ?? code.replace(/_/g, ' ');

const RANK: Record<Severity, number> = { critical: 0, high: 1, routine: 2 };

// Open issues by severity (critical first), oldest opening first within each.
export function groupIssues(issues: OpenIssue[]): Record<Severity, OpenIssue[]> {
  const out: Record<Severity, OpenIssue[]> = { critical: [], high: [], routine: [] };
  const seen = new Set<string>();
  for (const i of [...issues].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.opened_at.localeCompare(b.opened_at))) {
    if (seen.has(i.id)) continue; // a refreshed list never shows the same issue twice
    seen.add(i.id);
    (out[i.severity] ?? out.routine).push(i);
  }
  return out;
}

export function issueStatus(i: { acknowledged_at: string | null; resolved_at?: string | null }): IssueStatus {
  if (i.resolved_at) return 'resolved';
  return i.acknowledged_at ? 'acknowledged' : 'active';
}
export const STATUS_LABEL: Record<IssueStatus, string> = { active: 'Active', acknowledged: 'Acknowledged', resolved: 'Resolved' };
export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', routine: 'Routine' };
export const severityTone = (s: Severity): Tone => (s === 'critical' ? 'critical' : s === 'high' ? 'warning' : 'neutral');

// "12 min", "3 h", "2 d" — the age of a timestamp at `now`.
export function age(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const minutes = Math.max(0, Math.floor((now - t) / 60_000));
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}
export const ago = (iso: string | null | undefined, now: number) => (iso ? `${age(iso, now)} ago` : 'never');

// ── Status strip ────────────────────────────────────────────────────────────
// Scheduler state is reported from the switch, the cron job's active flag and
// real runs — never inferred from the migration having been applied.
export type SchedulerStatus = {
  enabled: boolean;
  sweep_active: boolean;
  running: number;
  last_completed_at: string | null;
  last_failed_at: string | null;
};
export function schedulerSummary(s: SchedulerStatus, now: number): { label: string; detail: string; tone: Tone } {
  const runs = `last completed run ${ago(s.last_completed_at, now)}${s.running ? ` · ${s.running} running` : ''}`;
  if (!s.enabled && !s.sweep_active) return { label: 'Off', detail: 'Automatic quarantine is disabled; an admin must run the worker.', tone: 'off' };
  if (!s.enabled) return { label: 'Off', detail: 'The switch is off, so the sweep job dispatches nothing.', tone: 'off' };
  if (!s.sweep_active) return { label: 'Kicks only', detail: `The switch is on but the sweep job is inactive · ${runs}`, tone: 'warning' };
  return { label: 'On', detail: runs, tone: 'ok' };
}

export type MonitoringOverview = {
  delivery_enabled: boolean;
  monitor_active: boolean;
  urgent_report_minutes: number;
  channels: { email: string; webhook: string; reported_at: string | null };
  last_check_at: string | null;
  last_delivery_at: string | null;
  last_delivery_error: string | null;
  open: OpenIssue[];
  resolved_24h: number;
  needs_origin_probe: string[] | null;
};
export function monitoringSummary(m: MonitoringOverview, now: number): { label: string; detail: string; tone: Tone } {
  const job = m.monitor_active ? 'monitor job active' : 'monitor job inactive';
  if (!m.delivery_enabled) {
    return { label: 'Alerts off', detail: `Delivery is disabled · ${job} · last check ${ago(m.last_check_at, now)}`, tone: 'off' };
  }
  if (m.last_delivery_error) return { label: 'Alerts failing', detail: `Last delivery error: ${m.last_delivery_error} · ${job}`, tone: 'critical' };
  return { label: 'Alerts on', detail: `${job} · last delivery ${ago(m.last_delivery_at, now)}`, tone: m.monitor_active ? 'ok' : 'warning' };
}

const CHANNEL_LABEL: Record<string, string> = {
  configured: 'Configured',
  not_configured: 'Not configured',
  missing_recipients: 'Recipients missing or invalid',
  too_many_recipients: 'Too many recipients',
  missing_sender: 'Sender missing',
  invalid_url: 'URL invalid',
  missing_secret: 'Signing secret missing',
  unknown: 'Not reported yet',
};
export const channelLabel = (status: string | null | undefined) => CHANNEL_LABEL[status ?? 'unknown'] ?? 'Unknown';
export const channelTone = (status: string | null | undefined): Tone =>
  status === 'configured' ? 'ok' : status === 'not_configured' || !status || status === 'unknown' ? 'off' : 'warning';

// ── Quarantine queue ────────────────────────────────────────────────────────
// counts are "<state>:<desired>" → n (admin_media_quarantine_overview).
export function queueSummary(counts: Record<string, number>): { waiting: number; restorePending: number; quarantined: number; failed: number } {
  let waiting = 0, restorePending = 0, quarantined = 0, failed = 0;
  for (const [k, n] of Object.entries(counts)) {
    const [state, desired] = k.split(':');
    if (['pending', 'copied', 'verified'].includes(state) && desired !== 'restore') waiting += n;
    else if (['restore_pending', 'restoring'].includes(state)) restorePending += n;
    else if (state === 'quarantined') quarantined += n;
    else if (state === 'failed') failed += n;
  }
  return { waiting, restorePending, quarantined, failed };
}

export const RUN_STATUS_TONE: Record<string, Tone> = {
  completed: 'ok', running: 'neutral', failed: 'critical', abandoned: 'critical', stale: 'critical', refused: 'off',
};

// ── Delivery health ─────────────────────────────────────────────────────────
export type ChannelTotals = { delivered: number; failed: number };
export function channelHealth(t: ChannelTotals | undefined): { label: string; tone: Tone } {
  if (!t || (t.delivered === 0 && t.failed === 0)) return { label: 'No attempts in 24 h', tone: 'off' };
  if (t.failed === 0) return { label: `${t.delivered} delivered`, tone: 'ok' };
  return { label: `${t.failed} failed · ${t.delivered} delivered`, tone: t.delivered ? 'warning' : 'critical' };
}

// ── Purge runs (read-only) ──────────────────────────────────────────────────
export type PurgeRun = {
  id: string;
  category: string;
  status: 'prepared' | 'approved' | 'expired' | 'cancelled' | 'completed' | 'needs_attention';
  stored_status: string;
  item_count: number;
  items_by_state: Record<string, number>;
  prepared_at: string;
  approval_expires_at: string;
  approved_at: string | null;
  execution_expires_at: string | null;
  closed_at: string | null;
  prepared_by_viewer: boolean;
  approved_by_viewer: boolean;
  viewer_may_approve: boolean;
};
export const PURGE_STATUS_LABEL: Record<PurgeRun['status'], string> = {
  prepared: 'Awaiting approval', approved: 'Approved', expired: 'Expired', cancelled: 'Cancelled',
  completed: 'Completed', needs_attention: 'Needs attention',
};
export const PURGE_STATUS_TONE: Record<PurgeRun['status'], Tone> = {
  prepared: 'warning', approved: 'neutral', expired: 'off', cancelled: 'off', completed: 'ok', needs_attention: 'critical',
};
export const CATEGORY_LABEL: Record<string, string> = { report_evidence: 'Report evidence', quarantine_copy: 'Quarantine copies' };

// Approval window and the viewer's position. The server decides; this only
// explains what the viewer will see if they try (in the dedicated flow).
export function purgeApproval(run: PurgeRun, now: number): { minutesLeft: number | null; note: string } {
  if (run.status !== 'prepared') {
    return { minutesLeft: null, note: run.approved_by_viewer ? 'You approved this run.' : run.prepared_by_viewer ? 'You prepared this run.' : '' };
  }
  const left = Math.max(0, Math.ceil((Date.parse(run.approval_expires_at) - now) / 60_000));
  if (run.prepared_by_viewer) return { minutesLeft: left, note: 'You prepared this run — a different administrator must approve it.' };
  return { minutesLeft: left, note: 'A second administrator may approve it; the server re-checks eligibility when an approval is submitted.' };
}
