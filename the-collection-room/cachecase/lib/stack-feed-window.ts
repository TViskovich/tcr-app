// Home's Stack feed: how far back it looks, how it pages, how it orders.
// Pure (no React Native imports) so it is unit tested:
//   node --test lib/stack-feed-window.test.ts
//
// Used by BOTH the Stack feed query (queryFeed in app/(tabs)/index.tsx) and
// the Stack new-activity dot (fetchNewestStackPostAt in
// lib/home-tab-activity.ts), so "a new post you'd see in Stack" can never
// drift from what Stack actually shows.
//
// This is a VISIBILITY window only. Posts older than it simply stop being
// fetched by the Stack feed — nothing expires, is archived or deleted. They
// stay on the author's profile (fetchUserPosts, no date window), behind
// direct links and notifications, and inside reposts/quotes. Block,
// moderation and hidden-account rules are enforced by RLS on public.posts,
// independently of this window.

export const STACK_WINDOW_DAYS = 90;
export const STACK_WINDOW_MS = STACK_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Posts per Stack page (infinite scroll).
export const STACK_PAGE_SIZE = 20;

// ISO timestamp of the oldest created_at the Stack includes (inclusive:
// the query filters created_at >= this).
export function stackWindowStartIso(now: number = Date.now()): string {
  return new Date(now - STACK_WINDOW_MS).toISOString();
}

// Whether a post created at `createdAt` falls inside the Stack window — the
// same rule as the query's .gte('created_at', stackWindowStartIso(now)).
export function isWithinStackWindow(createdAt: string, now: number = Date.now()): boolean {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && t >= now - STACK_WINDOW_MS;
}

// Inclusive PostgREST .range() bounds of a zero-based page.
export function stackPageRange(page: number): { from: number; to: number } {
  const from = page * STACK_PAGE_SIZE;
  return { from, to: from + STACK_PAGE_SIZE - 1 };
}

// Canonical feed chronology — every dataset the Stack renders (initial
// load, refresh, pagination merges) ends up sorted strictly by the post
// record's own created_at, newest first, regardless of post type. Missing/
// malformed timestamps sort to the bottom (0), never the top. Returns a new
// array — never mutates the one passed in.
export function sortPostsByCreatedAtDesc<T extends { created_at?: string | null }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
    return bTime - aTime;
  });
}
