// Pure view logic for the admin report review screens (app/admin/reports.tsx,
// app/admin/report/[id].tsx). No React Native or Supabase imports, so it is
// unit-tested with Node's test runner (lib/admin-reports-view.test.ts).
//
// Everything here only decides how server data is SHOWN. Authorization,
// eligibility and every action are decided by the server
// (20261201120000_admin_report_review.sql); `can` flags are hints.

export type Tone = 'critical' | 'warning' | 'ok' | 'neutral' | 'off';
export type ReportView = 'open' | 'claimed' | 'mine' | 'reopened' | 'actioned' | 'dismissed';
export type ReportStatus = 'open' | 'reviewing' | 'actioned' | 'dismissed';
export type ClaimState = 'none' | 'mine' | 'other' | 'stale';
export type EvidenceState = 'available' | 'purged' | 'missing';
export type AgeFilter = 'under_24h' | '1_to_7d' | 'over_7d';
export type SortOrder = 'priority' | 'oldest' | 'newest';

export type QueueItem = {
  id: string;
  target_type: string;
  reason: string;
  priority: 'normal' | 'urgent';
  status: ReportStatus;
  child_safety: boolean;
  created_at: string;
  claimed_at: string | null;
  claim: ClaimState;
  reviewed_at: string | null;
  resolution: string | null;
  reopened: boolean;
  evidence: EvidenceState;
  version: string;
};
export type QueueCounts = { open: number; claimed: number; mine: number; reopened: number; urgent: number; child_safety: number };
export type QueuePage = { items: QueueItem[]; next_cursor: unknown | null; counts: QueueCounts | null };

export type QueueFilters = {
  view: ReportView;
  targetType: string | null;
  reason: string | null;
  priority: 'normal' | 'urgent' | null;
  age: AgeFilter | null;
  sort: SortOrder | null;
};
export const DEFAULT_FILTERS: QueueFilters = { view: 'open', targetType: null, reason: null, priority: null, age: null, sort: null };

export type AdminRef = { username: string | null; is_me: boolean } | null;
export type ReportCase = {
  report: {
    id: string; target_type: string; reason: string; details: string | null; priority: 'normal' | 'urgent'; status: ReportStatus;
    created_at: string; updated_at: string; claimed_at: string | null; claimed_by: AdminRef; reviewed_at: string | null;
    reviewed_by: AdminRef; resolution: string | null; resolution_reason: string | null;
    evidence_purge_after: string | null; evidence_purged_at: string | null;
  };
  evidence: Record<string, unknown> | null;
  current: { exists: boolean; content: Record<string, unknown> | null };
  moderation: { state: string; active: boolean; child_safety: boolean; reason_code: string; created_at: string; lifted_at: string | null } | null;
  owner: { present: boolean; username?: string | null; account_state: string };
  reporter: { present: boolean };
  prior: {
    same_target: Record<ReportStatus, number>;
    same_owner: Record<ReportStatus, number> | null;
  };
  history: {
    action: string; from_status: string | null; to_status: string | null; outcome: string | null; reason_code: string | null;
    note: string | null; created_at: string; admin: AdminRef;
  }[];
  case: {
    version: string;
    child_safety: boolean;
    legal_hold: boolean;
    claim: ClaimState;
    evidence: EvidenceState;
    reopen_count: number;
    content_restricted: boolean;
    can: { claim: boolean; release: boolean; dismiss: boolean; reopen: boolean };
    blocked: { dismiss?: string; reopen?: string };
  };
};

// ── Labels ──────────────────────────────────────────────────────────────────
export const VIEWS: ReportView[] = ['open', 'claimed', 'mine', 'reopened', 'actioned', 'dismissed'];
export const VIEW_LABEL: Record<ReportView, string> = {
  open: 'Open', claimed: 'Claimed', mine: 'Mine', reopened: 'Reopened', actioned: 'Actioned', dismissed: 'Dismissed',
};
export const isResolvedView = (v: ReportView) => v === 'actioned' || v === 'dismissed';

export const TARGET_LABEL: Record<string, string> = {
  profile: 'Profile', post: 'Post', comment: 'Post comment', item_comment: 'Item comment', folder_comment: 'Folder comment',
  gallery_comment: 'Gallery comment', message: 'Direct message', collection_item: 'Collection item', folder: 'Folder',
};
export const REASON_LABEL: Record<string, string> = {
  spam: 'Spam', harassment: 'Harassment', hate: 'Hate', sexual: 'Sexual content', violence: 'Violence', self_harm: 'Self-harm',
  child_safety: 'Child safety', scam_fraud: 'Scam or fraud', impersonation: 'Impersonation',
  intellectual_property: 'Intellectual property', other: 'Other',
};
export const STATUS_LABEL: Record<ReportStatus, string> = { open: 'Open', reviewing: 'Claimed', actioned: 'Actioned', dismissed: 'Dismissed' };
export const STATUS_TONE: Record<ReportStatus, Tone> = { open: 'warning', reviewing: 'neutral', actioned: 'ok', dismissed: 'off' };
export const AGE_LABEL: Record<AgeFilter, string> = { under_24h: 'Under 24 h', '1_to_7d': '1–7 days', over_7d: 'Over 7 days' };
export const SORT_LABEL: Record<SortOrder, string> = { priority: 'Urgent first', oldest: 'Oldest first', newest: 'Newest first' };
export const sortsFor = (v: ReportView): SortOrder[] => (isResolvedView(v) ? ['newest', 'oldest'] : ['priority', 'oldest', 'newest']);

const CODE_LABEL: Record<string, string> = {
  no_violation: 'No violation', duplicate: 'Duplicate', administrative_closure: 'Administrative closure', content_removed: 'Content removed',
  within_guidelines: 'Within guidelines', insufficient_evidence: 'Insufficient evidence', duplicate_report: 'Duplicate report',
  target_deleted: 'Content was deleted', account_deleted: 'Account was deleted', out_of_scope: 'Out of scope', test_report: 'Test report',
  new_information: 'New information', resolved_in_error: 'Resolved in error', quality_review: 'Quality review',
  decision_overturned: 'Decision overturned',
};
export const codeLabel = (code: string | null | undefined) => (code ? CODE_LABEL[code] ?? code.replace(/_/g, ' ') : '—');

const ACTION_LABEL: Record<string, string> = {
  claim: 'Claimed', release: 'Released', resolve: 'Resolved', reopen: 'Reopened', hide: 'Content hidden', remove: 'Content removed',
  restore: 'Content restored', clear_fields: 'Profile fields cleared', restore_fields: 'Profile fields restored',
  release_fields: 'Profile fields released', suspend: 'Account suspended', lift_suspension: 'Suspension lifted',
  place_legal_hold: 'Legal hold placed', renew_legal_hold: 'Legal hold renewed', request_legal_hold_release: 'Legal hold release requested',
  release_legal_hold: 'Legal hold released',
};
export const actionLabel = (a: string) => ACTION_LABEL[a] ?? a.replace(/_/g, ' ');

// Server-defined reason codes for the two decisions exposed in M5.1
// (private.moderation_reason_valid). The server re-validates them.
export const DISMISS_OPTIONS: { outcome: 'no_violation' | 'duplicate' | 'administrative_closure'; reasons: string[] }[] = [
  { outcome: 'no_violation', reasons: ['within_guidelines', 'insufficient_evidence'] },
  { outcome: 'duplicate', reasons: ['duplicate_report'] },
  { outcome: 'administrative_closure', reasons: ['target_deleted', 'account_deleted', 'out_of_scope', 'test_report'] },
];
export const REOPEN_REASONS = ['new_information', 'resolved_in_error', 'quality_review'];
export const NOTE_MAX = 1000;

// ── Ages ────────────────────────────────────────────────────────────────────
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

// ── Queue rows ──────────────────────────────────────────────────────────────
export type Urgency = 'child_safety' | 'urgent' | null;
export const urgencyOf = (i: { child_safety: boolean; priority: string }): Urgency =>
  i.child_safety ? 'child_safety' : i.priority === 'urgent' ? 'urgent' : null;
export const URGENCY_LABEL: Record<Exclude<Urgency, null>, string> = { child_safety: 'Child safety', urgent: 'Urgent' };
export const URGENCY_TONE: Record<Exclude<Urgency, null>, Tone> = { child_safety: 'critical', urgent: 'warning' };

export function claimLabel(claim: ClaimState, status: ReportStatus): string | null {
  if (status !== 'reviewing') return null;
  return claim === 'mine' ? 'Claimed by you' : claim === 'stale' ? 'Stale claim — can be taken over' : 'Claimed by another admin';
}

// Metadata only: type, reason, times, status, claim. Never report text.
export function rowSummary(i: QueueItem, now: number) {
  const parts = [`Submitted ${ago(i.created_at, now)}`];
  const claim = claimLabel(i.claim, i.status);
  if (claim) parts.push(claim);
  if (i.reviewed_at && (i.status === 'actioned' || i.status === 'dismissed')) parts.push(`${STATUS_LABEL[i.status]} ${ago(i.reviewed_at, now)}`);
  if (i.reopened) parts.push('Reopened');
  if (i.evidence !== 'available') parts.push(i.evidence === 'purged' ? 'Evidence purged' : 'No evidence');
  return {
    title: `${REASON_LABEL[i.reason] ?? i.reason} · ${TARGET_LABEL[i.target_type] ?? i.target_type}`,
    detail: parts.join(' · '),
    urgency: urgencyOf(i),
    status: STATUS_LABEL[i.status] ?? i.status,
    statusTone: STATUS_TONE[i.status] ?? 'neutral',
    resolution: i.resolution ? codeLabel(i.resolution) : null,
  };
}

// A page appended (or a refresh replacing the list): never shows the same
// report twice; a refreshed copy of a report replaces the older one.
export function mergePage(existing: QueueItem[], page: QueueItem[], append: boolean): QueueItem[] {
  if (!append) return dedupe(page);
  const fresh = new Map(page.map((i) => [i.id, i]));
  const kept = existing.filter((i) => !fresh.has(i.id));
  return dedupe([...kept, ...page]);
}
function dedupe(items: QueueItem[]): QueueItem[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

export function activeFilterCount(f: QueueFilters): number {
  return [f.targetType, f.reason, f.priority, f.age, f.sort].filter((x) => x !== null).length;
}
// Switching views keeps filters but drops a sort the new view can't use.
export function withView(f: QueueFilters, view: ReportView): QueueFilters {
  return { ...f, view, sort: f.sort && sortsFor(view).includes(f.sort) ? f.sort : null };
}

export function emptyText(f: QueueFilters): string {
  if (activeFilterCount(f) > 0) return 'No reports match these filters.';
  return {
    open: 'No open reports. New reports appear here.',
    claimed: 'No reports are being reviewed.',
    mine: 'You have no claimed reports.',
    reopened: 'No reopened reports are waiting.',
    actioned: 'No actioned reports.',
    dismissed: 'No dismissed reports.',
  }[f.view];
}

// ── Screen state ────────────────────────────────────────────────────────────
// loading → (ok | empty | error); a refresh or next page never blanks what
// is already shown; an error on a later page keeps the list and offers retry.
export type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; items: QueueItem[]; cursor: unknown | null; moreError: boolean };

export function listAfterLoad(prev: ListState, res: ApiResult<QueuePage>, append: boolean): ListState {
  if (res.kind === 'ok') {
    const items = mergePage(prev.kind === 'ok' ? prev.items : [], res.data.items, append);
    return { kind: 'ok', items, cursor: res.data.next_cursor ?? null, moreError: false };
  }
  if (append && prev.kind === 'ok') return { ...prev, moreError: true };
  return { kind: 'error', message: failureMessage(res) };
}
export const isEmpty = (s: ListState) => s.kind === 'ok' && s.items.length === 0;

// ── API results ─────────────────────────────────────────────────────────────
// session_expired: no valid session (sign in again). forbidden: signed in but
// not an admin (or removed). inactive: the admin is suspended or pending
// deletion. conflict: the server refused a stale or conflicting change.
export type ApiFailure =
  | { kind: 'session_expired' }
  | { kind: 'forbidden' }
  | { kind: 'inactive' }
  | { kind: 'not_found' }
  | { kind: 'conflict'; code: string }
  | { kind: 'invalid'; code: string }
  | { kind: 'error' };
export type ApiResult<T> = { kind: 'ok'; data: T } | ApiFailure;

export function classifyError(e: { code?: string | null; message?: string | null; status?: number | null } | null | undefined): ApiFailure {
  if (!e) return { kind: 'error' };
  const code = e.code ?? '';
  const msg = (e.message ?? '').trim();
  if (/^PGRST30\d$/.test(code) || e.status === 401 || msg === 'not_authenticated' || /jwt expired/i.test(msg)) return { kind: 'session_expired' };
  if (msg === 'account_inactive') return { kind: 'inactive' };
  if (code === '42501' || msg === 'forbidden') return { kind: 'forbidden' };
  if (code === 'PT404' || msg === 'not_found') return { kind: 'not_found' };
  if (code === 'PT409') return { kind: 'conflict', code: msg };
  if (code === '22023') return { kind: 'invalid', code: msg };
  return { kind: 'error' };
}

// Whether the screen must stop showing admin data altogether.
export const losesAccess = (f: ApiFailure) => f.kind === 'session_expired' || f.kind === 'forbidden' || f.kind === 'inactive';

const CONFLICT_TEXT: Record<string, string> = {
  report_changed: 'This report changed since you opened it. The latest state is shown — review it before trying again.',
  claimed_by_other: 'Another administrator has claimed this report.',
  already_resolved: 'This report has already been resolved by another decision.',
  not_resolved: 'This report is not resolved, so it can’t be reopened.',
  reopen_not_supported: 'Actioned reports can’t be reopened here; their enforcement must be reviewed first.',
  evidence_unavailable: 'The evidence for this report is no longer available, so it can’t be reopened.',
  retention_expired: 'This report’s evidence retention period has ended, so it can’t be reopened.',
  duplicate_open_report: 'The same reporter has since filed a new open report on this content; review that one instead.',
  target_still_exists: 'The reported content still exists, so “Content was deleted” doesn’t apply.',
  account_still_exists: 'The account still exists, so “Account was deleted” doesn’t apply.',
  content_moderated: 'This content is currently restricted. It needs an enforcement decision, not a dismissal.',
};
export function failureMessage(f: ApiFailure): string {
  switch (f.kind) {
    case 'session_expired': return 'Your session has expired. Sign in again to continue.';
    case 'forbidden': return 'You no longer have administrator access.';
    case 'inactive': return 'Your account is restricted, so administrator tools are unavailable.';
    case 'not_found': return 'This report no longer exists.';
    case 'conflict': return CONFLICT_TEXT[f.code] ?? 'This change conflicts with the report’s current state. Refresh and review it again.';
    case 'invalid': return f.code === 'note_too_long' ? `Notes can be at most ${NOTE_MAX} characters.` : 'That choice isn’t valid for this report.';
    default: return 'Something went wrong. Check your connection and try again.';
  }
}

const BLOCKED_TEXT: Record<string, string> = {
  claim_first: 'Claim the report before deciding it.',
  claimed_by_other: 'Another administrator is reviewing this report.',
  content_moderated: 'The content is restricted; that decision belongs to enforcement (not available here yet).',
  already_resolved: 'Already resolved.',
  not_resolved: 'Only resolved reports can be reopened.',
  reopen_not_supported: 'Actioned reports can’t be reopened here.',
  evidence_unavailable: 'Evidence is no longer available, so it can’t be reopened.',
  retention_expired: 'The evidence retention period has ended.',
};
export const blockedText = (code: string | undefined) => (code ? BLOCKED_TEXT[code] ?? codeLabel(code) : null);

// ── Case actions ────────────────────────────────────────────────────────────
export type CaseAction = 'claim' | 'release' | 'dismiss' | 'reopen';
export function confirmCopy(action: CaseAction, c: ReportCase['case'], opts: { outcome?: string; reason?: string } = {}) {
  const cs = c.child_safety ? ' This is a child-safety report.' : '';
  switch (action) {
    case 'claim':
      return c.claim === 'stale'
        ? { title: 'Take over stale claim', message: 'The current claim is stale (over 24 hours old, or its administrator lost access). Taking it over is recorded in the audit trail.', confirm: 'Take over', destructive: false }
        : { title: 'Claim report', message: 'Other administrators will see that you are reviewing it.', confirm: 'Claim', destructive: false };
    case 'release':
      return c.claim === 'stale'
        ? { title: 'Release stale claim', message: 'The report returns to the open queue. Releasing another administrator’s stale claim is recorded in the audit trail.', confirm: 'Release', destructive: false }
        : { title: 'Release report', message: 'The report returns to the open queue for any administrator.', confirm: 'Release', destructive: false };
    case 'dismiss':
      return {
        title: 'Dismiss report',
        message: `Resolve as “${codeLabel(opts.outcome)} — ${codeLabel(opts.reason)}”. No content or account is changed. The evidence is kept for 90 days and can be reopened until then.${cs}`,
        confirm: 'Dismiss', destructive: true,
      };
    case 'reopen':
      return {
        title: 'Reopen report',
        message: `Return this report to the open queue (“${codeLabel(opts.reason)}”). Its retention clock stops until it is resolved again.${cs}`,
        confirm: 'Reopen', destructive: false,
      };
  }
}

// ── Restricted evidence preview ─────────────────────────────────────────────
// Text fields only, in a fixed order with readable labels; media references
// become counts (with availability), never URLs or paths. Child-safety
// reports start fully hidden and need an extra confirmation.
const FIELD_LABEL: [string, string][] = [
  ['username', 'Username'], ['display_name', 'Display name'], ['tagline', 'Tagline'], ['bio', 'Bio'], ['location', 'Location'],
  ['website', 'Website'], ['title', 'Title'], ['name', 'Name'], ['content', 'Text'], ['caption', 'Caption'], ['body', 'Text'],
  ['description', 'Description'], ['post_type', 'Post type'], ['item_type', 'Item type'], ['player_key', 'Player'],
  ['attachment_type', 'Attachment'],
];
export type PreviewField = { label: string; text: string };
export type MediaSummary = { total: number; available: number; withheld: number };
export function previewFields(content: Record<string, unknown> | null | undefined): PreviewField[] {
  if (!content) return [];
  const out: PreviewField[] = [];
  for (const [k, label] of FIELD_LABEL) {
    const v = content[k];
    if (typeof v === 'string' && v.trim()) out.push({ label, text: v });
  }
  return out;
}
export function mediaSummary(content: Record<string, unknown> | null | undefined): MediaSummary {
  const s: MediaSummary = { total: 0, available: 0, withheld: 0 };
  if (!content) return s;
  const refs: unknown[] = [content.attachment_ref, content.cover_ref, ...(Array.isArray(content.image_refs) ? content.image_refs : [])];
  for (const r of refs) {
    if (r && typeof r === 'object') {
      s.total += 1;
      if ((r as { available?: unknown }).available === true) s.available += 1;
    }
  }
  if (Array.isArray(content.withheld_media)) s.withheld = content.withheld_media.length;
  if (typeof content.image_count === 'number') s.total = Math.max(s.total, content.image_count);
  if (content.has_cover === true) s.total = Math.max(s.total, 1);
  return s;
}

export function evidenceNotice(c: Pick<ReportCase, 'case' | 'report'>, now: number): { text: string; tone: Tone } {
  if (c.case.evidence === 'purged') {
    return { text: `Evidence was purged ${ago(c.report.evidence_purged_at, now)} under the retention policy. It can’t be restored or viewed.`, tone: 'off' };
  }
  if (c.case.evidence === 'missing') return { text: 'No evidence was stored for this report.', tone: 'off' };
  const purge = c.report.evidence_purge_after;
  if (c.case.legal_hold) return { text: 'Evidence is under a legal hold and will not be purged while the hold is active.', tone: 'neutral' };
  if (c.case.child_safety) return { text: 'Child-safety evidence is preserved and excluded from routine purging.', tone: 'neutral' };
  if (purge) {
    return Date.parse(purge) <= now
      ? { text: 'Evidence retention has ended; it may be purged at any time.', tone: 'warning' }
      : { text: `Evidence is kept until ${new Date(purge).toLocaleDateString()}.`, tone: 'neutral' };
  }
  return { text: 'Evidence is kept while the report is unresolved.', tone: 'neutral' };
}

export function adminName(a: AdminRef): string {
  if (!a) return 'a former administrator';
  return a.is_me ? 'you' : a.username ? `@${a.username}` : 'another administrator';
}
