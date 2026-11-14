/// <reference types="node" />
// Unit tests for report media inspection, restoration and legal-hold display.
// Run: node --test lib/admin-media-view.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  actionState, childSafetyReversal, confirmEnforcement, dispositionsFor, emptyParams, enforceOptions, fieldsFor, outcomeMessage,
  reasonsFor, relevantActions, type Enforcement,
} from './admin-enforcement-view.ts';
import {
  HOLD_EFFECT, holdLine, jobLabel, jobPhase, mediaAvailability, mediaLabel, PHASE_LABEL, restorableJobs, restoreBlockedText,
  restoreConfirm, restoreSummary, signedUrl, viewRefusalText, type EvidenceMedia, type MediaJob,
} from './admin-media-view.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const media = (over: Partial<EvidenceMedia> = {}): EvidenceMedia => ({
  ref: 1, kind: 'item_image', image_index: 0, available: true, child_safety: false, quarantine: null, image_restricted: false, ...over,
});
const job = (over: Partial<MediaJob> = {}): MediaJob => ({
  id: 'j1', kind: 'item_image', state: 'restore_pending', desired: 'restore', child_safety: false, legal_hold: false, needs_attention: false,
  error: null, attempts: 1, updated_at: iso(5), restored_at: null, restore_blocked: null, ...over,
});

test('media labels and availability; quarantined originals are not viewable', () => {
  assert.equal(mediaLabel(media()), 'Item image 1');
  assert.equal(mediaLabel(media({ kind: 'dm_photo', image_index: null })), 'Message photo');
  assert.equal(mediaAvailability(media()).viewable, true);
  assert.match(mediaAvailability(media({ quarantine: { state: 'pending', desired: 'quarantine', needs_attention: false, legal_hold: false } })).text, /Queued for quarantine/);
  const q = mediaAvailability(media({ available: false, quarantine: { state: 'quarantined', desired: 'quarantine', needs_attention: false, legal_hold: true } }));
  assert.deepEqual([q.viewable, q.text], [false, 'Quarantined — not viewable in the app']);
  assert.equal(mediaAvailability(media({ available: false })).viewable, false);
  assert.match(viewRefusalText('quarantined'), /not viewable/);
  assert.match(viewRefusalText('whatever'), /can’t be shown/);
});

test('signed URLs: only a signed object path, joined to the app’s own project URL', () => {
  const p = '/storage/v1/object/sign/item-images/u/a.jpg?token=eyJhbGciOi.abc-_def';
  assert.equal(signedUrl('http://127.0.0.1:54321/', p), `http://127.0.0.1:54321${p}`);
  assert.equal(signedUrl('https://x.supabase.co', '/storage/v1/object/public/item-images/a.jpg'), null); // never a public URL
  assert.equal(signedUrl('https://x.supabase.co', 'https://evil.example/storage/v1/object/sign/a?token=x'), null);
  assert.equal(signedUrl('https://x.supabase.co', '/storage/v1/object/sign/a.jpg'), null); // no token
});

test('restoration phases cover the Gate C states', () => {
  assert.equal(jobPhase(job({ state: 'quarantined' })), 'quarantined');
  assert.equal(jobPhase(job({ state: 'restore_pending' })), 'awaiting_restore');
  assert.equal(jobPhase(job({ state: 'restoring' })), 'restoring');
  assert.equal(jobPhase(job({ state: 'restored' })), 'restored');
  assert.equal(jobPhase(job({ state: 'failed' })), 'failed');
  assert.equal(jobPhase(job({ state: 'restore_pending', needs_attention: true })), 'needs_attention');
  assert.equal(PHASE_LABEL.needs_attention, 'Needs administrator attention');
  assert.equal(jobLabel(job({ kind: 'share_snapshot' })), 'Public share copy');
});

test('only server-cleared jobs are offered; blocked reasons explained', () => {
  const jobs = [job(), job({ id: 'j2', restore_blocked: 'second_admin_required' }), job({ id: 'j3', restore_blocked: 'not_released', desired: 'quarantine' })];
  assert.deepEqual(restorableJobs(jobs).map((j) => j.id), ['j1']);
  assert.match(restoreBlockedText('second_admin_required') ?? '', /different administrator/);
  assert.match(restoreBlockedText('not_released') ?? '', /restore the content first/);
  assert.match(restoreBlockedText('not_in_report') ?? '', /Not part of this report/);
  assert.equal(restoreBlockedText(null), null);
});

test('restore confirmation distinguishes media from content, keeps legal-hold copies', () => {
  const c = restoreConfirm([job({ child_safety: true, legal_hold: true })]);
  assert.match(c.message, /separate from restoring the content/);
  assert.match(c.message, /under legal hold: the private evidence copy is kept/);
  assert.match(c.message, /only an administrator who did not impose the restriction/);
  assert.equal(c.childSafety, true);
  assert.match(restoreConfirm([job()]).message, /The private quarantine copy is kept/);
});

test('restore results: only "restored" counts as done; nothing claimed early', () => {
  assert.deepEqual(restoreSummary([{ id: 'a', outcome: 'restored' }]), { text: 'Media: 1 restored to the original location.', tone: 'ok' });
  const mixed = restoreSummary([{ id: 'a', outcome: 'busy' }, { id: 'b', outcome: 'refused', reason: 'second_admin_required' }]);
  assert.match(mixed.text, /1 not finished yet — try again; 1 refused \(Child-safety media you restricted/);
  assert.equal(mixed.tone, 'critical');
  assert.equal(restoreSummary([{ id: 'a', outcome: 'destination_occupied' }]).tone, 'critical');
  assert.equal(restoreSummary([]).text, 'No media was restored.');
  assert.doesNotMatch(JSON.stringify(restoreSummary([{ id: 'a', outcome: 'restored' }])), /erase|deleted/i);
});

test('legal holds: minimal line, and what they do (and do not) block', () => {
  const line = holdLine({ subject: 'report', hold_type: 'ordinary', basis_code: 'law_enforcement_request', placed_at: iso(60), expires_at: null, release_requested: true }, NOW);
  assert.equal(line, 'This report’s evidence · legal hold · Law-enforcement request · placed 1 h ago · no end date · release requested');
  assert.match(HOLD_EFFECT, /do not block hiding, removal, restoration, suspension or dismissal/);
  assert.match(HOLD_EFFECT, /stop it being purged/);
});

const ok = { available: true, blocked: null };
const no = (blocked: string) => ({ available: false, blocked });
function profileEnf(restore: { available: boolean; blocked: string | null }, cs = false): Enforcement {
  return {
    version: 'v', report_status: 'actioned', claim: 'none', child_safety: cs, legal_hold: false,
    target: { type: 'profile', exists: true, other_pending_reports: 0 },
    restriction: { target_type: 'profile', state: 'removed', active: true, linked: true, child_safety: cs, reason_code: 'harassment',
      created_at: iso(10), created_by_me: false, acted_by_me: false, lifted_at: null, lift_reason: null, reports_linked: 1 },
    media: { total: 0, by_state: {}, in_progress: 0, needs_attention: 0, legal_hold: 0, errors: [], automatic: false },
    profile: { clearable_fields: [], restricted_fields: [{ field: 'bio', status: 'active', created_at: iso(10), mine: false, current_is_cleared: true }] },
    account: { present: true, is_admin: false, suspended: false, suspension: null },
    actions: { hide: no('unsupported_target'), remove: no('unsupported_target'), restore: no('use_profile_restore'), clear_profile_fields: no('already_resolved'),
      restore_profile_fields: restore, suspend: ok, lift_suspension: no('not_suspended') },
  };
}

test('profile-field release: gated like a profile restore, never restores values', () => {
  const e = profileEnf(ok);
  assert.deepEqual(actionState(e, 'release_profile_fields'), ok);
  assert.ok(relevantActions(e).includes('release_profile_fields'));
  assert.deepEqual(reasonsFor('release_profile_fields', e), ['owner_may_edit', 'policy_review']);
  assert.deepEqual(fieldsFor('release_profile_fields', e), ['bio']);
  assert.deepEqual(dispositionsFor('release_profile_fields', e, ['bio']), []);
  const p = { ...emptyParams('release_profile_fields'), reason: 'owner_may_edit', fields: ['bio'] };
  assert.deepEqual(enforceOptions('release_profile_fields', p, NOW), { fields: ['bio'], confirm_child_safety: false });
  const c = confirmEnforcement('release_profile_fields', e, p, 'quinn');
  assert.match(c.message, /Lets @quinn edit Bio again\. The cleared values are NOT restored/);
  assert.match(outcomeMessage({ action: 'release_profile_fields', changed: true, report_status: 'actioned', version: 'v', related_resolved: 0,
    ended: ['bio'], profile_restriction: 'lifted', media: e.media }).text, /Released: Bio — the collector may edit it again; profile restriction lifted/);
  const cs = profileEnf(no('child_safety_second_admin_required'), true);
  assert.equal(actionState(cs, 'release_profile_fields').blocked, 'child_safety_second_admin_required');
  assert.equal(childSafetyReversal('release_profile_fields', cs), true);
  assert.deepEqual(reasonsFor('release_profile_fields', cs), ['child_safety_review_cleared']);
});
