import { useEffect, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';

// Item-scoped equivalent of hooks/use-folder-likes.ts (itself modeled on the
// feed's own post likes, see handleLike in app/(tabs)/index.tsx) — same
// optimistic-update-first shape, rollback-on-failure, and re-entry guard,
// backed by item_likes (see supabase/migrations/20260923120000_create_item_
// social.sql) instead of folder_likes. No notification wiring — item likes
// are explicitly out of scope for notifications per this pass.
type LikesRow = {
  like_count?: { count: number }[] | null;
  viewer_like?: { user_id: string }[] | null;
};

// One request for both values (was two sequential ones: a HEAD count, then
// the viewer's own row). item_likes is embedded twice through the item —
// once as an aggregate count, once filtered to the viewer and capped at one
// row — so nothing but a number and at most one user_id comes back.
// item_likes_select_visible only exposes likes on items the viewer can see,
// so this returns exactly what the two direct queries did; an item the
// viewer can't see reads as 0 / not liked either way.
async function fetchItemLikes(
  itemId: string,
  currentUserId: string | undefined,
): Promise<{ likeCount: number; liked: boolean }> {
  const { data } = currentUserId
    ? await supabase
        .from('collection_items')
        .select('like_count:item_likes(count), viewer_like:item_likes(user_id)')
        .eq('id', itemId)
        .eq('viewer_like.user_id', currentUserId)
        .limit(1, { referencedTable: 'viewer_like' })
        .maybeSingle()
    : await supabase.from('collection_items').select('like_count:item_likes(count)').eq('id', itemId).maybeSingle();
  const row = data as LikesRow | null;
  return { likeCount: row?.like_count?.[0]?.count ?? 0, liked: (row?.viewer_like?.length ?? 0) > 0 };
}

export function useItemLikes(itemId: string | undefined, currentUserId: string | undefined) {
  const [likeCount, setLikeCount] = useState(0);
  const [liked, setLiked] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  // The actual re-entry guard. setInFlight(true) doesn't take effect until
  // the next render, so two taps arriving before then could both read
  // inFlight as false — the ref is synchronous and closes that gap.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!itemId) return;
    let cancelled = false;
    fetchItemLikes(itemId, currentUserId).then((next) => {
      if (cancelled) return;
      setLikeCount(next.likeCount);
      setLiked(next.liked);
    });
    return () => {
      cancelled = true;
    };
  }, [itemId, currentUserId]);

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
