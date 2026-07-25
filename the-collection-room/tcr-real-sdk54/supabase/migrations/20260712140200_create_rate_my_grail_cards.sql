-- Fixes: "Could not find the table 'public.rate_my_grail_cards' in the
-- schema cache" — the table was never actually created (either the original
-- 20260711_rate_my_grails.sql never ran, or it partially failed and rolled
-- back as one transaction in the SQL Editor). This recreates it to exactly
-- match what app/rate-my-grails/new.tsx inserts and app/(tabs)/index.tsx /
-- app/post/[id].tsx select — see the column-by-column derivation above.
--
-- Correction from the first attempt: snapshot_image_url must be NULLable —
-- CollectionItem.image_url is `string | null` in the app, and
-- components/feed/grails-post-body.tsx already has a null-safe fallback for
-- a missing image. Making this NOT NULL would just trade one insert failure
-- for another the first time a grail has no photo.

CREATE TABLE IF NOT EXISTS public.rate_my_grail_cards (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id             uuid        NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  item_id             uuid        REFERENCES public.collection_items(id) ON DELETE SET NULL,
  snapshot_image_url  text,
  snapshot_title      text,
  snapshot_subtitle   text,
  display_order       smallint    NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, item_id)
);
-- The UNIQUE (post_id, item_id) constraint above also serves as the lookup
-- index for .eq('post_id', ...) / .in('post_id', [...]) — post_id is its
-- leading column, so no separate index is needed.

ALTER TABLE public.rate_my_grail_cards ENABLE ROW LEVEL SECURITY;
-- Matches this app's existing convention exactly (posts_select_public,
-- likes_select_public, etc. are all USING (true) — privacy, where it exists
-- at all, is enforced in application queries, not at the RLS layer. There is
-- no private-post concept anywhere in this app, so "posts they are permitted
-- to view" is currently every post.)
DROP POLICY IF EXISTS "rate_my_grail_cards_select_public" ON public.rate_my_grail_cards;
CREATE POLICY "rate_my_grail_cards_select_public" ON public.rate_my_grail_cards
  FOR SELECT USING (true);
-- Insert only for a post you own, and only snapshotting an item you own
-- (item_id is only ever non-null at insert time — it's the source grail
-- being snapshotted).
DROP POLICY IF EXISTS "rate_my_grail_cards_insert_own" ON public.rate_my_grail_cards;
CREATE POLICY "rate_my_grail_cards_insert_own" ON public.rate_my_grail_cards
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.user_id = auth.uid())
    AND (
      item_id IS NULL
      OR EXISTS (SELECT 1 FROM public.collection_items ci WHERE ci.id = item_id AND ci.user_id = auth.uid())
    )
  );
-- Supabase/PostgREST caches the schema and won't see a newly-created table
-- until this fires (the SQL Editor usually does this for you, but it's not
-- guaranteed for every execution path — explicit, to directly address the
-- "schema cache" error being fixed here).
NOTIFY pgrst, 'reload schema';
