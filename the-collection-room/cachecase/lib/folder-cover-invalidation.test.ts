/// <reference types="node" />
// Unit tests for folder-cover invalidation targets (P2.3 Issue 4, B2b).
// Run: node --test lib/folder-cover-invalidation.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { foldersAffectedBy, uniqueFolderIds } from './folder-cover-invalidation.ts';

test('B2b regression: a photo change invalidates its folder cover', () => {
  assert.deepEqual(foldersAffectedBy({ kind: 'photos', folderId: 'f1' }), ['f1']);
});

test('creating or deleting an item invalidates its folder cover', () => {
  assert.deepEqual(foldersAffectedBy({ kind: 'created', folderId: 'f1' }), ['f1']);
  assert.deepEqual(foldersAffectedBy({ kind: 'deleted', folderId: 'f1' }), ['f1']);
});

test('moving an item invalidates both folders (once each)', () => {
  assert.deepEqual(foldersAffectedBy({ kind: 'moved', fromFolderId: 'f1', toFolderId: 'f2' }), ['f1', 'f2']);
  assert.deepEqual(foldersAffectedBy({ kind: 'moved', fromFolderId: 'f1', toFolderId: 'f1' }), ['f1']);
});

test('unknown folders invalidate nothing', () => {
  assert.deepEqual(foldersAffectedBy({ kind: 'photos', folderId: null }), []);
  assert.deepEqual(foldersAffectedBy({ kind: 'moved', fromFolderId: undefined, toFolderId: '' }), []);
  assert.deepEqual(uniqueFolderIds(['a', null, 'a', undefined, 'b']), ['a', 'b']);
});

test('F4: a bulk move invalidates every source folder and the destination', () => {
  assert.deepEqual(foldersAffectedBy({ kind: 'bulkMoved', fromFolderIds: ['f1', 'f1', 'f3'], toFolderId: 'f2' }), ['f1', 'f3', 'f2']);
});

test('F4: both directions between a folder and its nested gallery', () => {
  assert.deepEqual(foldersAffectedBy({ kind: 'bulkMoved', fromFolderIds: ['parent'], toFolderId: 'gallery' }), ['parent', 'gallery']);
  assert.deepEqual(foldersAffectedBy({ kind: 'bulkMoved', fromFolderIds: ['gallery'], toFolderId: 'parent' }), ['gallery', 'parent']);
});

test('F4: unknown sources still invalidate the destination', () => {
  assert.deepEqual(foldersAffectedBy({ kind: 'bulkMoved', fromFolderIds: [null, undefined], toFolderId: 'f2' }), ['f2']);
});
