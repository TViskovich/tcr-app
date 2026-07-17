import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

// Folder-scoped equivalent of the feed's post likes (see handleLike in
// app/(tabs)/index.tsx) — same optimistic-update-first, no-revert-on-error
// shape, backed by folder_likes (see
// supabase/migrations/20260718_create_folder_likes.sql) instead of the
// post-scoped `likes` table.
export function useFolderLikes(folderId: string | undefined, currentUserId: string | undefined) {
  const [likeCount, setLikeCount] = useState(0);
  const [liked, setLiked] = useState(false);

  const load = useCallback(async () => {
    if (!folderId) {
      setLikeCount(0);
      setLiked(false);
      return;
    }
    const { count } = await supabase
      .from('folder_likes')
      .select('*', { count: 'exact', head: true })
      .eq('folder_id', folderId);
    setLikeCount(count ?? 0);

    if (currentUserId) {
      const { data } = await supabase
        .from('folder_likes')
        .select('user_id')
        .eq('folder_id', folderId)
        .eq('user_id', currentUserId)
        .maybeSingle();
      setLiked(!!data);
    } else {
      setLiked(false);
    }
  }, [folderId, currentUserId]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle() {
    if (!folderId || !currentUserId) return;
    const wasLiked = liked;

    // Optimistic update first so the UI responds immediately — same pattern
    // as app/(tabs)/index.tsx's handleLike.
    setLiked(!wasLiked);
    setLikeCount((c) => (wasLiked ? Math.max(0, c - 1) : c + 1));

    if (wasLiked) {
      const { error } = await supabase
        .from('folder_likes')
        .delete()
        .eq('user_id', currentUserId)
        .eq('folder_id', folderId);
      if (error) console.error('Folder unlike failed:', error.message);
    } else {
      const { error } = await supabase
        .from('folder_likes')
        .insert({ user_id: currentUserId, folder_id: folderId });
      if (error) console.error('Folder like failed:', error.message);
    }
  }

  return { likeCount, liked, toggle };
}
