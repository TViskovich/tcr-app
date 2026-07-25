-- ============================================================================
-- Secure direct-access gaps in the DM backend (Pass 2 audit, items 4-6)
-- See supabase/schema.sql's own "live but undocumented" convention — this
-- table set (conversations/conversation_participants/messages/notifications)
-- and get_or_create_conversation() predate this repo's migration history
-- entirely; this is the first migration to touch them.
--
-- Confirmed live before this change (Supabase Dashboard SQL Editor,
-- read-only catalog inspection):
--   - conversations_insert:  INSERT, {authenticated}, WITH CHECK true
--   - participants_insert:   INSERT, {authenticated}, WITH CHECK (user_id = auth.uid())
--   - get_or_create_conversation(uuid) / is_conversation_participant(uuid,uuid):
--     EXECUTE granted to anon, authenticated, service_role
--
-- Problem: conversations_insert's WITH CHECK is unconditionally true, so any
-- authenticated client can INSERT arbitrary orphaned conversations rows
-- directly. participants_insert only checks user_id = auth.uid(), not
-- whether the caller is authorized to join that specific conversation_id —
-- an authenticated client who learns a conversation_id can self-insert as
-- an unauthorized additional participant. Neither of these checks is
-- needed for legitimate use: conversation/participant creation is only
-- ever meant to happen through get_or_create_conversation(), which is
-- SECURITY DEFINER and therefore bypasses these RLS policies entirely for
-- its own inserts regardless of whether the policies exist. Removing them
-- only closes the direct-client-bypass path; the RPC is unaffected.
--
-- anon (fully unauthenticated) currently has EXECUTE on both functions.
-- Confirmed harmless in practice today only because
-- conversation_participants.user_id is NOT NULL (an anon call's own
-- auth.uid() is NULL, so its participant insert fails and the whole call
-- rolls back) — but the grant itself is unnecessary and removed as
-- least-privilege hygiene, and the function is also hardened with an
-- explicit guard so its safety no longer depends on that NOT NULL
-- constraint as an incidental side effect.
--
-- Out of scope for this migration (tracked separately, not addressed
-- here): the concurrent-call duplicate-conversation race, missing indexes
-- on messages/conversation_participants/notifications, message
-- pagination, the deleted-user .single() UI break, message body length/
-- nullability constraints, and the notifications.type-vs-nullable-FK
-- integrity gap.
-- ============================================================================

-- --- 1. Remove direct-INSERT policies on conversations / conversation_participants ---
-- Dropped entirely rather than replaced with an always-false policy: RLS on
-- a table with no permissive policy for a given command already denies
-- that command outright, which is exactly the desired end state, and
-- avoids leaving a policy on the table that exists only to say "never."
DROP POLICY IF EXISTS "conversations_insert" ON public.conversations;
DROP POLICY IF EXISTS "participants_insert" ON public.conversation_participants;

-- --- 2. Harden get_or_create_conversation() with an explicit auth guard ---
-- Full function body reproduced from the confirmed live definition, with
-- only the new NULL-auth guard added as the very first check (ahead of the
-- existing self-conversation check, so an unauthenticated caller gets a
-- clear "Authentication required" error rather than silently falling
-- through to a doomed insert). Everything else — language, SECURITY
-- DEFINER, search_path, the reuse lookup, the atomic two-insert creation —
-- is unchanged.
CREATE OR REPLACE FUNCTION public.get_or_create_conversation(other_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  conv_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF auth.uid() = other_user_id THEN
    RAISE EXCEPTION 'Cannot create a conversation with yourself';
  END IF;

  SELECT cp1.conversation_id INTO conv_id
  FROM public.conversation_participants cp1
  JOIN public.conversation_participants cp2
    ON cp1.conversation_id = cp2.conversation_id
  WHERE cp1.user_id = auth.uid()
    AND cp2.user_id = other_user_id
  LIMIT 1;

  IF conv_id IS NOT NULL THEN
    RETURN conv_id;
  END IF;

  INSERT INTO public.conversations DEFAULT VALUES RETURNING id INTO conv_id;

  INSERT INTO public.conversation_participants (conversation_id, user_id)
  VALUES (conv_id, auth.uid()), (conv_id, other_user_id);

  RETURN conv_id;
END;
$function$;

-- --- 3. Revoke anonymous/PUBLIC execution, grant only the intended roles ---
-- CREATE OR REPLACE FUNCTION above preserves whatever grants already exist
-- on this function's OID — it does not reset them — so these revokes are
-- still required as their own explicit step regardless of the replace
-- above. The PUBLIC revokes are defensive/no-ops against Section 8b's
-- confirmed live grants (no separate PUBLIC-grantee row was found), kept
-- for consistency with this codebase's own create_card_share_post
-- migration, which follows the same revoke-then-grant convention. The
-- explicit GRANTs restate exactly the access confirmed necessary and
-- already live for authenticated/service_role — not a privilege increase.
REVOKE EXECUTE ON FUNCTION public.get_or_create_conversation(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_or_create_conversation(uuid) FROM anon;

REVOKE EXECUTE ON FUNCTION public.is_conversation_participant(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_conversation_participant(uuid, uuid) FROM anon;

GRANT EXECUTE ON FUNCTION public.get_or_create_conversation(uuid)
  TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.is_conversation_participant(uuid, uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
