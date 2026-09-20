-- ============================================================================
-- Multi-collectible-type support — Phase 1: add the item_type discriminator
-- to collection_items. Purely additive: a NOT NULL column with a DEFAULT
-- backfills every existing row to 'sports_card' as part of adding the
-- column itself, so no separate UPDATE/backfill statement is needed and no
-- existing insert call site (none of which set item_type today) breaks.
--
-- Scope is deliberately narrow — this migration does NOT create the four
-- category-specific detail tables (sports_card_details/pokemon_card_details/
-- figurine_details/comic_book_details) and does NOT touch card_types,
-- registered_cards, registry_events, or any Registry RPC. Registry stays
-- implicitly sports-card-only: register_card() continues reading
-- collection_items.player/team/brand/year/title directly, which are
-- untouched by this migration.
-- ============================================================================

ALTER TABLE public.collection_items
  ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'sports_card';

ALTER TABLE public.collection_items
  DROP CONSTRAINT IF EXISTS collection_items_item_type_check;

ALTER TABLE public.collection_items
  ADD CONSTRAINT collection_items_item_type_check
  CHECK (item_type IN ('sports_card', 'pokemon', 'figurine', 'comic_book'));

NOTIFY pgrst, 'reload schema';
