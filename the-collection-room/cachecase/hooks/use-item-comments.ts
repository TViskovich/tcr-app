import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

export type ItemComment = {
  id: string;
  user_id: string;
  body: string;
  created_at: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

// Comments scoped to one item (see supabase/migrations/20260923120000_
// create_item_social.sql), modeled directly on hooks/use-folder-comments.ts
// — same load/insert/delete shape, just keyed by item_id instead of
// folder_id and backed by item_comments instead of folder_comments. No
// notification wiring — item comments are explicitly out of scope for
// notifications per this pass.
export function useItemComments(itemId: string | undefined, currentUserId: string | undefined) {
  const [comments, setComments] = useState<ItemComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!itemId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data: rows } = await supabase
      .from('item_comments')
      .select('id, user_id, body, created_at')
      .eq('item_id', itemId)
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
  }, [itemId]);

  useEffect(() => {
    load();
  }, [load]);

  async function addComment(body: string) {
    if (!itemId || !currentUserId || !body.trim() || sending) return;
    setSending(true);
    const { error } = await supabase
      .from('item_comments')
      .insert({ item_id: itemId, user_id: currentUserId, body: body.trim() });
    if (!error) await load();
    setSending(false);
    return !error;
  }

  async function deleteComment(commentId: string) {
    const { error } = await supabase.from('item_comments').delete().eq('id', commentId);
    if (!error) setComments((prev) => prev.filter((c) => c.id !== commentId));
    return !error;
  }

  return { comments, loading, sending, addComment, deleteComment, refresh: load };
}
