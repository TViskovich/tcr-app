-- New table backing the folder/group detail screen's like (heart) button
-- (app/collection/[folderId].tsx, next to the title). Mirrors the existing
-- post-scoped `likes` table shape (user_id, post_id PK) but for a folder_id
-- instead, and follows the same RLS conventions as folder_comments: public
-- read (needed to compute the like count), insert-as-self, own-row delete
-- only (unlike). IF NOT EXISTS everywhere so this is safe to run again if it
-- was already applied once before.

CREATE TABLE IF NOT EXISTS public.folder_likes (
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  folder_id  uuid        NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, folder_id)
);

CREATE INDEX IF NOT EXISTS folder_likes_folder_id_idx ON public.folder_likes (folder_id);

ALTER TABLE public.folder_likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "folder_likes_select_public" ON public.folder_likes;
CREATE POLICY "folder_likes_select_public" ON public.folder_likes
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "folder_likes_insert_own" ON public.folder_likes;
CREATE POLICY "folder_likes_insert_own" ON public.folder_likes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "folder_likes_delete_own" ON public.folder_likes;
CREATE POLICY "folder_likes_delete_own" ON public.folder_likes
  FOR DELETE USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';
