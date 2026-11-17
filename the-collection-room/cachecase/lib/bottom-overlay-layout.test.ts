/// <reference types="node" />
// Unit tests for the bottom-overlay layout rules (pre-build-23 layout audit).
// Run: node --test lib/bottom-overlay-layout.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bottomContentPadding,
  CONTENT_END_GAP,
  floatingBarCoversRoute,
  floatingBarTop,
  TAB_BAR_HEIGHT,
} from './bottom-overlay-layout.ts';

// Home-indicator insets of real devices: none (SE / home button), notch, Dynamic Island, extra.
const INSETS = [0, 20, 34, 48];
const MIN_CLEARANCE = 16; // the last row must end at least this far above the bar

test('geometry matches the floating bars (68pt tall, insets.bottom + 4 above the bottom)', () => {
  assert.equal(TAB_BAR_HEIGHT, 68);
  assert.equal(floatingBarTop(34), 34 + 4 + 68);
  assert.equal(floatingBarTop(0), 72);
});

test('Delete Account regression: the old fixed 48pt padding ended under the bar on every iPhone', () => {
  for (const inset of INSETS) assert.ok(48 < floatingBarTop(inset), `inset ${inset}: 48 would be hidden`);
});

test('with the bar, content always ends above it (container not padding the inset)', () => {
  for (const inset of INSETS) {
    const end = bottomContentPadding({ barVisible: true, insetBottom: inset });
    assert.ok(end >= floatingBarTop(inset) + MIN_CLEARANCE, `inset ${inset}: ends at ${end}`);
    assert.equal(end, TAB_BAR_HEIGHT + inset + CONTENT_END_GAP, 'the app convention, unchanged');
  }
});

test('a SafeAreaView with a bottom edge never double-counts the inset', () => {
  for (const inset of INSETS) {
    const padding = bottomContentPadding({ barVisible: true, insetBottom: inset, insetAppliedByContainer: true });
    assert.equal(padding, TAB_BAR_HEIGHT + CONTENT_END_GAP);
    assert.ok(inset + padding >= floatingBarTop(inset) + MIN_CLEARANCE, 'still clears the bar');
  }
});

test('without a bar (e.g. Delete Account opened from Account Suspended) no bar space is reserved', () => {
  assert.equal(bottomContentPadding({ barVisible: false, insetBottom: 34 }), 34 + CONTENT_END_GAP);
  assert.equal(bottomContentPadding({ barVisible: false, insetBottom: 34, insetAppliedByContainer: true }), CONTENT_END_GAP);
  assert.ok(bottomContentPadding({ barVisible: false, insetBottom: 34 }) < TAB_BAR_HEIGHT, 'no excessive blank space');
});

test('the bar covers stack and tab screens only while the app shows it, never another collector profile', () => {
  assert.equal(floatingBarCoversRoute({ barAllowed: true, pathname: '/account/delete' }), true);
  assert.equal(floatingBarCoversRoute({ barAllowed: true, pathname: '/notifications' }), true);
  assert.equal(floatingBarCoversRoute({ barAllowed: true, pathname: '/admin/report/1' }), true);
  assert.equal(floatingBarCoversRoute({ barAllowed: true, pathname: '/user/somebody' }), false);
  assert.equal(floatingBarCoversRoute({ barAllowed: false, pathname: '/account/delete' }), false, 'suspended / pending / recovery');
});

test('custom gap and defensive inset handling', () => {
  assert.equal(bottomContentPadding({ barVisible: true, insetBottom: 34, gap: 8 }), 68 + 34 + 8);
  assert.equal(bottomContentPadding({ barVisible: false, insetBottom: -5 }), CONTENT_END_GAP, 'negative insets are clamped');
});
