import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useForegroundGeneration } from '@/lib/app-foreground';
import {
  ensureHomeTabSeenLoaded,
  fetchNewestArrivalAt,
  fetchNewestStackPostAt,
  getHomeTabSeenSnapshot,
  isNewer,
  markHomeTabSeen,
  subscribeHomeTabSeen,
  type HomeTabKey,
} from '@/lib/home-tab-activity';
import { useLatestUnreadMessageAt } from '@/lib/message-badge-context';

// Minimum gap between Stack/Arrivals freshness checks. Checks only ever run
// when Home gains focus or the app returns to the foreground while Home is
// focused — never on a timer — so this just stops a burst of quick
// back-and-forth navigation from re-asking.
const CHECK_MIN_INTERVAL_MS = 30_000;

type Newest = { userId: string; stack: string | null; arrivals: string | null };

/**
 * "New activity" dots for Home's top tabs.
 *
 * - stack:    a post by someone else newer than the newest one seen on Stack.
 * - arrivals: a followed user's item newer than the newest one seen on Arrivals.
 * - messages: an unread conversation whose latest message is newer than the
 *             newest unread one seen on Messages (useUnreadMessages' existing
 *             30s app-wide poll — no extra polling here).
 *
 * A tab's dot clears while that tab is the settled Home section (its
 * watermark advances to the newest value), and Messages' also clears as
 * soon as nothing is unread. Never shown for the section being viewed.
 */
export function useHomeTabActivity({
  userId,
  activeTab,
  homeFocused,
}: {
  userId: string | undefined;
  activeTab: HomeTabKey;
  homeFocused: boolean;
}): Record<HomeTabKey, boolean> {
  const latestUnreadAt = useLatestUnreadMessageAt();
  const foregroundGeneration = useForegroundGeneration();
  const seenSnapshot = useSyncExternalStore(subscribeHomeTabSeen, getHomeTabSeenSnapshot, getHomeTabSeenSnapshot);
  const seen = userId && seenSnapshot?.userId === userId ? seenSnapshot.seen : null;

  const [newestState, setNewestState] = useState<Newest | null>(null);
  const newest = newestState?.userId === userId ? newestState : null;

  // Freshness check: two single-row, single-column queries on Home focus /
  // foreground, throttled. A failed check just leaves the dots as they were.
  const lastCheckRef = useRef<{ userId: string; at: number } | null>(null);
  useEffect(() => {
    if (!userId || !homeFocused) return;
    const last = lastCheckRef.current;
    if (last?.userId === userId && Date.now() - last.at < CHECK_MIN_INTERVAL_MS) return;
    const check = { userId, at: Date.now() };
    lastCheckRef.current = check;
    let cancelled = false;
    let settled = false;
    Promise.all([fetchNewestStackPostAt(userId), fetchNewestArrivalAt(userId), ensureHomeTabSeenLoaded(userId)]).then(
      ([stack, arrivals]) => {
        settled = true;
        if (cancelled) return;
        // First run on this device: start from what exists now rather than
        // flagging all existing content as new.
        markHomeTabSeen(userId, 'stack', stack, { onlyIfUnset: true });
        markHomeTabSeen(userId, 'arrivals', arrivals, { onlyIfUnset: true });
        setNewestState({ userId, stack, arrivals });
      },
      (e) => {
        settled = true;
        if (!cancelled && __DEV__) console.warn('[useHomeTabActivity] freshness check failed:', e);
      },
    );
    return () => {
      cancelled = true;
      // Abandoned before it answered (Home lost focus) — don't let it count
      // toward the throttle, so the next focus checks again.
      if (!settled && lastCheckRef.current === check) lastCheckRef.current = null;
    };
  }, [userId, homeFocused, foregroundGeneration]);

  // Messages needs the stored watermark even before the first check lands.
  useEffect(() => {
    if (userId) ensureHomeTabSeenLoaded(userId);
  }, [userId]);

  // Viewing a section is what "sees" it: advance its watermark to the
  // newest value known for it (only ever forwards).
  const activeNewest =
    activeTab === 'messages' ? latestUnreadAt : activeTab === 'stack' ? newest?.stack : newest?.arrivals;
  useEffect(() => {
    if (!userId || !homeFocused || !seen) return;
    markHomeTabSeen(userId, activeTab, activeNewest);
  }, [userId, homeFocused, activeTab, activeNewest, seen]);

  if (!seen) return { stack: false, arrivals: false, messages: false };
  const viewing = (tab: HomeTabKey) => homeFocused && activeTab === tab;
  return {
    stack: !viewing('stack') && isNewer(newest?.stack, seen.stack),
    arrivals: !viewing('arrivals') && isNewer(newest?.arrivals, seen.arrivals),
    messages: !viewing('messages') && isNewer(latestUnreadAt, seen.messages),
  };
}
