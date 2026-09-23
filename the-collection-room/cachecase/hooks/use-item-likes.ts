import { useCallback, useEffect, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';

// Item-scoped equivalent of hooks/use-folder-likes.ts (itself modeled on the
// feed's own post likes, see handleLike in app/(tabs)/index.tsx) — same
// optimistic-update-first shape, rollback-on-failure, and re-entry guard,
// backed by item_likes (see supabase/migrations/20260923120000_create_item_
// social.sql) instead of folder_likes. No notification wiring — item likes
// are explicitly out of scope for notifications per this pass.
export function useItemLikes(itemId: string | undefined, currentUserId: string | undefined) {
  const [likeCount, setLikeCount] = useState(0);
  const [liked, setLiked] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  // The actual re-entry guard. setInFlight(true) doesn't take effect until
  // the next render, so two taps arriving before then could both read
  // inFlight as false — the ref is synchronous and closes that gap.
  const inFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (!itemId) {
      setLikeCount(0);
      setLiked(false);
      return;
    }
    const { count } = await supabase
      .from('item_likes')
      .select('*', { count: 'exact', head: true })
      .eq('item_id', itemId);
    setLikeCount(count ?? 0);

    if (currentUserId) {
      const { data } = await supabase
        .from('item_likes')
        .select('user_id')
        .eq('item_id', itemId)
        .eq('user_id', currentUserId)
        .maybeSingle();
      setLiked(!!data);
    } else {
      setLiked(false);
    }
  }, [itemId, currentUserId]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle() {
    if (!itemId || !currentUserId || inFlightRef.current) return;
    inFlightRef.current = true;
    setInFlight(true);

    const prevLiked = liked;
    const prevLikeCount = likeCount;

    // Optimistic update first so the UI responds immediately — same pattern
    // as hooks/use-folder-likes.ts's own toggle().
    setLiked(!prevLiked);
    setLikeCount((c) => (prevLiked ? Math.max(0, c - 1) : c + 1));

    try {
      if (prevLiked) {
        const { error } = await supabase
          .from('item_likes')
          .delete()
          .eq('user_id', currentUserId)
          .eq('item_id', itemId);
        if (error) {
          console.error('Item unlike failed:', error.message);
          setLiked(prevLiked);
          setLikeCount(prevLikeCount);
          return;
        }
      } else {
        const { error } = await supabase
          .from('item_likes')
          .insert({ user_id: currentUserId, item_id: itemId });
        if (error) {
          console.error('Item like failed:', error.message);
          setLiked(prevLiked);
          setLikeCount(prevLikeCount);
          return;
        }
      }
    } catch (e) {
      console.error('Item like toggle threw:', e);
      setLiked(prevLiked);
      setLikeCount(prevLikeCount);
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }

  return { likeCount, liked, inFlight, toggle };
}
