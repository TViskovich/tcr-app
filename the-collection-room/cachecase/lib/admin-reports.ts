import { type EnforceResult, type Enforcement, type EnforcementAction } from '@/lib/admin-enforcement-view';
import { type Evidence, type RestoreOutcome, type ViewerResult } from '@/lib/admin-media-view';
import { supabase, supabaseAnonKey, supabaseFunctionsRegion, supabaseUrl } from '@/lib/supabase';

import {
  classifyError,
  type ApiResult,
  type CaseAction,
  type QueueFilters,
  type QueuePage,
  type ReportCase,
} from '@/lib/admin-reports-view';

// Client for the admin report review screens. Every call is a database RPC
// made with the signed-in user's own session; each one runs
// private.require_admin() server-side (signed in, an admin, not suspended,
// not pending deletion). There is no service-role path and no secret here.
// Nothing is logged: report text, evidence and identities stay in memory.
//
// RPCs (supabase/migrations/20261201120000_admin_report_review.sql):
//   admin_report_queue        queue page (metadata only)
//   admin_report_case         one report (admin_get_report, media withheld)
//   admin_report_case_action  claim | release | dismiss | reopen, refused
//                             with report_changed if the report moved on
//                             since `version`; delegates to the existing
//                             admin_claim/release/resolve/reopen_report.

async function call<T>(fn: string, args: Record<string, unknown>): Promise<ApiResult<T>> {
  try {
    const { data, error, status } = await supabase.rpc(fn, args);
    if (!error) return { kind: 'ok', data: data as T };
    return classifyError({ code: error.code, message: error.message, status });
  } catch {
    return { kind: 'error' };
  }
}

export const PAGE_SIZE = 20;

export const loadReportQueue = (f: QueueFilters, cursor: unknown | null = null) =>
  call<QueuePage>('admin_report_queue', {
    p_view: f.view,
    p_target_type: f.targetType,
    p_reason: f.reason,
    p_priority: f.priority,
    p_age: f.age,
    p_sort: f.sort,
    p_limit: PAGE_SIZE,
    p_cursor: cursor,
  });

export const loadReportCase = (id: string) => call<ReportCase>('admin_report_case', { p_report_id: id });

export const runCaseAction = (
  id: string,
  action: CaseAction,
  version: string,
  opts: { outcome?: string; reason?: string; note?: string } = {},
) =>
  call<{ id: string; status: string; changed: boolean; version: string }>('admin_report_case_action', {
    p_report_id: id,
    p_action: action,
    p_expected_version: version,
    p_outcome: opts.outcome ?? null,
    p_reason_code: opts.reason ?? null,
    p_note: opts.note?.trim() ? opts.note.trim() : null,
  });

// M5.2 — enforcement (20261202120000_admin_report_enforcement.sql).
//   admin_report_enforcement  the report's enforcement state (read-only)
//   admin_report_enforce      hide | remove | restore | clear_profile_fields |
//                             restore_profile_fields | suspend | lift_suspension,
//                             version-checked; the server derives the content,
//                             profile and account from the report and calls
//                             the existing enforcement function.
export const loadEnforcement = (id: string) => call<Enforcement>('admin_report_enforcement', { p_report_id: id });

export const runEnforcement = (
  id: string,
  action: EnforcementAction,
  version: string,
  reason: string,
  note: string,
  options: Record<string, unknown>,
) =>
  call<EnforceResult>('admin_report_enforce', {
    p_report_id: id,
    p_action: action,
    p_expected_version: version,
    p_reason_code: reason,
    p_note: note.trim() ? note.trim() : null,
    p_options: options,
  });

// M5.3 — report evidence (20261203120000_admin_report_media.sql) and the two
// admin Edge Functions. Functions are called with the admin's own session;
// each re-authorizes in the database. Nothing here is logged or cached.
export const loadEvidence = (id: string) => call<Evidence>('admin_report_evidence', { p_report_id: id });

type FnResult = { kind: 'ok'; status: number; body: any } | { kind: 'session_expired' } | { kind: 'forbidden' } | { kind: 'error' };
async function callFunction(name: string, body: unknown): Promise<FnResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { kind: 'session_expired' };
  const headers: Record<string, string> = { apikey: supabaseAnonKey, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (supabaseFunctionsRegion) headers['x-region'] = supabaseFunctionsRegion;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    if (res.status === 401) return { kind: 'session_expired' };
    if (res.status === 403) return { kind: 'forbidden' };
    const json = await res.json().catch(() => null);
    return res.ok && json ? { kind: 'ok', status: res.status, body: json } : { kind: 'error' };
  } catch {
    return { kind: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

// One evidence image of one report, by its position (never a path or URL).
export async function viewReportMedia(reportId: string, ref: number, confirmChildSafety: boolean): Promise<ViewerResult> {
  const r = await callFunction('admin-report-media', { report_id: reportId, ref, confirm_child_safety: confirmChildSafety });
  if (r.kind !== 'ok') return r;
  if (r.body.status === 'ok' && typeof r.body.signed_path === 'string') {
    return { kind: 'ok', signed_path: r.body.signed_path, expires_in: r.body.expires_in, child_safety: r.body.child_safety === true };
  }
  if (r.body.status === 'refused') return { kind: 'refused', reason: String(r.body.reason ?? '') };
  return { kind: 'error' };
}

// Restore quarantined media of THIS report's decision (existing
// admin-media-restore, scoped by report_id).
export async function restoreReportMedia(reportId: string, jobIds: string[], confirmChildSafety: boolean):
  Promise<{ kind: 'ok'; results: RestoreOutcome[] } | { kind: 'session_expired' } | { kind: 'forbidden' } | { kind: 'error' }> {
  const r = await callFunction('admin-media-restore', { job_ids: jobIds, confirm_child_safety: confirmChildSafety, report_id: reportId });
  if (r.kind !== 'ok') return r;
  return Array.isArray(r.body.results) ? { kind: 'ok', results: r.body.results as RestoreOutcome[] } : { kind: 'error' };
}
