// Pure view logic for report-scoped media inspection, media restoration and
// legal holds on the admin report screen (components/admin/report-media.tsx).
// No React Native or Supabase imports (unit-tested: lib/admin-media-view.test.ts).
//
// The server decides everything shown here (admin_report_evidence,
// admin-report-media, admin-media-restore). In particular: nothing is shown
// as restored until the server reports the job restored, and nothing is ever
// described as erased.

import { ago, type Tone } from './admin-reports-view.ts';

export type MediaKind = 'dm_photo' | 'folder_cover' | 'item_image' | 'post_image' | 'avatar';
export type QuarantineState =
  | 'pending' | 'copied' | 'verified' | 'quarantined' | 'source_missing' | 'restore_pending' | 'restoring' | 'restored' | 'cancelled' | 'failed';
export type EvidenceMedia = {
  ref: number; kind: MediaKind; image_index: number | null; available: boolean; child_safety: boolean;
  quarantine: { state: QuarantineState; desired: string; needs_attention: boolean; legal_hold: boolean } | null;
  image_restricted: boolean;
};
export type MediaJob = {
  id: string; kind: string; state: QuarantineState; desired: 'quarantine' | 'restore' | 'retain'; child_safety: boolean; legal_hold: boolean;
  needs_attention: boolean; error: string | null; attempts: number; updated_at: string; restored_at: string | null;
  restore_blocked: string | null;
};
export type LegalHold = {
  subject: 'report' | 'quarantine_copy' | 'profile_field' | 'account'; hold_type: 'ordinary' | 'child_safety'; basis_code: string;
  placed_at: string; expires_at: string | null; release_requested: boolean;
};
export type Evidence = { version: string; child_safety: boolean; media: EvidenceMedia[]; jobs: MediaJob[]; legal_holds: LegalHold[] };

// ── Media list ──────────────────────────────────────────────────────────────
const KIND_LABEL: Record<MediaKind, string> = {
  dm_photo: 'Message photo', folder_cover: 'Folder cover', item_image: 'Item image', post_image: 'Post image', avatar: 'Avatar',
};
export const mediaLabel = (m: Pick<EvidenceMedia, 'kind' | 'image_index'>) =>
  m.kind === 'item_image' && m.image_index !== null ? `${KIND_LABEL.item_image} ${m.image_index + 1}` : KIND_LABEL[m.kind] ?? m.kind;

// Can the viewer open it? Only media still at its recorded location; a
// quarantined original is never served to the app.
export function mediaAvailability(m: EvidenceMedia): { viewable: boolean; text: string; tone: Tone } {
  if (m.available) {
    return m.quarantine && ['pending', 'copied', 'verified'].includes(m.quarantine.state)
      ? { viewable: true, text: 'Queued for quarantine — still at its original location', tone: 'warning' }
      : { viewable: true, text: m.quarantine?.state === 'restored' ? 'Restored to its original location' : 'Available', tone: 'ok' };
  }
  if (m.quarantine && ['quarantined', 'restore_pending', 'restoring'].includes(m.quarantine.state)) {
    return { viewable: false, text: 'Quarantined — not viewable in the app', tone: 'neutral' };
  }
  return { viewable: false, text: 'No longer available (deleted or never uploaded)', tone: 'off' };
}

// ── Viewer ──────────────────────────────────────────────────────────────────
export type ViewerResult =
  | { kind: 'ok'; signed_path: string; expires_in: number; child_safety: boolean }
  | { kind: 'refused'; reason: string }
  | { kind: 'session_expired' } | { kind: 'forbidden' } | { kind: 'error' };
const VIEW_REFUSAL: Record<string, string> = {
  not_found: 'This media is not part of this report.',
  unavailable: 'This media is no longer available.',
  quarantined: 'This media is quarantined and is not viewable in the app.',
  child_safety_confirmation_required: 'Child-safety media needs an explicit confirmation before it is shown.',
};
export const viewRefusalText = (reason: string) => VIEW_REFUSAL[reason] ?? 'This media can’t be shown.';
// The signed URL lives for seconds; the app joins the relative path to its
// own project URL and never stores it.
export function signedUrl(base: string, signedPath: string): string | null {
  if (!/^\/storage\/v1\/object\/sign\/[^?#]+\?token=[A-Za-z0-9._-]+$/.test(signedPath)) return null;
  return `${base.replace(/\/+$/, '')}${signedPath}`;
}

// ── Restoration ─────────────────────────────────────────────────────────────
// The states the report screen distinguishes (Gate C).
export type JobPhase = 'quarantined' | 'queued' | 'awaiting_restore' | 'restoring' | 'restored' | 'failed' | 'needs_attention' | 'missing' | 'cancelled';
export function jobPhase(j: Pick<MediaJob, 'state' | 'needs_attention'>): JobPhase {
  if (j.needs_attention) return 'needs_attention';
  switch (j.state) {
    case 'pending': case 'copied': case 'verified': return 'queued';
    case 'quarantined': return 'quarantined';
    case 'restore_pending': return 'awaiting_restore';
    case 'restoring': return 'restoring';
    case 'restored': return 'restored';
    case 'failed': return 'failed';
    case 'source_missing': return 'missing';
    default: return 'cancelled';
  }
}
export const PHASE_LABEL: Record<JobPhase, string> = {
  quarantined: 'Quarantined', queued: 'Queued for quarantine', awaiting_restore: 'Awaiting restoration', restoring: 'Being restored',
  restored: 'Restored', failed: 'Failed', needs_attention: 'Needs administrator attention', missing: 'Original was already gone', cancelled: 'Cancelled',
};
export const PHASE_TONE: Record<JobPhase, Tone> = {
  quarantined: 'neutral', queued: 'warning', awaiting_restore: 'warning', restoring: 'warning', restored: 'ok', failed: 'critical',
  needs_attention: 'critical', missing: 'off', cancelled: 'off',
};
const KIND_JOB: Record<string, string> = {
  item_image: 'Item image', share_snapshot: 'Public share copy', dm_photo: 'Message photo', avatar: 'Avatar', folder_cover: 'Folder cover',
  hero_image: 'Hero image', showcase_badge: 'Showcase badge',
};
export const jobLabel = (j: Pick<MediaJob, 'kind'>) => KIND_JOB[j.kind] ?? j.kind.replace(/_/g, ' ');

const RESTORE_BLOCKED: Record<string, string> = {
  not_released: 'The content restriction is still in place (restore the content first).',
  already_restored: 'Already restored.',
  not_restorable: 'Not in a restorable state.',
  needs_attention: 'Flagged for administrator attention — see the media quarantine runbook.',
  owner_deleted: 'The owner’s account no longer exists.',
  owner_unavailable: 'The owner’s account is suspended or being deleted.',
  second_admin_required: 'Child-safety media you restricted — a different administrator must restore it.',
  not_in_report: 'Not part of this report.',
  child_safety_confirmation_required: 'Child-safety media needs explicit confirmation.',
};
export const restoreBlockedText = (code: string | null | undefined) => (code ? RESTORE_BLOCKED[code] ?? code.replace(/_/g, ' ') : null);

export const restorableJobs = (jobs: MediaJob[]) => jobs.filter((j) => j.restore_blocked === null);

export type RestoreOutcome = { id: string; outcome: string; reason?: string };
// What the admin-media-restore response means, per job — only 'restored'
// counts as done (the worker re-hashed the bytes before saying so).
export function restoreSummary(results: RestoreOutcome[]): { text: string; tone: Tone } {
  const done = results.filter((r) => r.outcome === 'restored').length;
  const refused = results.filter((r) => r.outcome === 'refused');
  const retry = results.filter((r) => ['busy', 'deferred', 'interrupted', 'claim_failed'].includes(r.outcome)).length;
  const failed = results.length - done - refused.length - retry;
  const parts: string[] = [];
  if (done) parts.push(`${done} restored to the original location`);
  if (retry) parts.push(`${retry} not finished yet — try again`);
  if (refused.length) parts.push(`${refused.length} refused (${[...new Set(refused.map((r) => restoreBlockedText(r.reason) ?? r.reason))].join(' ')})`);
  if (failed) parts.push(`${failed} failed — see the media quarantine runbook`);
  return {
    text: parts.length ? `Media: ${parts.join('; ')}.` : 'No media was restored.',
    tone: failed || (refused.length && !done) ? 'critical' : retry ? 'warning' : 'ok',
  };
}
export function restoreConfirm(jobs: MediaJob[]) {
  const cs = jobs.some((j) => j.child_safety);
  const held = jobs.filter((j) => j.legal_hold).length;
  return {
    title: 'Restore media',
    message: [
      `Copies ${jobs.length} quarantined file${jobs.length === 1 ? '' : 's'} back to ${jobs.length === 1 ? 'its' : 'their'} original location, after checking the bytes match the original.`,
      'This is separate from restoring the content: the content restriction has already been lifted.',
      held ? `${held} file${held === 1 ? ' is' : 's are'} under legal hold: the private evidence copy is kept.` : 'The private quarantine copy is kept.',
      cs ? 'Child-safety media: only an administrator who did not impose the restriction may restore it, and you confirm the child-safety review.' : '',
    ].filter(Boolean).join('\n\n'),
    childSafety: cs,
  };
}

// ── Legal holds ─────────────────────────────────────────────────────────────
const SUBJECT: Record<LegalHold['subject'], string> = {
  report: 'This report’s evidence', quarantine_copy: 'A quarantined media copy', profile_field: 'A cleared profile field', account: 'The reported account',
};
const BASIS: Record<string, string> = {
  law_enforcement_request: 'Law-enforcement request', litigation: 'Litigation', regulatory_inquiry: 'Regulatory inquiry',
  internal_investigation: 'Internal investigation', child_safety_preservation: 'Child-safety preservation', other_legal_obligation: 'Other legal obligation',
};
export function holdLine(h: LegalHold, now: number): string {
  const until = h.expires_at ? `until ${new Date(h.expires_at).toLocaleDateString()}` : 'no end date';
  return `${SUBJECT[h.subject] ?? h.subject} · ${h.hold_type === 'child_safety' ? 'child-safety hold' : 'legal hold'} · ${BASIS[h.basis_code] ?? h.basis_code} · placed ${ago(h.placed_at, now)} · ${until}${h.release_requested ? ' · release requested' : ''}`;
}
// Holds preserve evidence and block purging; none of the report-screen
// decisions is blocked by them (the backend has no such rule).
export const HOLD_EFFECT = 'Legal holds preserve evidence and stop it being purged. They do not block hiding, removal, restoration, suspension or dismissal, and none of those changes a hold. Holds are placed and released operationally (moderation retention runbook).';
