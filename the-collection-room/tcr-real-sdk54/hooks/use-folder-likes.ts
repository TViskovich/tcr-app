import { useCallback, useEffect, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';

// Folder-scoped equivalent of the feed's post likes (see handleLike in
// app/(tabs)/index.tsx) — same optimistic-update-first shape, backed by
// folder_likes (see supabase/migrations/20260718_create_folder_likes.sql)
// instead of the post-scoped `likes` table. Unlike the feed version, this
// one rolls back on failure and guards against overlapping taps (see
// toggle() below).
export function useFolderLikes(folderId: string | undefined, currentUserId: string | undefined) {
  const [likeCount, setLikeCount] = useState(0);
  const [liked, setLiked] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  // The actual re-entry guard. setInFlight(true) doesn't take effect until
  // the next render, so two taps arriving before then could both read
  // inFlight as false — the ref is synchronous and closes that gap.
  const inFlightRef = useRef(false);

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
    if (!folderId || !currentUserId || inFlightRef.current) return;
    inFlightRef.current = true;
    setInFlight(true);

    const prevLiked = liked;
    const prevLikeCount = likeCount;

    // Optimistic update first so the UI responds immediately — same pattern
    // as app/(tabs)/index.tsx's handleLike.
    setLiked(!prevLiked);
    setLikeCount((c) => (prevLiked ? Math.max(0, c - 1) : c + 1));

    try {
      if (prevLiked) {
        const { error } = await supabase
          .from('folder_likes')
          .delete()
          .eq('user_id', currentUserId)
          .eq('folder_id', folderId);
        if (error) {
          console.error('Folder unlike failed:', error.message);
          setLiked(prevLiked);
          setLikeCount(prevLikeCount);
          return;
        }
      } else {
        const { error } = await supabase
          .from('folder_likes')
          .insert({ user_id: currentUserId, folder_id: folderId });
        if (error) {
          console.error('Folder like failed:', error.message);
          setLiked(prevLiked);
          setLikeCount(prevLikeCount);
          return;
        }
      }
    } catch (e) {
      console.error('Folder like toggle threw:', e);
      setLiked(prevLiked);
      setLikeCount(prevLikeCount);
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }

  return { likeCount, liked, inFlight, toggle };
}
