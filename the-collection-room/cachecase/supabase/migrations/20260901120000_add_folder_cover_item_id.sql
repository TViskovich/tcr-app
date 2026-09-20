-- Folder hero/cover: adds explicit "owner picked this one item" as a third
-- cover source, alongside the existing 'upload' (real uploaded file) and
-- 'first_card' (automatic, always the newest active item) — see
-- supabase/migrations/20260820120000_add_folder_cover_storage_path.sql for
-- the original two. This is the smallest extension that lets the folder
-- detail hero's "Choose from Folder" flow reference a SPECIFIC item the
-- owner selected, rather than only ever the newest one.
--
-- No new Storage object, no image duplication: an 'item' cover resolves
-- through the referenced item's own collection_item_images primary row,
-- exactly like 'first_card' already does — cover_item_id is a pointer, not
-- a copy. get-folder-cover-signed-url (updated alongside this migration)
-- is the only place that resolves it, and additionally requires the
-- referenced item's own is_public flag (most-restrictive-wins, matching
-- the collection_items privacy model in
-- 20260825120000_add_collection_item_privacy.sql) for any non-owner
-- viewer.
--
-- cover_source stays a plain text column (no CHECK constraint exists
-- today), so adding the 'item' value needs no constraint change — only
-- application code needs to know about it.
ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS cover_item_id uuid REFERENCES public.collection_items(id) ON DELETE SET NULL;

-- Mirrors collection_items_folder_id_idx's own rationale (added by
-- 20260819120000_enforce_collection_folder_privacy.sql) — this becomes a
-- join/lookup column the moment any folder sets cover_source = 'item'.
CREATE INDEX IF NOT EXISTS folders_cover_item_id_idx
  ON public.folders (cover_item_id)
  WHERE cover_item_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
