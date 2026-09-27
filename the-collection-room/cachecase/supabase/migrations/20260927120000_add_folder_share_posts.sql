BEGIN;

-- ============================================================================
-- "Share Folder" feed post (Create menu -> Share Folder -> compose -> post).
--
-- A new post_type 'folder_share' that showcases one of the owner's folders in
-- the feed as a collage of up to 4 of its items.
--
-- Same durable-snapshot architecture as card_share / rate_my_grails:
--   * Each displayed item gets a snapshot row (folder_share_items) with a
--     durable image copy in the public share-snapshots bucket plus its
--     title/subtitle at posting time — created server-side, all-or-nothing,
--     by the create-snapshot-post Edge Function (post_type 'folder_share'),
--     which reuses copyItemImageIntoShareSnapshots.
--   * posts.folder_id / folder_name / folder_item_count snapshot the folder
--     at posting time. Renaming/reordering the folder or changing its
--     contents later does not change the post.
--   * Deleting a source item does NOT remove its cell: item_id is
--     ON DELETE SET NULL and the snapshot image stays (same as
--     card_share_items). Making an item/folder private later also leaves the
--     snapshot as posted (same as Share Card); deleting the POST removes the
--     rows via cascade and the delete-post Edge Function removes the
--     snapshot objects from share-snapshots.
--   * posts.folder_id is ON DELETE SET NULL, so deleting the folder keeps the
--     post (the "View collection" link is then hidden).
--
-- posts.folder_item_count = the number of ELIGIBLE items (active, is_public,
-- with a primary photo) in the folder when it was shared — NOT the folder's
-- total item count. The UI labels it "N public items" accordingly.
--
-- Privacy at posting time is enforced by the Edge Function (not here):
-- the folder must be the caller's and effectively public, and only public
-- photographed items are eligible. Likes/comments/delete reuse the generic
-- posts machinery.
-- ============================================================================

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_post_type_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_post_type_check
  CHECK (post_type IN ('item', 'text', 'rate_my_grails', 'card_share', 'folder_share'));

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES public.folders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS folder_name text,
  ADD COLUMN IF NOT EXISTS folder_item_count integer;

CREATE TABLE IF NOT EXISTS public.folder_share_items (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id             uuid        NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  item_id             uuid        REFERENCES public.collection_items(id) ON DELETE SET NULL,
  snapshot_image_url  text        NOT NULL,
  snapshot_title      text,
  snapshot_subtitle   text,
  display_order       smallint    NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, item_id)
);

CREATE INDEX IF NOT EXISTS folder_share_items_post_idx ON public.folder_share_items (post_id, display_order);

ALTER TABLE public.folder_share_items ENABLE ROW LEVEL SECURITY;

-- Public read, like card_share_items (the rows are just what was shared).
-- No client insert/update/delete policy: rows are written only by the
-- create-snapshot-post Edge Function (service role) and removed by the
-- posts ON DELETE CASCADE.
DROP POLICY IF EXISTS "folder_share_items_select_public" ON public.folder_share_items;
CREATE POLICY "folder_share_items_select_public" ON public.folder_share_items FOR SELECT USING (true);

NOTIFY pgrst, 'reload schema';

COMMIT;
