BEGIN;

-- ============================================================================
-- Allow reposting your OWN posts.
--
-- 20261014120000_add_post_reposts.sql and 20261015120000_add_quote_posts.sql
-- are already applied, so this is a new migration rather than an edit to
-- either. It replaces posts_repost_guard with the exact definition from
-- 20261015120000 MINUS the self-repost rejection ('cannot repost your own
-- post', SQLSTATE 22023). Nothing else changes:
--   * one repost per user per original (posts_one_repost_per_user) — your
--     own posts included, so a second repost is still a unique violation
--     the app treats as "already reposted";
--   * reposting a repost still references the ORIGINAL (no chains);
--     reposting a quote references the quote;
--   * a repost still carries no content (every content column cleared);
--   * immutable references: no turning a post into / out of / re-pointing
--     a repost or quote (quote_of_post_id may only be cleared by its
--     ON DELETE SET NULL);
--   * every quote rule (1-280 char comment, quote of a repost -> original,
--     never both a repost and a quote).
-- Inserts still go through posts_insert_own (auth.uid() = user_id), so a
-- user can still only create reposts as themselves. The trigger itself is
-- unchanged (still BEFORE INSERT OR UPDATE, from 20261014120000).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.posts_repost_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
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

  SELECT p.post_type, p.repost_of_post_id
    INTO v_target_type, v_target_of
    FROM public.posts p
   WHERE p.id = NEW.repost_of_post_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repost target not found' USING ERRCODE = '23503';
  END IF;

  -- Reposting a repost references its original (posts_repost_shape_check
  -- guarantees a repost's own target is never itself a repost). A quote is
  -- an original post of its own, so reposting one references the quote.
  -- Reposting your own post is allowed.
  IF v_target_type = 'repost' THEN
    NEW.repost_of_post_id := v_target_of;
    PERFORM 1 FROM public.posts p WHERE p.id = v_target_of;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'repost target not found' USING ERRCODE = '23503';
    END IF;
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
