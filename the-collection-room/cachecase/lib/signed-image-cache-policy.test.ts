/// <reference types="node" />
// Unit tests for the signed-image cache policy (P2.3 Issue 2).
// Run: node --test lib/signed-image-cache-policy.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canDisplayStale,
  classifyPersisted,
  expiryForAnswer,
  keyBelongsTo,
  NEGATIVE_BACKOFF_MS,
  NEGATIVE_TTL_MS,
  negativeTtlMs,
  nextNegativeCount,
  persistablePatch,
  shouldInvalidate,
  shouldPersist,
  STALE_DISPLAY_GRACE_MS,
} from './signed-image-cache-policy.ts';

const NOW = 1_800_000_000_000;
const TTL = 300_000;

test('negative TTL is 20 seconds (owner decision)', () => {
  assert.equal(NEGATIVE_TTL_MS, 20_000);
});

test('an "unavailable" answer expires after the short negative TTL, a URL after the signed TTL', () => {
  assert.equal(expiryForAnswer(null, NOW, TTL), NOW + 20_000);
  assert.equal(expiryForAnswer('https://x/sign/a?token=t', NOW, TTL), NOW + TTL);
});

test('B7c regression: an "unavailable" answer is never persisted', () => {
  assert.equal(shouldPersist({ url: null, expiresAt: NOW + TTL }), false);
  assert.equal(shouldPersist({ url: '', expiresAt: NOW + TTL }), false);
});

test('a transient failure and a tier fallback are never persisted; a real URL is', () => {
  assert.equal(shouldPersist({ url: null, expiresAt: NOW + 10_000, isTransientFailure: true }), false);
  assert.equal(shouldPersist({ url: 'u', expiresAt: NOW + TTL, servedTier: 'original' }), false);
  assert.equal(shouldPersist({ url: 'u', expiresAt: NOW + TTL }), true);
});

test('persisted negatives written by an older build are ignored on read', () => {
  assert.equal(classifyPersisted({ url: null, expiresAt: NOW + TTL }, NOW), 'ignore');
  assert.equal(classifyPersisted(undefined, NOW), 'ignore');
  assert.equal(classifyPersisted({ url: 'u', expiresAt: NOW + 1 }, NOW), 'usable');
  assert.equal(classifyPersisted({ url: 'u', expiresAt: NOW }, NOW), 'expired');
});

test('persistablePatch drops negatives from a batch write', () => {
  assert.deepEqual(persistablePatch({ a: { url: 'u', expiresAt: 1 }, b: { url: null, expiresAt: 1 } }), { a: { url: 'u', expiresAt: 1 } });
});

test('an expired authorization is not indefinite permission to display', () => {
  const expired = NOW - 1;
  assert.equal(canDisplayStale(expired, NOW), true, 'just expired: still shown while renewing');
  assert.equal(canDisplayStale(NOW - STALE_DISPLAY_GRACE_MS + 1, NOW), true);
  assert.equal(canDisplayStale(NOW - STALE_DISPLAY_GRACE_MS, NOW), false, 'past the grace: no longer shown');
  assert.equal(canDisplayStale(NOW - 24 * 3600_000, NOW), false, 'offline for a day: not shown');
  assert.equal(canDisplayStale(undefined, NOW), false, 'unknown expiry: not shown');
});

test('block invalidates every entry; unblock only the negatives', () => {
  const pos = { url: 'u', expiresAt: NOW + TTL };
  const neg = { url: null, expiresAt: NOW + 20_000 };
  assert.equal(shouldInvalidate(pos, 'all'), true);
  assert.equal(shouldInvalidate(neg, 'all'), true);
  assert.equal(shouldInvalidate(pos, 'negatives'), false);
  assert.equal(shouldInvalidate(neg, 'negatives'), true);
});

test('identity scoping: a key belongs only to its own identity', () => {
  assert.equal(keyBelongsTo('user-1:img', 'user-1'), true);
  assert.equal(keyBelongsTo('user-10:img', 'user-1'), false);
  assert.equal(keyBelongsTo('anon:img', 'user-1'), false);
});

test('F3: repeated negatives back off 20 → 40 → 80 → 160 → 300 s and stay capped', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(negativeTtlMs), [20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  assert.equal(negativeTtlMs(0), 20_000);
  assert.equal(NEGATIVE_BACKOFF_MS.at(-1), 300_000);
  assert.equal(expiryForAnswer(null, NOW, TTL, 3), NOW + 80_000);
});

test('F3: the ladder climbs only on consecutive real negatives, and restarts otherwise', () => {
  assert.equal(nextNegativeCount(undefined), 1, 'no previous entry (dropped by block/unblock/account change/restart/refresh)');
  assert.equal(nextNegativeCount({ url: null, expiresAt: 0 }), 2);
  assert.equal(nextNegativeCount({ url: null, expiresAt: 0, negatives: 4 }), 5);
  assert.equal(nextNegativeCount({ url: 'u', expiresAt: 0 }), 1, 'after a success');
  assert.equal(nextNegativeCount({ url: null, expiresAt: 0, isTransientFailure: true }), 1, 'after a network failure');
});

test('F3: one image per minute at most at steady state (vs every 20 s)', () => {
  // Requests in the first hour for a permanently unavailable image.
  let t = 0, n = 0, count = 0;
  while (t < 3_600_000) { count++; n++; t += negativeTtlMs(n); }
  assert.ok(count <= 16, `requests/hour: ${count}`);
});
