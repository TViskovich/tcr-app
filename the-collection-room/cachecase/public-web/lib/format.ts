// Presentation-only formatting. No data access here — every value this
// module touches was already returned by get-public-registry-card.

// Duplicated from lib/registry-custody-status.ts in the Expo app (and,
// separately, from the Edge Function's own copy) rather than shared — this
// is an independent deployable project with no build-time link to that
// repo path. Must be kept in sync by hand if custody states ever change;
// same tradeoff already accepted at the Edge Function boundary.
const CUSTODY_STATUS_LABEL: Record<string, string> = {
  owned: 'Owned',
  in_transfer: 'In Transfer',
  on_loan: 'On Loan',
  submitted_for_grading: 'Submitted for Grading',
  missing: 'Missing',
  stolen: 'Stolen',
  destroyed: 'Destroyed',
  archived: 'Archived',
};

export function formatCustodyStatus(status: string): string {
  return CUSTODY_STATUS_LABEL[status] ?? status;
}

// Restrained warning treatment applies to these three only, per spec —
// "archived" and "submitted_for_grading" are notable but not alarming, so
// they stay in the neutral/secondary treatment.
const SEVERE_CUSTODY_STATUSES = new Set(['missing', 'stolen', 'destroyed']);

export function isSevereCustodyStatus(status: string): boolean {
  return SEVERE_CUSTODY_STATUSES.has(status);
}

const EVENT_TYPE_LABEL: Record<string, string> = {
  registered: 'Registered',
  ownership_transferred: 'Ownership Transfer',
  status_changed: 'Status Update',
  grading_updated: 'Grading Update',
};

export function formatEventType(eventType: string): string {
  return EVENT_TYPE_LABEL[eventType] ?? eventType;
}

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return DATE_FORMATTER.format(date);
}
