-- Fixes: "Could not find the table 'public.grail_ratings' in the schema
-- cache" thrown from hooks/use-grail-rating.ts's submitRating. Same root
-- cause as the rate_my_grail_cards fix: this table was part of the original
-- 20260711_rate_my_grails.sql script and never actually landed.
--
-- Schema derived from the exact insert (upsert) and select calls in
-- hooks/use-grail-rating.ts, app/(tabs)/index.tsx, and app/post/[id].tsx —
-- see the accompanying report for the column-by-column derivation.

CREATE TABLE IF NOT EXISTS public.grail_ratings (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id        uuid        NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  rater_user_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  score          smallint    NOT NULL CHECK (score BETWEEN 1 AND 10),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Required for the app's .upsert(..., { onConflict: 'post_id,rater_user_id' })
  -- to work at all, and is exactly "one rating per user per post". Also
  -- serves as the lookup index for both read paths (post_id is its leading
  -- column) — no separate index needed for .eq/.in('post_id', ...).
  UNIQUE (post_id, rater_user_id)
);
ALTER TABLE public.grail_ratings ENABLE ROW LEVEL SECURITY;
-- Matches this app's existing convention (posts_select_public, etc. are all
-- USING (true)) — the feed reads ratings in a batch across many posts and
-- many raters, and there's no private-post concept anywhere in this app.
DROP POLICY IF EXISTS "grail_ratings_select_public" ON public.grail_ratings;
CREATE POLICY "grail_ratings_select_public" ON public.grail_ratings
  FOR SELECT USING (true);
-- Can only ever insert as yourself, and never on your own post (the app's
-- isOwner check already prevents calling submitRating in that case — this is
-- the DB-level backstop so the user_id can't be spoofed either way).
DROP POLICY IF EXISTS "grail_ratings_insert_own" ON public.grail_ratings;
CREATE POLICY "grail_ratings_insert_own" ON public.grail_ratings
  FOR INSERT WITH CHECK (
    auth.uid() = rater_user_id
    AND NOT EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.user_id = auth.uid())
  );
-- Upsert falls through to UPDATE on conflict (changing an existing rating) —
-- required for that path to work, and scoped so you can only ever update
-- your own row, never re-target it to someone else's post/user afterward.
DROP POLICY IF EXISTS "grail_ratings_update_own" ON public.grail_ratings;
CREATE POLICY "grail_ratings_update_own" ON public.grail_ratings
  FOR UPDATE USING (auth.uid() = rater_user_id) WITH CHECK (auth.uid() = rater_user_id);
-- No delete path exists in the app today, but "own rating only" if/when one
-- is added.
DROP POLICY IF EXISTS "grail_ratings_delete_own" ON public.grail_ratings;
CREATE POLICY "grail_ratings_delete_own" ON public.grail_ratings
  FOR DELETE USING (auth.uid() = rater_user_id);
NOTIFY pgrst, 'reload schema';
