/// <reference types="node" />
// Unit tests for legacy gallery-row materialisation (P2.3, review F2).
// Run: node --test lib/legacy-item-image.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldMaterializeLegacyImage } from './legacy-item-image.ts';

test('F2: after the last photo was removed the server image_url is null — nothing is re-created', () => {
  assert.equal(shouldMaterializeLegacyImage({ serverGalleryCount: 0, serverImageUrl: null }), false);
});

test('F2: a server read that failed never re-creates anything', () => {
  assert.equal(shouldMaterializeLegacyImage({ serverGalleryCount: null, serverImageUrl: 'https://x/a.jpg' }), false);
  assert.equal(shouldMaterializeLegacyImage({ serverGalleryCount: undefined, serverImageUrl: undefined }), false);
});

test('a genuine legacy item (no gallery rows, a server image_url) is still materialised', () => {
  assert.equal(shouldMaterializeLegacyImage({ serverGalleryCount: 0, serverImageUrl: 'https://x/a.jpg' }), true);
});

test('an item that already has gallery rows is never materialised', () => {
  assert.equal(shouldMaterializeLegacyImage({ serverGalleryCount: 2, serverImageUrl: 'https://x/a.jpg' }), false);
});
