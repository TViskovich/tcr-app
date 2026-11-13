/// <reference types="node" />
// Unit tests for the admin report review screens' view logic.
// Run: node --test lib/admin-reports-view.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeFilterCount, blockedText, classifyError, confirmCopy, DEFAULT_FILTERS, emptyText, evidenceNotice, failureMessage, isEmpty,
  listAfterLoad, losesAccess, mediaSummary, mergePage, previewFields, rowSummary, urgencyOf, withView,
  type ListState, type QueueItem, type ReportCase,
} from './admin-reports-view.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const item = (id: string, over: Partial<QueueItem> = {}): QueueItem => ({
  id, target_type: 'post', reason: 'spam', priority: 'normal', status: 'open', child_safety: false, created_at: iso(90),
  claimed_at: null, claim: 'none', reviewed_at: null, resolution: null, reopened: false, evidence: 'available', version: `v-${id}`, ...over,
});
const caseOf = (over: Partial<ReportCase['case']> = {}, report: Partial<ReportCase['report']> = {}) => ({
  case: { version: 'v', child_safety: false, legal_hold: false, claim: 'none', evidence: 'available', reopen_count: 0, content_restricted: false,
          can: { claim: true, release: false, dismiss: false, reopen: false }, blocked: {}, ...over } as ReportCase['case'],
  report: { evidence_purge_after: null, evidence_purged_at: null, ...report } as ReportCase['report'],
});

test('rows show metadata only, with urgency and claim', () => {
  const s = rowSummary(item('a', { reason: 'harassment', target_type: 'message', status: 'reviewing', claim: 'mine', reopened: true }), NOW);
  assert.equal(s.title, 'Harassment · Direct message');
  assert.equal(s.detail, 'Submitted 1 h ago · Claimed by you · Reopened');
  assert.equal(s.status, 'Claimed');
  assert.equal(rowSummary(item('b', { status: 'reviewing', claim: 'stale' }), NOW).detail.includes('Stale claim'), true);
  assert.equal(rowSummary(item('c', { status: 'reviewing', claim: 'other' }), NOW).detail.includes('another admin'), true);
  assert.match(rowSummary(item('d', { status: 'dismissed', reviewed_at: iso(5), evidence: 'purged', resolution: 'no_violation' }), NOW).detail,
    /Dismissed 5 min ago · Evidence purged/);
  // nothing in a row can carry report text: the type has no such field
  assert.deepEqual(Object.keys(rowSummary(item('e'), NOW)).sort(), ['detail', 'resolution', 'status', 'statusTone', 'title', 'urgency']);
});

test('child safety outranks urgent; both are flagged', () => {
  assert.equal(urgencyOf({ child_safety: true, priority: 'urgent' }), 'child_safety');
  assert.equal(urgencyOf({ child_safety: true, priority: 'normal' }), 'child_safety');
  assert.equal(urgencyOf({ child_safety: false, priority: 'urgent' }), 'urgent');
  assert.equal(urgencyOf({ child_safety: false, priority: 'normal' }), null);
});

test('pages merge without duplicates; a refresh replaces', () => {
  const a = [item('1'), item('2')];
  assert.deepEqual(mergePage(a, [item('2', { status: 'reviewing' }), item('3')], true).map((i) => [i.id, i.status]),
    [['1', 'open'], ['2', 'reviewing'], ['3', 'open']]);
  assert.deepEqual(mergePage(a, [item('3'), item('3')], false).map((i) => i.id), ['3']);
});

test('list states: loading, ok, empty, error, retry keeps rows', () => {
  const loading: ListState = { kind: 'loading' };
  const ok = listAfterLoad(loading, { kind: 'ok', data: { items: [item('1')], next_cursor: { id: '1' }, counts: null } }, false);
  assert.equal(ok.kind, 'ok');
  assert.equal(isEmpty(ok), false);
  assert.equal(isEmpty(listAfterLoad(loading, { kind: 'ok', data: { items: [], next_cursor: null, counts: null } }, false)), true);
  const err = listAfterLoad(loading, { kind: 'error' }, false);
  assert.equal(err.kind, 'error');
  // a failed next page keeps what is shown and offers a retry
  const more = listAfterLoad(ok, { kind: 'error' }, true);
  assert.equal(more.kind === 'ok' && more.moreError && more.items.length === 1, true);
  const next = listAfterLoad(more, { kind: 'ok', data: { items: [item('2')], next_cursor: null, counts: null } }, true);
  assert.equal(next.kind === 'ok' && !next.moreError && next.items.length === 2 && next.cursor === null, true);
});

test('filters: count, view switch drops an unusable sort, empty text', () => {
  const f = { ...DEFAULT_FILTERS, reason: 'spam', sort: 'priority' as const };
  assert.equal(activeFilterCount(f), 2);
  assert.equal(withView(f, 'dismissed').sort, null);
  assert.equal(withView({ ...f, sort: 'oldest' }, 'dismissed').sort, 'oldest');
  assert.equal(emptyText(f), 'No reports match these filters.');
  assert.equal(emptyText({ ...DEFAULT_FILTERS, view: 'mine' }), 'You have no claimed reports.');
});

test('errors: expired session, lost admin, suspension, conflicts', () => {
  assert.deepEqual(classifyError({ code: '42501', message: 'not_authenticated' }), { kind: 'session_expired' });
  assert.deepEqual(classifyError({ code: 'PGRST301', message: 'JWT expired', status: 401 }), { kind: 'session_expired' });
  assert.deepEqual(classifyError({ code: '42501', message: 'forbidden' }), { kind: 'forbidden' });
  assert.deepEqual(classifyError({ code: '42501', message: 'account_inactive' }), { kind: 'inactive' });
  assert.deepEqual(classifyError({ code: '42501', message: 'permission denied for function admin_report_queue' }), { kind: 'forbidden' });
  assert.deepEqual(classifyError({ code: 'PT404', message: 'not_found' }), { kind: 'not_found' });
  assert.deepEqual(classifyError({ code: 'PT409', message: 'report_changed' }), { kind: 'conflict', code: 'report_changed' });
  assert.deepEqual(classifyError({ code: '22023', message: 'note_too_long' }), { kind: 'invalid', code: 'note_too_long' });
  assert.deepEqual(classifyError({ code: '08006', message: 'x' }), { kind: 'error' });
  for (const k of ['session_expired', 'forbidden', 'inactive'] as const) assert.equal(losesAccess({ kind: k }), true);
  assert.equal(losesAccess({ kind: 'conflict', code: 'x' }), false);
  assert.match(failureMessage({ kind: 'conflict', code: 'report_changed' }), /changed since you opened it/);
  assert.match(failureMessage({ kind: 'conflict', code: 'claimed_by_other' }), /Another administrator/);
  assert.match(failureMessage({ kind: 'conflict', code: 'something_new' }), /Refresh/);
  assert.match(failureMessage({ kind: 'session_expired' }), /Sign in again/);
});

test('confirmations explain stale takeovers and child safety', () => {
  assert.match(confirmCopy('claim', caseOf({ claim: 'stale' }).case).message, /audit trail/);
  assert.equal(confirmCopy('claim', caseOf().case).title, 'Claim report');
  const d = confirmCopy('dismiss', caseOf({ child_safety: true }).case, { outcome: 'no_violation', reason: 'within_guidelines' });
  assert.equal(d.destructive, true);
  assert.match(d.message, /No violation — Within guidelines/);
  assert.match(d.message, /child-safety/);
  assert.match(confirmCopy('reopen', caseOf().case, { reason: 'new_information' }).message, /New information/);
  assert.equal(blockedText('claim_first'), 'Claim the report before deciding it.');
  assert.equal(blockedText(undefined), null);
});

test('restricted preview: text fields only, media as counts', () => {
  const ev = {
    v: 1, captured_at: 'x', content: 'hello', body: 'b', withheld_media: ['image_url'],
    image_refs: [{ bucket: 'item-images', available: true }, { bucket: 'item-images', available: false }],
    attachment_ref: { bucket: 'dm-attachments', available: true },
  };
  assert.deepEqual(previewFields(ev).map((f) => f.label), ['Text', 'Text']);
  assert.equal(JSON.stringify(previewFields(ev)).includes('item-images'), false);
  assert.deepEqual(mediaSummary(ev), { total: 3, available: 2, withheld: 1 });
  assert.deepEqual(previewFields(null), []);
  assert.deepEqual(mediaSummary({ image_count: 4 }), { total: 4, available: 0, withheld: 0 });
});

test('evidence notices: purged, missing, hold, child safety, retention', () => {
  assert.match(evidenceNotice(caseOf({ evidence: 'purged' }, { evidence_purged_at: iso(60 * 24 * 3) }), NOW).text, /purged 3 d ago.*can’t be restored/);
  assert.match(evidenceNotice(caseOf({ evidence: 'missing' }), NOW).text, /No evidence/);
  assert.match(evidenceNotice(caseOf({ legal_hold: true }), NOW).text, /legal hold/);
  assert.match(evidenceNotice(caseOf({ child_safety: true }), NOW).text, /preserved/);
  assert.match(evidenceNotice(caseOf({}, { evidence_purge_after: iso(5) }), NOW).text, /retention has ended/);
  assert.match(evidenceNotice(caseOf({}), NOW).text, /unresolved/);
});
