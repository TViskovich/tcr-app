BEGIN;

-- ============================================================================
-- Folder Share: folder-cover snapshot, plus idempotent alignment of the
-- folder_share schema with the durable-snapshot design.
--
-- 20260927120000_add_folder_share_posts.sql has ALREADY been applied remotely.
-- That migration was revised (from a live-reference design to a durable
-- snapshot design) before it was pushed, and it is not known which revision
-- the remote database received — so every statement below is idempotent and
-- brings EITHER version to the same final state instead of assuming one.
-- ============================================================================

-- 1. The folder's cover at posting time, copied into share-snapshots by the
--    create-snapshot-post Edge Function (NULL when the folder had no explicit
--    cover — the post then shows the item collage). Removed with the post by
--    delete-post, like every other snapshot object.
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS folder_cover_snapshot_url text;

-- 2. folder_share_items must be a durable snapshot table.
ALTER TABLE public.folder_share_items
  ADD COLUMN IF NOT EXISTS snapshot_image_url text,
  ADD COLUMN IF NOT EXISTS snapshot_title text,
  ADD COLUMN IF NOT EXISTS snapshot_subtitle text;

-- item_id: nullable, and a deleted source item keeps its snapshot cell.
ALTER TABLE public.folder_share_items ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE public.folder_share_items DROP CONSTRAINT IF EXISTS folder_share_items_item_id_fkey;
ALTER TABLE public.folder_share_items
  ADD CONSTRAINT folder_share_items_item_id_fkey
  FOREIGN KEY (item_id) REFERENCES public.collection_items(id) ON DELETE SET NULL;

-- snapshot_image_url is required once no legacy (image-less) rows exist; an
-- unpushed/unused table is empty, so this is normally immediately enforced.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.folder_share_items WHERE snapshot_image_url IS NULL) THEN
    ALTER TABLE public.folder_share_items ALTER COLUMN snapshot_image_url SET NOT NULL;
  END IF;
END
$$;

-- 3. Folder posts are now created only by the create-snapshot-post Edge
--    Function; the earlier RPC (if the remote has it) is obsolete.
DROP FUNCTION IF EXISTS public.create_folder_share_post(uuid, text);

NOTIFY pgrst, 'reload schema';

COMMIT;
