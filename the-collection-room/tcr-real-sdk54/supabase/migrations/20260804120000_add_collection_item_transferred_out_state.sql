-- Sender Transferred-Out Item Lifecycle — after an ownership transfer is
-- accepted, the sender's exact formerly-linked collection_items row must
-- stop behaving as an active owned card: it disappears from active
-- collection browsing, can never be registered or linked again, but is
-- preserved (not auto-deleted) as a historical record the sender can still
-- view or manually remove.
--
-- collection_status is a plain constrained-text state column, matching
-- this schema's own established convention for exactly this shape
-- (registered_cards.status, registered_cards.custody_status,
-- ownership_transfers.status are all the same pattern) — not a bare
-- timestamp-presence flag. Only two values in this pass, per the approved
-- scope: 'active' (default, every existing and newly created item) and
-- 'transferred_out' (set exactly once, atomically, by
-- accept_ownership_transfer below).
--
-- No historical backfill in this pass: existing collection_items rows
-- belonging to already-completed (pre-migration) transfers are NOT
-- automatically reconstructed to 'transferred_out' — they remain 'active'
-- (the column default) until a separate, explicitly reviewed backfill
-- migration is written. This is a known, deliberate limitation of this
-- pass, not an oversight — reconstructing "which item was linked to which
-- card at the time of each past acceptance" from registry_events history
-- is a distinct, non-trivial task left out of scope here.

ALTER TABLE public.collection_items
  ADD COLUMN IF NOT EXISTS collection_status text NOT NULL DEFAULT 'active'
    CHECK (collection_status IN ('active', 'transferred_out'));

ALTER TABLE public.collection_items
  ADD COLUMN IF NOT EXISTS transferred_out_at timestamptz;

ALTER TABLE public.collection_items
  ADD COLUMN IF NOT EXISTS transferred_registered_card_id uuid
    REFERENCES public.registered_cards(id) ON DELETE SET NULL;

-- No existing index supports the new (user_id, collection_status)
-- predicate this feature adds to most of collection_items' own active-
-- browsing queries — confirmed live: collection_items had only its
-- primary key index before this migration, no index on user_id or
-- folder_id at all (a pre-existing gap, unrelated to this feature and
-- left alone here).
CREATE INDEX IF NOT EXISTS collection_items_user_id_collection_status_idx
  ON public.collection_items (user_id, collection_status);

-- ============================================================================
-- Client-reactivation protection — column-level privilege, not a trigger.
--
-- items_update_own's RLS policy (USING auth.uid() = user_id) is row-level
-- only: it does not know or care WHICH columns an authenticated client's
-- own UPDATE touches. Without this, any client (a modified app build, a
-- direct API call) could set collection_status back to 'active' —
-- silently defeating register_card/link_registered_card_collection_item's
-- new state checks below, since those checks only look at whatever the
-- column currently says.
--
-- Every existing collection_items UPDATE call site in this app (item
-- edit in app/item/[id].tsx, the image_url-only updates in
-- lib/registry-claim.ts and lib/item-images.ts) sets only
-- title/player/team/year/brand/grade/grading_company/serial_number/
-- estimated_value/description/image_url — never any of the three new
-- columns — so narrowing just these three columns cannot break any
-- existing edit path.
--
-- `authenticated` currently holds a blanket, all-columns table-level
-- UPDATE grant (confirmed live). REVOKE UPDATE on a specific column list
-- narrows only that subset for that role — every other column stays
-- fully updatable. The trusted RPC path needs no new signal to be
-- recognized as trusted: accept_ownership_transfer/register_card/
-- link_registered_card_collection_item are SECURITY DEFINER, so their own
-- internal UPDATE statements execute with the FUNCTION OWNER's privileges
-- (this migration's executing role, i.e. `postgres`) — a structurally
-- different role from `authenticated`, never touched by this REVOKE.
-- postgres's own separate blanket grant (confirmed live, unaffected)
-- means the accept-transfer UPDATE below keeps working, while an ordinary
-- client request — which PostgREST always executes as literally the
-- `authenticated` role — cannot touch these columns under any
-- circumstances, in either direction (active→transferred_out or
-- transferred_out→active alike; REVOKE has no directionality). No trigger
-- and no client-supplied trust flag are needed: the distinction is which
-- database role executes the statement, not any runtime signal.
--
-- service_role's own separate blanket grant is also untouched, so
-- service-role/admin maintenance remains possible where appropriate.
REVOKE UPDATE (collection_status, transferred_out_at, transferred_registered_card_id)
  ON public.collection_items FROM authenticated;

-- ============================================================================
-- accept_ownership_transfer — live body reproduced verbatim, with exactly
-- one new block inserted: capturing the sender's old collection_item_id
-- and marking that exact row transferred_out, placed after the row is
-- already locked (v_card FOR UPDATE, done above) and BEFORE
-- registered_cards.collection_item_id is cleared, so the old item id is
-- still known at the point it's needed. Every existing authorization
-- check, lock, exception message, update, registry-event insert, and
-- notification insert is unchanged and unreordered relative to each
-- other — the only change is this one new UPDATE (plus its own
-- exact-one-row assertion) inserted between the existing ownership check
-- and the existing registered_cards UPDATE.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.accept_ownership_transfer(p_transfer_id uuid)
 RETURNS registered_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id      uuid := auth.uid();
  v_transfer       public.ownership_transfers;
  v_card           public.registered_cards;
  v_old_item_id    uuid;
  v_marked_item_id uuid;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_transfer FROM public.ownership_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_transfer.id IS NULL THEN
    RAISE EXCEPTION 'Transfer not found';
  END IF;
  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'This transfer is no longer pending';
  END IF;
  IF v_transfer.to_owner_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Only the designated recipient may accept this transfer';
  END IF;

  SELECT * INTO v_card FROM public.registered_cards WHERE id = v_transfer.registered_card_id FOR UPDATE;
  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Registered card not found';
  END IF;
  IF v_card.current_owner_id IS DISTINCT FROM v_transfer.from_owner_id THEN
    RAISE EXCEPTION 'The sender no longer owns this card; transfer cannot be completed';
  END IF;

  -- Sender Transferred-Out Item Lifecycle — capture the old link while
  -- it's still known (v_card was just locked above), and mark that exact
  -- row before it's cleared from registered_cards below. A card can be
  -- accepted while never having been claimed/linked by its sender in the
  -- first place (collection_item_id already NULL) — v_old_item_id is then
  -- NULL and this whole block is a no-op, matching that already-existing,
  -- already-handled case. When it IS non-null, the UPDATE must affect
  -- exactly one row (id is the primary key, so "more than one" is
  -- structurally impossible) — RETURNING id INTO v_marked_item_id makes a
  -- zero-row match (e.g. user_id somehow not matching v_transfer.from_owner_id)
  -- detectable and fatal, rather than a silent no-op that would leave the
  -- sender's item incorrectly still 'active' after a completed transfer.
  v_old_item_id := v_card.collection_item_id;
  IF v_old_item_id IS NOT NULL THEN
    UPDATE public.collection_items
    SET collection_status = 'transferred_out',
        transferred_out_at = now(),
        transferred_registered_card_id = v_card.id
    WHERE id = v_old_item_id AND user_id = v_transfer.from_owner_id
    RETURNING id INTO v_marked_item_id;

    IF v_marked_item_id IS NULL THEN
      RAISE EXCEPTION 'Linked collection item could not be marked as transferred out';
    END IF;
  END IF;

  -- Decision 1 (option a): id/cc_id are never touched — the permanent
  -- registry identity and its QR/public URL survive unchanged.
  -- collection_item_id is cleared because it points at the former owner's
  -- own personal collection item; the recipient may later link the same
  -- registry record to one of their own items.
  UPDATE public.registered_cards
  SET current_owner_id = v_transfer.to_owner_id,
      collection_item_id = NULL,
      updated_at = now()
  WHERE id = v_card.id
  RETURNING * INTO v_card;

  UPDATE public.ownership_transfers
  SET status = 'accepted', resolved_at = now()
  WHERE id = v_transfer.id;

  -- Decision 2: no item_unlinked event for the collection_item_id cleanup
  -- above — only the meaningful ownership_transferred event is recorded.
  INSERT INTO public.registry_events (registered_card_id, event_type, actor_id, from_owner_id, to_owner_id, metadata)
  VALUES (
    v_card.id, 'ownership_transferred', v_caller_id, v_transfer.from_owner_id, v_transfer.to_owner_id,
    CASE WHEN v_transfer.reason IS NOT NULL THEN jsonb_build_object('reason', v_transfer.reason) ELSE '{}'::jsonb END
  );

  -- Ownership Transfer Notifications Phase 1 — sender is notified their
  -- transfer was accepted.
  INSERT INTO public.notifications (user_id, actor_id, type, transfer_id, registered_card_id)
  VALUES (v_transfer.from_owner_id, v_caller_id, 'ownership_transfer_accepted', v_transfer.id, v_card.id);

  RETURN v_card;
END;
$function$;

-- ============================================================================
-- register_card and link_registered_card_collection_item — live bodies
-- reproduced verbatim, each with exactly one new check inserted
-- immediately after the existing "item belongs to caller" check: once an
-- item's collection_status is 'transferred_out', it can never again mint
-- a new registered_cards row or be linked to one, regardless of what any
-- client UI does or doesn't show, and regardless of any direct client
-- update attempt (blocked separately by the column-privilege REVOKE
-- above). A different, newly created item with identical descriptive
-- fields is unaffected — this check is purely a state check on the
-- specific row being registered/linked, never a similarity search over
-- any other row.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.register_card(p_card_type_id uuid DEFAULT NULL::uuid, p_collection_item_id uuid DEFAULT NULL::uuid, p_serial_number text DEFAULT NULL::text, p_grade_company text DEFAULT NULL::text, p_grade text DEFAULT NULL::text, p_cert_number text DEFAULT NULL::text, p_visibility text DEFAULT 'public'::text)
 RETURNS registered_cards
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

    IF v_item.collection_status <> 'active' THEN
      RAISE EXCEPTION 'This collection item can no longer be registered or linked';
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

CREATE OR REPLACE FUNCTION public.link_registered_card_collection_item(p_registered_card_id uuid, p_collection_item_id uuid)
 RETURNS registered_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id        uuid := auth.uid();
  v_row              public.registered_cards;
  v_previous_item_id uuid;
  v_item             public.collection_items;
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

  SELECT * INTO v_item FROM public.collection_items ci
  WHERE ci.id = p_collection_item_id AND ci.user_id = v_caller_id;

  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'Collection item not found or not owned by caller';
  END IF;

  IF v_item.collection_status <> 'active' THEN
    RAISE EXCEPTION 'This collection item can no longer be registered or linked';
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

NOTIFY pgrst, 'reload schema';
