import AsyncStorage from '@react-native-async-storage/async-storage';

import { FEED_POST_TYPES } from '@/components/feed/post-card';
import { supabase } from '@/lib/supabase';

// Data for the "new activity" dots on Home's top tabs (Stack / Arrivals /
// Messages) — see hooks/use-home-tab-activity.ts for when they show/clear.
//
// Every comparison is between two SERVER timestamps (a row's created_at /
// last_message_at vs. the newest one the user had when they last viewed
// that tab), never the device clock, so clock skew can't fake or hide a dot.

export type HomeTabKey = 'stack' | 'arrivals' | 'messages';
export type HomeTabSeen = Partial<Record<HomeTabKey, string>>;

// Same window and post types as Home's Stack feed (queryFeed in
// app/(tabs)/index.tsx), so "newer than what you've seen" means a post that
// would actually appear in Stack.
const STACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Newest Stack post by someone OTHER than the viewer (your own new post or
// repost shouldn't light the dot). One row, one column, through RLS.
export async function fetchNewestStackPostAt(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('posts')
    .select('created_at')
    .in('post_type', [...FEED_POST_TYPES])
    .gte('created_at', new Date(Date.now() - STACK_WINDOW_MS).toISOString())
    .neq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0] as { created_at: string } | undefined)?.created_at ?? null;
}

// Newest Arrivals item — same follow join and filters as the Arrivals grid
// (queryFollowingItemRows in components/feed/following-items-feed.tsx), but
// only created_at of a single row: no images, owner fields or comment
// counts.
export async function fetchNewestArrivalAt(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('collection_items')
    .select(
      'created_at, owner:profiles!collection_items_user_id_fkey!inner(' +
        'followers:follows!follows_following_id_fkey!inner(follower_id))',
    )
    .eq('owner.followers.follower_id', userId)
    .eq('is_public', true)
    .eq('collection_status', 'active')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0] as unknown as { created_at: string } | undefined)?.created_at ?? null;
}

// a > b for two timestamp strings (null = never). Parsed, not string-
// compared, since PostgREST's fractional-second digits vary.
export function isNewer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return Date.parse(a) > Date.parse(b);
}

// ── Per-user "newest thing seen" watermarks ──────────────────────────────
// Persisted (AsyncStorage) so a dot means "new since you last looked",
// across app launches too. Held in a tiny module store read through
// useSyncExternalStore, so marking a tab seen from an effect is a sync with
// an external store rather than a setState-in-effect.
const seenKey = (userId: string) => `cachecase:home-tab-seen:v1:${userId}`;

type SeenSnapshot = { userId: string; seen: HomeTabSeen } | null;
let seenSnapshot: SeenSnapshot = null;
const seenListeners = new Set<() => void>();
const seenLoads = new Map<string, Promise<void>>();

function setSeen(userId: string, seen: HomeTabSeen) {
  seenSnapshot = { userId, seen };
  for (const listener of seenListeners) listener();
}

export function subscribeHomeTabSeen(listener: () => void) {
  seenListeners.add(listener);
  return () => {
    seenListeners.delete(listener);
  };
}

export function getHomeTabSeenSnapshot(): SeenSnapshot {
  return seenSnapshot;
}

// Loads this user's watermarks once per app session (later calls reuse it).
export function ensureHomeTabSeenLoaded(userId: string): Promise<void> {
  if (seenSnapshot?.userId === userId) return Promise.resolve();
  let pending = seenLoads.get(userId);
  if (!pending) {
    pending = AsyncStorage.getItem(seenKey(userId))
      .then((raw) => {
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        return parsed && typeof parsed === 'object' ? (parsed as HomeTabSeen) : {};
      })
      .catch(() => ({}) as HomeTabSeen)
      .then((seen) => {
        if (seenSnapshot?.userId !== userId) setSeen(userId, seen);
      })
      .finally(() => {
        seenLoads.delete(userId);
      });
    seenLoads.set(userId, pending);
  }
  return pending;
}

// Advances `tab`'s watermark to `newest` (never backwards). `onlyIfUnset`
// is the first-run baseline: a tab never viewed on this device starts at
// whatever is newest now instead of lighting up for all existing content.
export function markHomeTabSeen(
  userId: string,
  tab: HomeTabKey,
  newest: string | null | undefined,
  { onlyIfUnset = false }: { onlyIfUnset?: boolean } = {},
): void {
  if (!newest || seenSnapshot?.userId !== userId) return;
  const current = seenSnapshot.seen[tab];
  if (onlyIfUnset ? current !== undefined : !isNewer(newest, current)) return;
  const seen = { ...seenSnapshot.seen, [tab]: newest };
  setSeen(userId, seen);
  AsyncStorage.setItem(seenKey(userId), JSON.stringify(seen)).catch(() => {});
}
