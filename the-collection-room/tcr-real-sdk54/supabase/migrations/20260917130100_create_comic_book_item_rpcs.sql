-- ============================================================================
-- Multi-collectible-type support — Phase 3: atomic create/update RPCs for
-- Comic Book items, mirroring create_pokemon_item/update_pokemon_item
-- (20260917120100_create_pokemon_item_rpcs.sql) exactly. Both write
-- collection_items AND comic_book_details (20260917130000_
-- create_comic_book_details.sql) in one function body/transaction — a
-- failure in the second INSERT/UPDATE rolls back the first, never leaving a
-- base item with no detail row or vice versa.
--
-- SECURITY INVOKER (not DEFINER), same reasoning as the Pokémon RPCs: every
-- statement below is already independently permitted for `authenticated` by
-- existing grants + RLS —
--   - collection_items INSERT: items_insert_own (folder ownership + own
--     user_id).
--   - collection_items UPDATE: items_update_own (own row) PLUS the
--     column-level allowlist from 20260804120500_
--     fix_collection_items_column_privileges.sql /
--     20260910140000_grant_collection_items_is_public_update.sql — this
--     function only ever writes title/estimated_value/description/
--     is_public, all four already granted to authenticated. item_type stays
--     outside that allowlist, so no client path (this RPC included) can
--     change it after creation.
--   - comic_book_details INSERT/UPDATE: comic_book_details_insert_own /
--     _update_own (ownership derived through the parent collection_items
--     row), from the migration above.
-- An explicit ownership/item_type check still runs up front in both
-- functions for a clear error message — RLS is what actually enforces it
-- underneath either way.
--
-- Condition and Key Issue fields are normalized server-side rather than
-- trusted from the client: whichever of Raw/Graded is NOT selected has its
-- fields forced to null, and Key Type/Key Description are forced to
-- empty/null whenever Key Issue is off, and Signed/Restored's own
-- conditional fields likewise — so a stale or manipulated client payload can
-- never leave inconsistent data (e.g. a "Raw" comic with a Grading Company
-- still set from a previous Graded state).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_comic_book_item(
  p_folder_id uuid,
  p_estimated_value numeric DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_is_public boolean DEFAULT true,
  p_series_title text DEFAULT NULL,
  p_issue_number text DEFAULT NULL,
  p_publisher text DEFAULT NULL,
  p_publication_year integer DEFAULT NULL,
  p_volume text DEFAULT NULL,
  p_cover_variant text DEFAULT NULL,
  p_printing text DEFAULT NULL,
  p_condition_type text DEFAULT 'raw',
  p_condition text DEFAULT NULL,
  p_grading_company text DEFAULT NULL,
  p_grade text DEFAULT NULL,
  p_certification_number text DEFAULT NULL,
  p_label_type text DEFAULT NULL,
  p_page_quality text DEFAULT NULL,
  p_is_key_issue boolean DEFAULT false,
  p_key_types text[] DEFAULT '{}',
  p_key_description text DEFAULT NULL,
  p_characters text DEFAULT NULL,
  p_story_arc text DEFAULT NULL,
  p_writer text DEFAULT NULL,
  p_interior_artist text DEFAULT NULL,
  p_cover_artist text DEFAULT NULL,
  p_edition text DEFAULT NULL,
  p_variant_name text DEFAULT NULL,
  p_variant_artist text DEFAULT NULL,
  p_incentive_ratio text DEFAULT NULL,
  p_retailer_exclusive text DEFAULT NULL,
  p_special_cover_finish text DEFAULT NULL,
  p_country_market text DEFAULT NULL,
  p_is_signed boolean DEFAULT false,
  p_signed_by text DEFAULT NULL,
  p_signature_authentication text DEFAULT NULL,
  p_is_restored boolean DEFAULT false,
  p_restoration_notes text DEFAULT NULL
)
RETURNS public.collection_items
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_caller         uuid := auth.uid();
  v_series_title   text;
  v_title          text;
  v_condition_type text;
  v_item           public.collection_items;
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

  -- Series/Title is the one truly required field — collection_items.title
  -- has no dedicated input in the Comic form, so it's always derived from
  -- this (plus the issue number, when present) instead, same pattern as
  -- create_pokemon_item deriving title from pokemon_name.
  v_series_title := NULLIF(btrim(p_series_title), '');
  IF v_series_title IS NULL THEN
    RAISE EXCEPTION 'Series / Title is required';
  END IF;
  v_title := CASE
    WHEN NULLIF(btrim(p_issue_number), '') IS NOT NULL
      THEN v_series_title || ' #' || btrim(p_issue_number)
    ELSE v_series_title
  END;

  v_condition_type := CASE WHEN p_condition_type = 'graded' THEN 'graded' ELSE 'raw' END;

  INSERT INTO public.collection_items (
    folder_id, user_id, item_type, title, estimated_value, description, is_public
  ) VALUES (
    p_folder_id, v_caller, 'comic_book', v_title,
    p_estimated_value, NULLIF(btrim(p_description), ''), COALESCE(p_is_public, true)
  )
  RETURNING * INTO v_item;

  INSERT INTO public.comic_book_details (
    item_id, series_title, issue_number, publisher, publication_year, volume,
    cover_variant, printing, condition_type, condition, grading_company,
    grade, certification_number, label_type, page_quality, is_key_issue,
    key_types, key_description, characters, story_arc, writer,
    interior_artist, cover_artist, edition, variant_name, variant_artist,
    incentive_ratio, retailer_exclusive, special_cover_finish,
    country_market, is_signed, signed_by, signature_authentication,
    is_restored, restoration_notes
  ) VALUES (
    v_item.id, v_series_title, NULLIF(btrim(p_issue_number), ''),
    NULLIF(btrim(p_publisher), ''), p_publication_year, NULLIF(btrim(p_volume), ''),
    NULLIF(btrim(p_cover_variant), ''), NULLIF(btrim(p_printing), ''), v_condition_type,
    CASE WHEN v_condition_type = 'raw' THEN NULLIF(btrim(p_condition), '') ELSE NULL END,
    CASE WHEN v_condition_type = 'graded' THEN NULLIF(btrim(p_grading_company), '') ELSE NULL END,
    CASE WHEN v_condition_type = 'graded' THEN NULLIF(btrim(p_grade), '') ELSE NULL END,
    CASE WHEN v_condition_type = 'graded' THEN NULLIF(btrim(p_certification_number), '') ELSE NULL END,
    CASE WHEN v_condition_type = 'graded' THEN NULLIF(btrim(p_label_type), '') ELSE NULL END,
    CASE WHEN v_condition_type = 'graded' THEN NULLIF(btrim(p_page_quality), '') ELSE NULL END,
    COALESCE(p_is_key_issue, false),
    CASE WHEN COALESCE(p_is_key_issue, false) THEN COALESCE(p_key_types, '{}') ELSE '{}' END,
    CASE WHEN COALESCE(p_is_key_issue, false) THEN NULLIF(btrim(p_key_description), '') ELSE NULL END,
    NULLIF(btrim(p_characters), ''), NULLIF(btrim(p_story_arc), ''), NULLIF(btrim(p_writer), ''),
    NULLIF(btrim(p_interior_artist), ''), NULLIF(btrim(p_cover_artist), ''), NULLIF(btrim(p_edition), ''),
    NULLIF(btrim(p_variant_name), ''), NULLIF(btrim(p_variant_artist), ''),
    NULLIF(btrim(p_incentive_ratio), ''), NULLIF(btrim(p_retailer_exclusive), ''),
    NULLIF(btrim(p_special_cover_finish), ''), NULLIF(btrim(p_country_market), ''),
    COALESCE(p_is_signed, false),
    CASE WHEN COALESCE(p_is_signed, false) THEN NULLIF(btrim(p_signed_by), '') ELSE NULL END,
    CASE WHEN COALESCE(p_is_signed, false) THEN NULLIF(btrim(p_signature_authentication), '') ELSE NULL END,
    COALESCE(p_is_restored, false),
    CASE WHEN COALESCE(p_is_restored, false) THEN NULLIF(btrim(p_restoration_notes), '') ELSE NULL END
  );

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.create_comic_book_item(
  uuid, numeric, text, boolean, text, text, text, integer, text, text, text,
  text, text, text, text, text, text, text, boolean, text[], text, text,
  text, text, text, text, text, text, text, text, text, text, text, boolean,
  text, text, boolean, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_comic_book_item(
  uuid, numeric, text, boolean, text, text, text, integer, text, text, text,
  text, text, text, text, text, text, text, boolean, text[], text, text,
  text, text, text, text, text, text, text, text, text, text, text, boolean,
  text, text, boolean, text
) TO authenticated;

-- ── update_comic_book_item ───────────────────────────────────────────────
-- item_type is fixed once an item exists (per the column-privilege note
-- above) — this function only ever updates the common + Comic-detail fields
-- of an item that is ALREADY item_type = 'comic_book'; it never creates one
-- and never changes an item's type.
CREATE OR REPLACE FUNCTION public.update_comic_book_item(
  p_item_id uuid,
  p_estimated_value numeric DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_is_public boolean DEFAULT true,
  p_series_title text DEFAULT NULL,
  p_issue_number text DEFAULT NULL,
  p_publisher text DEFAULT NULL,
  p_publication_year integer DEFAULT NULL,
  p_volume text DEFAULT NULL,
  p_cover_variant text DEFAULT NULL,
  p_printing text DEFAULT NULL,
  p_condition_type text DEFAULT 'raw',
  p_condition text DEFAULT NULL,
  p_grading_company text DEFAULT NULL,
  p_grade text DEFAULT NULL,
  p_certification_number text DEFAULT NULL,
  p_label_type text DEFAULT NULL,
  p_page_quality text DEFAULT NULL,
  p_is_key_issue boolean DEFAULT false,
  p_key_types text[] DEFAULT '{}',
  p_key_description text DEFAULT NULL,
  p_characters text DEFAULT NULL,
  p_story_arc text DEFAULT NULL,
  p_writer text DEFAULT NULL,
  p_interior_artist text DEFAULT NULL,
  p_cover_artist text DEFAULT NULL,
  p_edition text DEFAULT NULL,
  p_variant_name text DEFAULT NULL,
  p_variant_artist text DEFAULT NULL,
  p_incentive_ratio text DEFAULT NULL,
  p_retailer_exclusive text DEFAULT NULL,
  p_special_cover_finish text DEFAULT NULL,
  p_country_market text DEFAULT NULL,
  p_is_signed boolean DEFAULT false,
  p_signed_by text DEFAULT NULL,
  p_signature_authentication text DEFAULT NULL,
  p_is_restored boolean DEFAULT false,
  p_restoration_notes text DEFAULT NULL
)
RETURNS public.collection_items
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_caller         uuid := auth.uid();
  v_series_title   text;
  v_title          text;
  v_condition_type text;
  v_item_type      text;
  v_item           public.collection_items;
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

  IF v_item_type <> 'comic_book' THEN
    RAISE EXCEPTION 'This item is not a Comic Book item';
  END IF;

  v_series_title := NULLIF(btrim(p_series_title), '');
  IF v_series_title IS NULL THEN
    RAISE EXCEPTION 'Series / Title is required';
  END IF;
  v_title := CASE
    WHEN NULLIF(btrim(p_issue_number), '') IS NOT NULL
      THEN v_series_title || ' #' || btrim(p_issue_number)
    ELSE v_series_title
  END;

  v_condition_type := CASE WHEN p_condition_type = 'graded' THEN 'graded' ELSE 'raw' END;

  UPDATE public.collection_items
  SET title = v_title,
      estimated_value = p_estimated_value,
      description = NULLIF(btrim(p_description), ''),
      is_public = COALESCE(p_is_public, true)
  WHERE id = p_item_id
  RETURNING * INTO v_item;

  UPDATE public.comic_book_details
  SET series_title = v_series_title,
      issue_number = NULLIF(btrim(p_issue_number), ''),
      publisher = NULLIF(btrim(p_publisher), ''),
      publication_year = p_publication_year,
      volume = NULLIF(btrim(p_volume), ''),
      cover_variant = NULLIF(btrim(p_cover_variant), ''),
      printing = NULLIF(btrim(p_printing), ''),
      condition_type = v_condition_type,
      condition = CASE WHEN v_condition_type = 'raw' THEN NULLIF(btrim(p_condition), '') ELSE NULL END,
      grading_company = CASE WHEN v_condition_type = 'graded' THEN NULLIF(btrim(p_grading_company), '') ELSE NULL END,
      grade = CASE WHEN v_condition_type = 'graded' THEN NULLIF(btrim(p_grade), '') ELSE NULL END,
      certification_number = CASE WHEN v_condition_type = 'graded' THEN NULLIF(btrim(p_certification_number), '') ELSE NULL END,
      label_type = CASE WHEN v_condition_type = 'graded' THEN NULLIF(btrim(p_label_type), '') ELSE NULL END,
      page_quality = CASE WHEN v_condition_type = 'graded' THEN NULLIF(btrim(p_page_quality), '') ELSE NULL END,
      is_key_issue = COALESCE(p_is_key_issue, false),
      key_types = CASE WHEN COALESCE(p_is_key_issue, false) THEN COALESCE(p_key_types, '{}') ELSE '{}' END,
      key_description = CASE WHEN COALESCE(p_is_key_issue, false) THEN NULLIF(btrim(p_key_description), '') ELSE NULL END,
      characters = NULLIF(btrim(p_characters), ''),
      story_arc = NULLIF(btrim(p_story_arc), ''),
      writer = NULLIF(btrim(p_writer), ''),
      interior_artist = NULLIF(btrim(p_interior_artist), ''),
      cover_artist = NULLIF(btrim(p_cover_artist), ''),
      edition = NULLIF(btrim(p_edition), ''),
      variant_name = NULLIF(btrim(p_variant_name), ''),
      variant_artist = NULLIF(btrim(p_variant_artist), ''),
      incentive_ratio = NULLIF(btrim(p_incentive_ratio), ''),
      retailer_exclusive = NULLIF(btrim(p_retailer_exclusive), ''),
      special_cover_finish = NULLIF(btrim(p_special_cover_finish), ''),
      country_market = NULLIF(btrim(p_country_market), ''),
      is_signed = COALESCE(p_is_signed, false),
      signed_by = CASE WHEN COALESCE(p_is_signed, false) THEN NULLIF(btrim(p_signed_by), '') ELSE NULL END,
      signature_authentication = CASE WHEN COALESCE(p_is_signed, false) THEN NULLIF(btrim(p_signature_authentication), '') ELSE NULL END,
      is_restored = COALESCE(p_is_restored, false),
      restoration_notes = CASE WHEN COALESCE(p_is_restored, false) THEN NULLIF(btrim(p_restoration_notes), '') ELSE NULL END
  WHERE item_id = p_item_id;

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.update_comic_book_item(
  uuid, numeric, text, boolean, text, text, text, integer, text, text, text,
  text, text, text, text, text, text, text, boolean, text[], text, text,
  text, text, text, text, text, text, text, text, text, text, text, boolean,
  text, text, boolean, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_comic_book_item(
  uuid, numeric, text, boolean, text, text, text, integer, text, text, text,
  text, text, text, text, text, text, text, boolean, text[], text, text,
  text, text, text, text, text, text, text, text, text, text, text, boolean,
  text, text, boolean, text
) TO authenticated;

NOTIFY pgrst, 'reload schema';
