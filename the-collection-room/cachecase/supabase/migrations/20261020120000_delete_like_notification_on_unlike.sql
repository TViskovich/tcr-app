BEGIN;

-- ============================================================================
-- Remove a like's notification when the like is deleted.
--
-- Problem (confirmed on staging, load-test run mx-20261013-2): every unlike
-- path in the app (app/(tabs)/index.tsx, app/post/[id].tsx,
-- components/profile-v2/profile-v2-screen.tsx) deletes the like, then tries
--   DELETE FROM notifications WHERE actor_id = me AND post_id = … AND type = 'like'
-- from the client. RLS lets the ACTOR delete (notifications_delete_by_actor)
-- but only the RECIPIENT can see the row (notifications_select_own), and a
-- DELETE whose WHERE clause reads columns is also subject to the SELECT
-- policy — so the client's delete matches 0 rows, returns success, and the
-- like notification outlives its like. A later re-like then silently reuses
-- the stale row (notifications_like_unique + the RPC's unique_violation
-- handler).
--
-- Fix: an AFTER DELETE trigger on public.likes that deletes exactly the
-- notification for that like, inside the unlike's own transaction:
--   type = 'like' AND actor_id = OLD.user_id AND post_id = OLD.post_id
-- notifications_like_unique (user_id, actor_id, post_id) WHERE type = 'like'
-- makes that at most one row (the recipient is always the post's author).
-- No other notification type can match. A like with no notification (e.g.
-- a like on one's own post, which never creates one) deletes nothing.
--
-- SECURITY DEFINER so it can delete the recipient's row regardless of the
-- caller's RLS; search_path pinned to '' with fully qualified names. EXECUTE
-- is revoked from every client role: a trigger function is run by the
-- trigger, never called directly (same posture as
-- create_message_notification and profiles_username_guard).
--
-- The app's existing client-side delete becomes a harmless no-op; no app
-- change is required. Historical orphan like notifications are NOT touched
-- here — that cleanup is a separate, explicitly approved step.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_like_notification_on_unlike()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.notifications
  WHERE type = 'like'
    AND actor_id = OLD.user_id
    AND post_id = OLD.post_id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_like_notification_on_unlike() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_like_notification_on_unlike() FROM anon;
REVOKE ALL ON FUNCTION public.delete_like_notification_on_unlike() FROM authenticated;

DROP TRIGGER IF EXISTS likes_delete_like_notification ON public.likes;
CREATE TRIGGER likes_delete_like_notification
  AFTER DELETE ON public.likes
  FOR EACH ROW EXECUTE FUNCTION public.delete_like_notification_on_unlike();

COMMIT;
