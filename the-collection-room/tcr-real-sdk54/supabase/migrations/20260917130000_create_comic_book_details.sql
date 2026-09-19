-- ============================================================================
-- Multi-collectible-type support — Phase 3: comic_book_details, the second
-- category-specific detail table (see supabase/migrations/
-- 20260916120000_add_collection_item_type.sql's own header for the overall
-- item_type direction, and 20260917120000_create_pokemon_card_details.sql
-- for the precedent this mirrors exactly). Strictly 1:1 with
-- collection_items — item_id is the primary key itself (not a separate id +
-- unique index), same shape as pokemon_card_details/collection_item_images.
--
-- condition_type is a real CHECK-constrained column (not free text) because
-- the Add/Edit form's Raw-vs-Graded field groups are mutually exclusive by
-- design (see the RPCs below, which null out whichever side isn't active).
-- key_types is a text[] — same "small fixed vocabulary, multi-valued, no
-- separate join table" convention already used by profiles.favorite_sports/
-- favorite_teams/collecting_categories/collector_tags
-- (20260808_add_profile_v2_fields-equivalent columns — see Profile in
-- types/index.ts).
--
-- No table-level GRANT statements here — matches pokemon_card_details and
-- every other collection-item-adjacent table in this project: Supabase's
-- default privileges already cover newly created tables; RLS below is what
-- actually restricts access.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.comic_book_details (
  item_id                    uuid PRIMARY KEY REFERENCES public.collection_items(id) ON DELETE CASCADE,

  -- Main Comic Information
  series_title               text,
  issue_number               text,
  publisher                  text,
  publication_year           integer,
  volume                     text,
  cover_variant              text,
  printing                   text,

  -- Condition — condition_type gates which of the two field groups below is
  -- meaningful; the RPCs null out the inactive group's fields rather than
  -- trusting the client to leave them blank.
  condition_type             text NOT NULL DEFAULT 'raw' CHECK (condition_type IN ('raw', 'graded')),
  condition                  text, -- Raw only
  grading_company            text, -- Graded only
  grade                      text, -- Graded only
  certification_number       text, -- Graded only
  label_type                 text, -- Graded only
  page_quality               text, -- Graded only

  -- Key Issue — key_types/key_description are only meaningful when
  -- is_key_issue is true (enforced by the RPCs, not a CHECK, same
  -- "conditionally-relevant fields just left null" convention as condition
  -- above).
  is_key_issue               boolean NOT NULL DEFAULT false,
  key_types                  text[] NOT NULL DEFAULT '{}',
  key_description            text,

  -- Additional Details
  characters                 text,
  story_arc                  text,
  writer                     text,
  interior_artist            text,
  cover_artist                text,
  edition                    text,
  variant_name               text,
  variant_artist             text,
  incentive_ratio            text,
  retailer_exclusive         text,
  special_cover_finish       text,
  country_market             text,
  is_signed                  boolean NOT NULL DEFAULT false,
  signed_by                  text, -- Signed only
  signature_authentication   text, -- Signed only
  is_restored                boolean NOT NULL DEFAULT false,
  restoration_notes          text -- Restored only
);

ALTER TABLE public.comic_book_details ENABLE ROW LEVEL SECURITY;

-- SELECT — mirrors pokemon_card_details_select_public exactly: visible
-- whenever the parent item's folder chain is effectively public (or owned)
-- AND the item itself is public (or owned). Never more permissive than the
-- item itself.
CREATE POLICY "comic_book_details_select_public" ON public.comic_book_details
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = comic_book_details.item_id
        AND public.folder_is_effectively_visible(ci.folder_id)
        AND (ci.is_public = true OR ci.user_id = auth.uid())
    )
  );

-- INSERT/UPDATE/DELETE — ownership derived entirely through the parent
-- collection_items row, exactly like pokemon_card_details: no user_id
-- column of its own to check directly.
CREATE POLICY "comic_book_details_insert_own" ON public.comic_book_details
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = comic_book_details.item_id AND ci.user_id = auth.uid()
    )
  );

CREATE POLICY "comic_book_details_update_own" ON public.comic_book_details
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = comic_book_details.item_id AND ci.user_id = auth.uid()
    )
  );

CREATE POLICY "comic_book_details_delete_own" ON public.comic_book_details
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = comic_book_details.item_id AND ci.user_id = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
