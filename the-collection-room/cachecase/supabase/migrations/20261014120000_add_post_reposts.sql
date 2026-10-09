BEGIN;

-- ============================================================================
-- Universal feed reposts.
--
-- A repost is its own posts row (post_type 'repost') that REFERENCES the
-- original post (repost_of_post_id) instead of copying anything: no new
-- snapshots, no new collection_items, no change to who owns the content.
-- The client renders the original's own content (media, caption, item and
-- folder links, type-specific presentation) under "@reposter reposted",
-- while likes and comments attach to the repost row itself (they already
-- key on post_id), so a repost has its own engagement.
--
-- Rules, enforced here (not just in the app):
--   * Reposting a repost references the ORIGINAL — never a chain.
--   * You can't repost your own post (or a repost of it).
--   * One repost per user per original (unique index) — a double tap or a
--     retry can't create duplicates; the second insert is rejected with a
--     unique violation the client treats as "already reposted".
--   * A repost row carries no content of its own: every content column is
--     cleared on insert, whatever the client sent.
--   * A post can't be turned into, or out of, a repost after creation, and a
--     repost can't be re-pointed.
--   * Deleting the original deletes its reposts (ON DELETE CASCADE) — never
--     an orphaned repost of nothing. Undoing a repost is deleting the
--     repost row (existing posts_delete_own policy; it has no snapshot
--     objects to clean up).
--
-- Visibility: posts are world-readable (posts_select_public), and a post's
-- content is its own durable snapshot data, so a repost shows exactly what
-- the original shows to everyone — it never exposes anything the original
-- doesn't. Inserts still go through posts_insert_own (auth.uid() = user_id).
-- There is no user-blocking feature in this schema yet, so there is no block
-- rule to apply here.
-- ============================================================================

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS repost_of_post_id uuid REFERENCES public.posts(id) ON DELETE CASCADE;

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_post_type_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_post_type_check
  CHECK (post_type IN ('item', 'text', 'rate_my_grails', 'card_share', 'folder_share', 'repost'));

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_repost_shape_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_repost_shape_check
  CHECK ((post_type = 'repost') = (repost_of_post_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS posts_one_repost_per_user
  ON public.posts (user_id, repost_of_post_id) WHERE repost_of_post_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS posts_repost_of_post_id_idx
  ON public.posts (repost_of_post_id) WHERE repost_of_post_id IS NOT NULL;

-- SECURITY INVOKER: it only reads posts, which every role can already read
-- (posts_select_public), so it needs no privileges of its own.
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
    RETURN NEW;
  END IF;

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
  -- guarantees a repost's own target is never itself a repost).
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

DROP TRIGGER IF EXISTS posts_repost_guard ON public.posts;
CREATE TRIGGER posts_repost_guard
  BEFORE INSERT OR UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.posts_repost_guard();

NOTIFY pgrst, 'reload schema';

COMMIT;
