-- ============================================================================
-- Swipe-to-delete for DM conversations (Messages inbox) — a per-participant
-- "hide from my inbox" flag, not a real delete. Neither conversations nor
-- messages are ever deleted by this feature. conversation_participants and
-- messages predate this repo's migration history entirely (see
-- 20260725120000_secure_dm_direct_access.sql's own header comment) — this
-- is an ALTER on that same live, undocumented table set.
--
-- hidden_at is per (conversation_id, user_id): hiding is a property of one
-- participant's own row, not the conversation itself, so the other
-- participant's inbox is completely unaffected. NULL = visible in the inbox
-- (the default — existing rows backfill to NULL for free via ADD COLUMN).
-- Set to the hide timestamp when that participant swipe-deletes the
-- conversation from app/(tabs)/messages.tsx; cleared back to NULL
-- automatically the next time ANY new message lands in that conversation
-- (see the trigger below) — this is what makes a hidden conversation
-- "reappear" per the product spec, without the app having to remember to
-- clear it in every message-send code path itself.
-- ============================================================================

ALTER TABLE public.conversation_participants
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz NULL;

-- --- RLS: allow a participant to update their own row (hidden_at) ---
-- Additive and narrowly scoped to (auth.uid() = user_id) — if a broader
-- "update own participant row" policy already exists live (the app already
-- performs direct conversation_participants.last_read_at updates from
-- app/conversation/[id].tsx today, which would not work at all without
-- one), this is a harmless, overlapping permissive policy: Postgres RLS
-- combines multiple permissive policies for the same command with OR, so
-- this can only ever grant a subset of — never take away from, or conflict
-- with — whatever already exists.
DROP POLICY IF EXISTS "conversation_participants_update_own" ON public.conversation_participants;
CREATE POLICY "conversation_participants_update_own" ON public.conversation_participants
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- --- Auto-reappear: clear hidden_at for every participant when a new
-- message is inserted ---
-- SECURITY DEFINER is required here, not just style: a message's sender is
-- only ever one of the two participants, so a SECURITY INVOKER trigger
-- could never lift the *other* participant's hidden_at under the UPDATE
-- policy above (auth.uid() = user_id would reject it for that row). This
-- mirrors get_or_create_conversation's own reason for being SECURITY
-- DEFINER. Clears both participants' hidden_at unconditionally (not just
-- the recipient's) — "reappear if either of you sends a new message" in
-- the product spec applies symmetrically, including the sender's own
-- previously-hidden copy.
CREATE OR REPLACE FUNCTION public.unhide_conversation_on_new_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.conversation_participants
  SET hidden_at = NULL
  WHERE conversation_id = NEW.conversation_id
    AND hidden_at IS NOT NULL;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS messages_unhide_conversation ON public.messages;
CREATE TRIGGER messages_unhide_conversation
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.unhide_conversation_on_new_message();

-- Never called directly by client code, only invoked internally by the
-- trigger above (trigger firing is not gated by function-level EXECUTE
-- privileges the way a direct RPC call is) — no GRANT to authenticated is
-- added, least-privilege by default.
REVOKE EXECUTE ON FUNCTION public.unhide_conversation_on_new_message() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.unhide_conversation_on_new_message() FROM anon;

NOTIFY pgrst, 'reload schema';
