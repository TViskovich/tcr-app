BEGIN;

-- ============================================================================
-- Quote posts — "Quote" in the feed's Repost / Quote menu.
--
-- A quote is the user's OWN post (post_type 'quote'): their comment
-- (posts.content, 1-280 chars) plus a reference to the quoted post
-- (quote_of_post_id). Like a repost it copies nothing — no snapshots, no
-- collection_items, no ownership change; the client renders the quoted
-- post's own content (media, caption, attribution) embedded under the
-- comment. Its likes/comments are its own (they key on post_id).
--
-- Kept distinct from reposts (20261014120000_add_post_reposts.sql) by its
-- own column and type:
--   * reposts: repost_of_post_id, ONE per user per original (unique index),
--     deleted with the original (ON DELETE CASCADE).
--   * quotes:  quote_of_post_id, ANY number per user per post, and they
--     outlive the quoted post — its deletion only clears the reference
--     (ON DELETE SET NULL), so the quoter's comment survives and the app
--     shows "This post is unavailable" in place of the embed.
--
-- Rules, enforced here (posts_repost_guard, extended below):
--   * Quoting a repost references the repost's ORIGINAL (no chains through
--     reposts). Quoting a quote references that quote — it has content of
--     its own (the client embeds one level and labels deeper ones).
--   * A quote must reference a post that exists, has a non-empty comment
--     (trimmed, max 280 chars — also a CHECK, so edits can't break it), and
--     carries no other content (item/image/caption/folder columns cleared).
--   * A post can't be turned into or out of a quote, and a quote can't be
--     re-pointed. The only allowed change to quote_of_post_id is the
--     ON DELETE SET NULL above.
--   * A post can't be both a repost and a quote.
-- Quoting your own post is allowed (reposting it still isn't).
--
-- Visibility: posts are world-readable (posts_select_public) and a post's
-- content is its own durable snapshot data, so an embed shows exactly what
-- the quoted post shows everyone. Inserts still go through
-- posts_insert_own (auth.uid() = user_id).
-- ============================================================================

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS quote_of_post_id uuid REFERENCES public.posts(id) ON DELETE SET NULL;

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_post_type_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_post_type_check
  CHECK (post_type IN ('item', 'text', 'rate_my_grails', 'card_share', 'folder_share', 'repost', 'quote'));

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_quote_shape_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_quote_shape_check
  CHECK (quote_of_post_id IS NULL OR post_type = 'quote');

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_quote_content_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_quote_content_check
  CHECK (post_type <> 'quote' OR (content IS NOT NULL AND char_length(btrim(content)) BETWEEN 1 AND 280));

CREATE INDEX IF NOT EXISTS posts_quote_of_post_id_idx
  ON public.posts (quote_of_post_id) WHERE quote_of_post_id IS NOT NULL;

-- Same function as 20261014120000 (reposts), extended with quotes.
-- SECURITY INVOKER: it only reads posts, which every role can already read.
CREATE OR REPLACE FUNCTION public.posts_repost_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_target_owner uuid;
  v_target_type  text;
  v_target_of    uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.repost_of_post_id IS DISTINCT FROM OLD.repost_of_post_id
       OR (NEW.post_type = 'repost') IS DISTINCT FROM (OLD.post_type = 'repost') THEN
      RAISE EXCEPTION 'a post cannot be turned into, out of, or re-pointed as a repost'
        USING ERRCODE = '42501';
    END IF;
    -- Clearing the reference is the quoted post's ON DELETE SET NULL; any
    -- other change is not allowed.
    IF (NEW.quote_of_post_id IS NOT NULL AND NEW.quote_of_post_id IS DISTINCT FROM OLD.quote_of_post_id)
       OR (NEW.post_type = 'quote') IS DISTINCT FROM (OLD.post_type = 'quote') THEN
      RAISE EXCEPTION 'a post cannot be turned into, out of, or re-pointed as a quote'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- ── Quote ──
  IF NEW.post_type = 'quote' OR NEW.quote_of_post_id IS NOT NULL THEN
    IF NEW.quote_of_post_id IS NULL THEN
      RAISE EXCEPTION 'a quote must reference a post' USING ERRCODE = '23502';
    END IF;
    IF NEW.repost_of_post_id IS NOT NULL THEN
      RAISE EXCEPTION 'a post cannot be both a repost and a quote' USING ERRCODE = '22023';
    END IF;

    SELECT p.post_type, p.repost_of_post_id
      INTO v_target_type, v_target_of
      FROM public.posts p
     WHERE p.id = NEW.quote_of_post_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'quoted post not found' USING ERRCODE = '23503';
    END IF;
    -- Quoting a repost quotes its original.
    IF v_target_type = 'repost' THEN
      NEW.quote_of_post_id := v_target_of;
    END IF;

    NEW.post_type := 'quote';
    NEW.content := btrim(NEW.content);
    NEW.item_id := NULL;
    NEW.image_url := NULL;
    NEW.caption := NULL;
    NEW.folder_id := NULL;
    NEW.folder_name := NULL;
    NEW.folder_item_count := NULL;
    NEW.folder_cover_snapshot_url := NULL;
    RETURN NEW;
  END IF;

  -- ── Repost ──
  IF NEW.repost_of_post_id IS NULL THEN
    IF NEW.post_type = 'repost' THEN
      RAISE EXCEPTION 'a repost must reference a post' USING ERRCODE = '23502';
    END IF;
    RETURN NEW;
  END IF;

  SELECT p.user_id, p.post_type, p.repost_of_post_id
    INTO v_target_owner, v_target_type, v_target_of
    FROM public.posts p
   WHERE p.id = NEW.repost_of_post_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repost target not found' USING ERRCODE = '23503';
  END IF;

  -- Reposting a repost references its original (posts_repost_shape_check
  -- guarantees a repost's own target is never itself a repost). A quote is
  -- an original post of its own, so reposting one references the quote.
  IF v_target_type = 'repost' THEN
    NEW.repost_of_post_id := v_target_of;
    SELECT p.user_id INTO v_target_owner FROM public.posts p WHERE p.id = v_target_of;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'repost target not found' USING ERRCODE = '23503';
    END IF;
  END IF;

  IF v_target_owner = NEW.user_id THEN
    RAISE EXCEPTION 'cannot repost your own post' USING ERRCODE = '22023';
  END IF;

  NEW.post_type := 'repost';
  NEW.item_id := NULL;
  NEW.image_url := NULL;
  NEW.content := NULL;
  NEW.caption := NULL;
  NEW.folder_id := NULL;
  NEW.folder_name := NULL;
  NEW.folder_item_count := NULL;
  NEW.folder_cover_snapshot_url := NULL;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.posts_repost_guard() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
