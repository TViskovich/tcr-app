-- ============================================================================
-- Fix the confirmed concurrency race in get_or_create_conversation() —
-- Pass 3B of the DM-backend audit/hardening pass (Pass 2 found the bug,
-- Pass 3A separately closed the direct-table-access gaps in a prior,
-- already-applied-to-repo migration: 20260725_secure_dm_direct_access.sql).
-- This migration is additive to that one, not a modification of it.
--
-- Confirmed race (Pass 2/3B analysis): the function's existing-conversation
-- SELECT and its create-if-absent INSERTs are a classic check-then-act
-- sequence with nothing to serialize two concurrent calls for the same
-- user pair — both can see "no conversation exists" under READ COMMITTED
-- and both create one, producing two permanent duplicate conversations
-- for the same pair.
--
-- Pre-migration baseline (Supabase Dashboard SQL Editor, aggregate-only
-- audit, no user/conversation IDs returned):
--   pairs_with_duplicate_conversations:            0
--   total_duplicate_conversations_beyond_first:    0
--   conversations_with_exactly_two_participants:   3
--   conversations_with_fewer_than_two_participants: 0
--   conversations_with_more_than_two_participants:  0
-- No existing duplicates or malformed conversation shapes — this fix
-- requires no accompanying data cleanup.
--
-- Fix: acquire a transaction-scoped advisory lock (pg_advisory_xact_lock)
-- keyed on the canonicalized (order-independent) user pair before doing
-- the existing-conversation lookup, and only perform that lookup after
-- the lock is held. A concurrent call for the same pair either blocks on
-- the same key (if it arrived first and is still running) or finds the
-- winner's already-committed row (if it arrived first and already
-- finished) — either way, at most one conversation is ever created per
-- pair. Unrelated pairs normally use different keys and proceed
-- independently. A rare hash collision can temporarily serialize two
-- unrelated creation calls, but cannot return the wrong conversation or
-- corrupt data. The lock is released automatically on COMMIT or
-- ROLLBACK; no unlock call exists or is needed.
--
-- Out of scope for this migration (unchanged, tracked separately): the
-- lack of a cap on participant count, missing indexes, message
-- pagination, Realtime, the deleted-user .single() UI break, message
-- body length/nullability constraints, and the notifications.type-vs-
-- nullable-FK integrity gap.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_or_create_conversation(other_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  conv_id uuid;
  caller_id uuid;
  lock_key bigint;
BEGIN
  caller_id := auth.uid();

  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF other_user_id IS NULL THEN
    RAISE EXCEPTION 'Recipient is required';
  END IF;

  IF caller_id = other_user_id THEN
    RAISE EXCEPTION 'Cannot create a conversation with yourself';
  END IF;

  -- Deterministic, order-independent lock key for this pair: canonicalize
  -- via (LEAST, GREATEST) so A→B and B→A calls always compute the
  -- identical key, then reduce the pair's 256 bits into one 64-bit
  -- advisory-lock key via hashtextextended — a built-in deterministic
  -- hash that produces the same output for the same input across
  -- concurrent calls on this database. Unrelated pairs can theoretically
  -- map to the same 64-bit key (256 bits of input onto a 64-bit key
  -- space). That only matters if two such unrelated pairs happen to
  -- attempt conversation creation at the same time — the consequence is
  -- one pair briefly, unnecessarily waiting on the other's lock, nothing
  -- more. It can never return the wrong conversation or corrupt data:
  -- the lookup below runs after the lock is acquired and is still keyed
  -- on the real caller_id/other_user_id values, not on the lock key
  -- itself, so a collision can only cost time, never correctness.
  lock_key := hashtextextended(
    LEAST(caller_id, other_user_id)::text || ':' || GREATEST(caller_id, other_user_id)::text,
    0
  );

  -- Transaction-scoped: released automatically on COMMIT or ROLLBACK, no
  -- matching unlock call exists or is needed. Only this exact pair's key
  -- is locked, so unrelated pairs' creation calls are normally unaffected
  -- by this — this is not a global serializing lock.
  PERFORM pg_advisory_xact_lock(lock_key);

  -- The authoritative lookup — performed only now, after the lock is
  -- held, never before. Any concurrent call for this same pair that
  -- arrived first is either still running (this call is blocked above,
  -- waiting on the lock) or has already committed (this lookup now sees
  -- its result) — either way, this SELECT can be trusted from this line on.
  SELECT cp1.conversation_id INTO conv_id
  FROM public.conversation_participants cp1
  JOIN public.conversation_participants cp2
    ON cp1.conversation_id = cp2.conversation_id
  WHERE cp1.user_id = caller_id
    AND cp2.user_id = other_user_id
  LIMIT 1;

  IF conv_id IS NOT NULL THEN
    RETURN conv_id;
  END IF;

  INSERT INTO public.conversations DEFAULT VALUES RETURNING id INTO conv_id;

  INSERT INTO public.conversation_participants (conversation_id, user_id)
  VALUES (conv_id, caller_id), (conv_id, other_user_id);

  RETURN conv_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';
