-- New table backing the individual-card gallery view's comment sheet
-- (app/collection/[folderId].tsx in card mode, i.e. drilled into one player
-- group within a folder). Deliberately separate from folder_comments (the
-- whole-folder grouping view's comments, see
-- 20260717_create_folder_comments.sql) — a player group has no persisted
-- row/id of its own, so it's keyed by (folder_id, player_key) instead of a
-- single foreign key. player_key mirrors the `player` route param / the
-- app's NO_PLAYER_KEY sentinel for "no player set" (see hooks/use-collection.ts).
--
-- Schema/RLS follow this app's existing conventions exactly (same shape as
-- folder_comments): public read, insert-as-self, own-row delete only.
-- IF NOT EXISTS everywhere so this is safe to run again if it was already
-- applied once before.

CREATE TABLE IF NOT EXISTS public.gallery_comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id  uuid        NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  player_key text        NOT NULL,
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gallery_comments_folder_player_idx
  ON public.gallery_comments (folder_id, player_key, created_at);

ALTER TABLE public.gallery_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gallery_comments_select_public" ON public.gallery_comments;
CREATE POLICY "gallery_comments_select_public" ON public.gallery_comments
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "gallery_comments_insert_own" ON public.gallery_comments;
CREATE POLICY "gallery_comments_insert_own" ON public.gallery_comments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "gallery_comments_delete_own" ON public.gallery_comments;
CREATE POLICY "gallery_comments_delete_own" ON public.gallery_comments
  FOR DELETE USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';
