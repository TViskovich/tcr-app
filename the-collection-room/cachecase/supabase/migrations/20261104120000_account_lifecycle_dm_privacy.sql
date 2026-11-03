-- ============================================================================
-- Account lifecycle — Checkpoint 2: direct messages during the recovery
-- window.
--
-- Product decision: while a collector is pending deletion (or being
-- deleted), every conversation they belong to is unavailable to the other
-- participants — not just hidden in the app. Nothing is deleted or changed:
-- cancelling makes each conversation, its messages and its photo
-- attachments readable again exactly as they were.
--
-- 20261103120000 already blocks new messages to a hidden collector and every
-- read by the hidden collector themselves. This migration adds:
--   * RESTRICTIVE select policies on conversations, conversation_participants
--     and messages: rows of a conversation with a hidden participant are
--     invisible to everyone (so the inbox, unread badge and thread all treat
--     it as gone — the thread screen shows its "isn't available" state);
--   * the same rule for DM photo attachments in Storage (dm-attachments);
--   * get_or_create_conversation refuses a hidden recipient even when the
--     conversation already exists (previously it returned the existing id
--     without writing, so no write guard could catch it).
-- ============================================================================

-- A definer helper: the policies below can't look for the hidden
-- participant through conversation_participants under RLS, because that
-- row is exactly what they hide.
CREATE FUNCTION private.conversation_has_hidden_participant(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_participants p
    JOIN public.account_lifecycle l ON l.user_id = p.user_id
    WHERE p.conversation_id = p_conversation_id
  );
$$;
REVOKE ALL ON FUNCTION private.conversation_has_hidden_participant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.conversation_has_hidden_participant(uuid) TO anon, authenticated, service_role;

CREATE POLICY account_lifecycle_conversation_guard ON public.conversations AS RESTRICTIVE
  FOR SELECT TO public USING (NOT private.conversation_has_hidden_participant(id));
CREATE POLICY account_lifecycle_conversation_guard ON public.conversation_participants AS RESTRICTIVE
  FOR SELECT TO public USING (NOT private.conversation_has_hidden_participant(conversation_id));
CREATE POLICY account_lifecycle_conversation_guard ON public.messages AS RESTRICTIVE
  FOR SELECT TO public USING (NOT private.conversation_has_hidden_participant(conversation_id));

-- dm-attachments objects live at {conversation_id}/{message_id}/image.jpg.
-- Other buckets are unaffected; a malformed first folder fails closed.
CREATE POLICY account_lifecycle_dm_attachment_guard ON storage.objects AS RESTRICTIVE
  FOR SELECT TO public
  USING (
    bucket_id <> 'dm-attachments'
    OR (
      (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND NOT private.conversation_has_hidden_participant(((storage.foldername(name))[1])::uuid)
    )
  );

-- Same body as before plus the two marked checks. Raised errors use the
-- lifecycle tokens the app maps to messages (lib/account-errors.ts).
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

  -- Account lifecycle (20261104120000): neither side may be pending
  -- deletion — including when the conversation already exists.
  IF private.account_is_hidden(caller_id) THEN
    RAISE EXCEPTION 'account_inactive' USING ERRCODE = '42501';
  END IF;
  IF private.account_is_hidden(other_user_id) THEN
    RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '42501';
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
