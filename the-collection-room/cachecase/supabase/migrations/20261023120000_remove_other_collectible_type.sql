BEGIN;

-- ============================================================================
-- Remove the "Other" collectible type (reverses
-- 20261022120000_add_other_collectible_type.sql, which stays in history).
--
-- Forward-only correction: restores collection_items to its previous
-- five-type shape — drops the two Other-specific CHECK constraints and
-- columns (which also drops their column-level UPDATE grants), and restores
-- the previous item_type CHECK. No other schema is touched.
--
-- Data safety: refuses to run (and changes nothing) if ANY row still uses
-- the Other type or either Other column. It never deletes or converts data.
-- ============================================================================

DO $$
DECLARE
  in_use bigint;
BEGIN
  SELECT count(*) INTO in_use
  FROM public.collection_items
  WHERE item_type = 'other'
     OR (to_jsonb(collection_items) ->> 'other_category') IS NOT NULL
     OR (to_jsonb(collection_items) ->> 'other_category_custom_name') IS NOT NULL;
  IF in_use > 0 THEN
    RAISE EXCEPTION 'Refusing to remove the Other collectible type: % item(s) still use it.', in_use;
  END IF;

  -- Explicit revoke of the Other column grants (dropping the columns below
  -- would also remove them); skipped when the columns are already gone.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'collection_items'
               AND column_name = 'other_category') THEN
    EXECUTE 'REVOKE UPDATE (other_category, other_category_custom_name) ON TABLE public.collection_items FROM authenticated';
  END IF;
END $$;

ALTER TABLE public.collection_items
  DROP CONSTRAINT IF EXISTS collection_items_other_category_custom_name_check;

ALTER TABLE public.collection_items
  DROP CONSTRAINT IF EXISTS collection_items_other_category_check;

ALTER TABLE public.collection_items
  DROP COLUMN IF EXISTS other_category_custom_name,
  DROP COLUMN IF EXISTS other_category;

ALTER TABLE public.collection_items
  DROP CONSTRAINT IF EXISTS collection_items_item_type_check;

ALTER TABLE public.collection_items
  ADD CONSTRAINT collection_items_item_type_check
  CHECK (item_type IN ('sports_card', 'pokemon', 'figurine', 'comic_book', 'trading_card'));

COMMIT;
