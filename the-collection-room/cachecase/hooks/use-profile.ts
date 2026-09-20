import { useCallback, useEffect, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';
import type { Profile } from '@/types';

export type ProfileStats = {
  folderCount: number;
  itemCount: number;
  postCount: number;
  followerCount: number;
  followingCount: number;
  // Real count of this user's items with a non-null grade — not a stored
  // aggregate, just collection_items.grade IS NOT NULL, same pattern as the
  // other counts here.
  gradedCount: number;
};

export function useProfile(userId: string | undefined) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<ProfileStats>({ folderCount: 0, itemCount: 0, postCount: 0, followerCount: 0, followingCount: 0, gradedCount: 0 });
  const [loading, setLoading] = useState(true);
  // Holds the AbortController for whichever load() batch is currently
  // "active" (the only one allowed to commit state). A batch left running
  // past the point anything still needs it (superseded by a newer load(),
  // or the hook unmounted) can have its underlying XHR connection torn
  // down by the native networking layer; whatwg-fetch's onload handler
  // then reads xhr.status back as 0 and passes it straight into
  // `new Response(...)`, which throws synchronously (RangeError, status
  // outside [200,599]) inside a bare setTimeout callback — outside any
  // promise chain, so nothing here could ever catch it. Aborting
  // ourselves instead routes to whatwg-fetch's onabort handler, a normal
  // rejection. This codebase never calls .throwOnError(), so
  // postgrest-js's own PostgrestBuilder catches that rejection and
  // resolves with an error-shaped result (`{ data: null, count: null,
  // error: {...}, status: 0 }`) rather than rejecting Promise.all —
  // confirmed by reading node_modules/@supabase/postgrest-js/src/
  // PostgrestBuilder.ts. So staleness here is guarded by controller
  // identity (below), and genuine failures are guarded by checking each
  // result's own `.error`, not by catching a thrown AbortError.
  const abortControllerRef = useRef<AbortController | null>(null);

  // Shared by both the mount/userId-change effect and manual refresh() —
  // the caller owns creating/registering `controller` so each has full
  // control over its own cancellation.
  const runLoad = useCallback(async (controller: AbortController) => {
    if (!userId) {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      setLoading(false);
      return;
    }
    setLoading(true);

    try {
      const [profileRes, foldersRes, itemsRes, postsRes, followersRes, followingRes, gradedRes] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', userId).abortSignal(controller.signal).single(),
        supabase.from('folders').select('*', { count: 'exact', head: true }).eq('user_id', userId).abortSignal(controller.signal),
        supabase.from('collection_items').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('collection_status', 'active').abortSignal(controller.signal),
        supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId).abortSignal(controller.signal),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId).abortSignal(controller.signal),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId).abortSignal(controller.signal),
        supabase.from('collection_items').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('collection_status', 'active').not('grade', 'is', null).abortSignal(controller.signal),
      ]);

      // A newer load() (or unmount) may have superseded this exact batch
      // while it was in flight. Its results are stale regardless of
      // whether any individual leg carried an abort error or genuinely
      // completed — discard the whole batch silently (this is normal
      // cancellation, not an application error) rather than let it
      // clobber whatever the active batch already committed or will
      // commit.
      if (abortControllerRef.current !== controller || controller.signal.aborted) {
        return;
      }

      const results = {
        profile: profileRes,
        folders: foldersRes,
        items: itemsRes,
        posts: postsRes,
        followers: followersRes,
        following: followingRes,
        graded: gradedRes,
      } as const;
      const failed = (Object.keys(results) as (keyof typeof results)[]).filter((key) => results[key].error);
      // .single() has PostgREST return an error (e.g. PGRST116) for zero
      // or multiple matching rows, so a successful, error-free response
      // is guaranteed to carry data — but if that guarantee is ever wrong
      // in practice, treat it the same as a failed batch rather than
      // silently pairing a stale/prior profile with freshly committed
      // stats for a possibly-different user.
      const profileDataMissing = !failed.includes('profile') && !profileRes.data;
      if (failed.length > 0 || profileDataMissing) {
        if (__DEV__) {
          const labels = profileDataMissing ? [...failed, 'profile (no data)'] : failed;
          console.error(`useProfile: ${labels.join(', ')} request(s) failed`);
        }
        return;
      }

      setProfile(profileRes.data as Profile);
      setStats({
        folderCount:    foldersRes.count   ?? 0,
        itemCount:      itemsRes.count     ?? 0,
        postCount:      postsRes.count     ?? 0,
        followerCount:  followersRes.count ?? 0,
        followingCount: followingRes.count ?? 0,
        gradedCount:    gradedRes.count    ?? 0,
      });
    } catch (err) {
      // Callers (the mount effect, manual refresh()) don't await/catch
      // this, so rethrowing here would become an unhandled rejection.
      // Normal cancellation must stay silent — only a genuine failure on
      // the still-current, non-aborted controller is worth logging.
      if (controller.signal.aborted || abortControllerRef.current !== controller) {
        return;
      }
      if (__DEV__) console.error('useProfile: load failed', err);
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [userId]);

  const load = useCallback(() => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    return runLoad(controller);
  }, [runLoad]);

  useEffect(() => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    runLoad(controller);

    return () => {
      // Cancels this effect's own batch. Also cancels a manual refresh()
      // batch that superseded it and is still active at cleanup time —
      // otherwise that request would keep running past unmount, exactly
      // the "left running past the point anything still needs it"
      // scenario this whole mechanism exists to prevent. Only clears the
      // ref when it still points at the controller being aborted here;
      // a manual refresh's own controller is aborted but left for its
      // own runLoad() invocation's finally block to clear.
      controller.abort();
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      } else {
        abortControllerRef.current?.abort();
      }
    };
  }, [runLoad]);

  // Adjusts the locally-held follower count without a full profile
  // refetch — used by follow/unfollow (profile-v2-screen.tsx's
  // toggleFollow) right after a confirmed successful Supabase write, so
  // the visible count updates immediately instead of waiting for the
  // next focus-triggered refresh(). Clamped at 0 — a follower count can
  // never go negative. Purely additive to this hook's existing state;
  // refresh()/load() still replace `stats` wholesale on the next focus,
  // which self-corrects any drift rather than compounding with it.
  const adjustFollowerCount = useCallback((delta: number) => {
    setStats((prev) => ({
      ...prev,
      followerCount: Math.max(0, prev.followerCount + delta),
    }));
  }, []);

  return { profile, stats, loading, refresh: load, adjustFollowerCount };
}
