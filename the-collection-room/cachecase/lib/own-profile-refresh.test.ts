/// <reference types="node" />
// Unit tests for the own-profile Posts refresh logic (P2.3 Issue 3, B8a).
// Run: node --test lib/own-profile-refresh.test.ts
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  _resetOwnPostsSignalForTests,
  canPersistOwnProfile,
  currentOwnPostsGeneration,
  focusRefreshPlan,
  markOwnPostsSeen,
  notifyOwnPostsChanged,
  ownPostsDirty,
  pullToRefreshEnabled,
  showPostsRefreshError,
  subscribeOwnPostsChanged,
} from './own-profile-refresh.ts';

beforeEach(() => _resetOwnPostsSignalForTests());

test('B8a regression: publishing a post makes the next focus refresh posts even with a fresh cache', () => {
  assert.equal(focusRefreshPlan({ isOwnProfile: true, cacheFresh: true, postsDirty: ownPostsDirty() }), 'none');
  notifyOwnPostsChanged();
  assert.equal(focusRefreshPlan({ isOwnProfile: true, cacheFresh: true, postsDirty: ownPostsDirty() }), 'posts');
});

test('a stale cache always reloads everything; a visitor always reloads', () => {
  assert.equal(focusRefreshPlan({ isOwnProfile: true, cacheFresh: false, postsDirty: false }), 'full');
  assert.equal(focusRefreshPlan({ isOwnProfile: false, cacheFresh: true, postsDirty: false }), 'full');
});

test('the change stays pending until a fetch that started AFTER it succeeds', () => {
  const before = currentOwnPostsGeneration();        // a fetch starts…
  notifyOwnPostsChanged();                           // …then the post is created
  markOwnPostsSeen(before);                          // that older fetch succeeds
  assert.equal(ownPostsDirty(), true, 'an older fetch never clears a newer change');
  const after = currentOwnPostsGeneration();
  markOwnPostsSeen(after);
  assert.equal(ownPostsDirty(), false);
});

test('an aborted fetch (never marked seen) leaves the change pending (D2)', () => {
  notifyOwnPostsChanged();
  currentOwnPostsGeneration(); // fetch started, then aborted on blur — nothing marked
  assert.equal(ownPostsDirty(), true);
  assert.equal(focusRefreshPlan({ isOwnProfile: true, cacheFresh: true, postsDirty: ownPostsDirty() }), 'posts');
});

test('listeners are notified and can unsubscribe; a throwing listener breaks nothing', () => {
  let calls = 0;
  const off = subscribeOwnPostsChanged(() => calls++);
  subscribeOwnPostsChanged(() => {
    throw new Error('boom');
  });
  notifyOwnPostsChanged();
  off();
  notifyOwnPostsChanged();
  assert.equal(calls, 1);
});

test('D1 regression: the cache is never persisted until the posts fetch succeeded', () => {
  const base = { isOwnProfile: true, hasProfile: true, anyLoading: false, realSettle: true };
  for (const postsStatus of ['idle', 'loading', 'error', 'aborted'] as const) {
    assert.equal(canPersistOwnProfile({ ...base, postsStatus }), false, postsStatus);
  }
  assert.equal(canPersistOwnProfile({ ...base, postsStatus: 'ok' }), true);
  assert.equal(canPersistOwnProfile({ ...base, postsStatus: 'ok', anyLoading: true }), false);
  assert.equal(canPersistOwnProfile({ ...base, postsStatus: 'ok', realSettle: false }), false);
  assert.equal(canPersistOwnProfile({ ...base, postsStatus: 'ok', isOwnProfile: false }), false);
});

test('D4: a failed refresh with posts on screen shows the inline banner', () => {
  assert.equal(showPostsRefreshError({ error: 'x', postCount: 3 }), true);
  assert.equal(showPostsRefreshError({ error: 'x', postCount: 0 }), false);
  assert.equal(showPostsRefreshError({ error: null, postCount: 3 }), false);
});

test('F9: pull-to-refresh is off while editing or reordering, on otherwise', () => {
  assert.equal(pullToRefreshEnabled({ editMode: false, reordering: false }), true);
  assert.equal(pullToRefreshEnabled({ editMode: true, reordering: false }), false);
  assert.equal(pullToRefreshEnabled({ editMode: false, reordering: true }), false);
  assert.equal(pullToRefreshEnabled({ editMode: true, reordering: true }), false);
});
