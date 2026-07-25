-- ============================================================
-- Rate My Grails — run this in the Supabase SQL Editor
-- (or `supabase db push` if you've linked the CLI to this project).
--
-- Adds two new tables and one additive column. Does not touch any
-- existing table's data, and does not alter posts.post_type (it's an
-- unconstrained text column already — 'rate_my_grails' is just a new
-- value the app starts writing, same as 'item'/'text' today).
-- ============================================================

-- Snapshot of the grails shared in a Rate My Grails post. Denormalized
-- (snapshot_image_url/title/subtitle) on purpose: the grid must keep
-- rendering correctly even if the source collection_item is later edited
-- or deleted. item_id is kept only as an optional "view original card"
-- link — never required for rendering.
CREATE TABLE public.rate_my_grail_cards (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id             uuid        NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  item_id             uuid        REFERENCES public.collection_items(id) ON DELETE SET NULL,
  snapshot_image_url  text        NOT NULL,
  snapshot_title      text,
  snapshot_subtitle   text,
  display_order       smallint    NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.grail_ratings (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id        uuid        NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  rater_user_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  score          smallint    NOT NULL CHECK (score BETWEEN 1 AND 10),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, rater_user_id)
);
-- Ratings are mutable and every change fires a fresh notification, so the
-- score has to be frozen onto the notification row itself rather than
-- looked up live (a later rating change must not silently rewrite the text
-- of an earlier notification).
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS rating_score smallint;
-- ROW LEVEL SECURITY -------------------------------------------

ALTER TABLE public.rate_my_grail_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grail_ratings       ENABLE ROW LEVEL SECURITY;
-- rate_my_grail_cards
CREATE POLICY "rate_my_grail_cards_select_public" ON public.rate_my_grail_cards
  FOR SELECT USING (true);
-- Post owner can only attach items they own, to a post they own.
CREATE POLICY "rate_my_grail_cards_insert_own" ON public.rate_my_grail_cards
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.user_id = auth.uid())
    AND (
      item_id IS NULL
      OR EXISTS (SELECT 1 FROM public.collection_items ci WHERE ci.id = item_id AND ci.user_id = auth.uid())
    )
  );
-- grail_ratings
CREATE POLICY "grail_ratings_select_public" ON public.grail_ratings
  FOR SELECT USING (true);
-- Can only insert as yourself, and never on your own post — DB-level
-- self-rating block (the client also hides the control for the owner).
CREATE POLICY "grail_ratings_insert_own" ON public.grail_ratings
  FOR INSERT WITH CHECK (
    auth.uid() = rater_user_id
    AND NOT EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.user_id = auth.uid())
  );
CREATE POLICY "grail_ratings_update_own" ON public.grail_ratings
  FOR UPDATE USING (auth.uid() = rater_user_id) WITH CHECK (auth.uid() = rater_user_id);
