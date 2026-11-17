/// <reference types="node" />
// Unit tests for the Grails image performance changes (pre-build 23):
//   * the Grails page reuses the profile grid's stable cache keys,
//   * the profile warm-up downloads first-frame images before rotation previews.
// Run: node --test lib/grail-image-priority.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { grailImagePlan, secondaryWarmupReady, type GrailSlotImages } from './grail-image-priority.ts';
import { COMPACT_IMAGE_TIER, DETAIL_IMAGE_TIER, type ImageTier } from './image-tiers.ts';
import { itemImageCacheKey } from './private-image-cache-key.ts';

const A = 'user-a';
const B = 'user-b';
const item = (id: string | null): GrailSlotImages => ({ entry_type: 'item', item: { primary_image_id: id } });
const coll = (ids: string[]): GrailSlotImages => ({ entry_type: 'collection', previewImageIds: ids });
const all = () => true;

// ── Stable cache keys: profile grid ≡ Grails page ─────────────────────────
// Both build the key as itemImageCacheKey(identity, imageId, COMPACT_IMAGE_TIER, servedTiers)
// (components/profile-v2/grail-slot-preview.tsx and components/profile/grails-grid.tsx).
test('the Grails page key equals the profile grid key for the same image, account and size', () => {
  const served = new Map<string, ImageTier>();
  const profileGrid = itemImageCacheKey(A, 'img-1', COMPACT_IMAGE_TIER, served);
  const grailsPage = itemImageCacheKey(A, 'img-1', COMPACT_IMAGE_TIER, served);
  assert.equal(grailsPage, profileGrid);
  assert.equal(profileGrid, 'user-a:item-image:img-1:preview');
});

test('the key does not depend on the rotating signed URL (re-signs reuse the bytes)', () => {
  // The URL is not an input at all: two re-signs of the same image share one key.
  assert.equal(itemImageCacheKey(A, 'img-1', COMPACT_IMAGE_TIER), itemImageCacheKey(A, 'img-1', COMPACT_IMAGE_TIER));
});

test('account isolation: another account never shares the entry (account switch, blocking viewer)', () => {
  assert.notEqual(itemImageCacheKey(A, 'img-1', COMPACT_IMAGE_TIER), itemImageCacheKey(B, 'img-1', COMPACT_IMAGE_TIER));
  assert.notEqual(itemImageCacheKey(A, 'img-1', COMPACT_IMAGE_TIER), itemImageCacheKey('anon', 'img-1', COMPACT_IMAGE_TIER));
});

test('size isolation: preview, detail and original bytes never share a key; a fallback is keyed by what was served', () => {
  const preview = itemImageCacheKey(A, 'img-1', COMPACT_IMAGE_TIER);
  const detail = itemImageCacheKey(A, 'img-1', DETAIL_IMAGE_TIER);
  const original = itemImageCacheKey(A, 'img-1', 'original');
  assert.equal(new Set([preview, detail, original]).size, 3);
  const fellBack = new Map<string, ImageTier>([['img-1', 'original']]);
  assert.equal(itemImageCacheKey(A, 'img-1', COMPACT_IMAGE_TIER, fellBack), original);
});

test('a changed image (new photo = new image id) gets a new key, never the old bytes', () => {
  assert.notEqual(itemImageCacheKey(A, 'img-old', COMPACT_IMAGE_TIER), itemImageCacheKey(A, 'img-new', COMPACT_IMAGE_TIER));
});

// ── First-frame priority ──────────────────────────────────────────────────
test('a full grid: each slot contributes exactly its first image to the first frame, rotation previews come later', () => {
  const slots = [item('i1'), coll(['c1a', 'c1b', 'c1c']), item('i2'), coll(['c2a', 'c2b']), item('i3'), item('i4'), coll(['c3a']), item('i5'), item('i6')];
  const plan = grailImagePlan(slots, all);
  assert.deepEqual(plan.firstFrame, ['i1', 'c1a', 'i2', 'c2a', 'i3', 'i4', 'c3a', 'i5', 'i6']);
  assert.equal(plan.firstFrame.length, 9, 'one per occupied slot');
  assert.deepEqual(plan.secondary, ['c1b', 'c1c', 'c2b'], 'rotation order preserved');
});

test('the total image set is unchanged (nothing dropped, nothing added)', () => {
  const slots = [item('i1'), coll(['c1a', 'c1b', 'c1c']), coll(['c2a', 'c2b'])];
  const plan = grailImagePlan(slots, all);
  const before = ['i1', 'c1a', 'c1b', 'c1c', 'c2a', 'c2b']; // what the old warm-up downloaded
  assert.deepEqual([...plan.firstFrame, ...plan.secondary].sort(), before.sort());
});

test('empty and partially filled grids', () => {
  assert.deepEqual(grailImagePlan([], all), { firstFrame: [], secondary: [] });
  assert.deepEqual(grailImagePlan([item('i1')], all), { firstFrame: ['i1'], secondary: [] });
  assert.deepEqual(grailImagePlan([item(null), coll([])], all), { firstFrame: [], secondary: [] }, 'no image, no previews');
});

test('an unavailable or blocked first preview is skipped, exactly like the visible slot', () => {
  const signed = new Set(['c1b', 'c1c']); // c1a: no URL (blocked / restricted / private)
  const plan = grailImagePlan([coll(['c1a', 'c1b', 'c1c'])], (id) => signed.has(id));
  assert.deepEqual(plan.firstFrame, ['c1b'], 'the first usable preview is the first frame');
  assert.deepEqual(plan.secondary, ['c1a', 'c1c'], 'listed, but only images with a URL are ever mounted');
});

test('duplicate images across slots are warmed once', () => {
  const plan = grailImagePlan([item('x'), coll(['x', 'y'])], all);
  assert.deepEqual(plan.firstFrame, ['x']);
  assert.deepEqual(plan.secondary, ['y']);
});

test('rotation previews wait for the first frame to finish (loaded or failed), not for unsigned images', () => {
  const ff = ['i1', 'c1a', 'i2'];
  assert.equal(secondaryWarmupReady(ff, all, new Set()), false, 'nothing finished yet');
  assert.equal(secondaryWarmupReady(ff, all, new Set(['i1', 'c1a'])), false, 'one still loading');
  assert.equal(secondaryWarmupReady(ff, all, new Set(['i1', 'c1a', 'i2'])), true, 'all finished');
  assert.equal(secondaryWarmupReady(ff, (id) => id !== 'i2', new Set(['i1', 'c1a'])), true, 'an unsigned image never blocks');
  assert.equal(secondaryWarmupReady([], all, new Set()), true, 'no first frame: nothing to wait for');
});
