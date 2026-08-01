-- ============================================================================
-- CacheCase Registry — Registry Status v1: update_registered_card_custody_status.
--
-- Reuses the exact authorization/locking/transaction pattern already used
-- by accept_ownership_transfer: SECURITY DEFINER, pinned search_path,
-- auth.uid() null-check, row locked via SELECT ... FOR UPDATE before any
-- decision is made, ownership verified via IS DISTINCT FROM, and the
-- state-changing UPDATE + the registry_events INSERT both happen inside
-- this single function body — atomic by construction (a RAISE EXCEPTION
-- anywhere rolls back the entire call, including a partially-applied
-- UPDATE). No ownership-transfer RPC is modified by this migration, and
-- no transfer RPC is made to touch custody_status automatically — that
-- integration is explicitly deferred.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_registered_card_custody_status(
  p_registered_card_id uuid,
  p_new_custody_status public.registry_custody_status
)
 RETURNS public.registered_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id uuid := auth.uid();
  v_card      public.registered_cards;
  v_old       public.registry_custody_status;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_card FROM public.registered_cards WHERE id = p_registered_card_id FOR UPDATE;
  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Registered card not found';
  END IF;

  -- Same ownership check as accept_ownership_transfer's post-lock
  -- revalidation — only the current owner may change custody status.
  IF v_card.current_owner_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Only the current owner may change custody status';
  END IF;

  v_old := v_card.custody_status;

  IF v_old = p_new_custody_status THEN
    RAISE EXCEPTION 'Card already has this custody status';
  END IF;

  UPDATE public.registered_cards
  SET custody_status = p_new_custody_status,
      updated_at = now()
  WHERE id = v_card.id
  RETURNING * INTO v_card;

  INSERT INTO public.registry_events (
    registered_card_id, event_type, actor_id, old_custody_status, new_custody_status
  ) VALUES (
    v_card.id, 'status_changed', v_caller_id, v_old, p_new_custody_status
  );

  RETURN v_card;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.update_registered_card_custody_status(uuid, public.registry_custody_status) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_registered_card_custody_status(uuid, public.registry_custody_status) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_registered_card_custody_status(uuid, public.registry_custody_status)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
