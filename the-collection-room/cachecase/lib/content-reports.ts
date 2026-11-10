import { supabase } from '@/lib/supabase';

// Content reporting — the client half of
// supabase/migrations/20261114120000_add_content_reports.sql. The database
// decides everything (visibility, ownership, duplicates, rate limits); this
// module only calls submit_report, validates what the form sends, and turns
// the server's error tokens into words. It never reads reports back — there
// is no client read path — and never sees who else reported anything.

export type ReportTargetType =
  | 'profile'
  | 'post'
  | 'comment'
  | 'item_comment'
  | 'folder_comment'
  | 'gallery_comment'
  | 'message'
  | 'collection_item'
  | 'folder';

export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'hate'
  | 'sexual'
  | 'violence'
  | 'self_harm'
  | 'child_safety'
  | 'scam_fraud'
  | 'impersonation'
  | 'intellectual_property'
  | 'other';

// What is being reported. `id` is always the reported row's own id (the
// comment, the message …) — never a parent post or conversation id.
export type ReportTarget = {
  type: ReportTargetType;
  id: string;
  // Shown at the top of the sheet, e.g. "Comment by @sam".
  label: string;
  // The collector behind it, when the screen already knows them — only used
  // to offer Block after reporting. The server derives the owner itself.
  ownerId?: string | null;
  ownerUsername?: string | null;
};

export const REPORT_REASONS: { value: ReportReason; label: string; hint: string }[] = [
  { value: 'spam', label: 'Spam', hint: 'Repetitive, misleading or unwanted promotion' },
  { value: 'harassment', label: 'Harassment or bullying', hint: 'Targeting, insulting or intimidating someone' },
  { value: 'hate', label: 'Hate', hint: 'Attacks on people based on who they are' },
  { value: 'sexual', label: 'Sexual content', hint: 'Nudity or sexual material' },
  { value: 'violence', label: 'Violence or threats', hint: 'Threats, or encouraging violence' },
  { value: 'self_harm', label: 'Self-harm', hint: 'Someone may be at risk of hurting themselves' },
  { value: 'child_safety', label: 'Child safety', hint: 'Content that endangers or exploits a minor' },
  { value: 'scam_fraud', label: 'Scam or fraud', hint: 'Fake listings, counterfeit items or deception' },
  { value: 'impersonation', label: 'Impersonation', hint: 'Pretending to be someone else' },
  { value: 'intellectual_property', label: 'Intellectual property', hint: 'Using someone’s photos or work without permission' },
  { value: 'other', label: 'Something else', hint: 'Tell us more below' },
];

export const REPORT_DETAILS_MAX = 500;

export const REPORT_TITLES: Record<ReportTargetType, string> = {
  profile: 'Report collector',
  post: 'Report post',
  comment: 'Report comment',
  item_comment: 'Report comment',
  folder_comment: 'Report comment',
  gallery_comment: 'Report comment',
  message: 'Report message',
  collection_item: 'Report item',
  folder: 'Report collection',
};

// No promise about how fast reports are reviewed (no operational review
// process exists yet).
export const REPORT_COPY = {
  received: 'Thanks for reporting. We’ll review this against our Community Guidelines.',
  alreadyReported: 'You’ve already reported this. We’ll review it against our Community Guidelines.',
  private: 'We won’t tell them who reported it.',
};

export type ReportFailure =
  | 'session_expired'
  | 'not_found'
  | 'self'
  | 'rate_limited'
  | 'inactive'
  | 'invalid'
  | 'network'
  | 'unknown';

export const REPORT_ERROR_COPY: Record<ReportFailure, string> = {
  session_expired: 'Your session has ended. Sign in again to send this report.',
  not_found: 'This isn’t available to report anymore.',
  self: 'You can’t report your own content.',
  rate_limited: 'You’ve sent several reports recently. Please try again later.',
  inactive: 'Your account is scheduled for deletion, so reporting isn’t available.',
  invalid: 'Something about this report wasn’t right. Please choose a reason and try again.',
  network: 'Couldn’t send your report. Check your connection and try again.',
  unknown: 'Couldn’t send your report. Please try again.',
};

export function reportFailureOf(error: { message?: string; code?: string } | null | undefined): ReportFailure {
  const message = error?.message ?? '';
  if (message.includes('not_authenticated') || error?.code === 'PGRST301' || /jwt expired|invalid jwt/i.test(message)) return 'session_expired';
  if (message.includes('not_found')) return 'not_found';
  if (message.includes('cannot_report_self')) return 'self';
  if (message.includes('rate_limited')) return 'rate_limited';
  if (message.includes('account_inactive')) return 'inactive';
  if (/invalid_target_type|invalid_reason|details_too_long/.test(message)) return 'invalid';
  if (/failed to fetch|network request failed|load failed|fetch failed/i.test(message)) return 'network';
  return 'unknown';
}

export type ReportResult =
  | { ok: true; alreadyReported: boolean }
  | { ok: false; reason: ReportFailure; message: string };

// Trims the explanation; an empty one is sent as null. Over-long input is
// refused here too (the form also caps it), so the server never sees it.
export function normalizeReportDetails(details: string): string | null | false {
  const trimmed = details.trim();
  if (!trimmed) return null;
  return trimmed.length > REPORT_DETAILS_MAX ? false : trimmed;
}

export async function submitReport(target: ReportTarget, reason: ReportReason, details: string): Promise<ReportResult> {
  const normalized = normalizeReportDetails(details);
  if (normalized === false || !REPORT_REASONS.some((r) => r.value === reason)) {
    return { ok: false, reason: 'invalid', message: REPORT_ERROR_COPY.invalid };
  }
  try {
    const { data, error } = await supabase.rpc('submit_report', {
      p_target_type: target.type,
      p_target_id: target.id,
      p_reason: reason,
      p_details: normalized,
    });
    if (error) {
      const failure = reportFailureOf(error);
      return { ok: false, reason: failure, message: REPORT_ERROR_COPY[failure] };
    }
    return { ok: true, alreadyReported: (data as { already_reported?: boolean } | null)?.already_reported === true };
  } catch {
    return { ok: false, reason: 'network', message: REPORT_ERROR_COPY.network };
  }
}
