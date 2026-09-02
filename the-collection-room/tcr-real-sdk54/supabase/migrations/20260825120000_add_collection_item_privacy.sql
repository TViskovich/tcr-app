-- ============================================================================
-- Item-level privacy (Model A: most-restrictive-wins).
--
-- Adds collection_items.is_public, independent of and additional to
-- folders.is_public (see 20260819120000_enforce_collection_folder_privacy.sql,
-- which established folder privacy and explicitly said "privacy remains
-- strictly PER-FOLDER" — this migration adds a second, finer-grained gate on
-- top of that, it does not replace it). Effective visibility for a non-owner
-- is now:
--
--   folder.is_public = true AND collection_items.is_public = true
--
-- A private folder still hides everything inside it regardless of any item's
-- own flag (the folder remains the outer boundary); an item inside a public
-- folder may additionally be made private on its own. The owner (auth.uid()
-- = user_id, on either table) always retains full access regardless of
-- either flag — unchanged from the existing folder-privacy pattern.
--
-- Default true / backfill true: existing items must not become invisible the
-- moment this ships. Every existing item's effective visibility is
-- unchanged by this migration — it was previously governed by folder
-- privacy alone, and folder.is_public=true AND collection_items.is_public
-- (now true for every existing row) reduces to exactly the old
-- folder-only rule.
--
-- get-collection-item-image-signed-url (Edge Function, service-role —
-- bypasses this RLS entirely) is updated separately in the same change to
-- mirror this exact condition; the table RLS below does not by itself
-- protect image delivery, which goes through that function, not a direct
-- table read.
-- ============================================================================

ALTER TABLE public.collection_items
  ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;

-- --- collection_items: visibility now requires BOTH folder and item public ---
DROP POLICY IF EXISTS "items_select_public" ON public.collection_items;
CREATE POLICY "items_select_public" ON public.collection_items
  FOR SELECT USING (
    (
      EXISTS (
        SELECT 1 FROM public.folders f
        WHERE f.id = collection_items.folder_id
          AND (f.is_public = true OR f.user_id = auth.uid())
      )
      AND (collection_items.is_public = true OR collection_items.user_id = auth.uid())
    )
  );

-- --- collection_item_images: same AND, one level down (item -> image) ---
DROP POLICY IF EXISTS "collection_item_images_select_public" ON public.collection_item_images;
CREATE POLICY "collection_item_images_select_public" ON public.collection_item_images
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      JOIN public.folders f ON f.id = ci.folder_id
      WHERE ci.id = collection_item_images.item_id
        AND (f.is_public = true OR f.user_id = auth.uid())
        AND (ci.is_public = true OR ci.user_id = auth.uid())
    )
  );

-- folder_comments / gallery_comments are deliberately untouched — both are
-- scoped to folder_id only (no item_id column on either table), so there is
-- no item-specific read path on them to protect.

NOTIFY pgrst, 'reload schema';
