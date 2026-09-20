import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

export type FolderComment = {
  id: string;
  user_id: string;
  body: string;
  created_at: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

// Comments scoped to one folder (see supabase/migrations/20260717_create_folder_comments.sql),
// separate from the existing post-scoped `comments` table. Same load/insert/
// delete shape as app/post/[id].tsx's comment handling, but for a folder_id
// instead of a post_id.
export function useFolderComments(folderId: string | undefined, currentUserId: string | undefined) {
  const [comments, setComments] = useState<FolderComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!folderId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data: rows } = await supabase
      .from('folder_comments')
      .select('id, user_id, body, created_at')
      .eq('folder_id', folderId)
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
  }, [folderId]);

  useEffect(() => {
    load();
  }, [load]);

  async function addComment(body: string) {
    if (!folderId || !currentUserId || !body.trim() || sending) return;
    setSending(true);
    const { error } = await supabase
      .from('folder_comments')
      .insert({ folder_id: folderId, user_id: currentUserId, body: body.trim() });
    if (!error) await load();
    setSending(false);
    return !error;
  }

  async function deleteComment(commentId: string) {
    const { error } = await supabase.from('folder_comments').delete().eq('id', commentId);
    if (!error) setComments((prev) => prev.filter((c) => c.id !== commentId));
    return !error;
  }

  return { comments, loading, sending, addComment, deleteComment, refresh: load };
}
