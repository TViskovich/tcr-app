-- Follow-notification refresh RPC.
--
-- Live-verified root cause of the "re-follow sends no new notification" bug:
-- notifications_follow_unique is a partial unique index on
-- (user_id, actor_id) WHERE type = 'follow' — one row per (recipient,
-- follower) pair, not one row per follow event. A prior client-side fix
-- (insert, and on 23505 DELETE the stale row scoped to
-- user_id/actor_id/type, then re-INSERT) failed at runtime: the actor's
-- session can never see the recipient's notification row under
-- notifications_select_own (SELECT USING (user_id = auth.uid())), and
-- PostgREST's client DELETE — being itself governed by RLS row visibility —
-- silently affects zero rows rather than erroring, so the replacement
-- INSERT hits the exact same 23505.
--
-- Fix: do the whole refresh server-side, SECURITY DEFINER, so it isn't
-- constrained by the actor's own SELECT visibility. This does not weaken
-- notifications_select_own, notifications_update_own, or any other policy —
-- the function only ever writes exactly one row shaped
-- (user_id = p_followed_user_id, actor_id = auth.uid(), type = 'follow'),
-- identical in shape to what the actor's own direct INSERT was already
-- authorized to create under notifications_insert_as_actor (actor_id =
-- auth.uid()). It just also handles the ON CONFLICT refresh that a plain
-- client INSERT cannot.
--
-- Follows the same SECURITY DEFINER conventions already established by
-- update_registered_card_custody_status (20260731121000) and the ownership-
-- transfer RPCs (20260729120000/20260802140000): pinned search_path, actor
-- derived from auth.uid() only (never accepted as a parameter), explicit
-- REVOKE from PUBLIC/anon before a narrow GRANT.
--
-- Only user_id/actor_id/type/created_at/read are referenced — these are the
-- only columns any live follow-notification row has ever had set (post_id/
-- transfer_id/registered_card_id/rating_score are other notification types'
-- fields and are never populated for type = 'follow'), confirmed by every
-- follow-notification INSERT in the app (historically only
-- components/profile-v2/profile-v2-screen.tsx). The notifications table
-- itself has no CREATE TABLE in this repo (live-only, as already documented
-- in supabase/schema.sql's own notice) — this migration only ALTERs
-- behavior via a new function, never restates or assumes the full table
-- shape.
--
-- Live-verified column facts (not inferred): follows.created_at is
-- nullable in schema (default now(), 0 of 5 live rows are actually NULL);
-- notifications.created_at is NOT NULL (default now()). The function below
-- treats each according to its own confirmed nullability rather than
-- assuming either.
--
-- AUTHORIZATION: being SECURITY DEFINER, this function runs with the
-- privileges of its owner, not the caller — RLS on public.notifications
-- does not constrain what it can write, so the function itself is the only
-- thing standing between an authenticated caller and creating an arbitrary
-- "X followed you" notification for anyone, regardless of whether a follow
-- relationship actually exists. It therefore independently re-verifies that
-- exact relationship (a matching public.follows row for this caller/
-- recipient pair) before writing anything — this is never trusted from the
-- client, and is checked fresh on every call rather than assumed from the
-- fact that the client only calls this right after its own successful
-- follows insert (a caller invoking the RPC directly, bypassing that client
-- code path entirely, must be stopped here). Row-not-found and a
-- found-but-malformed-NULL-timestamp row are distinguished explicitly
-- (FOUND vs. a second NULL check) rather than conflated into one IS NULL
-- test, so a genuine authorization failure and an unexpected data anomaly
-- raise distinct, diagnosable messages. On failure this RAISES rather than
-- silently no-ops, matching every other authorization check in this repo's
-- SECURITY DEFINER RPCs (e.g. update_registered_card_custody_status's
-- 'Only the current owner may...', accept_ownership_transfer's 'Only the
-- designated recipient may...') — the null/self-recipient guards below
-- remain silent no-ops since those are unreachable-from-the-UI defensive
-- conditions, not a boundary an authenticated caller could otherwise cross.
--
-- SECOND AUTHORIZATION LAYER — refresh-once-per-follow-event: proving a
-- follow relationship currently exists is not, on its own, enough. Without
-- a further check, a caller could invoke this RPC repeatedly for the same
-- still-active follow and keep resetting the recipient's notification back
-- to unread/current with no new follow event behind each reset. The fix
-- ties the conflict-update to the CURRENT follows row's created_at: the
-- update is only permitted when the existing notification predates that
-- follow row's created_at (notifications.created_at is confirmed NOT NULL
-- live, so no NULL-handling is needed on that side of the comparison). The
-- first insert for a brand-new relationship always satisfies this (nothing
-- to compare against yet — ON CONFLICT only ever fires when a row already
-- exists). A genuine re-follow satisfies it exactly once, because
-- unfollowing and re-following always produces a strictly newer
-- follows.created_at than whatever the stale notification's created_at
-- was. Any further RPC call during that same still-active relationship
-- compares the already-current notification.created_at against the same,
-- unchanged follows.created_at and the WHERE clause evaluates false — the
-- ON CONFLICT UPDATE matches zero rows, a successful no-op call.

CREATE OR REPLACE FUNCTION public.create_or_refresh_follow_notification(p_followed_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_follow_created_at timestamptz;
BEGIN
  -- Silent no-op, not an exception: these three conditions should be
  -- unreachable from the live UI (toggleFollow already requires an
  -- authenticated session and guards isOwnProfile before this is ever
  -- called) — this is defense in depth against a caller invoking the RPC
  -- directly with a malformed argument, not an authorization boundary.
  IF v_actor_id IS NULL OR p_followed_user_id IS NULL OR v_actor_id = p_followed_user_id THEN
    RETURN;
  END IF;

  -- Authorization boundary #1: this function is SECURITY DEFINER, so RLS
  -- does not gate what it can write — without this check, any
  -- authenticated caller could invoke this RPC for an arbitrary recipient
  -- they don't actually follow. Re-verified fresh on every call, never
  -- trusted from the client or inferred from call order. The follow row's
  -- own created_at is captured here for boundary #2 below, not queried
  -- twice.
  SELECT f.created_at INTO v_follow_created_at
  FROM public.follows f
  WHERE f.follower_id = v_actor_id
    AND f.following_id = p_followed_user_id;

  -- FOUND distinguishes "no matching follows row" (the actual authorization
  -- failure) from "a matching row exists but its created_at is NULL" (an
  -- unexpected data anomaly, given follows.created_at is nullable in
  -- schema even though no live row is currently NULL) — conflating the two
  -- into a single IS NULL check would misreport a malformed row as a
  -- missing follow relationship.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only an active follower may create a follow notification for this user';
  END IF;

  IF v_follow_created_at IS NULL THEN
    RAISE EXCEPTION 'Active follow relationship is missing created_at';
  END IF;

  -- Authorization boundary #2 (refresh-once-per-follow-event): only refresh
  -- an existing notification if it predates the CURRENT follow
  -- relationship's own created_at — see the module comment above. A
  -- first-time insert for this (user_id, actor_id) pair always proceeds
  -- (ON CONFLICT only evaluates once a conflicting row already exists);
  -- repeated calls during the same still-active follow relationship match
  -- zero rows and change nothing.
  INSERT INTO public.notifications AS n (user_id, actor_id, type, read, created_at)
  VALUES (p_followed_user_id, v_actor_id, 'follow', false, now())
  ON CONFLICT (user_id, actor_id) WHERE type = 'follow'
  DO UPDATE SET created_at = now(), read = false
  WHERE n.created_at < v_follow_created_at;
END;
$function$;

-- Least-privilege: never called by an Edge Function or any service-role
-- context, only ever invoked directly by an authenticated client session
-- immediately after its own successful follow insert.
REVOKE EXECUTE ON FUNCTION public.create_or_refresh_follow_notification(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_or_refresh_follow_notification(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_or_refresh_follow_notification(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
