-- ============================================================================
-- CacheCase Registry — ownership transfer (Phase A: schema + RPCs only).
--
-- Implements the 7 product decisions approved after the ownership-transfer
-- audit:
--   1. Accepting a transfer preserves registered_cards.id/cc_id, moves only
--      current_owner_id, and atomically clears collection_item_id (the
--      former owner's personal collection link — option (a)).
--   2. No item_unlinked event is emitted for that automatic cleanup; the
--      meaningful public event is ownership_transferred.
--   3. State machine: pending -> accepted / declined / cancelled. These four
--      states are tracked privately in ownership_transfers only. Only a
--      completed (accepted) transfer produces a public registry_events row
--      — the sole new RegistryEventType is ownership_transferred. There is
--      no separate ownership_transfer_accepted event, because acceptance
--      and the completed ownership change happen atomically in
--      accept_ownership_transfer. Initiation, decline, and cancellation
--      remain private negotiation states and are never written to
--      registry_events or surfaced on the public provenance timeline.
--   4. Consent model: sender initiates; only the designated recipient may
--      accept/decline; only the sender may cancel; only
--      accept_ownership_transfer ever changes current_owner_id. Every
--      resolving RPC locks and revalidates the pending transfer AND current
--      ownership before acting. At most one pending transfer per card
--      (enforced by a partial unique index, not just an application check).
--   5. reason is one of sale/trade/gift/other, stored only as a categorical
--      value in registry_events.metadata — never price, payment, shipping,
--      or other private/financial data.
--   6. Recipient must already have a CacheCase account — resolved
--      server-side by username, never by a client-supplied user id.
--   7. The existing fake profile-level Transfers UI is untouched by this
--      migration.
--
-- Not applied to the live database by this session — draft for review only.
-- ============================================================================


-- ============================================================================
-- ownership_transfers — one row per transfer attempt (working/mutable
-- state, not permanent provenance — that's registry_events' job). Unlike
-- registered_cards/registry_events, this table is NOT publicly readable:
-- a pending transfer is a private negotiation between two specific users.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.ownership_transfers (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Working state tied to one registered card, not a permanent identity of
  -- its own — cascades with the card, unlike registry_events' own FK which
  -- also cascades (the timeline itself has no meaning without the card
  -- either). Distinct from registered_cards' created_by/current_owner_id,
  -- which use SET NULL because those are permanent provenance columns on a
  -- row meant to keep existing after an account is gone.
  registered_card_id  uuid        NOT NULL REFERENCES public.registered_cards(id) ON DELETE CASCADE,
  from_owner_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_owner_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status              text        NOT NULL DEFAULT 'pending',
  reason              text        NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz NULL,

  CONSTRAINT ownership_transfers_status_check
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  CONSTRAINT ownership_transfers_reason_check
    CHECK (reason IS NULL OR reason IN ('sale', 'trade', 'gift', 'other')),
  CONSTRAINT ownership_transfers_not_self
    CHECK (from_owner_id <> to_owner_id)
);

-- Decision 4: at most one pending transfer per card. Partial (not a plain
-- UNIQUE(registered_card_id)) so a card's full transfer history can
-- accumulate resolved rows over time without conflicting with a later,
-- unrelated pending transfer.
CREATE UNIQUE INDEX IF NOT EXISTS ownership_transfers_one_pending_per_card
  ON public.ownership_transfers (registered_card_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS ownership_transfers_to_owner_id_idx
  ON public.ownership_transfers (to_owner_id);

CREATE INDEX IF NOT EXISTS ownership_transfers_from_owner_id_idx
  ON public.ownership_transfers (from_owner_id);

ALTER TABLE public.ownership_transfers ENABLE ROW LEVEL SECURITY;

-- Participant-only — not public, unlike registered_cards/registry_events.
CREATE POLICY "ownership_transfers_select_participants" ON public.ownership_transfers
  FOR SELECT USING (
    auth.uid() = from_owner_id OR auth.uid() = to_owner_id
  );

-- No INSERT/UPDATE/DELETE policy of any kind. Every write goes through the
-- four SECURITY DEFINER RPCs below, matching registered_cards/
-- registry_events' existing RPC-only write convention.

-- Defense in depth on top of "absence of a policy = denial": this project's
-- public schema grants anon/authenticated full table privileges by default
-- (relied on elsewhere in this schema, e.g. registered_cards/registry_events,
-- purely via RLS). ownership_transfers additionally revokes the write grants
-- outright, so a future RLS misconfiguration alone could not open a direct
-- write path. SELECT is re-granted to authenticated only (never anon) —
-- required for the participant-only RLS policy above to have anything to
-- evaluate.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.ownership_transfers
  FROM anon, authenticated;

GRANT SELECT ON TABLE public.ownership_transfers
  TO authenticated;


-- ============================================================================
-- registry_events — extend the event_type allow-list. Postgres has no
-- ALTER CHECK; the constraint is dropped and recreated with the broader
-- list. Purely additive: every existing row's event_type is still valid
-- under the new constraint, so no data is affected.
-- ============================================================================
ALTER TABLE public.registry_events
  DROP CONSTRAINT IF EXISTS registry_events_event_type_check;

ALTER TABLE public.registry_events
  ADD CONSTRAINT registry_events_event_type_check
    CHECK (event_type IN (
      'registered',
      'item_linked',
      'item_unlinked',
      'status_changed',
      'grading_updated',
      'ownership_transferred'
    ));


-- ============================================================================
-- RPC — initiate_ownership_transfer
-- Only the current owner may call this. Recipient is resolved server-side
-- by username (decision 6: recipient must already have an account) — a
-- client can never target an arbitrary user id directly. Locks the card
-- row so a concurrent initiate/accept/cancel on the same card can't
-- interleave with the ownership check.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.initiate_ownership_transfer(
  p_registered_card_id uuid,
  p_recipient_username text,
  p_reason text DEFAULT NULL
)
 RETURNS public.ownership_transfers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id    uuid := auth.uid();
  v_card         public.registered_cards;
  v_recipient_id uuid;
  v_transfer     public.ownership_transfers;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_reason IS NOT NULL AND p_reason NOT IN ('sale', 'trade', 'gift', 'other') THEN
    RAISE EXCEPTION 'Invalid transfer reason: %', p_reason;
  END IF;

  SELECT * INTO v_card FROM public.registered_cards WHERE id = p_registered_card_id FOR UPDATE;
  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Registered card not found';
  END IF;
  IF v_card.current_owner_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Only the current owner may initiate a transfer';
  END IF;

  SELECT id INTO v_recipient_id FROM public.profiles WHERE username = p_recipient_username;
  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'Recipient not found';
  END IF;

  IF v_recipient_id = v_caller_id THEN
    RAISE EXCEPTION 'Cannot transfer a card to yourself';
  END IF;

  BEGIN
    INSERT INTO public.ownership_transfers (registered_card_id, from_owner_id, to_owner_id, reason)
    VALUES (p_registered_card_id, v_caller_id, v_recipient_id, p_reason)
    RETURNING * INTO v_transfer;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This card already has a pending transfer';
  END;

  RETURN v_transfer;
END;
$function$;


-- ============================================================================
-- RPC — accept_ownership_transfer
-- Only the designated recipient may call this. Locks the transfer row
-- first (rejects a double-accept or an accept racing a decline/cancel),
-- then locks and revalidates the card's current owner still matches the
-- transfer's captured from_owner_id (the concrete "sender's account was
-- deleted mid-transfer" / any other ownership drift guard) before moving
-- ownership. Ownership move, collection_item_id cleanup, transfer
-- resolution, and the single ownership_transferred event all happen in one
-- atomic function call.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.accept_ownership_transfer(
  p_transfer_id uuid
)
 RETURNS public.registered_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id uuid := auth.uid();
  v_transfer  public.ownership_transfers;
  v_card      public.registered_cards;
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

  RETURN v_card;
END;
$function$;


-- ============================================================================
-- RPC — decline_ownership_transfer
-- Only the designated recipient may call this (declining is the
-- recipient's action; the sender's equivalent is cancel, below). Never
-- touches registered_cards.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.decline_ownership_transfer(
  p_transfer_id uuid
)
 RETURNS public.ownership_transfers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id uuid := auth.uid();
  v_transfer  public.ownership_transfers;
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
    RAISE EXCEPTION 'Only the designated recipient may decline this transfer';
  END IF;

  UPDATE public.ownership_transfers
  SET status = 'declined',
      resolved_at = now()
  WHERE id = v_transfer.id
  RETURNING * INTO v_transfer;

  RETURN v_transfer;
END;
$function$;


-- ============================================================================
-- RPC — cancel_ownership_transfer
-- Only the original sender may call this. Never touches registered_cards.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.cancel_ownership_transfer(
  p_transfer_id uuid
)
 RETURNS public.ownership_transfers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id uuid := auth.uid();
  v_transfer  public.ownership_transfers;
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
  IF v_transfer.from_owner_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Only the sender may cancel this transfer';
  END IF;

  UPDATE public.ownership_transfers
  SET status = 'cancelled',
      resolved_at = now()
  WHERE id = v_transfer.id
  RETURNING * INTO v_transfer;

  RETURN v_transfer;
END;
$function$;


REVOKE EXECUTE ON FUNCTION public.initiate_ownership_transfer(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.initiate_ownership_transfer(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.initiate_ownership_transfer(uuid, text, text)
  TO authenticated;

REVOKE EXECUTE ON FUNCTION public.accept_ownership_transfer(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.accept_ownership_transfer(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_ownership_transfer(uuid)
  TO authenticated;

REVOKE EXECUTE ON FUNCTION public.decline_ownership_transfer(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decline_ownership_transfer(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.decline_ownership_transfer(uuid)
  TO authenticated;

REVOKE EXECUTE ON FUNCTION public.cancel_ownership_transfer(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cancel_ownership_transfer(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_ownership_transfer(uuid)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
