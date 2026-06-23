import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';
import type { Profile } from '@/types';

export type ProfileStats = {
  folderCount: number;
  itemCount: number;
  postCount: number;
};

export function useProfile(userId: string | undefined) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<ProfileStats>({ folderCount: 0, itemCount: 0, postCount: 0 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);

    const [profileRes, foldersRes, itemsRes, postsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('folders').select('*', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('collection_items').select('*', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId),
    ]);

    if (profileRes.data) setProfile(profileRes.data as Profile);
    setStats({
      folderCount: foldersRes.count ?? 0,
      itemCount: itemsRes.count ?? 0,
      postCount: postsRes.count ?? 0,
    });
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { profile, stats, loading, refresh: load };
}
