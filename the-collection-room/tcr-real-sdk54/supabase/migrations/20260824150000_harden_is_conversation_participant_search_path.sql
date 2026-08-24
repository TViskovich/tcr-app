-- Pins is_conversation_participant()'s search_path to the empty string,
-- matching the hardened convention already used by
-- create_or_refresh_follow_notification (20260822120000) and every other
-- SECURITY DEFINER function's SET search_path TO 'public' pin.
--
-- is_conversation_participant(uuid, uuid) is live-only — its CREATE
-- FUNCTION body has never been tracked in any migration in this repo (only
-- its EXECUTE grants are, in 20260725120000_secure_dm_direct_access.sql:
-- REVOKE FROM PUBLIC/anon, GRANT TO authenticated/service_role). Live
-- inspection (read-only, via pg_proc) confirmed: SECURITY DEFINER, already
-- uses fully-qualified public.conversation_participants references, but
-- SET search_path TO 'public' rather than the stricter empty-string pin.
--
-- This migration changes ONLY the search_path configuration via ALTER
-- FUNCTION — it does not (and, since the body is not tracked here, cannot)
-- redefine the function body, and does not touch its signature, name,
-- return type, security property, or grants. Since every reference inside
-- the function is already fully schema-qualified (per the same live
-- inspection), tightening search_path to '' is a pure hardening step with
-- no behavior change — it does not alter any messaging/conversation
-- semantics that this function's callers (the live conversations/messages/
-- conversation_participants RLS policies) depend on.
ALTER FUNCTION public.is_conversation_participant(uuid, uuid) SET search_path = '';

NOTIFY pgrst, 'reload schema';
