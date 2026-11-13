// Pure view logic for the Enforcement section of the admin report screen
// (components/admin/report-enforcement.tsx). No React Native or Supabase
// imports, so it is unit-tested with Node's test runner
// (lib/admin-enforcement-view.test.ts).
//
// Action names, reason codes, dispositions and options are the EXISTING
// backend's (private.moderation_reason_valid and the admin_* enforcement
// functions, reached through public.admin_report_enforce). The server
// re-validates every one of them; `available` flags are hints.

import { ago, codeLabel, TARGET_LABEL, type Tone } from './admin-reports-view.ts';

export type EnforcementAction =
  | 'hide' | 'remove' | 'restore' | 'clear_profile_fields' | 'restore_profile_fields' | 'suspend' | 'lift_suspension';
export const ACTION_ORDER: EnforcementAction[] = ['hide', 'remove', 'restore', 'clear_profile_fields', 'restore_profile_fields', 'suspend', 'lift_suspension'];

export type MediaSummary = {
  total: number; by_state: Record<string, number>; in_progress: number; awaiting_restore?: number; needs_attention: number; legal_hold: number;
  errors: string[]; automatic: boolean;
};
export type Enforcement = {
  version: string;
  report_status: 'open' | 'reviewing' | 'actioned' | 'dismissed';
  claim: 'none' | 'mine' | 'other' | 'stale';
  child_safety: boolean;
  legal_hold: boolean;
  target: { type: string; exists: boolean; other_pending_reports: number };
  restriction: {
    target_type: string; state: 'hidden' | 'removed' | 'lifted'; active: boolean; linked: boolean; child_safety: boolean;
    reason_code: string; created_at: string; created_by_me: boolean; acted_by_me: boolean; lifted_at: string | null;
    lift_reason: string | null; reports_linked: number;
  } | null;
  media: MediaSummary;
  profile: {
    restricted_fields: { field: string; status: string; created_at: string; mine: boolean; current_is_cleared: boolean }[];
    clearable_fields: string[];
  } | null;
  account: {
    present: boolean; is_admin?: boolean; lifecycle?: string; suspended?: boolean; suspensions_total?: number;
    suspension?: {
      state: 'active' | 'expired' | 'lifted'; reason_code: string; child_safety: boolean; created_at: string;
      expires_at: string | null; lifted_at: string | null; lift_reason: string | null; created_by_me: boolean; from_this_report: boolean;
    } | null;
  };
  actions: Record<EnforcementAction, { available: boolean; blocked: string | null }>;
};
export type EnforceResult = {
  action: EnforcementAction; changed: boolean; report_status: string; version: string; related_resolved: number;
  cleared?: string[] | null; already_locked?: string[] | null; ended?: string[] | null; not_restricted?: string[] | null;
  public_media_still_reachable?: string[] | null; profile_restriction?: string | null; media: MediaSummary;
};

// ── Reason codes (private.moderation_reason_valid) ──────────────────────────
const REMOVE_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm', 'child_safety', 'scam_fraud',
  'impersonation', 'intellectual_property', 'other_violation'];
export const REASONS: Record<EnforcementAction, string[]> = {
  hide: ['pending_review', 'urgent_risk'],
  remove: REMOVE_REASONS,
  clear_profile_fields: REMOVE_REASONS,
  restore: ['resolved_in_error', 'new_information', 'appeal_granted', 'child_safety_review_cleared'],
  restore_profile_fields: ['resolved_in_error', 'new_information', 'appeal_granted', 'child_safety_review_cleared'],
  suspend: [...REMOVE_REASONS.filter((r) => r !== 'other_violation'), 'repeat_violations', 'ban_evasion', 'urgent_risk', 'other_violation'],
  lift_suspension: ['resolved_in_error', 'new_information', 'appeal_granted', 'child_safety_review_cleared'],
};
export const CHILD_SAFETY_CLEARED = 'child_safety_review_cleared';
export const PROFILE_FIELDS = ['display_name', 'bio', 'tagline', 'location', 'website', 'hero_display_name', 'avatar_url', 'hero_image_url', 'showcase_badge_url'];
export const FIELD_LABEL: Record<string, string> = {
  display_name: 'Display name', bio: 'Bio', tagline: 'Tagline', location: 'Location', website: 'Website',
  hero_display_name: 'Hero display name', avatar_url: 'Avatar', hero_image_url: 'Hero image', showcase_badge_url: 'Showcase badge',
};
const MEDIA_FIELDS = ['avatar_url', 'hero_image_url', 'showcase_badge_url'];

export const ACTION_LABEL: Record<EnforcementAction, string> = {
  hide: 'Hide content', remove: 'Remove content', restore: 'Restore content', clear_profile_fields: 'Clear profile fields',
  restore_profile_fields: 'Restore profile fields', suspend: 'Suspend account', lift_suspension: 'Lift suspension',
};
const REASON_EXTRA: Record<string, string> = {
  pending_review: 'Pending review', urgent_risk: 'Urgent risk', other_violation: 'Other violation', repeat_violations: 'Repeat violations',
  ban_evasion: 'Ban evasion', appeal_granted: 'Appeal granted', child_safety_review_cleared: 'Child-safety review cleared',
  spam: 'Spam', harassment: 'Harassment', hate: 'Hate', sexual: 'Sexual content', violence: 'Violence', self_harm: 'Self-harm',
  child_safety: 'Child safety', scam_fraud: 'Scam or fraud', impersonation: 'Impersonation', intellectual_property: 'Intellectual property',
  keep_reviewing: 'Keep reviewing', reopen: 'Reopen the reports', overturn: 'Overturn (dismiss the reports)',
};
export const reasonLabel = (code: string | null | undefined) => (code ? REASON_EXTRA[code] ?? codeLabel(code) : '—');

// ── Which actions to show ───────────────────────────────────────────────────
// Only actions that apply to the reported content type are listed at all;
// of those, the unavailable ones carry a short reason.
export function relevantActions(e: Enforcement): EnforcementAction[] {
  const profile = e.target.type === 'profile';
  return ACTION_ORDER.filter((a) => {
    if (a === 'hide' || a === 'remove' || a === 'restore') return !profile;
    if (a === 'clear_profile_fields' || a === 'restore_profile_fields') return profile;
    return e.account.present; // suspend / lift
  }).filter((a) => {
    const s = e.actions[a];
    if (s.available) return true;
    // Hide noise that can't apply in the current state.
    return !['unsupported_target', 'use_profile_restore', 'owner_unavailable', 'not_restricted', 'not_suspended', 'already_suspended'].includes(s.blocked ?? '');
  });
}

const BLOCKED_TEXT: Record<string, string> = {
  claim_required: 'Claim the report first.',
  claimed_by_other: 'Another administrator is reviewing this report.',
  already_resolved: 'The report is already resolved.',
  already_removed: 'The content is already removed.',
  already_hidden: 'The content is already hidden.',
  target_not_found: 'The reported content no longer exists.',
  nothing_to_clear: 'The profile has no fields left to clear.',
  restricted_via_other_report: 'The restriction was placed through another report; restore it from that report.',
  child_safety_second_admin_required: 'Child-safety restriction you applied — awaiting review by a second administrator.',
  second_admin_required: 'Child-safety suspension you imposed — awaiting review by a second administrator.',
  cannot_suspend_admin: 'Administrators can’t be suspended from the app.',
  cannot_suspend_self: 'You can’t suspend your own account.',
  account_deleting: 'The account is being deleted.',
  already_suspended: 'The account is already suspended.',
  not_suspended: 'The account is not suspended.',
  not_restricted: 'Nothing is restricted.',
};
export const blockedEnforcementText = (code: string | null | undefined) => (code ? BLOCKED_TEXT[code] ?? codeLabel(code) : null);
export const awaitingSecondAdmin = (e: Enforcement) =>
  ['restore', 'restore_profile_fields', 'lift_suspension'].some((a) =>
    ['child_safety_second_admin_required', 'second_admin_required'].includes(e.actions[a as EnforcementAction].blocked ?? ''));

// ── Child-safety requirements of a reversal (enforced by the server) ───────
export function childSafetyReversal(action: EnforcementAction, e: Enforcement): boolean {
  if (action === 'restore' || action === 'restore_profile_fields') return !!e.restriction?.child_safety;
  if (action === 'lift_suspension') return !!e.account.suspension?.child_safety;
  return false;
}
export function reasonsFor(action: EnforcementAction, e: Enforcement): string[] {
  const cs = childSafetyReversal(action, e);
  if (['restore', 'restore_profile_fields', 'lift_suspension'].includes(action)) {
    return cs ? [CHILD_SAFETY_CLEARED] : REASONS[action].filter((r) => r !== CHILD_SAFETY_CLEARED);
  }
  return REASONS[action];
}

// restore: keep_reviewing only while hidden and no linked report is resolved
// (the server re-checks); profile restore: a disposition exactly when the
// last restricted field is restored.
export function dispositionsFor(action: EnforcementAction, e: Enforcement, fields: string[] = []): string[] {
  if (action === 'restore') {
    const keep = e.restriction?.state === 'hidden' && (e.report_status === 'open' || e.report_status === 'reviewing');
    return keep ? ['keep_reviewing', 'reopen', 'overturn'] : ['reopen', 'overturn'];
  }
  if (action === 'restore_profile_fields') {
    const active = (e.profile?.restricted_fields ?? []).map((f) => f.field);
    return active.length > 0 && active.every((f) => fields.includes(f)) ? ['reopen', 'overturn'] : [];
  }
  return [];
}
export function fieldsFor(action: EnforcementAction, e: Enforcement): string[] {
  if (action === 'clear_profile_fields') return e.profile?.clearable_fields ?? [];
  if (action === 'restore_profile_fields') return (e.profile?.restricted_fields ?? []).map((f) => f.field);
  return [];
}

export const EXPIRY_PRESETS: { key: string; label: string; hours: number | null }[] = [
  { key: '24h', label: '24 hours', hours: 24 }, { key: '7d', label: '7 days', hours: 24 * 7 },
  { key: '30d', label: '30 days', hours: 24 * 30 }, { key: 'indefinite', label: 'Indefinite', hours: null },
];
export const expiryFor = (key: string, now: number): string | null => {
  const p = EXPIRY_PRESETS.find((x) => x.key === key);
  return p && p.hours !== null ? new Date(now + p.hours * 3_600_000).toISOString() : null;
};

export type EnforceParams = {
  reason: string | null; note: string; fields: string[]; disposition: string | null; expiry: string | null;
  includeRelated: boolean; confirmChildSafety: boolean;
};
export const emptyParams = (action: EnforcementAction): EnforceParams => ({
  reason: null, note: '', fields: [], disposition: null, expiry: action === 'suspend' ? '7d' : null,
  includeRelated: action === 'remove', confirmChildSafety: false,
});

// What is still missing before the confirmation can be shown (UI only).
export function missingInput(action: EnforcementAction, e: Enforcement, p: EnforceParams): string | null {
  if (!p.reason || !reasonsFor(action, e).includes(p.reason)) return 'Choose a reason.';
  if ((action === 'clear_profile_fields' || action === 'restore_profile_fields') && p.fields.length === 0) return 'Choose at least one field.';
  const disp = dispositionsFor(action, e, p.fields);
  if (disp.length > 0 && (!p.disposition || !disp.includes(p.disposition))) return 'Choose what happens to the reports.';
  if (action === 'suspend' && !p.expiry) return 'Choose a duration.';
  if (childSafetyReversal(action, e)) {
    if (!p.note.trim()) return 'A child-safety reversal needs a note explaining the review.';
    if (!p.confirmChildSafety) return 'Confirm the child-safety review.';
  }
  return null;
}

// The arguments sent to admin_report_enforce. Targets are never sent: the
// server derives the content, profile and account from the report.
export function enforceOptions(action: EnforcementAction, p: EnforceParams, now: number): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (action === 'remove' || action === 'clear_profile_fields') o.include_related = p.includeRelated;
  if (action === 'clear_profile_fields' || action === 'restore_profile_fields') o.fields = p.fields;
  if ((action === 'restore' || action === 'restore_profile_fields') && p.disposition) o.disposition = p.disposition;
  if (action === 'restore' || action === 'restore_profile_fields' || action === 'lift_suspension') o.confirm_child_safety = p.confirmChildSafety;
  if (action === 'suspend' && p.expiry) {
    const at = expiryFor(p.expiry, now);
    if (at) o.expires_at = at;
  }
  return o;
}

// ── Confirmation ────────────────────────────────────────────────────────────
// Exact action, the target, the reason, the effects, whether it can be
// undone and whether another administrator is needed.
export function confirmEnforcement(action: EnforcementAction, e: Enforcement, p: EnforceParams, owner: string | null) {
  const target = TARGET_LABEL[e.target.type] ?? e.target.type;
  const who = owner ? `@${owner}` : 'the reported account';
  const cs = e.child_safety || p.reason === 'child_safety';
  const lines: string[] = [];
  let reversible = '';
  let second = '';
  switch (action) {
    case 'hide':
      lines.push(`Hides this ${target.toLowerCase()} from everyone but its owner while you keep reviewing. The report stays claimed by you.`);
      reversible = 'Reversible: Restore content.';
      break;
    case 'remove':
      lines.push(`Removes this ${target.toLowerCase()} from public view and resolves this report as “Content removed”.`);
      if (p.includeRelated && e.target.other_pending_reports) lines.push(`Also resolves ${e.target.other_pending_reports} other pending report(s) on the same content.`);
      lines.push('Nothing is deleted; the owner still sees it. Media is queued for quarantine.');
      reversible = 'Reversible: Restore content.';
      break;
    case 'restore':
      lines.push(`Lifts the ${e.restriction?.state ?? ''} restriction on this ${target.toLowerCase()} and returns its media.`);
      lines.push(`Linked reports (${e.restriction?.reports_linked ?? 1}): ${reasonLabel(p.disposition)}.`);
      reversible = 'Can be restricted again later.';
      break;
    case 'clear_profile_fields':
      lines.push(`Clears ${p.fields.map((f) => FIELD_LABEL[f] ?? f).join(', ')} on ${who}'s profile and locks them; resolves this report as “Content removed”.`);
      if (p.fields.some((f) => MEDIA_FIELDS.includes(f))) lines.push('Cleared images are queued for quarantine.');
      reversible = 'Reversible: Restore profile fields (the original values are kept server-side).';
      break;
    case 'restore_profile_fields':
      lines.push(`Restores ${p.fields.map((f) => FIELD_LABEL[f] ?? f).join(', ')} on ${who}'s profile to their original values.`);
      if (p.disposition) lines.push(`This lifts the last field restriction; linked reports: ${reasonLabel(p.disposition)}.`);
      reversible = 'Fails safely if the collector has since set a new value.';
      break;
    case 'suspend': {
      const exp = EXPIRY_PRESETS.find((x) => x.key === p.expiry);
      lines.push(`Suspends ${who} ${exp?.hours ? `for ${exp.label}` : 'indefinitely'}: their profile and content are hidden and they can’t post or message.`);
      lines.push('They keep account deletion and Download My Data. Nothing is deleted.');
      reversible = 'Reversible: Lift suspension.';
      break;
    }
    case 'lift_suspension':
      lines.push(`Lifts ${who}'s suspension; their profile and content become visible again.`);
      reversible = 'Can be suspended again later.';
      break;
  }
  if (childSafetyReversal(action, e)) second = 'Child-safety reversal: allowed only for an administrator other than the one who imposed it.';
  else if (cs && ['hide', 'remove', 'clear_profile_fields', 'suspend'].includes(action)) second = 'Child safety: reversing this later will require a different administrator.';
  else second = 'No second administrator is required.';
  return {
    title: ACTION_LABEL[action],
    message: [`${target} · reason: ${reasonLabel(p.reason)}`, ...lines, reversible, second].filter(Boolean).join('\n\n'),
    confirm: ACTION_LABEL[action].split(' ')[0],
    destructive: action === 'remove' || action === 'suspend' || action === 'clear_profile_fields' || action === 'hide',
  };
}

// ── State lines ─────────────────────────────────────────────────────────────
export function restrictionLine(e: Enforcement, now: number): { text: string; tone: Tone } | null {
  const m = e.restriction;
  if (!m) return null;
  if (!m.active) return { text: `Restriction lifted ${ago(m.lifted_at, now)} (${reasonLabel(m.lift_reason)}).`, tone: 'off' };
  const by = m.created_by_me ? 'by you' : 'by another administrator';
  const via = m.linked ? '' : ' through another report';
  return {
    text: `${m.state === 'removed' ? 'Removed' : 'Hidden'} ${ago(m.created_at, now)} ${by}${via} · ${reasonLabel(m.reason_code)}${m.child_safety ? ' · child safety' : ''}`,
    tone: m.state === 'removed' ? 'critical' : 'warning',
  };
}

// Completed vs queued: quarantine is asynchronous and only runs
// automatically when the scheduler switch is on.
export function mediaLine(m: MediaSummary | null | undefined): { text: string; tone: Tone } | null {
  if (!m || m.total === 0) return null;
  const done = (m.by_state.quarantined ?? 0) + (m.by_state.restored ?? 0) + (m.by_state.cancelled ?? 0) + (m.by_state.source_missing ?? 0);
  const parts = [`${m.total} media file${m.total === 1 ? '' : 's'}: ${done} settled`];
  if (m.in_progress) parts.push(`${m.in_progress} queued${m.automatic ? '' : ' (automatic quarantine is off — an administrator must run the worker)'}`);
  if (m.awaiting_restore) parts.push(`${m.awaiting_restore} awaiting media restoration (a separate administrator step; never automatic)`);
  if (m.needs_attention) parts.push(`${m.needs_attention} need attention${m.errors.length ? ` (${m.errors.join(', ')})` : ''}`);
  if (m.legal_hold) parts.push(`${m.legal_hold} under legal hold`);
  return { text: parts.join(' · '), tone: m.needs_attention ? 'critical' : m.in_progress || m.awaiting_restore ? 'warning' : 'ok' };
}

export function suspensionLine(e: Enforcement, now: number): { text: string; tone: Tone } {
  const a = e.account;
  if (!a.present) return { text: 'The reported account no longer exists.', tone: 'off' };
  if (a.is_admin) return { text: 'The reported account is an administrator.', tone: 'neutral' };
  const s = a.suspension;
  if (!s) return { text: 'Not suspended; no suspension history.', tone: 'off' };
  if (s.state === 'active') {
    const until = s.expires_at ? `until ${new Date(s.expires_at).toLocaleString()}` : 'indefinitely';
    return { text: `Suspended ${until} · ${reasonLabel(s.reason_code)}${s.child_safety ? ' · child safety' : ''} · by ${s.created_by_me ? 'you' : 'another administrator'}`, tone: 'critical' };
  }
  if (s.state === 'expired') return { text: `Not suspended — the last suspension expired ${ago(s.expires_at, now)}.`, tone: 'off' };
  return { text: `Not suspended — the last suspension was lifted ${ago(s.lifted_at, now)} (${reasonLabel(s.lift_reason)}).`, tone: 'off' };
}

export function outcomeMessage(r: EnforceResult): { text: string; tone: Tone } {
  if (!r.changed) return { text: 'Already in that state — nothing changed.', tone: 'neutral' };
  const base: Record<EnforcementAction, string> = {
    hide: 'Content hidden. The report stays claimed by you.',
    remove: `Content removed; report actioned${r.related_resolved ? ` (and ${r.related_resolved} related)` : ''}.`,
    restore: 'Restriction lifted.',
    clear_profile_fields: `Cleared: ${(r.cleared ?? []).map((f) => FIELD_LABEL[f] ?? f).join(', ') || 'none'}${r.already_locked?.length ? ` (already locked: ${r.already_locked.map((f) => FIELD_LABEL[f] ?? f).join(', ')})` : ''}.`,
    restore_profile_fields: `Restored: ${(r.ended ?? []).map((f) => FIELD_LABEL[f] ?? f).join(', ')}${r.profile_restriction === 'lifted' ? '; profile restriction lifted' : ''}.`,
    suspend: 'Account suspended.',
    lift_suspension: 'Suspension lifted.',
  };
  const media = (r.media?.in_progress
    ? ` Media: ${r.media.in_progress} file${r.media.in_progress === 1 ? '' : 's'} queued for quarantine${r.media.automatic ? ' (automatic)' : ' — automatic quarantine is off, so this completes only when an administrator runs the worker'}.`
    : '') + (r.media?.awaiting_restore
    ? ` Media: ${r.media.awaiting_restore} file${r.media.awaiting_restore === 1 ? '' : 's'} still in quarantine — restoring media is a separate administrator step and has not happened yet.`
    : '');
  const reach = r.public_media_still_reachable?.length ? ' Previously shared public image links stay reachable until quarantine completes.' : '';
  return { text: base[r.action] + media + reach, tone: 'ok' };
}

// Server refusals of enforcement (codes from the existing functions).
const ENFORCE_ERROR: Record<string, string> = {
  claim_required: 'Claim the report before deciding it.',
  not_restricted: 'The content is no longer restricted.',
  restricted_via_other_report: 'The restriction belongs to another report; restore it from there.',
  owner_unavailable: 'The reported account no longer exists.',
  already_removed: 'The content was already removed.',
  target_not_found: 'The reported content no longer exists.',
  nothing_to_clear: 'Those fields are already empty.',
  concurrent_change: 'Another administrator changed this restriction at the same moment. Review the latest state.',
  child_safety_confirmation_required: 'Child-safety reversal needs the dedicated reason, a note and explicit confirmation.',
  child_safety_review_required: 'Child-safety reversal needs the dedicated reason and a note.',
  child_safety_second_admin_required: 'A different administrator must review this child-safety restriction.',
  second_admin_required: 'A different administrator must review this child-safety suspension.',
  cannot_suspend_admin: 'Administrators can’t be suspended from the app.',
  cannot_suspend_self: 'You can’t suspend your own account.',
  already_suspended: 'The account is already suspended.',
  not_suspended: 'The account is no longer suspended (it may have expired or been lifted).',
  account_deleting: 'The account is being deleted.',
  invalid_expiry: 'A temporary suspension lasts between 1 hour and 1 year.',
  field_changed: 'The collector has set a new value since; restoring would overwrite it.',
  original_media_missing: 'The original image is no longer available, so it can’t be restored.',
  invalid_disposition: 'That choice for the linked reports isn’t valid any more. Review the latest state.',
  restore_inconsistent: 'The restore couldn’t keep the reports consistent and was rolled back. Review the latest state.',
  unsupported_target: 'That action doesn’t apply to this content type.',
  invalid_fields: 'Choose valid profile fields.',
};
export const enforcementErrorText = (code: string) => ENFORCE_ERROR[code] ?? null;
