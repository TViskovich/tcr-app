-- ============================================================
-- The Collection Room — Supabase Schema
-- Run this in the Supabase SQL Editor (supabase.com → your project → SQL Editor)
-- ============================================================

-- TABLES -------------------------------------------------------

CREATE TABLE public.profiles (
  id               uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username         text        UNIQUE NOT NULL,
  display_name     text,
  bio              text,
  avatar_url       text,
  created_at       timestamptz DEFAULT now()
);

CREATE TABLE public.follows (
  follower_id      uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  following_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at       timestamptz DEFAULT now(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

CREATE TABLE public.folders (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name             text        NOT NULL,
  cover_image_url  text,
  is_public        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz DEFAULT now()
);

CREATE TABLE public.collection_items (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id        uuid          NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  user_id          uuid          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title            text,
  year             smallint,
  brand            text,
  player           text,
  team             text,
  grade            text,
  grading_company  text,
  serial_number    text,
  estimated_value  numeric(10,2),
  image_url        text,
  description      text,
  created_at       timestamptz   DEFAULT now()
);

CREATE TABLE public.posts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_id          uuid        REFERENCES public.collection_items(id) ON DELETE SET NULL,
  image_url        text        NOT NULL,
  caption          text,
  created_at       timestamptz DEFAULT now()
);

CREATE TABLE public.likes (
  user_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  post_id          uuid        NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  created_at       timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

-- TRIGGER: auto-create profile row when a user signs up ---------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, username, display_name)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(trim(NEW.raw_user_meta_data->>'username'), ''),
      split_part(NEW.email, '@', 1)
    ),
    COALESCE(
      NULLIF(trim(NEW.raw_user_meta_data->>'display_name'), ''),
      split_part(NEW.email, '@', 1)
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- ROW LEVEL SECURITY -------------------------------------------

ALTER TABLE public.profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.likes             ENABLE ROW LEVEL SECURITY;

-- profiles
CREATE POLICY "profiles_select_public"  ON public.profiles FOR SELECT USING (true);
CREATE POLICY "profiles_insert_own"     ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own"     ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- follows
CREATE POLICY "follows_select_public"   ON public.follows  FOR SELECT USING (true);
CREATE POLICY "follows_insert_own"      ON public.follows  FOR INSERT WITH CHECK (auth.uid() = follower_id);
CREATE POLICY "follows_delete_own"      ON public.follows  FOR DELETE USING (auth.uid() = follower_id);

-- folders
CREATE POLICY "folders_select_public"   ON public.folders  FOR SELECT USING (true);
CREATE POLICY "folders_insert_own"      ON public.folders  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "folders_update_own"      ON public.folders  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "folders_delete_own"      ON public.folders  FOR DELETE USING (auth.uid() = user_id);

-- collection_items
CREATE POLICY "items_select_public"     ON public.collection_items FOR SELECT USING (true);
CREATE POLICY "items_insert_own"        ON public.collection_items FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "items_update_own"        ON public.collection_items FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "items_delete_own"        ON public.collection_items FOR DELETE USING (auth.uid() = user_id);

-- posts
CREATE POLICY "posts_select_public"     ON public.posts FOR SELECT USING (true);
CREATE POLICY "posts_insert_own"        ON public.posts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "posts_update_own"        ON public.posts FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "posts_delete_own"        ON public.posts FOR DELETE USING (auth.uid() = user_id);

-- likes
CREATE POLICY "likes_select_public"     ON public.likes FOR SELECT USING (true);
CREATE POLICY "likes_insert_own"        ON public.likes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "likes_delete_own"        ON public.likes FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- Rate My Grails (added 2026-07-11 — see supabase/migrations/20260711_rate_my_grails.sql)
-- NOTE: this file predates several other live tables (comments, notifications,
-- conversations/messages, saved_*, profile_showcase_items) that are NOT
-- documented above — do not treat this file as the full source of truth.
-- ============================================================

-- NOTE: this table did not actually get created when this file was first
-- written (posting failed with "Could not find the table
-- 'public.rate_my_grail_cards' in the schema cache") — recreated in
-- supabase/migrations/20260712_create_rate_my_grail_cards.sql, which also
-- corrects snapshot_image_url below to nullable (CollectionItem.image_url is
-- `string | null` in the app; this file wrongly had it NOT NULL originally).
CREATE TABLE public.rate_my_grail_cards (
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

-- NOTE: like rate_my_grail_cards above, this table did not actually get
-- created when this file was first written (submitRating failed with
-- "Could not find the table 'public.grail_ratings' in the schema cache") —
-- recreated in supabase/migrations/20260712_create_grail_ratings.sql.
CREATE TABLE public.grail_ratings (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id        uuid        NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  rater_user_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  score          smallint    NOT NULL CHECK (score BETWEEN 1 AND 10),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, rater_user_id)
);

-- notifications.rating_score added via ALTER — see migration file (notifications
-- table itself isn't defined in this file; it already exists live). Also
-- likely never landed the first time (same rollback pattern as
-- rate_my_grail_cards/grail_ratings) — recreated in
-- supabase/migrations/20260712140000_fix_notifications_for_grail_rating.sql,
-- which also (defensively, unconfirmed) extends notifications_type_check —
-- if that constraint exists live under a different name, this file is wrong
-- until someone corrects it with the real name.
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS rating_score smallint;
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow', 'like', 'comment', 'message', 'grail_rating'));

-- posts_post_type_check (a live constraint that predates this file and was
-- never documented here) only allowed 'item'/'text' — extended to also allow
-- 'rate_my_grails'. See supabase/migrations/20260711193000_fix_posts_post_type_check.sql.
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_post_type_check;
ALTER TABLE public.posts
  ADD CONSTRAINT posts_post_type_check
  CHECK (post_type IN ('item', 'text', 'rate_my_grails'));

ALTER TABLE public.rate_my_grail_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grail_ratings       ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rate_my_grail_cards_select_public" ON public.rate_my_grail_cards FOR SELECT USING (true);
CREATE POLICY "rate_my_grail_cards_insert_own" ON public.rate_my_grail_cards
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.user_id = auth.uid())
    AND (
      item_id IS NULL
      OR EXISTS (SELECT 1 FROM public.collection_items ci WHERE ci.id = item_id AND ci.user_id = auth.uid())
    )
  );

CREATE POLICY "grail_ratings_select_public" ON public.grail_ratings FOR SELECT USING (true);
CREATE POLICY "grail_ratings_insert_own" ON public.grail_ratings
  FOR INSERT WITH CHECK (
    auth.uid() = rater_user_id
    AND NOT EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.user_id = auth.uid())
  );
CREATE POLICY "grail_ratings_update_own" ON public.grail_ratings
  FOR UPDATE USING (auth.uid() = rater_user_id) WITH CHECK (auth.uid() = rater_user_id);
CREATE POLICY "grail_ratings_delete_own" ON public.grail_ratings
  FOR DELETE USING (auth.uid() = rater_user_id);

-- STORAGE BUCKETS ----------------------------------------------
-- 1. Create these in Supabase Dashboard → Storage → New bucket:
--      Name: avatars       | Public: true
--      Name: item-images   | Public: true
--
-- 2. Then run the policies below in the SQL Editor.
--    "Public" on a bucket only enables unauthenticated reads.
--    Write access is controlled by these RLS policies on storage.objects.

-- item-images: upload path is {userId}/{timestamp}.{ext}
-- foldername(name)[1] extracts the first path segment (the userId folder)

CREATE POLICY "item_images_insert_own"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'item-images'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "item_images_select_public"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'item-images');

CREATE POLICY "item_images_update_own"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'item-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "item_images_delete_own"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'item-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- avatars: same pattern, used in Phase 3

CREATE POLICY "avatars_insert_own"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "avatars_select_public"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

CREATE POLICY "avatars_update_own"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "avatars_delete_own"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
