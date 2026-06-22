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

-- STORAGE BUCKETS ----------------------------------------------
-- Create these in Supabase Dashboard → Storage → New bucket
--
--   Name: avatars        | Public: true
--   Name: item-images    | Public: true
