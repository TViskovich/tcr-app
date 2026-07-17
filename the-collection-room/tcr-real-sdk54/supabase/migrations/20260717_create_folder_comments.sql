-- New table backing the folder/group detail screen's comment sheet
-- (components/collection/folder-comments-sheet.tsx, opened from the chat-
-- bubble icon in app/collection/[folderId].tsx's header). Lets people
-- discuss one specific collection of cards (a folder), separate from the
-- existing post-scoped `comments` table.
--
-- Schema/RLS follow this app's existing conventions exactly (see
-- 20260712_create_grail_ratings.sql): public read, insert-as-self, own-row
-- delete only. IF NOT EXISTS everywhere so this is safe to run again if it
-- was already applied once before.

CREATE TABLE IF NOT EXISTS public.folder_comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id  uuid        NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS folder_comments_folder_id_idx
  ON public.folder_comments (folder_id, created_at);

ALTER TABLE public.folder_comments ENABLE ROW LEVEL SECURITY;

-- Matches this app's existing convention (posts_select_public, comments on
-- posts, etc. are all USING (true)) — no per-folder privacy gate on reading
-- comments today.
DROP POLICY IF EXISTS "folder_comments_select_public" ON public.folder_comments;
CREATE POLICY "folder_comments_select_public" ON public.folder_comments
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "folder_comments_insert_own" ON public.folder_comments;
CREATE POLICY "folder_comments_insert_own" ON public.folder_comments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "folder_comments_delete_own" ON public.folder_comments;
CREATE POLICY "folder_comments_delete_own" ON public.folder_comments
  FOR DELETE USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';
