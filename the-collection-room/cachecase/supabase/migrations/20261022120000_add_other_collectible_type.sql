BEGIN;

-- ============================================================================
-- Sixth collectible type: "Other" — item_type 'other', with a required
-- subcategory (other_category) and, for "Other / Custom", the collector's
-- own category name (other_category_custom_name).
--
-- Unlike Pokémon / Comic Book / Trading Card there is no detail table and
-- no RPC: an Other item has only the shared basic fields (title, notes =
-- description, photos, folder, visibility), so it is written with the same
-- plain INSERT / column-granted UPDATE as Sports Card. Category-specific
-- detail forms (and any tables they need) are a later, separate change.
--
-- Backward compatible and forward-only: ADDS 'other' to the item_type CHECK,
-- two nullable columns, two CHECK constraints and two column UPDATE grants.
-- Every existing row has a non-'other' type and NULL in both new columns,
-- so it satisfies both new constraints unchanged. No existing column,
-- policy, trigger or function changes.
-- ============================================================================

ALTER TABLE public.collection_items
  DROP CONSTRAINT IF EXISTS collection_items_item_type_check;

ALTER TABLE public.collection_items
  ADD CONSTRAINT collection_items_item_type_check
  CHECK (item_type IN ('sports_card', 'pokemon', 'figurine', 'comic_book', 'trading_card', 'other'));

-- other_category: the subcategory slug, set exactly when item_type = 'other'.
-- other_category_custom_name: the collector's own category name, set exactly
-- when other_category = 'custom'. NULL otherwise.
ALTER TABLE public.collection_items
  ADD COLUMN IF NOT EXISTS other_category text NULL,
  ADD COLUMN IF NOT EXISTS other_category_custom_name text NULL;

-- Valid combinations only:
--   item_type = 'other'  → a listed other_category; a custom name present
--                          if and only if other_category = 'custom'.
--   any other item_type  → both columns NULL.
-- The explicit IS NOT NULL matters: `NULL IN (...)` is NULL, not false, and
-- a CHECK that evaluates to NULL passes — without it an Other item with no
-- category would be accepted.
ALTER TABLE public.collection_items
  DROP CONSTRAINT IF EXISTS collection_items_other_category_check;

ALTER TABLE public.collection_items
  ADD CONSTRAINT collection_items_other_category_check
  CHECK (
    (
      item_type = 'other'
      AND other_category IS NOT NULL
      AND other_category IN (
        'art', 'watches', 'sneakers', 'coins', 'currency', 'stamps',
        'autographs_memorabilia', 'video_games', 'toys', 'books', 'custom'
      )
      AND ((other_category = 'custom') = (other_category_custom_name IS NOT NULL))
    )
    OR (
      item_type <> 'other'
      AND other_category IS NULL
      AND other_category_custom_name IS NULL
    )
  );

-- Custom name shape (when present): already trimmed, 1–60 characters, no
-- control characters / line breaks, and never the bare word "other" or
-- "custom" (same rule as trading_card_details.franchise's "Other"). The app
-- trims before saving; this is the authoritative guard.
ALTER TABLE public.collection_items
  DROP CONSTRAINT IF EXISTS collection_items_other_category_custom_name_check;

ALTER TABLE public.collection_items
  ADD CONSTRAINT collection_items_other_category_custom_name_check
  CHECK (
    other_category_custom_name IS NULL
    OR (
      other_category_custom_name = btrim(other_category_custom_name)
      AND char_length(other_category_custom_name) BETWEEN 1 AND 60
      AND other_category_custom_name !~ '[[:cntrl:]]'
      AND lower(other_category_custom_name) NOT IN ('other', 'custom')
    )
  );

-- UPDATE on collection_items is granted per column (see
-- 20260910140000_grant_collection_items_is_public_update.sql) — without
-- these, editing an Other item's subcategory would fail with "permission
-- denied". item_type stays ungranted: the top-level type is fixed after
-- creation. INSERT is already granted table-wide.
GRANT UPDATE (other_category, other_category_custom_name)
  ON TABLE public.collection_items TO authenticated;

COMMIT;
