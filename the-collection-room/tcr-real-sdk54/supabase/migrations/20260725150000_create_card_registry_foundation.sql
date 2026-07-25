-- ============================================================================
-- CacheCase Registry — Phase 2A: database foundation only.
-- See the Phase 1 audit/design conversation for the full rationale; this
-- migration implements exactly its recommended schema + RPC layer. No QR
-- rendering, camera scanning, routes, deep links, or ownership-transfer
-- workflow are part of this migration — those are later phases.
--
-- Three new tables:
--   card_types       — catalog-level description shared by many physical
--                       copies (e.g. "2024 Topps Chrome #1 Shohei Ohtani").
--   registered_cards — the permanent identity for ONE physical copy.
--   registry_events   — append-only provenance timeline per registered card.
--
-- Core security decision (deliberately breaking from this schema's usual
-- "own-row UPDATE" convention — see registered_cards' RLS section below for
-- why): registered_cards has NO client-facing INSERT or UPDATE policy at
-- all. Every write goes through one of three SECURITY DEFINER RPCs
-- (register_card, link_registered_card_collection_item,
-- unlink_registered_card_collection_item), which is the only place a
-- public_code gets generated, an owner gets assigned, or a registry_events
-- row gets written. A plain client UPDATE can never move current_owner_id,
-- forge a public_code, or fabricate history — mirrors why
-- get_or_create_conversation is SECURITY DEFINER (see
-- 20260725130000_concurrency_safe_get_or_create_conversation.sql).
-- ============================================================================


-- ============================================================================
-- TABLE 1 — card_types
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.card_types (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  year                smallint    NULL,
  manufacturer        text        NULL,
  product             text        NULL,
  player              text        NULL,
  card_number         text        NULL,
  parallel            text        NULL,
  sport               text        NULL,
  serial_denominator  integer     NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Generous fixed bounds (not tied to current_date — CHECK constraints
  -- evaluating volatile functions are discouraged and re-verified only at
  -- write time anyway). 1860 predates the earliest known trade/tobacco
  -- cards; 2100 is simply "far enough out to never need revisiting."
  CONSTRAINT card_types_year_range
    CHECK (year IS NULL OR (year BETWEEN 1860 AND 2100)),
  CONSTRAINT card_types_serial_denominator_positive
    CHECK (serial_denominator IS NULL OR serial_denominator > 0),
  -- Blank-but-non-null strings ('', '   ') are rejected outright rather than
  -- silently treated as "unset" — a column that's genuinely unset should be
  -- NULL, not an empty string, so every reader can rely on that distinction.
  CONSTRAINT card_types_manufacturer_not_blank CHECK (manufacturer IS NULL OR btrim(manufacturer) <> ''),
  CONSTRAINT card_types_product_not_blank      CHECK (product      IS NULL OR btrim(product)      <> ''),
  CONSTRAINT card_types_player_not_blank       CHECK (player       IS NULL OR btrim(player)       <> ''),
  CONSTRAINT card_types_card_number_not_blank  CHECK (card_number  IS NULL OR btrim(card_number)  <> ''),
  CONSTRAINT card_types_parallel_not_blank     CHECK (parallel     IS NULL OR btrim(parallel)     <> ''),
  CONSTRAINT card_types_sport_not_blank        CHECK (sport        IS NULL OR btrim(sport)        <> '')
);

-- No automatic global deduplication in this phase, per spec — two identical
-- card_types rows can exist side by side today. Left as a deliberate,
-- documented gap for a future pass, not an oversight.


-- ============================================================================
-- TABLE 2 — registered_cards
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.registered_cards (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code           text        NOT NULL UNIQUE,
  card_type_id          uuid        NULL REFERENCES public.card_types(id) ON DELETE SET NULL,
  current_owner_id      uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by            uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  collection_item_id    uuid        NULL REFERENCES public.collection_items(id) ON DELETE SET NULL,
  serial_numerator      integer     NULL,
  grading_company       text        NULL,
  certification_number  text        NULL,
  status                text        NOT NULL DEFAULT 'active',
  visibility            text        NOT NULL DEFAULT 'public',
  registered_at         timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- current_owner_id / created_by are both SET NULL (not CASCADE) on profile
  -- deletion — deliberately breaking from this schema's usual
  -- profiles(id) ON DELETE CASCADE convention (see follows/folders/
  -- collection_items/posts above). A registry record is meant to survive
  -- its owner's account being deleted (see status value
  -- 'owner_account_deleted' below) — provenance must not silently vanish
  -- just because a user closed their account.

  -- Canonical stored form: uppercase, unhyphenated, fixed 8 characters,
  -- drawn from the Crockford base32 alphabet (0-9, A-Z minus I/L/O/U — 32
  -- symbols, chosen to eliminate visually ambiguous characters on a printed
  -- label). Any CC-XXXX-XXXX display formatting happens at the UI layer
  -- only, never stored.
  CONSTRAINT registered_cards_public_code_format
    CHECK (public_code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  CONSTRAINT registered_cards_serial_numerator_nonneg
    CHECK (serial_numerator IS NULL OR serial_numerator >= 0),
  CONSTRAINT registered_cards_status_check
    CHECK (status IN ('active', 'inactive', 'owner_account_deleted')),
  CONSTRAINT registered_cards_visibility_check
    CHECK (visibility IN ('public', 'unlisted', 'private')),
  CONSTRAINT registered_cards_grading_company_not_blank
    CHECK (grading_company IS NULL OR btrim(grading_company) <> ''),
  CONSTRAINT registered_cards_certification_number_not_blank
    CHECK (certification_number IS NULL OR btrim(certification_number) <> '')
);

-- A collection item can back at most one registry record. Partial (not a
-- plain UNIQUE column constraint) since most rows have collection_item_id
-- IS NULL and NULLs never conflict in a unique index anyway — the WHERE
-- clause just makes that explicit. Same idiom as
-- profile_grail_slots_unique_item.
CREATE UNIQUE INDEX IF NOT EXISTS registered_cards_unique_collection_item
  ON public.registered_cards (collection_item_id)
  WHERE collection_item_id IS NOT NULL;

-- One graded cert can only belong to one registered card. Only applies once
-- BOTH grading_company and certification_number are present and non-blank —
-- ungraded cards (both NULL) are exempt entirely. Assumes register_card()
-- below always normalizes both to upper(btrim(...)) before writing; a
-- future direct/admin write path must normalize the same way or this index
-- will under-protect (e.g. "PSA"/"psa" would not collide).
CREATE UNIQUE INDEX IF NOT EXISTS registered_cards_unique_grading_cert
  ON public.registered_cards (grading_company, certification_number)
  WHERE grading_company IS NOT NULL AND certification_number IS NOT NULL
    AND btrim(grading_company) <> '' AND btrim(certification_number) <> '';

CREATE INDEX IF NOT EXISTS registered_cards_current_owner_id_idx
  ON public.registered_cards (current_owner_id);

CREATE INDEX IF NOT EXISTS registered_cards_card_type_id_idx
  ON public.registered_cards (card_type_id);

-- public_code already has an implicit unique index from its UNIQUE column
-- constraint above — no separate index needed for code lookups.


-- ============================================================================
-- TABLE 3 — registry_events
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

  -- Cascades from registered_cards (not from profiles) — an event with no
  -- parent registry row is meaningless, so it goes with its parent. This is
  -- unrelated to, and does not weaken, the SET NULL-on-profile-deletion
  -- provenance guarantee above: the row itself always survives a user
  -- account deletion, it just loses the specific actor/from/to identity.
  --
  -- Only the initial supported set is enabled here. Ownership-transfer event
  -- types ('ownership_transfer_initiated', '..._accepted', '..._declined',
  -- '..._cancelled', 'ownership_transferred') are intentionally NOT added
  -- yet — no transfer workflow exists in this phase. Extending this CHECK
  -- is a one-line ALTER when that phase begins (see notifications_type_check
  -- in supabase/schema.sql for the established extend-a-CHECK precedent).
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


-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE public.card_types      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registered_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registry_events  ENABLE ROW LEVEL SECURITY;

-- --- card_types: public catalog data, low sensitivity ---
-- Direct client INSERT is allowed (unlike registered_cards below) — a
-- card_type row on its own carries no ownership/identity risk, it's just
-- catalog metadata, and Phase 1/this phase both explicitly defer
-- deduplication rather than gate creation behind an RPC. No UPDATE/DELETE
-- policy for ordinary users yet — editing existing catalog rows is out of
-- scope for this foundation phase.
CREATE POLICY "card_types_select_public" ON public.card_types
  FOR SELECT USING (true);

CREATE POLICY "card_types_insert_own" ON public.card_types
  FOR INSERT WITH CHECK (auth.uid() = created_by);

-- --- registered_cards: no INSERT/UPDATE/DELETE policy for any client role ---
-- SELECT only, and only for: fully public rows, or rows the caller owns or
-- created. 'unlisted' is intentionally treated the same as 'private' at
-- this RLS layer for now — RLS has no notion of "reached via a scanned QR
-- code vs. reached via a general query," so a real "visible if you have the
-- code" access pattern needs its own narrow, column-filtered read path
-- (a view or RPC), which belongs with the registry page/route work
-- (explicitly excluded from this phase) — building it here would mean
-- guessing at a read shape the route layer hasn't been designed yet.
--
-- No INSERT policy: registration only happens via register_card() below
-- (SECURITY DEFINER, bypasses RLS for its own write). No UPDATE policy:
-- current_owner_id must never move via a plain client UPDATE (see this
-- file's header comment) — collection_item_id changes go through the two
-- link/unlink RPCs below, also SECURITY DEFINER. No DELETE policy: registry
-- rows are permanent.
CREATE POLICY "registered_cards_select_visible" ON public.registered_cards
  FOR SELECT USING (
    visibility = 'public'
    OR current_owner_id = auth.uid()
    OR created_by = auth.uid()
  );

-- --- registry_events: append-only, readable only where the parent card is ---
-- Same visibility gate as registered_cards_select_visible, inlined rather
-- than factored into a shared helper function — unlike
-- is_conversation_participant() (a SECURITY DEFINER helper needed
-- specifically to avoid RLS self-recursion when a table's policy
-- references itself), this is a different table referencing
-- registered_cards, so there's no recursion risk to design around.
--
-- No INSERT/UPDATE/DELETE policy for any client role — every event is
-- written exclusively by the SECURITY DEFINER RPCs below. This is what
-- makes "ordinary users must not be able to update or delete registry
-- events" true: they can't even directly INSERT one, let alone edit it.
CREATE POLICY "registry_events_select_visible" ON public.registry_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.registered_cards rc
      WHERE rc.id = registered_card_id
        AND (rc.visibility = 'public' OR rc.current_owner_id = auth.uid() OR rc.created_by = auth.uid())
    )
  );


-- ============================================================================
-- PUBLIC CODE GENERATION
-- ============================================================================
-- Internal helper only — never granted to anon/authenticated (see grants at
-- the bottom of this file). Called exclusively from inside register_card()'s
-- SECURITY DEFINER body, which runs as this function's owner regardless of
-- who the original caller is, so no direct grant is needed for the nested
-- call to succeed. Uses core random() (no pgcrypto dependency) — this code
-- is a public lookup identifier, not a secret/session token, so
-- unpredictability requirements are lower than CSPRNG-grade; collision
-- resistance (the actual security property that matters here) comes from
-- register_card()'s retry-on-unique-violation loop below, not from the
-- quality of this RNG.
CREATE OR REPLACE FUNCTION public.generate_registry_public_code()
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Crockford base32: 0-9 and A-Z minus I, L, O, U (32 symbols exactly —
  -- excluded letters chosen for visual ambiguity with digits/each other,
  -- U additionally dropped per Crockford's own convention to reduce
  -- accidental offensive substrings).
  alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  result   text := '';
  i        int;
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(alphabet, (floor(random() * length(alphabet)))::int + 1, 1);
  END LOOP;
  RETURN result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.generate_registry_public_code() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_registry_public_code() FROM anon;


-- ============================================================================
-- RPC — register_card
-- The only way a registered_cards row (and its first registry_events row)
-- ever gets created. Always registers into the CALLER's own account —
-- current_owner_id and created_by are both auth.uid(), never a parameter,
-- which is what makes "users can register only cards into their own
-- account" true by construction rather than by convention.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.register_card(
  p_card_type_id uuid DEFAULT NULL,
  p_collection_item_id uuid DEFAULT NULL,
  p_serial_numerator integer DEFAULT NULL,
  p_grading_company text DEFAULT NULL,
  p_certification_number text DEFAULT NULL,
  p_visibility text DEFAULT 'public'
)
 RETURNS public.registered_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id      uuid := auth.uid();
  v_grading        text;
  v_cert           text;
  v_candidate_code text;
  v_constraint     text;
  v_attempt        int := 0;
  v_row            public.registered_cards;
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

  -- Ownership check on the collection item mirrors profile_grail_slots'
  -- own INSERT policy shape — belongs to the caller, or it's rejected.
  IF p_collection_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.collection_items ci
    WHERE ci.id = p_collection_item_id AND ci.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Collection item not found or not owned by caller';
  END IF;

  -- Normalized here (not left to the client) so the partial unique index
  -- above actually catches case/whitespace variants of the same real cert
  -- ("PSA"/" psa " must collide with "PSA"). Blank-after-trim collapses to
  -- NULL, matching the table's own not-blank CHECK constraints.
  v_grading := NULLIF(upper(btrim(p_grading_company)), '');
  v_cert    := NULLIF(upper(btrim(p_certification_number)), '');

  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 10 THEN
      RAISE EXCEPTION 'Could not generate a unique registry code — please try again';
    END IF;

    v_candidate_code := public.generate_registry_public_code();

    BEGIN
      INSERT INTO public.registered_cards (
        public_code, card_type_id, current_owner_id, created_by,
        collection_item_id, serial_numerator, grading_company,
        certification_number, visibility
      ) VALUES (
        v_candidate_code, p_card_type_id, v_caller_id, v_caller_id,
        p_collection_item_id, p_serial_numerator, v_grading,
        v_cert, p_visibility
      )
      RETURNING * INTO v_row;

      EXIT; -- insert succeeded
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;

      IF v_constraint = 'registered_cards_public_code_key' THEN
        -- Code collision (astronomically unlikely at 40 bits of entropy) —
        -- regenerate and retry, not a real error.
        CONTINUE;
      ELSIF v_constraint = 'registered_cards_unique_collection_item' THEN
        RAISE EXCEPTION 'This collection item is already linked to another registered card';
      ELSIF v_constraint = 'registered_cards_unique_grading_cert' THEN
        RAISE EXCEPTION 'A card with this grading company and certification number is already registered';
      ELSE
        RAISE; -- unexpected constraint — surface the original error, don't mask it
      END IF;
    END;
  END LOOP;

  INSERT INTO public.registry_events (registered_card_id, event_type, actor_id, to_owner_id, metadata)
  VALUES (v_row.id, 'registered', v_caller_id, v_caller_id, jsonb_build_object('visibility', p_visibility));

  RETURN v_row;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.register_card(uuid, uuid, integer, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.register_card(uuid, uuid, integer, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_card(uuid, uuid, integer, text, text, text)
  TO authenticated, service_role;


-- ============================================================================
-- RPC — link_registered_card_collection_item / unlink_registered_card_collection_item
-- The only way collection_item_id on an existing registered_cards row ever
-- changes. Owner-only (current_owner_id = caller) — changing the linked
-- collection item never changes the registry's own identity (id/public_code
-- untouched), matching the Phase 1 requirement directly.
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

  -- Row lock held for the remainder of the transaction so a concurrent
  -- link/unlink call for the same registered card can't interleave with
  -- this one's read-then-write.
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

NOTIFY pgrst, 'reload schema';
