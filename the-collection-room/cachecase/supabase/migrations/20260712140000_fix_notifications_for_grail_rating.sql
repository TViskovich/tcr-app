-- Fixes the notification flow triggered after a successful Rate My Grails
-- rating (hooks/use-grail-rating.ts's follow-up insert: type: 'grail_rating',
-- rating_score: score). Both pieces below were part of the original
-- 20260711_rate_my_grails.sql script and, per the pattern already found
-- twice this session (rate_my_grail_cards, grail_ratings), most likely never
-- actually landed as that script apparently rolled back as one transaction.
--
-- Does not change application behavior — schema only.

-- 1. rating_score — near-certain gap. Every 'grail_rating' notification
--    insert sends this; app/(tabs)/notifications.tsx's select and notifLabel
--    both read it back.
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS rating_score smallint;
-- 2. type CHECK constraint — UNCONFIRMED, included defensively. I have no
--    live DB query access to confirm this constraint exists or its exact
--    name. Written the same way the posts_post_type_check fix was: DROP ...
--    IF EXISTS is a no-op if no such constraint exists under this name, and
--    the ADD covers every type value actually used anywhere in the app
--    today ('follow','like','comment','message','grail_rating'), so this is
--    correct whether or not the constraint currently exists. If Postgres
--    reports a *different* constraint name already in place when this runs,
--    that's the signal this needs a second pass with the real name.
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow', 'like', 'comment', 'message', 'grail_rating'));
NOTIFY pgrst, 'reload schema';
