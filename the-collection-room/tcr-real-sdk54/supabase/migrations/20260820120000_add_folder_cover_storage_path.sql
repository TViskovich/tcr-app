-- Phase 3D (item-images beta privacy hardening): adds the canonical
-- Storage object path for uploaded folder covers, ahead of migrating
-- folder-cover rendering to authorized signed delivery
-- (get-folder-cover-signed-url).
--
-- Also retroactively documents folders.cover_source in migration history.
-- Live inventory (run immediately before this migration) confirmed the
-- column already exists in production — text, NOT NULL, default 'upload'
-- — but no committed migration or supabase/schema.sql entry ever created
-- it, meaning a fresh environment built from this repo's migrations alone
-- would be missing a column the app already depends on for every folder
-- read/write. ADD COLUMN IF NOT EXISTS is a no-op against the current live
-- database (confirmed matching types/definition below); it only closes
-- that drift gap for any future/fresh environment. Folded into this same
-- migration rather than a separate schema-drift migration because it's
-- inert against live state and this migration's own assertion below
-- already depends on cover_source existing with these exact semantics.
ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS cover_source text NOT NULL DEFAULT 'upload';

-- Canonical Storage object path for an uploaded folder cover
-- (cover_source = 'upload'). Deliberately left NULL for
-- cover_source = 'first_card' folders — that cover is resolved server-side
-- from the folder's current newest active item's primary gallery image
-- (collection_item_images.storage_path where is_primary = true), never a
-- folder-owned Storage object, so persisting a path here would create a
-- second, staleness-prone pointer to an item-owned image that could drift
-- out of sync after a primary-image change. cover_image_url remains for
-- transitional/legacy display only — future rendering must not depend on
-- it as a canonical identifier.
ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS cover_storage_path text;

-- Live inventory (run immediately before this migration) confirmed zero
-- rows with cover_source = 'upload' AND cover_image_url IS NOT NULL, so
-- there is nothing to backfill today. This assertion documents and
-- enforces that assumption at migration time rather than silently
-- trusting a point-in-time inventory result — if it ever fails (e.g. this
-- migration is applied later against a database that has since gained
-- uploaded covers), it must be revisited with an actual backfill strategy
-- instead of proceeding to leave those rows with no reconstructable cover.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.folders
  WHERE cover_source = 'upload'
    AND cover_image_url IS NOT NULL
    AND cover_storage_path IS NULL;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Phase 3D migration assertion failed: % upload-cover folder(s) have cover_image_url but no cover_storage_path. This migration assumed zero such rows based on live inventory taken immediately before it — add an explicit backfill before proceeding.',
      v_count;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
