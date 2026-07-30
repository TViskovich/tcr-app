-- ============================================================================
-- CacheCase Registry — durable snapshot image foundation (Phase S3, part 2
-- of 2): register_card sets an initial snapshot_image_status at
-- registration time.
--
-- Reproduces the current (Phase S2) register_card definition exactly —
-- same 7-param signature, same auth/visibility/card_type checks, same
-- collection-item ownership fetch, same unique-violation handling, same
-- registered_events insert, same SECURITY DEFINER + pinned search_path +
-- grants — with exactly one addition: the INSERT now also sets
-- snapshot_image_status, computed from data already fetched into v_item
-- (no extra query):
--   - 'pending'     when the ownership-verified linked item has an image
--   - 'unavailable' when there is no linked item, or it has no image
--
-- snapshot_image_url continues to be set exactly as Phase S2 already does
-- (the provisional/legacy value, copied from the live collection item) —
-- unchanged by this migration. Registration does not depend on the
-- copy-registry-snapshot-image Edge Function in any way; that function is
-- invoked by the client as a separate, best-effort follow-up call after
-- this RPC returns successfully.
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
      snapshot_brand, snapshot_team, snapshot_image_status
    ) VALUES (
      p_card_type_id, v_caller_id, v_caller_id, p_collection_item_id,
      NULLIF(btrim(p_serial_number), ''),
      NULLIF(upper(btrim(p_grade_company)), ''),
      NULLIF(btrim(p_grade), ''),
      NULLIF(upper(btrim(p_cert_number)), ''),
      p_visibility,
      v_item.image_url, v_item.title, v_item.player, v_item.year,
      v_item.brand, v_item.team,
      CASE WHEN v_item.image_url IS NOT NULL THEN 'pending' ELSE 'unavailable' END
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
