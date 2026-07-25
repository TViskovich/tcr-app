-- ============================================================================
-- CacheCase Registry — roll-forward correction after the failed
-- 20260725150000 deploy.
--
-- Root cause (see the schema-drift audit): card_types and registered_cards
-- already existed live, dated 2026-07-09 — predating this repo's entire
-- migration history and referenced by zero application code anywhere in
-- this repo. 20260725150000's `CREATE TABLE IF NOT EXISTS` silently no-op'd
-- against them, then a later statement referenced a column
-- (collection_item_id) that only existed in the *intended* design, not the
-- live table, and the deploy aborted.
--
-- 20260725150000 is intentionally left untouched on disk (migration
-- history is not edited, and it is not marked applied) but is superseded by
-- this file — its own register_card/link/unlink definitions reference
-- column names (public_code, serial_numerator, grading_company,
-- certification_number) that no longer apply per the product decisions
-- below, so that file must never be pushed; this migration is the real one.
--
-- Every "does this already exist" assumption below was verified directly
-- against the live database via `supabase db query --linked` immediately
-- before writing this file — not inferred, not assumed. That is the
-- specific discipline this file exists to restore after the previous
-- incident.
--
-- Product decisions adopted (this session):
--   1. Keep 'owner_registered' as a valid status, alongside the originally
--      planned active/inactive/owner_account_deleted.
--   2. Keep the existing "CC-XXXX-XXXX" cc_id format and its existing
--      generator (generate_cc_id / trg_set_registered_card_cc_id) exactly
--      as-is — hardened in place, not replaced.
--   3. Normalize/validate cc_id's stored shape (a CHECK constraint), but
--      never strip the display format from storage.
--   4. Keep registered_cards.serial_number as free text; no
--      serial_numerator column is added.
--   5. registered_cards becomes RPC-only for writes — the two live
--      direct-INSERT/UPDATE policies are dropped.
--   6. Preserve the live-only columns grade, trust_score (card_types.team,
--      card_types.variation) exactly as they are — no renames, no drops.
--   7. created_at is the registration timestamp; no registered_at column.
--   8. Every change below is an additive ALTER against the live tables —
--      no table is dropped or recreated, no existing column is renamed or
--      removed, no row is deleted.
-- ============================================================================


-- ============================================================================
-- card_types — additive only
-- ============================================================================
ALTER TABLE public.card_types
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Both existing rows already carry a real created_at value (verified) —
-- safe to tighten. Continues Phase 2A's originally-approved design intent;
-- not itself one of the 8 named decisions, but not contradicted by any of
-- them either.
ALTER TABLE public.card_types
  ALTER COLUMN created_at SET NOT NULL;

-- Bundled into one statement so a failure partway rolls back atomically —
-- the previous incident's exact failure mode (a later statement assuming
-- an earlier one's success) does not recur here. Verified zero violations
-- against live data for every one of these before writing them.
ALTER TABLE public.card_types
  ADD CONSTRAINT card_types_year_range
    CHECK (year IS NULL OR (year BETWEEN 1860 AND 2100)),
  ADD CONSTRAINT card_types_print_run_positive
    CHECK (print_run IS NULL OR print_run > 0),
  ADD CONSTRAINT card_types_brand_not_blank
    CHECK (brand IS NULL OR btrim(brand) <> ''),
  ADD CONSTRAINT card_types_set_name_not_blank
    CHECK (set_name IS NULL OR btrim(set_name) <> ''),
  ADD CONSTRAINT card_types_player_name_not_blank
    CHECK (player_name IS NULL OR btrim(player_name) <> ''),
  ADD CONSTRAINT card_types_team_not_blank
    CHECK (team IS NULL OR btrim(team) <> ''),
  ADD CONSTRAINT card_types_card_number_not_blank
    CHECK (card_number IS NULL OR btrim(card_number) <> ''),
  ADD CONSTRAINT card_types_parallel_not_blank
    CHECK (parallel IS NULL OR btrim(parallel) <> ''),
  ADD CONSTRAINT card_types_variation_not_blank
    CHECK (variation IS NULL OR btrim(variation) <> ''),
  ADD CONSTRAINT card_types_sport_not_blank
    CHECK (sport IS NULL OR btrim(sport) <> '');

-- card_types RLS/policies are NOT touched by this migration — the adopted
-- decisions only scope RPC-only writes to registered_cards (decision 5).
-- Live policies ("Authenticated users can read/create card types") are
-- left exactly as they are.


-- ============================================================================
-- registered_cards — additive only
-- ============================================================================
ALTER TABLE public.registered_cards
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS collection_item_id uuid REFERENCES public.collection_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public';

-- current_owner_id's FK target (auth.users, not profiles like every other
-- table in this schema) is deliberately left unchanged — not one of the 8
-- adopted decisions, and functionally harmless to leave: profiles.id
-- itself references auth.users(id) 1:1, so every RPC below can validate
-- ownership via auth.uid() directly without needing the FK retargeted.

-- created_at/updated_at/status all already have non-null values/defaults
-- live (verified: the one existing row has status='owner_registered',
-- non-null created_at/updated_at) — safe to tighten.
ALTER TABLE public.registered_cards
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN status SET NOT NULL;

-- Format constraint matches generate_cc_id()'s EXACT existing alphabet
-- ('ABCDEFGHJKLMNPQRSTUVWXYZ23456789' — excludes 0/1/I/O, keeps L/U; this
-- is NOT the Crockford alphabet originally proposed in Phase 1/2A, which is
-- superseded by decision 2's "keep the existing format" call) and shape
-- (CC-XXXX-XXXX). Verified the one live value ("CC-7DEP-HRTK") matches.
-- status now includes 'owner_registered' per decision 1, alongside the
-- originally-planned three. trust_score/serial_number/grade*/cert_number
-- not-blank/non-negative checks extend the same CHECK-constraint pattern
-- already applied to every other table in this migration and Phase 2A —
-- all verified against live data as zero violations (every value on the
-- one existing row is NULL except status/trust_score, which already
-- satisfy these checks).
ALTER TABLE public.registered_cards
  ADD CONSTRAINT registered_cards_cc_id_format_check
    CHECK (cc_id ~ '^CC-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$'),
  ADD CONSTRAINT registered_cards_status_check
    CHECK (status IN ('owner_registered', 'active', 'inactive', 'owner_account_deleted')),
  ADD CONSTRAINT registered_cards_visibility_check
    CHECK (visibility IN ('public', 'unlisted', 'private')),
  ADD CONSTRAINT registered_cards_trust_score_nonneg
    CHECK (trust_score IS NULL OR trust_score >= 0),
  ADD CONSTRAINT registered_cards_serial_number_not_blank
    CHECK (serial_number IS NULL OR btrim(serial_number) <> ''),
  ADD CONSTRAINT registered_cards_grade_company_not_blank
    CHECK (grade_company IS NULL OR btrim(grade_company) <> ''),
  ADD CONSTRAINT registered_cards_grade_not_blank
    CHECK (grade IS NULL OR btrim(grade) <> ''),
  ADD CONSTRAINT registered_cards_cert_number_not_blank
    CHECK (cert_number IS NULL OR btrim(cert_number) <> '');

-- A collection item can back at most one registered card.
CREATE UNIQUE INDEX IF NOT EXISTS registered_cards_unique_collection_item
  ON public.registered_cards (collection_item_id)
  WHERE collection_item_id IS NOT NULL;

-- One graded cert can only belong to one registered card. Column names
-- match the live schema (grade_company/cert_number), not the originally
-- proposed grading_company/certification_number.
CREATE UNIQUE INDEX IF NOT EXISTS registered_cards_unique_grade_cert
  ON public.registered_cards (grade_company, cert_number)
  WHERE grade_company IS NOT NULL AND cert_number IS NOT NULL
    AND btrim(grade_company) <> '' AND btrim(cert_number) <> '';

-- --- RPC-only writes (decision 5) ---
-- Drops the two live policies that let any owner directly INSERT/UPDATE
-- their own row (including grade/cert_number/status/trust_score with no
-- validation and no audit trail, since registry_events didn't exist until
-- this migration). Verified via repo-wide grep that no application code
-- anywhere references these tables today, so removing them breaks nothing
-- currently shipping. Replaces the owner-only-read policy with a
-- visibility-aware one — otherwise the new visibility column just added
-- above would be inert (never consulted by any policy).
DROP POLICY IF EXISTS "Users can create their own registered cards" ON public.registered_cards;
DROP POLICY IF EXISTS "Users can update their own registered cards" ON public.registered_cards;
DROP POLICY IF EXISTS "Users can read their own registered cards" ON public.registered_cards;

CREATE POLICY "registered_cards_select_visible" ON public.registered_cards
  FOR SELECT USING (
    visibility = 'public'
    OR current_owner_id = auth.uid()
    OR created_by = auth.uid()
  );

-- No INSERT/UPDATE/DELETE policy of any kind remains on registered_cards.
-- All writes go through register_card() / link_registered_card_collection_item()
-- / unlink_registered_card_collection_item() below (all SECURITY DEFINER).


-- ============================================================================
-- registry_events — never reached by the failed deploy; created fresh here,
-- unaffected by any of the 8 decisions (all specific to card_types/
-- registered_cards column shape).
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.registry_events (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  registered_card_id   uuid        NOT NULL REFERENCES public.registered_cards(id) ON DELETE CASCADE,
  event_type           text        NOT NULL,
  actor_id             uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  from_owner_id        uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  to_owner_id          uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  metadata             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT registry_events_event_type_check
    CHECK (event_type IN (
      'registered',
      'item_linked',
      'item_unlinked',
      'status_changed',
      'grading_updated'
    ))
);

CREATE INDEX IF NOT EXISTS registry_events_registered_card_id_idx
  ON public.registry_events (registered_card_id, created_at);

ALTER TABLE public.registry_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "registry_events_select_visible" ON public.registry_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.registered_cards rc
      WHERE rc.id = registered_card_id
        AND (rc.visibility = 'public' OR rc.current_owner_id = auth.uid() OR rc.created_by = auth.uid())
    )
  );

-- No INSERT/UPDATE/DELETE policy for any client role — every event is
-- written exclusively by the SECURITY DEFINER RPCs below.


-- ============================================================================
-- Harden the existing live generator functions IN PLACE — same bodies,
-- same output format/alphabet (decision 2/3: never replace the existing
-- CC-XXXX-XXXX generation), only adding a pinned search_path (neither
-- function had one live — a real search-path-hijacking gap) and revoking
-- the unnecessary anon EXECUTE grant (trigger functions don't need direct
-- grants at all; generate_cc_id has no legitimate reason to be
-- anon-callable either).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_cc_id()
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := 'CC-';
  i int;
begin
  for i in 1..4 loop
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  end loop;

  result := result || '-';

  for i in 1..4 loop
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  end loop;

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_registered_card_cc_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.cc_id is null or new.cc_id = '' then
    loop
      new.cc_id := generate_cc_id();

      exit when not exists (
        select 1
        from registered_cards
        where cc_id = new.cc_id
      );
    end loop;
  end if;

  return new;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.generate_cc_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_cc_id() FROM anon;

REVOKE EXECUTE ON FUNCTION public.set_registered_card_cc_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_registered_card_cc_id() FROM anon;


-- ============================================================================
-- RPC — register_card
-- The only way a registered_cards row (and its first registry_events row)
-- ever gets created now that decision 5 has removed direct client INSERT.
-- Deliberately does NOT generate or set cc_id itself — the existing
-- trg_set_registered_card_cc_id BEFORE INSERT trigger (hardened above)
-- already does that on every insert where cc_id is left null, exactly
-- preserving today's generation mechanism/format per decision 2/3.
-- Always registers into the CALLER's own account (current_owner_id =
-- created_by = auth.uid(), never a parameter).
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

  IF p_collection_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.collection_items ci
    WHERE ci.id = p_collection_item_id AND ci.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Collection item not found or not owned by caller';
  END IF;

  BEGIN
    INSERT INTO public.registered_cards (
      card_type_id, current_owner_id, created_by, collection_item_id,
      serial_number, grade_company, grade, cert_number, visibility
    ) VALUES (
      p_card_type_id, v_caller_id, v_caller_id, p_collection_item_id,
      NULLIF(btrim(p_serial_number), ''),
      NULLIF(upper(btrim(p_grade_company)), ''),
      NULLIF(btrim(p_grade), ''),
      NULLIF(upper(btrim(p_cert_number)), ''),
      p_visibility
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


-- ============================================================================
-- RPC — link_registered_card_collection_item / unlink_registered_card_collection_item
-- Unchanged in logic from the original (never-applied) 20260725150000
-- design — collection_item_id was always going to be a plain nullable FK,
-- and none of the 8 adopted decisions affect it.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.link_registered_card_collection_item(
  p_registered_card_id uuid,
  p_collection_item_id uuid
)
 RETURNS public.registered_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id        uuid := auth.uid();
  v_row              public.registered_cards;
  v_previous_item_id uuid;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_collection_item_id IS NULL THEN
    RAISE EXCEPTION 'collection_item_id is required';
  END IF;

  SELECT * INTO v_row FROM public.registered_cards WHERE id = p_registered_card_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Registered card not found';
  END IF;
  IF v_row.current_owner_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Only the current owner may link a collection item';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.collection_items ci
    WHERE ci.id = p_collection_item_id AND ci.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Collection item not found or not owned by caller';
  END IF;

  v_previous_item_id := v_row.collection_item_id;

  BEGIN
    UPDATE public.registered_cards
    SET collection_item_id = p_collection_item_id, updated_at = now()
    WHERE id = p_registered_card_id
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This collection item is already linked to another registered card';
  END;

  IF v_previous_item_id IS NOT NULL AND v_previous_item_id IS DISTINCT FROM p_collection_item_id THEN
    INSERT INTO public.registry_events (registered_card_id, event_type, actor_id, metadata)
    VALUES (p_registered_card_id, 'item_unlinked', v_caller_id, jsonb_build_object('collection_item_id', v_previous_item_id));
  END IF;

  INSERT INTO public.registry_events (registered_card_id, event_type, actor_id, metadata)
  VALUES (p_registered_card_id, 'item_linked', v_caller_id, jsonb_build_object('collection_item_id', p_collection_item_id));

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unlink_registered_card_collection_item(
  p_registered_card_id uuid
)
 RETURNS public.registered_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id        uuid := auth.uid();
  v_row              public.registered_cards;
  v_previous_item_id uuid;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_row FROM public.registered_cards WHERE id = p_registered_card_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Registered card not found';
  END IF;
  IF v_row.current_owner_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Only the current owner may unlink a collection item';
  END IF;

  IF v_row.collection_item_id IS NULL THEN
    RETURN v_row; -- already unlinked — no-op, no spurious event
  END IF;

  v_previous_item_id := v_row.collection_item_id;

  UPDATE public.registered_cards
  SET collection_item_id = NULL, updated_at = now()
  WHERE id = p_registered_card_id
  RETURNING * INTO v_row;

  INSERT INTO public.registry_events (registered_card_id, event_type, actor_id, metadata)
  VALUES (p_registered_card_id, 'item_unlinked', v_caller_id, jsonb_build_object('collection_item_id', v_previous_item_id));

  RETURN v_row;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.link_registered_card_collection_item(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.link_registered_card_collection_item(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.link_registered_card_collection_item(uuid, uuid)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.unlink_registered_card_collection_item(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.unlink_registered_card_collection_item(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.unlink_registered_card_collection_item(uuid)
  TO authenticated, service_role;

-- get_public_registered_card(...) is intentionally NOT created here — still
-- deferred to Phase 2B (the public registry page work), per the prior
-- audit's conclusion. Not part of this correction.

NOTIFY pgrst, 'reload schema';
