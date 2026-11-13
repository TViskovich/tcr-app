/// <reference types="node" />
// Unit tests for the Enforcement section's view logic.
// Run: node --test lib/admin-enforcement-view.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  awaitingSecondAdmin, childSafetyReversal, confirmEnforcement, dispositionsFor, emptyParams, enforceOptions, enforcementErrorText,
  expiryFor, fieldsFor, mediaLine, missingInput, outcomeMessage, reasonsFor, relevantActions, restrictionLine, suspensionLine,
  type Enforcement, type EnforcementAction,
} from './admin-enforcement-view.ts';
import { classifyError, losesAccess } from './admin-reports-view.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const ok = { available: true, blocked: null };
const no = (blocked: string) => ({ available: false, blocked });
const media = { total: 0, by_state: {}, in_progress: 0, awaiting_restore: 0, needs_attention: 0, legal_hold: 0, errors: [], automatic: false };
function enf(over: Partial<Enforcement> = {}, actions: Partial<Enforcement['actions']> = {}): Enforcement {
  return {
    version: 'v', report_status: 'reviewing', claim: 'mine', child_safety: false, legal_hold: false,
    target: { type: 'post', exists: true, other_pending_reports: 0 }, restriction: null, media, profile: null,
    account: { present: true, is_admin: false, lifecycle: 'active', suspended: false, suspension: null, suspensions_total: 0 },
    actions: {
      hide: ok, remove: ok, restore: no('not_restricted'), clear_profile_fields: no('unsupported_target'),
      restore_profile_fields: no('unsupported_target'), suspend: ok, lift_suspension: no('not_suspended'), ...actions,
    },
    ...over,
  };
}

test('only actions for the content type are listed; irrelevant blocks are hidden', () => {
  assert.deepEqual(relevantActions(enf()), ['hide', 'remove', 'suspend']);
  const profile = enf({ target: { type: 'profile', exists: true, other_pending_reports: 0 } },
    { hide: no('unsupported_target'), remove: no('unsupported_target'), clear_profile_fields: ok });
  assert.deepEqual(relevantActions(profile), ['clear_profile_fields', 'suspend']);
  // a blocked-but-relevant action is listed (with its reason)
  assert.deepEqual(relevantActions(enf({}, { hide: no('claim_required'), remove: no('claim_required') })), ['hide', 'remove', 'suspend']);
  assert.deepEqual(relevantActions(enf({ account: { present: false } }, { suspend: no('owner_unavailable') })), ['hide', 'remove']);
  assert.ok(relevantActions(enf({}, { suspend: no('cannot_suspend_admin') })).includes('suspend'));
});

test('child-safety reversals: dedicated reason, note and confirmation', () => {
  const cs = enf({ restriction: { target_type: 'post', state: 'removed', active: true, linked: true, child_safety: true, reason_code: 'child_safety',
    created_at: iso(5), created_by_me: false, acted_by_me: false, lifted_at: null, lift_reason: null, reports_linked: 1 } }, { restore: ok });
  assert.equal(childSafetyReversal('restore', cs), true);
  assert.deepEqual(reasonsFor('restore', cs), ['child_safety_review_cleared']);
  assert.ok(!reasonsFor('restore', enf()).includes('child_safety_review_cleared'));
  const p = { ...emptyParams('restore'), reason: 'child_safety_review_cleared', disposition: 'reopen' };
  assert.match(missingInput('restore', cs, p) ?? '', /note/);
  assert.match(missingInput('restore', cs, { ...p, note: 'reviewed' }) ?? '', /Confirm/);
  assert.equal(missingInput('restore', cs, { ...p, note: 'reviewed', confirmChildSafety: true }), null);
  assert.equal(enforceOptions('restore', { ...p, confirmChildSafety: true }, NOW).confirm_child_safety, true);
  const c = confirmEnforcement('restore', cs, { ...p, note: 'x', confirmChildSafety: true }, 'olly');
  assert.match(c.message, /administrator other than the one who imposed it/);
});

test('awaiting a second administrator is surfaced', () => {
  assert.equal(awaitingSecondAdmin(enf({}, { restore: no('child_safety_second_admin_required') })), true);
  assert.equal(awaitingSecondAdmin(enf({}, { lift_suspension: no('second_admin_required') })), true);
  assert.equal(awaitingSecondAdmin(enf()), false);
});

test('dispositions follow the backend rules', () => {
  const hidden = enf({ restriction: { target_type: 'post', state: 'hidden', active: true, linked: true, child_safety: false, reason_code: 'pending_review',
    created_at: iso(5), created_by_me: true, acted_by_me: true, lifted_at: null, lift_reason: null, reports_linked: 1 } });
  assert.deepEqual(dispositionsFor('restore', hidden), ['keep_reviewing', 'reopen', 'overturn']);
  assert.deepEqual(dispositionsFor('restore', { ...hidden, report_status: 'actioned' }), ['reopen', 'overturn']);
  const prof = enf({ profile: { clearable_fields: ['tagline'], restricted_fields: [
    { field: 'bio', status: 'active', created_at: iso(3), mine: true, current_is_cleared: true },
    { field: 'display_name', status: 'active', created_at: iso(3), mine: true, current_is_cleared: true }] } });
  assert.deepEqual(dispositionsFor('restore_profile_fields', prof, ['bio']), []);
  assert.deepEqual(dispositionsFor('restore_profile_fields', prof, ['bio', 'display_name']), ['reopen', 'overturn']);
  assert.deepEqual(fieldsFor('clear_profile_fields', prof), ['tagline']);
  assert.deepEqual(fieldsFor('restore_profile_fields', prof), ['bio', 'display_name']);
});

test('options carry no target ids; suspension expiry from presets', () => {
  const s = { ...emptyParams('suspend'), reason: 'spam' };
  assert.equal(s.expiry, '7d');
  assert.equal(enforceOptions('suspend', s, NOW).expires_at, new Date(NOW + 7 * 86_400_000).toISOString());
  assert.deepEqual(enforceOptions('suspend', { ...s, expiry: 'indefinite' }, NOW), {});
  assert.equal(expiryFor('indefinite', NOW), null);
  const all = (['hide', 'remove', 'restore', 'clear_profile_fields', 'restore_profile_fields', 'suspend', 'lift_suspension'] as EnforcementAction[])
    .map((a) => JSON.stringify(enforceOptions(a, { ...emptyParams(a), reason: 'x', fields: ['bio'] }, NOW))).join();
  assert.doesNotMatch(all, /user_id|report_id|moderation_id|target/);
  assert.equal(emptyParams('remove').includeRelated, true); // backend default
  assert.equal(emptyParams('clear_profile_fields').includeRelated, false); // backend default
});

test('confirmations state action, target, reason, effects, reversibility and second admin', () => {
  const c = confirmEnforcement('remove', enf({ target: { type: 'message', exists: true, other_pending_reports: 2 } }),
    { ...emptyParams('remove'), reason: 'harassment' }, 'olly');
  assert.equal(c.title, 'Remove content');
  assert.match(c.message, /Direct message · reason: Harassment/);
  assert.match(c.message, /2 other pending report/);
  assert.match(c.message, /Reversible: Restore content/);
  assert.match(c.message, /No second administrator is required/);
  const s = confirmEnforcement('suspend', enf({ child_safety: true }), { ...emptyParams('suspend'), reason: 'child_safety', expiry: 'indefinite' }, 'olly');
  assert.match(s.message, /Suspends @olly indefinitely/);
  assert.match(s.message, /keep account deletion and Download My Data/);
  assert.match(s.message, /require a different administrator/);
  assert.equal(s.destructive, true);
});

test('media lines: queued vs settled vs awaiting manual restore', () => {
  assert.equal(mediaLine(media), null);
  assert.match(mediaLine({ ...media, total: 2, in_progress: 2, by_state: { pending: 2 } })!.text, /2 queued \(automatic quarantine is off/);
  assert.match(mediaLine({ ...media, total: 1, awaiting_restore: 1, by_state: { restore_pending: 1 } })!.text, /awaiting media restoration \(a separate administrator step/);
  const done = mediaLine({ ...media, total: 1, legal_hold: 1, by_state: { quarantined: 1 } })!;
  assert.match(done.text, /1 settled · 1 under legal hold/);
  assert.equal(done.tone, 'ok');
  assert.equal(mediaLine({ ...media, total: 1, needs_attention: 1, errors: ['attempts_exhausted'], by_state: { failed: 1 } })!.tone, 'critical');
});

test('outcomes say what completed and what is still queued', () => {
  const r = { action: 'remove' as const, changed: true, report_status: 'actioned', version: 'v', related_resolved: 1,
    media: { ...media, total: 1, in_progress: 1 } };
  assert.match(outcomeMessage(r).text, /Content removed; report actioned \(and 1 related\)\. Media: 1 file queued for quarantine — automatic quarantine is off/);
  assert.match(outcomeMessage({ ...r, action: 'restore', media: { ...media, total: 1, awaiting_restore: 1 } }).text,
    /Restriction lifted\. Media: 1 file still in quarantine — restoring media is a separate administrator step/);
  assert.equal(outcomeMessage({ ...r, changed: false }).text, 'Already in that state — nothing changed.');
  assert.match(outcomeMessage({ ...r, action: 'clear_profile_fields', cleared: ['bio'], already_locked: ['tagline'], media }).text, /Cleared: Bio \(already locked: Tagline\)/);
});

test('state lines: restriction, suspension (active, expired, lifted, admin)', () => {
  assert.equal(restrictionLine(enf(), NOW), null);
  const m = { target_type: 'post', state: 'hidden' as const, active: true, linked: false, child_safety: true, reason_code: 'urgent_risk',
    created_at: iso(10), created_by_me: false, acted_by_me: false, lifted_at: null, lift_reason: null, reports_linked: 2 };
  assert.match(restrictionLine(enf({ restriction: m }), NOW)!.text, /Hidden 10 min ago by another administrator through another report · Urgent risk · child safety/);
  const sus = (state: 'active' | 'expired' | 'lifted', more = {}) => enf({ account: { present: true, is_admin: false, suspended: state === 'active',
    suspension: { state, reason_code: 'spam', child_safety: false, created_at: iso(100), expires_at: null, lifted_at: iso(5), lift_reason: 'appeal_granted',
      created_by_me: true, from_this_report: true, ...more } } });
  assert.match(suspensionLine(sus('active'), NOW).text, /Suspended indefinitely · Spam · by you/);
  assert.match(suspensionLine(sus('expired', { expires_at: iso(60) }), NOW).text, /expired 1 h ago/);
  assert.match(suspensionLine(sus('lifted'), NOW).text, /lifted 5 min ago \(Appeal granted\)/);
  assert.match(suspensionLine(enf({ account: { present: true, is_admin: true } }), NOW).text, /is an administrator/);
});

test('enforcement refusals are not mistaken for lost admin access', () => {
  const r = classifyError({ code: '42501', message: 'child_safety_second_admin_required' });
  assert.deepEqual(r, { kind: 'refused', code: 'child_safety_second_admin_required' });
  assert.equal(losesAccess(r), false);
  assert.deepEqual(classifyError({ code: '42501', message: 'second_admin_required' }), { kind: 'refused', code: 'second_admin_required' });
  assert.deepEqual(classifyError({ code: '42501', message: 'forbidden' }), { kind: 'forbidden' });
  assert.match(enforcementErrorText('child_safety_second_admin_required') ?? '', /different administrator/);
  assert.match(enforcementErrorText('field_changed') ?? '', /overwrite/);
  assert.equal(enforcementErrorText('nope'), null);
});
