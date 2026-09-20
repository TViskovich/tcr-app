-- Ownership Transfer Notifications Phase 1 — adds four notification types
-- for the transfer lifecycle (requested/accepted/declined/cancelled),
-- two nullable navigation columns, and a duplicate-prevention partial
-- unique index, then republishes all four transfer RPCs with exactly one
-- new notification INSERT each. No other logic in any of the four RPCs is
-- changed, reordered, or removed — every authorization check, lock,
-- update, exception message, and return type is preserved verbatim from
-- the live function bodies (supabase/migrations/20260729120000_
-- create_ownership_transfers.sql). CREATE OR REPLACE (not DROP + CREATE)
-- is used deliberately so the existing EXECUTE grants for
-- authenticated/postgres/service_role are preserved automatically rather
-- than needing to be restated.
--
-- Each notification insert is intentionally NOT wrapped in its own
-- BEGIN/EXCEPTION block — a failure there rolls back the whole RPC call,
-- keeping the notification atomic with the transfer state change it
-- describes, matching this feature's own approved requirement that a
-- notification must never exist without the state change it announces
-- (or vice versa).

-- 1. Notification type check — full existing list plus the four new
--    transfer types.
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'follow', 'like', 'comment', 'message', 'grail_rating',
    'ownership_transfer_requested', 'ownership_transfer_accepted',
    'ownership_transfer_declined', 'ownership_transfer_cancelled'
  ));

-- 2. Navigation target columns — both nullable, both SET NULL on delete
--    (a notification is a historical record of something that happened;
--    it should survive its target being gone, same reasoning as
--    posts.item_id / rate_my_grail_cards.item_id's existing SET NULL
--    convention in this schema, not the CASCADE convention used for
--    purely-live pointers like profile_grail_slots.item_id).
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS transfer_id uuid REFERENCES public.ownership_transfers(id) ON DELETE SET NULL;
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS registered_card_id uuid REFERENCES public.registered_cards(id) ON DELETE SET NULL;

-- 3. Duplicate-prevention — same partial-unique-index convention already
--    live for notifications_follow_unique / notifications_like_unique,
--    scoped to only the four transfer types via the WHERE clause so it
--    has no effect on any existing notification type.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_ownership_transfer_unique
  ON public.notifications (user_id, type, transfer_id)
  WHERE type IN (
    'ownership_transfer_requested', 'ownership_transfer_accepted',
    'ownership_transfer_declined', 'ownership_transfer_cancelled'
  );

-- 4. Transfer RPCs — each is the live body verbatim plus exactly one new
--    INSERT INTO public.notifications, placed after the transfer's own
--    state change succeeds and before RETURN.

CREATE OR REPLACE FUNCTION public.initiate_ownership_transfer(p_registered_card_id uuid, p_recipient_username text, p_reason text DEFAULT NULL::text)
 RETURNS ownership_transfers
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

  -- Ownership Transfer Notifications Phase 1 — recipient is notified a
  -- transfer is awaiting their response.
  INSERT INTO public.notifications (user_id, actor_id, type, transfer_id, registered_card_id)
  VALUES (v_recipient_id, v_caller_id, 'ownership_transfer_requested', v_transfer.id, p_registered_card_id);

  RETURN v_transfer;
END;
$function$;

CREATE OR REPLACE FUNCTION public.accept_ownership_transfer(p_transfer_id uuid)
 RETURNS registered_cards
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

  -- Ownership Transfer Notifications Phase 1 — sender is notified their
  -- transfer was accepted.
  INSERT INTO public.notifications (user_id, actor_id, type, transfer_id, registered_card_id)
  VALUES (v_transfer.from_owner_id, v_caller_id, 'ownership_transfer_accepted', v_transfer.id, v_card.id);

  RETURN v_card;
END;
$function$;

CREATE OR REPLACE FUNCTION public.decline_ownership_transfer(p_transfer_id uuid)
 RETURNS ownership_transfers
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

  -- Ownership Transfer Notifications Phase 1 — sender is notified their
  -- transfer was declined.
  INSERT INTO public.notifications (user_id, actor_id, type, transfer_id, registered_card_id)
  VALUES (v_transfer.from_owner_id, v_caller_id, 'ownership_transfer_declined', v_transfer.id, v_transfer.registered_card_id);

  RETURN v_transfer;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_ownership_transfer(p_transfer_id uuid)
 RETURNS ownership_transfers
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

  -- Ownership Transfer Notifications Phase 1 — recipient is notified the
  -- pending transfer was cancelled.
  INSERT INTO public.notifications (user_id, actor_id, type, transfer_id, registered_card_id)
  VALUES (v_transfer.to_owner_id, v_caller_id, 'ownership_transfer_cancelled', v_transfer.id, v_transfer.registered_card_id);

  RETURN v_transfer;
END;
$function$;

NOTIFY pgrst, 'reload schema';
