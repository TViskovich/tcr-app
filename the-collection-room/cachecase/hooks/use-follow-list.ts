import { useCallback, useEffect, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';

export type FollowListDirection = 'followers' | 'following';

export type FollowListUser = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  // Whether the CURRENT viewer already follows this user — batched into
  // this same load (see the third query below) rather than each row
  // fetching its own relationship state. This is always a real boolean by
  // the time a row exists at all (the list screen doesn't render any rows
  // until `loading` is false — see follow-list-screen.tsx), so a row never
  // has to render an unknown/loading state for its OWN follow button; it's
  // resolved before the row is ever mounted, eliminating the Follow→
  // Following flash a per-row fetch used to cause. `false` when there's no
  // signed-in viewer to check against.
  isFollowedByViewer: boolean;
};

// Backs the Followers/Following list screens (app/followers/[userId].tsx,
// app/following/[userId].tsx). Reuses the app's one existing follow
// relationship table — no new schema, no duplicate follow model.
//
// 'followers' of `userId`: rows where follows.following_id = userId; the
// other person in each row is follows.follower_id.
// 'following' of `userId`: rows where follows.follower_id = userId; the
// other person in each row is follows.following_id.
//
// Three round trips (follow rows for the list itself, profiles for the ids
// found, then the viewer's own follow rows against those SAME ids) — the
// first two are the same shape as hooks/use-saved.ts's useSavedAll,
// deliberately not a guessed PostgREST embedded-resource join
// (`profiles!fk_name(...)`), since this app's actual FK constraint names
// for `follows` aren't established anywhere else in the codebase to safely
// assume. The third is what batches the viewer's relationship to every
// listed user into one query instead of hooks/use-follow.ts's per-row
// fetch running once per visible row.
//
// No pagination — matches every other "list of things belonging to a
// user" hook in this app (use-saved.ts's useSavedAll, use-collection.ts's
// folder/item lists), all of which fetch everything in one shot. The only
// hook in this app that actually paginates is the main feed
// (app/(tabs)/index.tsx), which is a different scale of data; nothing here
// prevents adding real pagination later if a profile's follower count
// grows enough to need it.
export function useFollowList(
  userId: string | undefined,
  direction: FollowListDirection,
  currentUserId: string | undefined,
) {
  const [users, setUsers] = useState<FollowListUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    if (!userId) {
      setUsers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const relationColumn = direction === 'followers' ? 'following_id' : 'follower_id';
    const otherColumn = direction === 'followers' ? 'follower_id' : 'following_id';

    try {
      const { data: rows, error: rowsError } = await supabase
        .from('follows')
        .select(`${otherColumn}, created_at`)
        .eq(relationColumn, userId)
        .order('created_at', { ascending: false })
        .abortSignal(controller.signal);

      if (abortControllerRef.current !== controller || controller.signal.aborted) return;
      if (rowsError) throw rowsError;

      // Dedup while preserving the most-recent-first order the query
      // already returned — a Set built from an ordered array keeps
      // first-seen order in JS.
      const orderedIds = [...new Set((rows ?? []).map((r: any) => r[otherColumn] as string))];

      if (!orderedIds.length) {
        setUsers([]);
        return;
      }

      // Profiles and the viewer's own follow relationships against these
      // same ids are independent of each other — fetched in parallel, not
      // sequentially.
      const [profilesResult, viewerFollowsResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url')
          .in('id', orderedIds)
          .abortSignal(controller.signal),
        currentUserId
          ? supabase
              .from('follows')
              .select('following_id')
              .eq('follower_id', currentUserId)
              .in('following_id', orderedIds)
              .abortSignal(controller.signal)
          : Promise.resolve({ data: [] as { following_id: string }[], error: null }),
      ]);

      if (abortControllerRef.current !== controller || controller.signal.aborted) return;
      if (profilesResult.error) throw profilesResult.error;
      if (viewerFollowsResult.error) throw viewerFollowsResult.error;

      const profileMap = new Map((profilesResult.data ?? []).map((p: any) => [p.id, p]));
      const viewerFollowsSet = new Set(
        (viewerFollowsResult.data ?? []).map((r: any) => r.following_id as string),
      );

      setUsers(
        orderedIds
          .map((id) => profileMap.get(id))
          .filter((p): p is NonNullable<typeof p> => !!p) // account deleted since the follow row was created
          .map((p) => ({
            id: p.id,
            username: p.username,
            displayName: p.display_name ?? null,
            avatarUrl: p.avatar_url ?? null,
            isFollowedByViewer: viewerFollowsSet.has(p.id),
          })),
      );
    } catch (e) {
      if (controller.signal.aborted || abortControllerRef.current !== controller) return;
      console.error('[useFollowList] load failed:', e);
      setError('Failed to load list.');
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [userId, direction, currentUserId]);

  useEffect(() => {
    load();
    return () => abortControllerRef.current?.abort();
  }, [load]);

  return { users, loading, error, refresh: load };
}
