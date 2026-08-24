-- Harden folder_likes RLS to derive visibility/write-eligibility from the
-- parent folder's own privacy, exactly like the sibling fix already applied
-- to folders/collection_items/collection_item_images/folder_comments/
-- gallery_comments in 20260819120000_enforce_collection_folder_privacy.sql.
--
-- Confirmed live (read-only DB inspection, not assumed): folder_likes_select_public
-- was `USING (true)` and folder_likes_insert_own was `WITH CHECK (auth.uid() =
-- user_id)` with no folder check at all — the exact same USING(true)/no-parent-
-- check shape that migration fixed on five other tables, but folder_likes was
-- never included in that sweep (its own header names exactly five tables and
-- folder_likes isn't one of them, despite having the identical folder_id FK
-- shape and the identical pre-fix policy text). Confirmed live impact:
-- hooks/use-folder-likes.ts's load() fires unconditionally on mount for any
-- folderId (app/collection/[folderId].tsx calls useFolderLikes() before its
-- own isPrivate UI gate is even computed), so a private folder's like count
-- and the current viewer's own like status were both fetched over the network
-- successfully regardless of ownership/visibility, and any authenticated
-- caller who knew a private folder's UUID could insert a like row against it
-- directly via the REST API, independent of the app UI entirely.
--
-- Only SELECT and INSERT are touched, matching the confirmed live gap exactly
-- — DELETE (folder_likes_delete_own, USING (auth.uid() = user_id)) already
-- matches the sibling tables' own precedent (folder_comments_delete_own /
-- gallery_comments_delete_own are likewise not re-checked against folder
-- visibility) and is left untouched: a user must always be able to remove
-- their own existing like row even if the folder's visibility changed after
-- they liked it.

-- --- folder_likes: visibility derived from parent folder only ---
DROP POLICY IF EXISTS "folder_likes_select_public" ON public.folder_likes;
CREATE POLICY "folder_likes_select_public" ON public.folder_likes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.id = folder_likes.folder_id
        AND (f.is_public = true OR f.user_id = auth.uid())
    )
  );

-- --- folder_likes: INSERT requires the folder be public or owned ---
-- Same public-or-owned rule as folder_comments_insert_own /
-- gallery_comments_insert_own (not owned-only, unlike collection_items'
-- insert policy) — a folder "like" is a public-facing engagement action on
-- content the app already lets a non-owner view, not a management action
-- that requires ownership of the folder itself.
DROP POLICY IF EXISTS "folder_likes_insert_own" ON public.folder_likes;
CREATE POLICY "folder_likes_insert_own" ON public.folder_likes
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.id = folder_likes.folder_id
        AND (f.is_public = true OR f.user_id = auth.uid())
    )
  );

NOTIFY pgrst, 'reload schema';
