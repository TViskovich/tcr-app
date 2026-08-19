-- ============================================================================
-- DM message-notification reliability — server-side creation.
--
-- Problem: type='message' notifications were previously created only by a
-- client-side fire-and-forget INSERT in app/conversation/[id].tsx's
-- finalizeSentMessage(), issued after the message INSERT already committed,
-- with no retry and no reconciliation. A message could durably exist while
-- its notification row silently never did (console.error only, no user-
-- facing signal) — the message itself and the DM unread badge were always
-- unaffected (both are independent of the notifications table, per the
-- prior last_message_at slice), but the notification-center list and the
-- separate bell badge (hooks/use-unread-count.ts) would silently under-
-- report.
--
-- Live inspection (Supabase Dashboard SQL Editor, prior to this migration)
-- confirmed:
--   - notifications RLS: INSERT allowed for authenticated when
--     actor_id = auth.uid() (no constraint on user_id) — SELECT/UPDATE own,
--     DELETE by actor.
--   - notifications has no message_id column; deliberately not added in
--     this migration (tracked separately, not required for correctness
--     under the current 2-participant conversation model — see below).
--   - message_notifications_total = 60 vs messages_total = 64 (existing,
--     pre-cutover drift from the old unreliable client writer — expected,
--     not a defect this migration needs to repair; no backfill performed).
--   - candidate_duplicate_groups = 0 — no existing duplicate-notification
--     pattern to guard against retroactively.
--   - conversations_with_more_than_two_participants = 0 — every live
--     conversation has exactly one recipient today (get_or_create_
--     conversation() only ever inserts two participant rows; see
--     20260725130000_concurrency_safe_get_or_create_conversation.sql).
--
-- Fix: an AFTER INSERT trigger on public.messages that creates one
-- notification row per conversation participant other than the sender.
-- conversations/messages/notifications predate this repo's migration
-- history (see 20260725120000_secure_dm_direct_access.sql's own header)
-- and this is the third trigger added to that live, undocumented table
-- set — coexists independently with messages_unhide_conversation (writes
-- conversation_participants.hidden_at) and
-- messages_bump_conversation_last_message_at (writes
-- conversations.last_message_at, see 20260818120000). All three are
-- AFTER INSERT triggers on public.messages with disjoint write targets;
-- none depends on another having already run, and Postgres fires all
-- matching triggers for the same event/row without any ordering
-- dependency between them mattering here.
--
-- FAILURE SEMANTICS — deliberately DIFFERENT from the last_message_at
-- trigger's atomic-rollback behavior. That trigger treats its own metadata
-- as inseparable from the message it describes (a message's own
-- last-message timestamp). A notification is a secondary, best-effort
-- signal ABOUT the message, not part of its core identity — message
-- delivery must not depend on notification-row creation succeeding. The
-- notification INSERT below is therefore wrapped in its own nested
-- BEGIN/EXCEPTION block: on any error it emits a RAISE WARNING (server
-- logs only, sender_id/conversation_id/message id — never the message
-- body) and continues, so the outer message INSERT still commits either
-- way. This intentionally diverges from the ownership-transfer migration's
-- (20260802140000) precedent of letting a notification failure roll back
-- its whole transaction — that precedent fits a state-change notification
-- tightly coupled to the RPC it lives inside; a DM send has no comparable
-- reason to fail just because a secondary notification row couldn't be
-- created.
--
-- The client-side notification INSERT in app/conversation/[id].tsx's
-- finalizeSentMessage() is removed as part of this same coordinated
-- cutover (not left as a second writer) — unlike last_message_at's
-- harmless-scalar-overwrite case, a second writer here would produce an
-- actual duplicate, user-visible notification row on every successful
-- send. This trigger is intended to become the sole writer of
-- type='message' notifications from this cutover forward; deploy this
-- migration together with that client change, not independently, and not
-- while the old client build is still live in the running app bundle.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_message_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Isolated in its own block so any failure here (constraint violation,
  -- unexpected RLS-adjacent issue, etc.) cannot propagate out and roll back
  -- the message INSERT itself — see this migration's header for why
  -- notification creation is intentionally best-effort here, unlike
  -- messages_bump_conversation_last_message_at's atomic treatment of
  -- last_message_at. One INSERT ... SELECT fans out to every participant
  -- except the sender — today that's always exactly one recipient
  -- (conversations_with_more_than_two_participants = 0, confirmed live),
  -- but this also correctly generalizes to a future >2-participant
  -- conversation without needing to change this trigger.
  BEGIN
    INSERT INTO public.notifications (user_id, actor_id, type, conversation_id)
    SELECT cp.user_id, NEW.sender_id, 'message', NEW.conversation_id
    FROM public.conversation_participants cp
    WHERE cp.conversation_id = NEW.conversation_id
      AND cp.user_id <> NEW.sender_id;
  EXCEPTION
    WHEN OTHERS THEN
      -- Diagnosable without exposing message content: conversation/message/
      -- sender ids and the underlying SQLERRM, never NEW.body.
      RAISE WARNING 'create_message_notification failed for message_id=%, conversation_id=%, sender_id=%: %',
        NEW.id, NEW.conversation_id, NEW.sender_id, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

-- SECURITY DEFINER even though the live notifications_insert policy
-- (actor_id = auth.uid()) would already be satisfied under SECURITY
-- INVOKER for a normal send (the message INSERT this trigger fires from
-- only ever runs as the sender's own session, so NEW.sender_id = auth.uid()
-- holds at that point): this trigger is server-owned metadata-maintenance
-- infrastructure and must not depend on that RLS policy's exact shape
-- continuing to permit it — e.g. a future policy tightening around
-- user_id would not affect this DEFINER-scoped write. Matches
-- unhide_conversation_on_new_message() and
-- bump_conversation_last_message_at()'s own reasoning.
DROP TRIGGER IF EXISTS messages_create_message_notification ON public.messages;
CREATE TRIGGER messages_create_message_notification
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.create_message_notification();

-- Never called directly by client code, only invoked internally by the
-- trigger above — no GRANT to authenticated is added, least-privilege by
-- default. Mirrors both existing public.messages trigger functions' own
-- REVOKE hygiene exactly.
REVOKE EXECUTE ON FUNCTION public.create_message_notification() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_message_notification() FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_message_notification() FROM authenticated;

NOTIFY pgrst, 'reload schema';
