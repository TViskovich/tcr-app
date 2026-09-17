-- ============================================================================
-- Multi-collectible-type support — Phase 2: atomic create/update RPCs for
-- Pokémon items. Both write collection_items AND pokemon_card_details
-- (20260917120000_create_pokemon_card_details.sql) in one function body, so
-- Postgres runs the whole thing as a single transaction — a failure in the
-- second INSERT/UPDATE rolls back the first, never leaving a base item with
-- no detail row or vice versa.
--
-- SECURITY INVOKER (not DEFINER), matching set_primary_item_image/
-- remove_item_image/reorder_item_images (20260721120000_
-- create_collection_item_images.sql) rather than register_card/
-- move_collection_items: every statement below is already independently
-- permitted for `authenticated` by existing grants + RLS —
--   - collection_items INSERT: items_insert_own (folder ownership + own
--     user_id), no column-level restriction.
--   - collection_items UPDATE: items_update_own (own row) PLUS the
--     column-level allowlist from 20260804120500_
--     fix_collection_items_column_privileges.sql /
--     20260910140000_grant_collection_items_is_public_update.sql — this
--     function only ever writes title/estimated_value/description/
--     is_public, all four already granted to authenticated. item_type is
--     deliberately NOT in that allowlist, so it is already impossible for
--     ANY client path (this RPC included, since SECURITY INVOKER runs under
--     the caller's own grants) to change item_type after creation — no
--     extra guard is needed to keep item_type fixed once an item exists.
--   - pokemon_card_details INSERT/UPDATE: pokemon_card_details_insert_own /
--     _update_own (ownership derived through the parent collection_items
--     row), from the migration above.
-- An explicit ownership/item_type check still runs up front in both
-- functions for a clear error message, matching set_primary_item_image's
-- own "explicit check for a clear error instead of a silent no-op" —
-- RLS is what actually enforces it underneath either way.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_pokemon_item(
  p_folder_id uuid,
  p_estimated_value numeric DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_is_public boolean DEFAULT true,
  p_pokemon_name text DEFAULT NULL,
  p_set_name text DEFAULT NULL,
  p_card_number text DEFAULT NULL,
  p_rarity text DEFAULT NULL,
  p_language text DEFAULT NULL,
  p_edition text DEFAULT NULL,
  p_holo_type text DEFAULT NULL,
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

  -- Pokémon name is the one truly required field — collection_items.title
  -- has no dedicated input in the Pokémon form, so it's always derived from
  -- this instead (see title's own comment below). Every other field stays
  -- fully optional.
  v_title := NULLIF(btrim(p_pokemon_name), '');
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Pokémon name is required';
  END IF;

  INSERT INTO public.collection_items (
    folder_id, user_id, item_type, title, estimated_value, description, is_public
  ) VALUES (
    p_folder_id, v_caller, 'pokemon', v_title,
    p_estimated_value, NULLIF(btrim(p_description), ''), COALESCE(p_is_public, true)
  )
  RETURNING * INTO v_item;

  INSERT INTO public.pokemon_card_details (
    item_id, pokemon_name, set_name, card_number, rarity, language, edition,
    holo_type, grading_company, grade
  ) VALUES (
    v_item.id, v_title,
    NULLIF(btrim(p_set_name), ''), NULLIF(btrim(p_card_number), ''),
    NULLIF(btrim(p_rarity), ''), NULLIF(btrim(p_language), ''),
    NULLIF(btrim(p_edition), ''), NULLIF(btrim(p_holo_type), ''),
    NULLIF(btrim(p_grading_company), ''), NULLIF(btrim(p_grade), '')
  );

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.create_pokemon_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_pokemon_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) TO authenticated;

-- ── update_pokemon_item ──────────────────────────────────────────────────
-- item_type is fixed once an item exists (per the column-privilege note
-- above) — this function only ever updates the common + Pokémon-detail
-- fields of an item that is ALREADY item_type = 'pokemon'; it never creates
-- one and never changes an item's type.
CREATE OR REPLACE FUNCTION public.update_pokemon_item(
  p_item_id uuid,
  p_estimated_value numeric DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_is_public boolean DEFAULT true,
  p_pokemon_name text DEFAULT NULL,
  p_set_name text DEFAULT NULL,
  p_card_number text DEFAULT NULL,
  p_rarity text DEFAULT NULL,
  p_language text DEFAULT NULL,
  p_edition text DEFAULT NULL,
  p_holo_type text DEFAULT NULL,
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

  IF v_item_type <> 'pokemon' THEN
    RAISE EXCEPTION 'This item is not a Pokémon item';
  END IF;

  v_title := NULLIF(btrim(p_pokemon_name), '');
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Pokémon name is required';
  END IF;

  UPDATE public.collection_items
  SET title = v_title,
      estimated_value = p_estimated_value,
      description = NULLIF(btrim(p_description), ''),
      is_public = COALESCE(p_is_public, true)
  WHERE id = p_item_id
  RETURNING * INTO v_item;

  UPDATE public.pokemon_card_details
  SET pokemon_name = v_title,
      set_name = NULLIF(btrim(p_set_name), ''),
      card_number = NULLIF(btrim(p_card_number), ''),
      rarity = NULLIF(btrim(p_rarity), ''),
      language = NULLIF(btrim(p_language), ''),
      edition = NULLIF(btrim(p_edition), ''),
      holo_type = NULLIF(btrim(p_holo_type), ''),
      grading_company = NULLIF(btrim(p_grading_company), ''),
      grade = NULLIF(btrim(p_grade), '')
  WHERE item_id = p_item_id;

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.update_pokemon_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_pokemon_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) TO authenticated;

NOTIFY pgrst, 'reload schema';
