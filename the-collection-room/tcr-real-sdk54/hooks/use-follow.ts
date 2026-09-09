import { useEffect, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';

// Generic per-target-user follow toggle — same `follows` table, same
// insert/delete shape, and same create_or_refresh_follow_notification RPC
// as components/profile-v2/profile-v2-screen.tsx's own toggleFollow. That
// screen's copy is left exactly as it was (it's also wired to its own
// `stats.followerCount` optimistic adjustment, which has no equivalent
// here — a list row isn't displaying anyone's live follower count) —
// this hook exists for call sites that need a self-contained "is the
// viewer following this OTHER user, and toggle it" without that screen's
// extra wiring, starting with the Followers/Following list rows
// (components/profile-v2/follow-list-row.tsx).
//
// `isFollowing` is a real tri-state — `null` means "not known yet," never
// treated as "not following." A caller that already knows the answer (the
// Followers/Following list screens batch it into their own list query —
// see hooks/use-follow-list.ts) passes it as `initialIsFollowing`, which
// seeds state immediately and skips this hook's own fetch entirely — the
// state is never `null` for even one render in that case, so there's
// nothing for a caller to flicker through. Without that seed, `isFollowing`
// starts `null` and this hook fetches the real value itself, exactly as
// before, just without the old false-until-loaded default that caused a
// visible Follow → Following flip once the fetch resolved.
export function useFollow(
  targetUserId: string | undefined,
  currentUserId: string | undefined,
  initialIsFollowing?: boolean,
) {
  const canFollow = !!targetUserId && !!currentUserId && targetUserId !== currentUserId;

  const [isFollowing, setIsFollowing] = useState<boolean | null>(initialIsFollowing ?? null);
  // Mutation in flight (the toggle() call itself) — distinct from
  // `isFollowing === null` (the initial relationship check still
  // resolving). A row is non-interactive during either.
  const [mutating, setMutating] = useState(false);
  // Synchronous re-entry guard for toggle() — same reasoning as
  // hooks/use-saved.ts's useSavedEntity: setMutating(true) doesn't take
  // effect until the next render, so two fast taps could both read
  // `mutating` as false and both fire a mutation.
  const savingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Already known from the caller's own batched query — nothing to
    // fetch, and deliberately not reset back to null on a dependency
    // change here (a changing `initialIsFollowing` prop value, e.g. after
    // the list screen's own refresh(), should update via the state
    // initializer path a fresh row mount takes, not re-flicker an already-
    // mounted row back to unknown).
    if (initialIsFollowing !== undefined) return;

    if (!canFollow) {
      setIsFollowing(false);
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    supabase
      .from('follows')
      .select('follower_id')
      .eq('follower_id', currentUserId)
      .eq('following_id', targetUserId)
      .abortSignal(controller.signal)
      .maybeSingle()
      .then(({ data }) => {
        if (abortControllerRef.current !== controller || controller.signal.aborted) return;
        setIsFollowing(!!data);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canFollow, targetUserId, currentUserId, initialIsFollowing !== undefined]);

  async function toggle() {
    if (!canFollow || isFollowing === null || savingRef.current) return;
    savingRef.current = true;
    setMutating(true);

    const prevFollowing = isFollowing;
    setIsFollowing(!prevFollowing);

    try {
      if (prevFollowing) {
        const { error } = await supabase
          .from('follows')
          .delete()
          .eq('follower_id', currentUserId!)
          .eq('following_id', targetUserId!);
        if (error) {
          console.error('[useFollow] unfollow failed:', error.message);
          setIsFollowing(prevFollowing);
        }
      } else {
        const { error } = await supabase
          .from('follows')
          .insert({ follower_id: currentUserId!, following_id: targetUserId! });
        if (error) {
          console.error('[useFollow] follow failed:', error.message);
          setIsFollowing(prevFollowing);
        } else {
          // Notification delivery is secondary to the follow mutation
          // above, which already succeeded — never let it surface as a
          // failed follow. Same RPC as profile-v2-screen.tsx's own
          // createFollowNotification.
          supabase.rpc('create_or_refresh_follow_notification', { p_followed_user_id: targetUserId }).then(
            ({ error: notifyError }) => {
              if (notifyError) console.error('[useFollow] notify failed:', notifyError.message);
            },
          );
        }
      }
    } catch (e) {
      console.error('[useFollow] toggle threw:', e);
      setIsFollowing(prevFollowing);
    } finally {
      savingRef.current = false;
      setMutating(false);
    }
  }

  return {
    // null = still checking, never treated as "not following" by a caller.
    isFollowing,
    // True while either the initial check is unresolved OR a toggle is in
    // flight — the one flag a caller needs to know "don't let this row be
    // tapped right now."
    checking: isFollowing === null || mutating,
    mutating,
    toggle,
    canFollow,
  };
}
