-- ============================================================================
-- Collector blocking × Registry ownership transfers (Phase 1B.1).
--
-- 20261112120000_add_user_blocks.sql deliberately left ownership_transfers
-- unguarded, but the Registry transfer flow is reachable from a registered
-- card's item details. Without this, a blocked collector could send a
-- transfer request (and its notification) to someone who blocked them.
--
-- Transfers are written only by the SECURITY DEFINER RPCs (clients have no
-- INSERT/UPDATE privilege or policy on ownership_transfers), so guarding the
-- table covers every path:
--   * initiate_ownership_transfer — new request: refused when either side
--     has blocked the other. The error is the RPC's own existing
--     'Recipient not found', so a block is indistinguishable from an unknown
--     username. The request notification is inserted after the transfer in
--     the same transaction, so it is never created.
--   * accept_ownership_transfer — completing a pending transfer between a
--     blocked pair is refused (account_unavailable, as the lifecycle guard
--     does for hidden senders). The whole RPC rolls back: card, custody,
--     item and registry history are untouched and the transfer stays
--     pending (accept after unblocking, or decline/cancel).
--   * decline_ownership_transfer / cancel_ownership_transfer — unchanged, so
--     either collector can always resolve a pending transfer safely.
-- Nothing existing is completed, deleted or reassigned. The functions
-- themselves are not modified; the existing reject_blocked_interaction
-- guard (shared pair lock + fresh block check) is reused.
-- ============================================================================

-- reject_blocked_interaction gains an optional third trigger argument, the
-- SQLSTATE to raise (default 42501, so every existing trigger is unchanged).
-- The transfer guard uses P0001 so its 'Recipient not found' matches the
-- RPC's own unknown-username error exactly (message and code).
-- Same body as 20261112120000 except the v_code lines.
CREATE OR REPLACE FUNCTION private.reject_blocked_interaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_kind   text := split_part(TG_ARGV[0], ':', 1);
  v_column text := split_part(TG_ARGV[0], ':', 2);
  v_error  text := COALESCE(NULLIF(TG_ARGV[1], ''), 'account_unavailable');
  v_code   text := CASE WHEN TG_NARGS >= 3 AND TG_ARGV[2] <> '' THEN TG_ARGV[2] ELSE '42501' END;
  v_new    jsonb := to_jsonb(NEW);
  v_value  uuid;
  v_target uuid;
  v_other  uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_kind = 'conversation' THEN
    FOR v_other IN
      SELECT p.user_id FROM public.conversation_participants p
      WHERE p.conversation_id = (v_new ->> 'conversation_id')::uuid AND p.user_id <> v_actor
    LOOP
      PERFORM pg_advisory_xact_lock_shared(private.user_block_pair_key(v_actor, v_other));
      IF private.users_blocked(v_actor, v_other) THEN
        RAISE EXCEPTION '%', v_error USING ERRCODE = v_code;
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  v_value := (v_new ->> v_column)::uuid;
  IF v_value IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_kind = 'user' THEN
    v_target := v_value;
  ELSIF v_kind = 'post' THEN
    SELECT p.user_id INTO v_target FROM public.posts p WHERE p.id = v_value;
  ELSIF v_kind = 'item' THEN
    SELECT ci.user_id INTO v_target FROM public.collection_items ci WHERE ci.id = v_value;
  ELSIF v_kind = 'folder' THEN
    SELECT f.user_id INTO v_target FROM public.folders f WHERE f.id = v_value;
  ELSE
    RAISE EXCEPTION 'reject_blocked_interaction: unknown kind %', TG_ARGV[0];
  END IF;

  IF v_target IS NULL OR v_target = v_actor THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(private.user_block_pair_key(v_actor, v_target));
  IF private.users_blocked(v_actor, v_target) THEN
    RAISE EXCEPTION '%', v_error USING ERRCODE = v_code;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.reject_blocked_interaction() FROM PUBLIC;

CREATE TRIGGER user_block_guard BEFORE INSERT ON public.ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('user:to_owner_id', 'Recipient not found', 'P0001');

CREATE TRIGGER user_block_guard_accept BEFORE UPDATE OF status ON public.ownership_transfers
  FOR EACH ROW WHEN (NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted')
  EXECUTE FUNCTION private.reject_blocked_interaction('user:from_owner_id');

-- Defense in depth: a transfer-request notification between a blocked pair is
-- dropped even if some future path inserts one. (Accepted/declined/cancelled
-- notifications are responses to an existing transfer and stay deliverable.)
-- Same body as 20261112120000 plus 'ownership_transfer_requested'.
CREATE OR REPLACE FUNCTION private.suppress_blocked_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.type NOT IN ('follow', 'like', 'comment', 'message', 'grail_rating', 'item_tag', 'folder_tag', 'ownership_transfer_requested')
     OR NEW.actor_id IS NULL OR NEW.user_id IS NULL OR NEW.actor_id = NEW.user_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.read AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;
  IF private.users_blocked(NEW.actor_id, NEW.user_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.suppress_blocked_notification() FROM PUBLIC;
