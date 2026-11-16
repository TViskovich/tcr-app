// Own-profile Posts refresh (P2.3 Issue 3, B8a). Pure — no React Native
// imports — so it is unit tested: node --test lib/own-profile-refresh.test.ts
//
// B8a: a post that was saved, shown in the feed and readable in the database
// never appeared on the owner's Profile → Posts tab. Confirmed contributing
// defects (components/profile-v2/profile-v2-screen.tsx, lib/own-profile-cache.ts):
//   D1 the own-profile cache was stamped "fresh" once profile/grails/folders/
//      items settled, WITHOUT waiting for the posts fetch, so it could persist
//      the OLD posts list as fresh;
//   D2 that posts fetch is aborted on blur — the next focus (within 45 s) then
//      trusted the "fresh" cache and skipped the refresh;
//   D3 invalidateOwnProfileCache was a no-op without an in-memory entry;
//   D4 a failed refresh kept the old list with no visible error;
//   D5 there was no manual refresh;
//   D6 creating/deleting a post never told a mounted Profile screen.
// This module holds the "own posts changed" signal (D6) and the refresh
// decisions (D1, D2); the screen wires them.

// ── "Own posts changed" signal ──────────────────────────────────────────────
// Emitted by every lib function that creates, deletes, reposts or quotes a
// post for the signed-in account (lib/posts.ts, lib/share-snapshots.ts,
// lib/folder-share-post.ts, app/share-card/new.tsx). A monotonically
// increasing generation, so a posts fetch that STARTED before a change can
// never mark that change as seen.
let changeGeneration = 0;
let seenGeneration = 0;
const listeners = new Set<() => void>();

export function notifyOwnPostsChanged(): void {
  changeGeneration++;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // a listener must never break the post action that notified it
    }
  }
}

export function subscribeOwnPostsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The generation a posts fetch should record if it succeeds — capture it
// when the fetch STARTS.
export function currentOwnPostsGeneration(): number {
  return changeGeneration;
}

// A posts fetch that started at `generation` succeeded.
export function markOwnPostsSeen(generation: number): void {
  if (generation > seenGeneration) seenGeneration = generation;
}

export function ownPostsDirty(): boolean {
  return changeGeneration > seenGeneration;
}

// Test-only reset.
export function _resetOwnPostsSignalForTests(): void {
  changeGeneration = 0;
  seenGeneration = 0;
  listeners.clear();
}

// ── Refresh decisions ───────────────────────────────────────────────────────
export type FocusRefreshPlan = 'full' | 'posts' | 'none';

// What a focus event should reload. A visitor's profile always reloads fully
// (unchanged); the owner's skips only when the cache is fresh AND no post
// change is pending.
export function focusRefreshPlan(input: { isOwnProfile: boolean; cacheFresh: boolean; postsDirty: boolean }): FocusRefreshPlan {
  if (!input.isOwnProfile || !input.cacheFresh) return 'full';
  return input.postsDirty ? 'posts' : 'none';
}

export type PostsStatus = 'idle' | 'loading' | 'ok' | 'error' | 'aborted';

// Whether the own-profile cache may be written now (D1): only from a real
// load, with every section settled — INCLUDING the posts, which must have
// been fetched successfully. A pending, aborted or failed posts fetch never
// gets the old list stamped as fresh.
export function canPersistOwnProfile(input: {
  isOwnProfile: boolean;
  hasProfile: boolean;
  anyLoading: boolean;
  realSettle: boolean;
  postsStatus: PostsStatus;
}): boolean {
  return input.isOwnProfile && input.hasProfile && !input.anyLoading && input.realSettle && input.postsStatus === 'ok';
}

// Whether the Posts tab should show the inline "couldn't refresh" banner
// (D4): a failed refresh while an older list is still displayed. With no
// posts at all, the existing full error state is shown instead.
export function showPostsRefreshError(input: { error: string | null; postCount: number }): boolean {
  return !!input.error && input.postCount > 0;
}

// Pull-to-refresh on the profile (D5) is offered only while the screen is in
// plain browsing — never while the owner is editing the profile (drag and
// auto-scroll gestures) or reordering (review F9).
export function pullToRefreshEnabled(input: { editMode: boolean; reordering: boolean }): boolean {
  return !input.editMode && !input.reordering;
}
