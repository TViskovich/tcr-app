-- ============================================================================
-- CacheCase Registry — snapshot foundation (Phase S2: register_card
-- populates the snapshot fields added in 20260729130000).
--
-- Reproduces the live register_card definition exactly (same signature,
-- same auth/visibility/card_type checks, same unique-violation handling,
-- same registered_events insert, same SECURITY DEFINER + pinned
-- search_path + grants) with exactly one behavioral addition: when
-- p_collection_item_id is provided, the linked collection_items row is
-- fetched (instead of only existence-checked) so its display fields can be
-- copied into the new snapshot_* columns in the same INSERT. Ownership is
-- verified with the exact same condition the live function already used
-- (ci.id = p_collection_item_id AND ci.user_id = v_caller_id) — just
-- captured as a row instead of a boolean EXISTS.
--
-- snapshot_set_name / snapshot_card_number / snapshot_variation are not
-- set here — collection_items has no equivalent source fields yet (per
-- decision 3 in the S1 migration) — they stay null on every new
-- registration until those source fields exist.
--
-- Does not touch: cc_id generation (trigger, untouched), status/visibility
-- validation, the unique_violation error mapping, the registered
-- registry_events insert, or any transfer RPC. collection_item_id-clearing
-- behavior during ownership-transfer acceptance is untouched — that logic
-- lives entirely in accept_ownership_transfer, not here.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.register_card(
  p_card_type_id uuid DEFAULT NULL,
  p_collection_item_id uuid DEFAULT NULL,
  p_serial_number text DEFAULT NULL,
  p_grade_company text DEFAULT NULL,
  p_grade text DEFAULT NULL,
  p_cert_number text DEFAULT NULL,
  p_visibility text DEFAULT 'public'
)
 RETURNS public.registered_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id  uuid := auth.uid();
  v_constraint text;
  v_row        public.registered_cards;
  v_item       public.collection_items;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_visibility NOT IN ('public', 'unlisted', 'private') THEN
    RAISE EXCEPTION 'Invalid visibility value: %', p_visibility;
  END IF;

  IF p_card_type_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.card_types WHERE id = p_card_type_id
  ) THEN
    RAISE EXCEPTION 'Card type not found';
  END IF;

  IF p_collection_item_id IS NOT NULL THEN
    SELECT * INTO v_item
    FROM public.collection_items ci
    WHERE ci.id = p_collection_item_id AND ci.user_id = v_caller_id;

    IF v_item.id IS NULL THEN
      RAISE EXCEPTION 'Collection item not found or not owned by caller';
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.registered_cards (
      card_type_id, current_owner_id, created_by, collection_item_id,
      serial_number, grade_company, grade, cert_number, visibility,
      snapshot_image_url, snapshot_title, snapshot_player, snapshot_year,
      snapshot_brand, snapshot_team
    ) VALUES (
      p_card_type_id, v_caller_id, v_caller_id, p_collection_item_id,
      NULLIF(btrim(p_serial_number), ''),
      NULLIF(upper(btrim(p_grade_company)), ''),
      NULLIF(btrim(p_grade), ''),
      NULLIF(upper(btrim(p_cert_number)), ''),
      p_visibility,
      v_item.image_url, v_item.title, v_item.player, v_item.year,
      v_item.brand, v_item.team
    )
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'registered_cards_unique_collection_item' THEN
      RAISE EXCEPTION 'This collection item is already linked to another registered card';
    ELSIF v_constraint = 'registered_cards_unique_grade_cert' THEN
      RAISE EXCEPTION 'A card with this grading company and certification number is already registered';
    ELSE
      RAISE; -- unexpected constraint (e.g. cc_id collision surfacing despite the trigger's own retry loop) — surface it, don't mask it
    END IF;
  END;

  INSERT INTO public.registry_events (registered_card_id, event_type, actor_id, to_owner_id, metadata)
  VALUES (v_row.id, 'registered', v_caller_id, v_caller_id, jsonb_build_object('visibility', p_visibility));

  RETURN v_row;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.register_card(uuid, uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.register_card(uuid, uuid, text, text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_card(uuid, uuid, text, text, text, text, text)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
