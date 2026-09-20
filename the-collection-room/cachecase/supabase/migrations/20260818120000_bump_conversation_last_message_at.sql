-- ============================================================================
-- DM last_message_at reliability — server-side maintenance.
--
-- Problem: conversations.last_message_at was previously maintained only by a
-- client-side fire-and-forget UPDATE in app/conversation/[id].tsx, issued
-- after a message INSERT already committed, with no retry and no
-- reconciliation. A message could durably exist while last_message_at stayed
-- stale, which specifically caused a false-negative unread badge in
-- hooks/use-unread-messages.ts (it compares conversations.last_message_at
-- directly against conversation_participants.last_read_at, with no fallback
-- to messages.created_at — unlike app/(tabs)/messages.tsx's inbox query,
-- which already sources ordering from messages.created_at directly and only
-- falls back to last_message_at for a conversation with no message in its
-- recent-200 window, so inbox ordering was never the primary risk here).
--
-- Live inspection (Supabase Dashboard SQL Editor, prior to this migration)
-- confirmed:
--   - conversations_update RLS policy already permits a conversation
--     participant to UPDATE the row (is_conversation_participant(id,
--     auth.uid()), both USING and WITH CHECK) — the previous client write was
--     not silently RLS-rejected.
--   - drifted_conversations = 0 — no existing conversation's last_message_at
--     is currently behind its true latest message, so this migration needs
--     no backfill/repair statement.
--   - last_message_at is `timestamp with time zone NOT NULL DEFAULT now()` —
--     never NULL, so the trigger below needs no COALESCE.
--   - messages.conversation_id has ON DELETE CASCADE — irrelevant to an
--     AFTER INSERT trigger, no delete-time interaction to account for.
--
-- Fix: an AFTER INSERT trigger on public.messages that updates the parent
-- conversation's last_message_at in the SAME transaction as the message
-- insert — conversations/messages predate this repo's migration history
-- (see 20260725120000_secure_dm_direct_access.sql's own header) and this is
-- the second trigger added to that live, undocumented table set (the first
-- being messages_unhide_conversation in
-- 20260725140000_add_conversation_participants_hidden_at.sql, which this
-- migration does not modify — both AFTER INSERT triggers on public.messages
-- coexist independently: this one only ever writes conversations.
-- last_message_at, that one only ever writes
-- conversation_participants.hidden_at, so there is no shared-state conflict
-- between them, and Postgres runs multiple AFTER INSERT triggers on the same
-- table/event in a single pass over the same NEW row without either
-- interfering with the other's UPDATE).
--
-- The prior client-side UPDATE in app/conversation/[id].tsx's
-- finalizeSentMessage() has been removed as part of this same cutover,
-- deliberately, not left as a "harmless" redundant writer: it assigned a
-- plain client-clock timestamp with no GREATEST guard, so it was not
-- guaranteed to be >= this trigger's GREATEST(last_message_at,
-- NEW.created_at) value — a clock-skewed device, or two racing clients,
-- could have overwritten the trigger's correct monotonic value with an
-- older one after the trigger already committed. This trigger is intended
-- to become the sole writer of conversations.last_message_at from this
-- cutover forward; deploy this migration together with that client change,
-- not independently.
--
-- Atomic failure semantics (intentional, not a side effect): the trigger
-- runs in the same transaction as the messages INSERT. If this UPDATE were
-- ever to fail, the entire INSERT rolls back with it — after this migration,
-- a message and its conversation's last_message_at either both commit or
-- neither does. No more silent metadata drift.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bump_conversation_last_message_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- GREATEST guards against a theoretically out-of-order commit (two
  -- concurrent sends whose INSERTs commit in a different order than their
  -- created_at values) ever moving last_message_at backward — the column
  -- always converges on the greatest created_at seen across every message
  -- insert for that conversation, regardless of commit order. Not a defensive
  -- NULL guard: last_message_at is NOT NULL DEFAULT now() (confirmed live),
  -- so GREATEST always compares two real timestamps here.
  UPDATE public.conversations
  SET last_message_at = GREATEST(last_message_at, NEW.created_at)
  WHERE id = NEW.conversation_id;

  RETURN NEW;
END;
$function$;

-- SECURITY DEFINER even though conversations_update RLS already permits a
-- participant to make this exact write directly: this trigger is
-- server-owned metadata-maintenance infrastructure, not a client action, and
-- must keep working unconditionally regardless of whether that RLS policy is
-- later narrowed, replaced, or removed for other reasons. Matches
-- unhide_conversation_on_new_message()'s own reasoning in
-- 20260725140000_add_conversation_participants_hidden_at.sql.
DROP TRIGGER IF EXISTS messages_bump_conversation_last_message_at ON public.messages;
CREATE TRIGGER messages_bump_conversation_last_message_at
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_conversation_last_message_at();

-- Never called directly by client code, only invoked internally by the
-- trigger above (trigger firing is not gated by function-level EXECUTE
-- privileges the way a direct RPC call is) — no GRANT to authenticated is
-- added, least-privilege by default. Mirrors
-- unhide_conversation_on_new_message()'s own REVOKE hygiene exactly.
REVOKE EXECUTE ON FUNCTION public.bump_conversation_last_message_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bump_conversation_last_message_at() FROM anon;
REVOKE EXECUTE ON FUNCTION public.bump_conversation_last_message_at() FROM authenticated;

NOTIFY pgrst, 'reload schema';
