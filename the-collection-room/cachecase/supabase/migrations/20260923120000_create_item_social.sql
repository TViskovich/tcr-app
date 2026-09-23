-- Item-level social actions (Comment/Like, to match the collection detail
-- screen's own Comment/Like/Share row — see app/collection/[folderId].tsx
-- and hooks/use-folder-likes.ts/use-folder-comments.ts, the implementation
-- pattern this mirrors). Two new tables only — item_likes and
-- item_comments — same shape as folder_likes/folder_comments respectively.
-- Notifications are explicitly OUT of scope for this migration (per
-- request): no changes to public.notifications, no new notification RPCs,
-- and neither table below is referenced by any existing notification
-- trigger/RPC. folder_likes/folder_comments, saved_folders/saved_cards, and
-- every other existing table/policy are untouched.
--
-- Visibility rule (the exact rule given, not the richer
-- items_select_public policy on collection_items itself — see that
-- policy's own history in 20260910130000_fix_folders_rls_recursion.sql for
-- why: it also OR-includes public.item_is_grail_showcased(id), a narrow
-- exception for showing a card's own details when showcased on someone's
-- Rate My Grails wall, which is about surfacing the CARD, not about
-- opening it up for comments/likes — deliberately not carried over here,
-- so this migration does not loosen privacy beyond what was asked):
--
--   caller owns the item
--   OR (item.is_public = true AND its parent folder is effectively
--       visible to the caller — via public.folder_is_effectively_visible,
--       the same recursive-ancestor-aware helper items_select_public
--       itself now calls, not a shallower single-level folders EXISTS)
--
-- This is intentionally the AND of "item is public" with "folder is
-- visible" (not just "folder is public") so a public item inside a folder
-- that's itself hidden by a private ANCESTOR further up the hierarchy
-- (recursive Collections nesting, 20260902120000_recursive_folder_hierarchy_
-- privacy.sql) stays correctly invisible — matching items_select_public's
-- own current behavior for the exact same case.

CREATE TABLE IF NOT EXISTS public.item_likes (
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_id    uuid        NOT NULL REFERENCES public.collection_items(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS item_likes_item_id_idx ON public.item_likes (item_id);

ALTER TABLE public.item_likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "item_likes_select_visible" ON public.item_likes;
CREATE POLICY "item_likes_select_visible" ON public.item_likes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = item_likes.item_id
        AND (
          ci.user_id = auth.uid()
          OR (ci.is_public = true AND public.folder_is_effectively_visible(ci.folder_id))
        )
    )
  );

-- INSERT: authenticated as self, and only against an item currently
-- visible to that same caller (same rule as SELECT above, re-checked here
-- since RLS policies are independent — a caller who can SEE an item is not
-- automatically allowed to like it without this repeating the check).
DROP POLICY IF EXISTS "item_likes_insert_own" ON public.item_likes;
CREATE POLICY "item_likes_insert_own" ON public.item_likes
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = item_likes.item_id
        AND (
          ci.user_id = auth.uid()
          OR (ci.is_public = true AND public.folder_is_effectively_visible(ci.folder_id))
        )
    )
  );

-- DELETE: own row only (unlike) — same as folder_likes_delete_own, no
-- additional item/folder-owner moderation path, and none is being added.
DROP POLICY IF EXISTS "item_likes_delete_own" ON public.item_likes;
CREATE POLICY "item_likes_delete_own" ON public.item_likes
  FOR DELETE USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.item_comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid        NOT NULL REFERENCES public.collection_items(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS item_comments_item_id_idx
  ON public.item_comments (item_id, created_at);

ALTER TABLE public.item_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "item_comments_select_visible" ON public.item_comments;
CREATE POLICY "item_comments_select_visible" ON public.item_comments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = item_comments.item_id
        AND (
          ci.user_id = auth.uid()
          OR (ci.is_public = true AND public.folder_is_effectively_visible(ci.folder_id))
        )
    )
  );

DROP POLICY IF EXISTS "item_comments_insert_own" ON public.item_comments;
CREATE POLICY "item_comments_insert_own" ON public.item_comments
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = item_comments.item_id
        AND (
          ci.user_id = auth.uid()
          OR (ci.is_public = true AND public.folder_is_effectively_visible(ci.folder_id))
        )
    )
  );

-- DELETE: own comment only — matches folder_comments_delete_own exactly.
-- Confirmed (read-only inspection of every migration touching
-- folder_comments, from 20260717_create_folder_comments.sql through
-- 20260902120000_recursive_folder_hierarchy_privacy.sql): the folder-
-- comment system has never had a folder-owner/moderator delete path, only
-- "the comment's own author may delete it" — so there is no existing
-- convention to carry over here beyond that.
DROP POLICY IF EXISTS "item_comments_delete_own" ON public.item_comments;
CREATE POLICY "item_comments_delete_own" ON public.item_comments
  FOR DELETE USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';
