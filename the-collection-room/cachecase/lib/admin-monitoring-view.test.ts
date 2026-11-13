/// <reference types="node" />
// Unit tests for the admin monitoring dashboard's view logic.
// Run: node --test lib/admin-monitoring-view.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  age, channelHealth, channelLabel, groupIssues, issueStatus, monitoringSummary, purgeApproval, queueSummary, schedulerSummary,
  type MonitoringOverview, type OpenIssue, type PurgeRun,
} from './admin-monitoring-view.ts';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const issue = (id: string, severity: OpenIssue['severity'], openedMin: number, ack = false): OpenIssue => ({
  id, code: 'x', category: 'quarantine', severity, count: 1, oldest_at: iso(openedMin), opened_at: iso(openedMin), last_seen_at: iso(0),
  acknowledged_at: ack ? iso(1) : null, notified_at: null, last_delivery_error: null,
});

test('issues group by severity, critical first, oldest first, never duplicated', () => {
  const g = groupIssues([issue('r', 'routine', 5), issue('c2', 'critical', 3), issue('h', 'high', 9), issue('c1', 'critical', 30), issue('c1', 'critical', 30)]);
  assert.deepEqual(g.critical.map((i) => i.id), ['c1', 'c2']);
  assert.deepEqual(g.high.map((i) => i.id), ['h']);
  assert.deepEqual(g.routine.map((i) => i.id), ['r']);
});

test('acknowledged is distinct from resolved', () => {
  assert.equal(issueStatus({ acknowledged_at: null }), 'active');
  assert.equal(issueStatus({ acknowledged_at: iso(1) }), 'acknowledged');
  assert.equal(issueStatus({ acknowledged_at: iso(1), resolved_at: iso(0) }), 'resolved');
});

test('ages', () => {
  assert.equal(age(iso(0), NOW), '<1 min');
  assert.equal(age(iso(12), NOW), '12 min');
  assert.equal(age(iso(180), NOW), '3 h');
  assert.equal(age(iso(60 * 72), NOW), '3 d');
  assert.equal(age(null, NOW), '—');
});

test('scheduler: off is shown as off, never as running', () => {
  const off = schedulerSummary({ enabled: false, sweep_active: false, running: 0, last_completed_at: null, last_failed_at: null }, NOW);
  assert.equal(off.label, 'Off');
  assert.equal(off.tone, 'off');
  assert.equal(schedulerSummary({ enabled: false, sweep_active: true, running: 0, last_completed_at: null, last_failed_at: null }, NOW).label, 'Off');
  assert.equal(schedulerSummary({ enabled: true, sweep_active: false, running: 0, last_completed_at: null, last_failed_at: null }, NOW).label, 'Kicks only');
  const on = schedulerSummary({ enabled: true, sweep_active: true, running: 1, last_completed_at: iso(2), last_failed_at: null }, NOW);
  assert.equal(on.label, 'On');
  assert.match(on.detail, /2 min ago · 1 running/);
});

test('monitoring: delivery disabled is explicit', () => {
  const base: MonitoringOverview = {
    delivery_enabled: false, monitor_active: false, urgent_report_minutes: 60,
    channels: { email: 'not_configured', webhook: 'not_configured', reported_at: null },
    last_check_at: iso(3), last_delivery_at: null, last_delivery_error: null, open: [], resolved_24h: 0, needs_origin_probe: [],
  };
  const off = monitoringSummary(base, NOW);
  assert.equal(off.label, 'Alerts off');
  assert.match(off.detail, /Delivery is disabled · monitor job inactive · last check 3 min ago/);
  assert.equal(monitoringSummary({ ...base, delivery_enabled: true, last_delivery_error: 'webhook_rejected' }, NOW).label, 'Alerts failing');
  assert.equal(monitoringSummary({ ...base, delivery_enabled: true, monitor_active: true }, NOW).tone, 'ok');
});

test('channels: safe status words only', () => {
  assert.equal(channelLabel('configured'), 'Configured');
  assert.equal(channelLabel('too_many_recipients'), 'Too many recipients');
  assert.equal(channelLabel(undefined), 'Not reported yet');
  assert.equal(channelLabel('https://hooks.example/x'), 'Unknown'); // never echoes unexpected values
});

test('per-channel delivery health flags a failing channel even when the other delivered', () => {
  assert.equal(channelHealth({ delivered: 0, failed: 0 }).tone, 'off');
  assert.equal(channelHealth({ delivered: 3, failed: 0 }).label, '3 delivered');
  assert.deepEqual(channelHealth({ delivered: 3, failed: 2 }), { label: '2 failed · 3 delivered', tone: 'warning' });
  assert.equal(channelHealth({ delivered: 0, failed: 2 }).tone, 'critical');
});

test('queue counts', () => {
  assert.deepEqual(queueSummary({ 'pending:quarantine': 2, 'copied:retain': 1, 'verified:restore': 4, 'restore_pending:restore': 3, 'quarantined:quarantine': 9, 'failed:quarantine': 1 }),
    { waiting: 3, restorePending: 3, quarantined: 9, failed: 1 });
});

test('purge approvals: expiry countdown and self-approval explained, never granted', () => {
  const run: PurgeRun = {
    id: 'r', category: 'report_evidence', status: 'prepared', stored_status: 'prepared', item_count: 3, items_by_state: { pending: 3 },
    prepared_at: iso(10), approval_expires_at: new Date(NOW + 20 * 60_000).toISOString(), approved_at: null, execution_expires_at: null,
    closed_at: null, prepared_by_viewer: true, approved_by_viewer: false, viewer_may_approve: false,
  };
  assert.deepEqual(purgeApproval(run, NOW), { minutesLeft: 20, note: 'You prepared this run — a different administrator must approve it.' });
  assert.match(purgeApproval({ ...run, prepared_by_viewer: false, viewer_may_approve: true }, NOW).note, /server re-checks/);
  assert.equal(purgeApproval({ ...run, approval_expires_at: iso(1) }, NOW).minutesLeft, 0);
  assert.equal(purgeApproval({ ...run, status: 'expired' }, NOW).minutesLeft, null);
});
