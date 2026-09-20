-- ============================================================================
-- Backfill missing collection_item_images rows and require storage_path.
--
-- Phase 1A of the item-images beta privacy hardening (see the RLS sweep and
-- the item-images static/architecture audits earlier this effort). Confirmed
-- via read-only live inventory: 24 of 24 existing collection_item_images
-- rows already have a non-null storage_path, and non_standard_url_format = 0
-- across every collection_items.image_url — but exactly 1 collection_items
-- row has a non-null image_url with no matching collection_item_images row
-- at all, most likely because the best-effort gallery-row auto-seed insert
-- in app/item/new.tsx's create flow (explicitly documented there as "a
-- failure here shouldn't block the save") didn't land for that one item.
--
-- This migration closes that gap generically — set-based, not hardcoded to
-- that one row's id — using the exact same backfill shape already proven in
-- 20260721120000_create_collection_item_images.sql's own backfill, so the
-- storage_path derivation stays byte-for-byte consistent with both that SQL
-- and this codebase's two TypeScript equivalents (lib/item-images.ts's
-- deriveStoragePathFromPublicUrl and materializeLegacyItemImage, which both
-- parse the identical /object/public/item-images/ marker). No new parsing
-- convention is introduced.
--
-- storage_path is then made NOT NULL, but only after a hard assertion
-- confirms zero NULLs remain — converting today's observed 100% coverage
-- into an enforced schema invariant, which the upcoming signed-URL delivery
-- work (Phase 2+) depends on being able to trust unconditionally.
--
-- Deliberately out of scope for this migration (tracked separately): Storage
-- objects/bucket settings, RLS/policies of any kind, folders.cover_storage_path,
-- application code, and posts/card_share_items/rate_my_grail_cards snapshot
-- behavior — none of those are touched by anything below.
-- ============================================================================

-- --- 1. Backfill: one gallery row for any image-bearing item that has none ---
-- Identical shape/derivation to 20260721120000's own backfill. The
-- NOT EXISTS guard is what makes this both safe to re-run and provably
-- unable to touch any item that already has a gallery row (of any kind,
-- primary or not) — such an item's id can never satisfy NOT EXISTS here, so
-- it's excluded from this INSERT's SELECT entirely, not merely left
-- unmodified by coincidence.
INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary)
SELECT
  ci.id,
  ci.user_id,
  ci.image_url,
  CASE
    WHEN ci.image_url LIKE '%/object/public/item-images/%'
      THEN substring(ci.image_url FROM '/object/public/item-images/(.*)$')
    ELSE NULL
  END,
  0,
  true
FROM public.collection_items ci
WHERE ci.image_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.collection_item_images cii WHERE cii.item_id = ci.id
  );

-- --- 2. Hard assertion: abort rather than silently proceed if any row still
--        lacks a storage_path (including one this backfill's own CASE
--        couldn't resolve, matching the "derive only if it can be done
--        safely" contract shared with deriveStoragePathFromPublicUrl) ---
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.collection_item_images WHERE storage_path IS NULL) THEN
    RAISE EXCEPTION 'collection_item_images has rows with NULL storage_path after backfill — aborting before SET NOT NULL';
  END IF;
END $$;

-- --- 3. Enforce the now-verified invariant ---
ALTER TABLE public.collection_item_images ALTER COLUMN storage_path SET NOT NULL;

NOTIFY pgrst, 'reload schema';
