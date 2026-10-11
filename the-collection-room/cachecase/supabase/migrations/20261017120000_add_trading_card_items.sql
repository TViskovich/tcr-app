BEGIN;

-- ============================================================================
-- Fifth collectible type: "Trading Card (Other)" — item_type 'trading_card'
-- (Magic: The Gathering, Yu-Gi-Oh!, One Piece, Disney Lorcana, Dragon Ball,
-- Digimon, Star Wars, or a custom franchise).
--
-- Same architecture as Pokémon (20260917120000/20260917120100): a one-to-one
-- detail table keyed by the item, readable under the parent item's own
-- visibility, writable only by its owner, and written together with the
-- item by two SECURITY INVOKER RPCs (one transaction each). Its own table
-- rather than pokemon_card_details: different fields (franchise, card name,
-- variation; no holo type), and no Pokémon rows get mixed with other games.
--
-- Backward compatible: only ADDS 'trading_card' to the item_type CHECK, a
-- new table and two new functions. No existing row, column, policy or
-- function changes.
-- ============================================================================

ALTER TABLE public.collection_items
  DROP CONSTRAINT IF EXISTS collection_items_item_type_check;

ALTER TABLE public.collection_items
  ADD CONSTRAINT collection_items_item_type_check
  CHECK (item_type IN ('sports_card', 'pokemon', 'figurine', 'comic_book', 'trading_card'));

-- franchise holds the chosen game/franchise as displayed — a listed name, or
-- the collector's own name when they picked "Other" and typed one. Never the
-- bare word "Other": both functions below reject it (the app requires a
-- custom name when Other is chosen). NULL = not set.
CREATE TABLE IF NOT EXISTS public.trading_card_details (
  item_id          uuid PRIMARY KEY REFERENCES public.collection_items(id) ON DELETE CASCADE,
  franchise        text,
  card_name        text,
  set_name         text,
  card_number      text,
  rarity           text,
  language         text,
  edition          text,
  grading_company  text,
  grade            text
);

ALTER TABLE public.trading_card_details ENABLE ROW LEVEL SECURITY;

-- Identical rules to pokemon_card_details_* (same parent-item visibility).
CREATE POLICY "trading_card_details_select_public" ON public.trading_card_details
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = trading_card_details.item_id
        AND public.folder_is_effectively_visible(ci.folder_id)
        AND (ci.is_public = true OR ci.user_id = auth.uid())
    )
  );

CREATE POLICY "trading_card_details_insert_own" ON public.trading_card_details
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = trading_card_details.item_id AND ci.user_id = auth.uid()
    )
  );

CREATE POLICY "trading_card_details_update_own" ON public.trading_card_details
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = trading_card_details.item_id AND ci.user_id = auth.uid()
    )
  );

CREATE POLICY "trading_card_details_delete_own" ON public.trading_card_details
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = trading_card_details.item_id AND ci.user_id = auth.uid()
    )
  );

-- Create: the item (title = card name, required) and its details, atomically.
-- Both functions are SECURITY INVOKER, so every write also passes the
-- existing collection_items policies and the trading_card_details policies
-- above, and each runs as one transaction. EXECUTE is revoked from anon
-- explicitly (Supabase's default privileges grant new functions to anon
-- directly, which REVOKE ... FROM PUBLIC doesn't remove); they also reject
-- an unauthenticated caller themselves.
CREATE OR REPLACE FUNCTION public.create_trading_card_item(
  p_folder_id uuid,
  p_estimated_value numeric DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_is_public boolean DEFAULT true,
  p_franchise text DEFAULT NULL,
  p_card_name text DEFAULT NULL,
  p_set_name text DEFAULT NULL,
  p_card_number text DEFAULT NULL,
  p_rarity text DEFAULT NULL,
  p_language text DEFAULT NULL,
  p_edition text DEFAULT NULL,
  p_grading_company text DEFAULT NULL,
  p_grade text DEFAULT NULL
)
RETURNS public.collection_items
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_title  text;
  v_item   public.collection_items;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_folder_id IS NULL THEN
    RAISE EXCEPTION 'Folder is required';
  END IF;

  IF NOT public.folder_owned_by(p_folder_id, v_caller) THEN
    RAISE EXCEPTION 'Folder not found or not owned by caller';
  END IF;

  v_title := NULLIF(btrim(p_card_name), '');
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Card name is required';
  END IF;

  IF lower(btrim(p_franchise)) = 'other' THEN
    RAISE EXCEPTION 'Please specify the franchise';
  END IF;

  INSERT INTO public.collection_items (
    folder_id, user_id, item_type, title, estimated_value, description, is_public
  ) VALUES (
    p_folder_id, v_caller, 'trading_card', v_title,
    p_estimated_value, NULLIF(btrim(p_description), ''), COALESCE(p_is_public, true)
  )
  RETURNING * INTO v_item;

  INSERT INTO public.trading_card_details (
    item_id, franchise, card_name, set_name, card_number, rarity, language, edition,
    grading_company, grade
  ) VALUES (
    v_item.id, NULLIF(btrim(p_franchise), ''), v_title,
    NULLIF(btrim(p_set_name), ''), NULLIF(btrim(p_card_number), ''),
    NULLIF(btrim(p_rarity), ''), NULLIF(btrim(p_language), ''),
    NULLIF(btrim(p_edition), ''),
    NULLIF(btrim(p_grading_company), ''), NULLIF(btrim(p_grade), '')
  );

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.create_trading_card_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_trading_card_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) TO authenticated;

-- Update: owner-only, trading_card items only; upserts the detail row so an
-- item somehow missing one still saves.
CREATE OR REPLACE FUNCTION public.update_trading_card_item(
  p_item_id uuid,
  p_estimated_value numeric DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_is_public boolean DEFAULT true,
  p_franchise text DEFAULT NULL,
  p_card_name text DEFAULT NULL,
  p_set_name text DEFAULT NULL,
  p_card_number text DEFAULT NULL,
  p_rarity text DEFAULT NULL,
  p_language text DEFAULT NULL,
  p_edition text DEFAULT NULL,
  p_grading_company text DEFAULT NULL,
  p_grade text DEFAULT NULL
)
RETURNS public.collection_items
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_caller    uuid := auth.uid();
  v_title     text;
  v_item_type text;
  v_item      public.collection_items;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT item_type INTO v_item_type
  FROM public.collection_items
  WHERE id = p_item_id AND user_id = v_caller;

  IF v_item_type IS NULL THEN
    RAISE EXCEPTION 'Item not found or not owned by caller';
  END IF;

  IF v_item_type <> 'trading_card' THEN
    RAISE EXCEPTION 'This item is not a trading card item';
  END IF;

  v_title := NULLIF(btrim(p_card_name), '');
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Card name is required';
  END IF;

  IF lower(btrim(p_franchise)) = 'other' THEN
    RAISE EXCEPTION 'Please specify the franchise';
  END IF;

  UPDATE public.collection_items
  SET title = v_title,
      estimated_value = p_estimated_value,
      description = NULLIF(btrim(p_description), ''),
      is_public = COALESCE(p_is_public, true)
  WHERE id = p_item_id
  RETURNING * INTO v_item;

  INSERT INTO public.trading_card_details (
    item_id, franchise, card_name, set_name, card_number, rarity, language, edition,
    grading_company, grade
  ) VALUES (
    p_item_id, NULLIF(btrim(p_franchise), ''), v_title,
    NULLIF(btrim(p_set_name), ''), NULLIF(btrim(p_card_number), ''),
    NULLIF(btrim(p_rarity), ''), NULLIF(btrim(p_language), ''),
    NULLIF(btrim(p_edition), ''),
    NULLIF(btrim(p_grading_company), ''), NULLIF(btrim(p_grade), '')
  )
  ON CONFLICT (item_id) DO UPDATE
  SET franchise = EXCLUDED.franchise,
      card_name = EXCLUDED.card_name,
      set_name = EXCLUDED.set_name,
      card_number = EXCLUDED.card_number,
      rarity = EXCLUDED.rarity,
      language = EXCLUDED.language,
      edition = EXCLUDED.edition,
      grading_company = EXCLUDED.grading_company,
      grade = EXCLUDED.grade;

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.update_trading_card_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_trading_card_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
