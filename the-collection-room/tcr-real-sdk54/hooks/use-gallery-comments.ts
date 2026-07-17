import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

export type GalleryComment = {
  id: string;
  user_id: string;
  body: string;
  created_at: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

// Comments scoped to one player-group gallery within a folder — a folder_id
// + player_key pair (see supabase/migrations/20260719_create_gallery_comments.sql),
// deliberately separate from folder_comments (the whole-folder grouping
// view's comments). player_key mirrors the same value passed as the
// `player` route param / NO_PLAYER_KEY sentinel in app/collection/[folderId].tsx,
// since a player group has no persisted row/id of its own to key off of.
export function useGalleryComments(
  folderId: string | undefined,
  playerKey: string | undefined,
  currentUserId: string | undefined,
) {
  const [comments, setComments] = useState<GalleryComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!folderId || !playerKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data: rows } = await supabase
      .from('gallery_comments')
      .select('id, user_id, body, created_at')
      .eq('folder_id', folderId)
      .eq('player_key', playerKey)
      .order('created_at', { ascending: true });

    const list = (rows ?? []) as { id: string; user_id: string; body: string; created_at: string }[];

    if (!list.length) {
      setComments([]);
      setLoading(false);
      return;
    }

    const userIds = [...new Set(list.map((c) => c.user_id))];
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', userIds);

    const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));

    setComments(
      list.map((c) => {
        const p = profileMap.get(c.user_id) ?? {};
        return {
          id: c.id,
          user_id: c.user_id,
          body: c.body,
          created_at: c.created_at,
          username: p.username ?? 'user',
          display_name: p.display_name ?? null,
          avatar_url: p.avatar_url ?? null,
        };
      }),
    );
    setLoading(false);
  }, [folderId, playerKey]);

  useEffect(() => {
    load();
  }, [load]);

  async function addComment(body: string) {
    if (!folderId || !playerKey || !currentUserId || !body.trim() || sending) return;
    setSending(true);
    const { error } = await supabase
      .from('gallery_comments')
      .insert({ folder_id: folderId, player_key: playerKey, user_id: currentUserId, body: body.trim() });
    if (!error) await load();
    setSending(false);
    return !error;
  }

  async function deleteComment(commentId: string) {
    const { error } = await supabase.from('gallery_comments').delete().eq('id', commentId);
    if (!error) setComments((prev) => prev.filter((c) => c.id !== commentId));
    return !error;
  }

  return { comments, loading, sending, addComment, deleteComment, refresh: load };
}
