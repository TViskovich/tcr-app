-- ============================================================================
-- Multi-collectible-type support — Phase 2: pokemon_card_details, the first
-- category-specific detail table (see supabase/migrations/
-- 20260916120000_add_collection_item_type.sql's own header for the overall
-- item_type direction). Strictly 1:1 with collection_items — item_id is the
-- primary key itself (not a separate id + unique index), same "keyed by
-- item_id, ownership derived through the parent row" shape as
-- collection_item_images (20260721120000_create_collection_item_images.sql).
--
-- No table-level GRANT statements here — matches every other
-- collection-item-adjacent table in this project (collection_item_images,
-- card_share_items, profile_grail_slots, folder_comments): none of them
-- carry an explicit GRANT ... TO authenticated, because this project's
-- Supabase default privileges already cover newly created tables; RLS below
-- is what actually restricts access.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pokemon_card_details (
  item_id          uuid PRIMARY KEY REFERENCES public.collection_items(id) ON DELETE CASCADE,
  pokemon_name     text,
  set_name         text,
  card_number      text,
  rarity           text,
  language         text,
  edition          text,
  holo_type        text,
  grading_company  text,
  grade            text
);

ALTER TABLE public.pokemon_card_details ENABLE ROW LEVEL SECURITY;

-- SELECT — mirrors collection_item_images_select_public's CURRENT (recursive,
-- ancestor-aware) definition from supabase/migrations/
-- 20260902120000_recursive_folder_hierarchy_privacy.sql, not the older
-- non-recursive version: visible whenever the parent item's folder chain is
-- effectively public (or owned) AND the item itself is public (or owned).
-- Never more permissive than the item itself, per the explicit requirement.
CREATE POLICY "pokemon_card_details_select_public" ON public.pokemon_card_details
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = pokemon_card_details.item_id
        AND public.folder_is_effectively_visible(ci.folder_id)
        AND (ci.is_public = true OR ci.user_id = auth.uid())
    )
  );

-- INSERT/UPDATE/DELETE — ownership derived entirely through the parent
-- collection_items row, exactly as specified: no user_id column of its own
-- to check directly.
CREATE POLICY "pokemon_card_details_insert_own" ON public.pokemon_card_details
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = pokemon_card_details.item_id AND ci.user_id = auth.uid()
    )
  );

CREATE POLICY "pokemon_card_details_update_own" ON public.pokemon_card_details
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = pokemon_card_details.item_id AND ci.user_id = auth.uid()
    )
  );

CREATE POLICY "pokemon_card_details_delete_own" ON public.pokemon_card_details
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = pokemon_card_details.item_id AND ci.user_id = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
