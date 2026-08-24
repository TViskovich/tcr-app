-- Verified server-side notification creation for like/comment/grail_rating.
--
-- Confirmed live: notifications_insert_as_actor is WITH CHECK (actor_id =
-- auth.uid()) with no constraint on user_id, type, post_id, or anything else
-- — combined with the app's own client-side inserts for these three
-- notification types (app/(tabs)/index.tsx, app/post/[id].tsx,
-- components/profile-v2/profile-v2-screen.tsx for 'like';
-- app/post/[id].tsx for 'comment'; hooks/use-grail-rating.ts for
-- 'grail_rating'), any authenticated caller could insert an arbitrary
-- notification into any other user's feed today, with no real like/comment/
-- rating behind it at all. 'follow' (create_or_refresh_follow_notification,
-- 20260822120000), 'message' (create_message_notification trigger,
-- 20260818130000), and every 'ownership_transfer_*' type (written inside
-- their own SECURITY DEFINER RPCs, 20260802140000) are already safe —
-- this migration brings the remaining three client-generated types to the
-- same standard.
--
-- Each function below follows the exact template already established by
-- create_or_refresh_follow_notification: actor derived exclusively from
-- auth.uid() (never a parameter), a real underlying event independently
-- re-verified via EXISTS/matching row before any write, the recipient
-- resolved server-side from public.posts.user_id (never accepted as a
-- parameter), self-notifications silently skipped, SET search_path = ''
-- with every reference fully schema-qualified, and explicit REVOKE FROM
-- PUBLIC/anon + GRANT TO authenticated only.
--
-- This migration does NOT touch notifications_insert_as_actor,
-- notifications_select_own, notifications_update_own, or
-- notifications_delete_by_actor — the client is rewired to call these RPCs
-- in the same change, and the direct-insert policy is only dropped in a
-- later migration once every call site is confirmed rewired (see
-- 20260824140000_drop_notifications_insert_as_actor.sql).

-- --- 1. like ---
-- Current client behavior (app/(tabs)/index.tsx, app/post/[id].tsx,
-- components/profile-v2/profile-v2-screen.tsx) is a plain INSERT that
-- silently ignores a 23505 (comment: "unique index makes this idempotent"),
-- never an ON CONFLICT DO UPDATE refresh — there is no tracked definition of
-- notifications_like_unique's exact columns to target with ON CONFLICT, so
-- rather than guess at a conflict target this reproduces the exact same
-- externally-observed behavior (attempt an insert; a unique-constraint
-- collision on ANY column set is treated as already-satisfied, never
-- surfaced as an error) via an exception handler instead of ON CONFLICT.
-- This is deliberately NOT a "refresh" in the create_or_refresh_follow_
-- notification sense (no created_at/read reset) — that behavior was never
-- present for likes and this migration does not add it, per "preserve
-- current UX as closely as possible."
CREATE OR REPLACE FUNCTION public.create_or_refresh_like_notification(p_post_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_recipient_id uuid;
BEGIN
  -- Silent no-op: unreachable from the live UI (the client only ever calls
  -- this right after its own successful likes insert), defense in depth
  -- against a malformed direct call, not an authorization boundary.
  IF v_actor_id IS NULL OR p_post_id IS NULL THEN
    RETURN;
  END IF;

  -- Authorization boundary: being SECURITY DEFINER, RLS does not gate what
  -- this function can write — without this check, any authenticated caller
  -- could invoke it for an arbitrary post_id with no real like behind it.
  IF NOT EXISTS (
    SELECT 1 FROM public.likes
    WHERE user_id = v_actor_id AND post_id = p_post_id
  ) THEN
    RAISE EXCEPTION 'Only a user who has liked this post may create a like notification for it';
  END IF;

  SELECT p.user_id INTO v_recipient_id FROM public.posts p WHERE p.id = p_post_id;
  -- Post not found (race with a concurrent delete) or liking your own post
  -- (the app's own UI never triggers a like-notification insert in that
  -- case either, see the `post.user_id !== currentUserId` guards at every
  -- call site) — both silent no-ops, never an error.
  IF v_recipient_id IS NULL OR v_recipient_id = v_actor_id THEN
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.notifications (user_id, actor_id, type, post_id)
    VALUES (v_recipient_id, v_actor_id, 'like', p_post_id);
  EXCEPTION WHEN unique_violation THEN
    -- Matches the client's own current "ignore 23505" behavior exactly —
    -- see module comment above.
    NULL;
  END;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_or_refresh_like_notification(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_or_refresh_like_notification(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_or_refresh_like_notification(uuid) TO authenticated;

-- --- 2. comment ---
-- public.comments' live shape (confirmed, not tracked in any migration):
--   id uuid not null, user_id uuid nullable, post_id uuid nullable,
--   body text not null, created_at timestamptz not null.
-- Current client behavior (app/post/[id].tsx) is a plain INSERT with no
-- conflict handling at all — every comment gets its own notification, never
-- deduplicated — so this reproduces that exactly (no exception handling,
-- no ON CONFLICT).
CREATE OR REPLACE FUNCTION public.create_comment_notification(p_post_id uuid, p_comment_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_recipient_id uuid;
BEGIN
  IF v_actor_id IS NULL OR p_post_id IS NULL OR p_comment_id IS NULL THEN
    RETURN;
  END IF;

  -- Authorization boundary: verifies a real comment row exists, was
  -- actually authored by this caller, and references this exact post —
  -- without this, any authenticated caller could invoke this for an
  -- arbitrary post_id/comment_id with no real comment behind it.
  IF NOT EXISTS (
    SELECT 1 FROM public.comments
    WHERE id = p_comment_id AND user_id = v_actor_id AND post_id = p_post_id
  ) THEN
    RAISE EXCEPTION 'Only the comment''s own author may create a notification for it';
  END IF;

  SELECT p.user_id INTO v_recipient_id FROM public.posts p WHERE p.id = p_post_id;
  IF v_recipient_id IS NULL OR v_recipient_id = v_actor_id THEN
    RETURN;
  END IF;

  INSERT INTO public.notifications (user_id, actor_id, type, post_id)
  VALUES (v_recipient_id, v_actor_id, 'comment', p_post_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_comment_notification(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_comment_notification(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_comment_notification(uuid, uuid) TO authenticated;

-- --- 3. grail_rating ---
-- public.grail_ratings' tracked shape (20260712140100_create_grail_ratings.sql):
--   id uuid pk, post_id uuid not null references posts, rater_user_id uuid
--   not null references profiles, score smallint not null check (1-10),
--   created_at/updated_at timestamptz, UNIQUE (post_id, rater_user_id).
-- Current client behavior (hooks/use-grail-rating.ts) inserts a fresh
-- notification on every submit/change with no conflict handling at all
-- (its own comment: "Every submit/change gets its own notification — the
-- score is frozen onto the row since a later rating change must not
-- rewrite it") — reproduced exactly, no exception handling needed since no
-- uniqueness on notifications is expected for this type.
CREATE OR REPLACE FUNCTION public.create_or_refresh_grail_rating_notification(p_post_id uuid, p_score smallint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_recipient_id uuid;
BEGIN
  IF v_actor_id IS NULL OR p_post_id IS NULL THEN
    RETURN;
  END IF;

  -- Authorization boundary: verifies the caller's own current rating row
  -- for this post actually matches the exact score being notified about —
  -- without this, any authenticated caller could invoke this for an
  -- arbitrary post_id/score with no real rating behind it.
  IF NOT EXISTS (
    SELECT 1 FROM public.grail_ratings
    WHERE post_id = p_post_id AND rater_user_id = v_actor_id AND score = p_score
  ) THEN
    RAISE EXCEPTION 'Only the rating''s own author may create a notification for it, matching the exact recorded score';
  END IF;

  SELECT p.user_id INTO v_recipient_id FROM public.posts p WHERE p.id = p_post_id;
  IF v_recipient_id IS NULL OR v_recipient_id = v_actor_id THEN
    RETURN;
  END IF;

  INSERT INTO public.notifications (user_id, actor_id, type, post_id, rating_score)
  VALUES (v_recipient_id, v_actor_id, 'grail_rating', p_post_id, p_score);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_or_refresh_grail_rating_notification(uuid, smallint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_or_refresh_grail_rating_notification(uuid, smallint) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_or_refresh_grail_rating_notification(uuid, smallint) TO authenticated;

NOTIFY pgrst, 'reload schema';
