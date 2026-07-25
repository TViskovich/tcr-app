import { useCallback, useEffect, useState } from 'react';

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

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);

    const [profileRes, foldersRes, itemsRes, postsRes, followersRes, followingRes, gradedRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('folders').select('*', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('collection_items').select('*', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
      supabase.from('collection_items').select('*', { count: 'exact', head: true }).eq('user_id', userId).not('grade', 'is', null),
    ]);

    if (profileRes.data) setProfile(profileRes.data as Profile);
    setStats({
      folderCount:    foldersRes.count   ?? 0,
      itemCount:      itemsRes.count     ?? 0,
      postCount:      postsRes.count     ?? 0,
      followerCount:  followersRes.count ?? 0,
      followingCount: followingRes.count ?? 0,
      gradedCount:    gradedRes.count    ?? 0,
    });
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

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
