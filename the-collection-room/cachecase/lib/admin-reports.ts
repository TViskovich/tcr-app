import { type EnforceResult, type Enforcement, type EnforcementAction } from '@/lib/admin-enforcement-view';
import { supabase } from '@/lib/supabase';

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
