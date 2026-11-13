import { supabase } from '@/lib/supabase';

import type { AuthorizedAdmins, MonitoringOverview, OpenIssue, PurgePrivileges, PurgeRun, SchedulerStatus, Severity } from '@/lib/admin-monitoring-view';

// Client for the admin monitoring dashboard. Every call is a database RPC
// made with the signed-in user's own session; each one runs
// private.require_admin() server-side (an active admin, not suspended or
// pending deletion), so a non-admin who reaches the screen gets 'forbidden'
// and nothing else. There is no service-role path and no secret in the app.
//
// RPCs (supabase/migrations):
//   admin_moderation_monitoring_overview   20261127120000 (refreshes the check)
//   admin_acknowledge_moderation_issue     20261127120000
//   admin_media_quarantine_overview        20261120120000
//   admin_media_quarantine_scheduler_status 20261126120000
//   admin_moderation_issue_detail / _history, admin_media_quarantine_scheduler_runs,
//   admin_moderation_delivery_history, admin_retention_purge_dashboard   20261128120000

export type Result<T> = { kind: 'ok'; data: T } | { kind: 'forbidden' } | { kind: 'not_found' } | { kind: 'error' };

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (!error) return { kind: 'ok', data: data as T };
    // 42501 = not signed in / not an admin / account inactive; PT404 → HTTP 404.
    if (error.code === '42501' || /forbidden|not_authenticated|account_inactive/.test(error.message ?? '')) return { kind: 'forbidden' };
    if (error.code === 'PT404' || /not_found/.test(error.message ?? '')) return { kind: 'not_found' };
    return { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}

export type QuarantineOverview = {
  counts: Record<string, number>;
  oldest_open_at: string | null;
  needs_attention: {
    id: string; kind: string; state: string; desired: string; child_safety: boolean; last_error: string | null; attempts: number; updated_at: string;
  }[];
};
export type SchedulerStatusFull = SchedulerStatus & {
  runs_24h: Record<string, number>;
  dispatches_24h: Record<string, number>;
  claimable: boolean;
  child_safety_claimable: boolean;
};
export type SchedulerRun = {
  id: string; trigger: string; status: string; started_at: string; finished_at: string | null; jobs: number;
  outcomes: Record<string, number>; error_code: string | null; duration_ms: number | null;
};
export type Page<T> = { items: T[]; next_before: string | null };
export type Delivery = {
  id: string; claimed_at: string; finished_at: string | null; outcome: 'delivered' | 'failed' | 'in_flight' | 'abandoned';
  partial: boolean; notice_count: number; includes_summary: boolean; delivered_channels: string[];
  channel_errors: Record<string, string>; error_code: string | null;
};
export type DeliveryHistory = Page<Delivery> & {
  channels_24h: { email: { delivered: number; failed: number }; webhook: { delivered: number; failed: number }; failed_attempts: number };
  retrying: { issue_id: string; code: string; severity: Severity; failures: number; last_delivery_error: string | null; last_attempt_at: string | null }[];
};
export type IssueDetail = {
  issue: OpenIssue & {
    description: string; detection: 'sql' | 'origin_probe'; status: 'active' | 'acknowledged' | 'resolved'; resolved_at: string | null;
    acknowledged_by: string | null; resolve_notified_at: string | null; delivery_failures: number; last_attempt_at: string | null;
  };
  affected: {
    live: boolean; total: number; offset: number; limit: number;
    items: { ref_kind: 'quarantine_job' | 'content_report' | 'purge_run' | 'purge_item'; ref_id: string; since: string | null; state: string;
             detail_code: string | null; child_safety: boolean; attempts: number | null }[];
  };
  events: { at: string; event: string; count: number | null; notice_kind: string | null; error_code: string | null; actor_id: string | null }[];
};
export type IssueHistoryItem = IssueDetail['issue'];
export type PurgeDashboard = Page<PurgeRun> & {
  pending_approval: number;
  needs_attention: number;
  viewer_privileges?: PurgePrivileges;   // 20261129120000
  authorized_admins?: AuthorizedAdmins;  // 20261129120000
};

export const loadMonitoringOverview = () => call<MonitoringOverview>('admin_moderation_monitoring_overview');
export const loadQuarantineOverview = () => call<QuarantineOverview>('admin_media_quarantine_overview');
export const loadSchedulerStatus = () => call<SchedulerStatusFull>('admin_media_quarantine_scheduler_status');
export const loadSchedulerRuns = (before: string | null = null, limit = 10) =>
  call<Page<SchedulerRun>>('admin_media_quarantine_scheduler_runs', { p_limit: limit, p_before: before });
export const loadDeliveryHistory = (before: string | null = null, limit = 10) =>
  call<DeliveryHistory>('admin_moderation_delivery_history', { p_limit: limit, p_before: before });
export const loadPurgeDashboard = (status: PurgeRun['status'] | null = null, before: string | null = null, limit = 10) =>
  call<PurgeDashboard>('admin_retention_purge_dashboard', { p_status: status, p_limit: limit, p_before: before });
export const loadIssueDetail = (id: string, offset = 0, limit = 25) =>
  call<IssueDetail>('admin_moderation_issue_detail', { p_issue_id: id, p_offset: offset, p_limit: limit });
export const loadIssueHistory = (status: 'active' | 'acknowledged' | 'resolved' | 'all', before: string | null = null, limit = 20) =>
  call<Page<IssueHistoryItem>>('admin_moderation_issue_history', { p_status: status, p_limit: limit, p_before: before });
export const acknowledgeIssue = (id: string) =>
  call<{ ok: boolean; acknowledged?: boolean; resolved?: boolean; changed?: boolean; reason?: string }>('admin_acknowledge_moderation_issue', { p_issue_id: id });
