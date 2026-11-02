BEGIN;

-- ============================================================================
-- Collector tagging — Checkpoint 1: database foundation and security.
--
-- A content owner can tag other collectors in one of their Items
-- (collection_item_tags) or Collections (folder_tags). Tagged content shows
-- on the tagged collector's Profile V2 Tagged tab; the tagged collector is
-- notified when they can see it. Separate from saved_cards / saved_folders
-- (bookmarks), which this migration does not touch.
--
-- Rules (enforced here, never by the client):
--   * only the content's owner adds tags; tagged_by is always the caller
--     and created_at the server's time;
--   * no self-tagging; the tagged collector must have a profile;
--   * one tag per collector per item/collection (primary key), at most 20
--     collectors per item/collection (checked under a per-content lock);
--   * a tag row is visible exactly when its item/collection is visible to the
--     reader — the policies defer to collection_items / folders RLS, so
--     tagging NEVER grants access to private content (owner, public flag,
--     nested-folder privacy and Grail showcase rules all carry over);
--   * the owner removes any tag; a tagged collector removes their own;
--   * tags are never updated, only added/removed;
--   * a deleted account's tags go with it (ON DELETE CASCADE via profiles),
--     as do a deleted item's/collection's.
--
-- Notifications: new types item_tag / folder_tag with item_id / folder_id.
-- Created server-side (AFTER INSERT trigger) only when the tagged collector
-- can see the content at that moment; at most one per collector per
-- item/collection (partial unique index); removed when the tag is removed.
-- ============================================================================

-- ── 1. Tables ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.collection_item_tags (
  item_id        uuid NOT NULL REFERENCES public.collection_items(id) ON DELETE CASCADE,
  tagged_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tagged_by      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, tagged_user_id),
  CONSTRAINT collection_item_tags_not_self CHECK (tagged_user_id <> tagged_by)
);

CREATE TABLE IF NOT EXISTS public.folder_tags (
  folder_id      uuid NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  tagged_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tagged_by      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (folder_id, tagged_user_id),
  CONSTRAINT folder_tags_not_self CHECK (tagged_user_id <> tagged_by)
);

-- The Tagged tab's lookup (newest first), and the tagged_by FK.
CREATE INDEX IF NOT EXISTS collection_item_tags_tagged_user_idx
  ON public.collection_item_tags (tagged_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collection_item_tags_tagged_by_idx
  ON public.collection_item_tags (tagged_by);
CREATE INDEX IF NOT EXISTS folder_tags_tagged_user_idx
  ON public.folder_tags (tagged_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS folder_tags_tagged_by_idx
  ON public.folder_tags (tagged_by);

-- ── 2. "Can this user see it?" for a user other than the caller ───────────
-- Items reuse the existing server-only public._item_visible_to(item, viewer)
-- (20261004120000, used by DM item attachments and view tracking): the
-- items_select_public rule for an arbitrary viewer. Collections get the
-- matching folders_select_public rule here. Server-only: used to decide
-- whether a newly tagged collector is notified.
CREATE OR REPLACE FUNCTION public._folder_visible_to(p_folder_id uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public._folder_is_effectively_visible_for(p_folder_id, p_user)
      OR public.folder_is_grail_showcased(p_folder_id);
$$;

REVOKE ALL ON FUNCTION public._folder_visible_to(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── 3. Insert validation ──────────────────────────────────────────────────
-- BEFORE INSERT: stamps tagged_by/created_at for client inserts, then checks
-- ownership, self-tagging, the tagged profile and the 20-collector cap, with
-- stable error tokens the app maps to copy:
--   tag_not_owner, tag_self, tag_user_not_found, tag_limit_reached.
-- The cap is counted under a per-item/collection advisory lock, so
-- concurrent inserts can't exceed it. SECURITY DEFINER so the count sees
-- every tag, not just the ones the caller can read.
CREATE OR REPLACE FUNCTION public.validate_content_tag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller     uuid := auth.uid();
  v_content_id uuid;
  v_owner      uuid;
  v_count      integer;
BEGIN
  -- Client inserts: the tagger is always the caller, the time the server's.
  -- Trusted server-side roles (no auth.uid()) must name tagged_by.
  IF v_caller IS NOT NULL THEN
    NEW.tagged_by := v_caller;
    NEW.created_at := now();
  ELSIF NEW.tagged_by IS NULL THEN
    RAISE EXCEPTION 'tag_not_owner' USING ERRCODE = '42501';
  END IF;

  IF TG_TABLE_NAME = 'collection_item_tags' THEN
    v_content_id := NEW.item_id;
    SELECT ci.user_id INTO v_owner FROM public.collection_items ci WHERE ci.id = NEW.item_id;
  ELSE
    v_content_id := NEW.folder_id;
    SELECT f.user_id INTO v_owner FROM public.folders f WHERE f.id = NEW.folder_id;
  END IF;

  -- Same answer for "not yours" and "doesn't exist".
  IF v_owner IS NULL OR v_owner <> NEW.tagged_by THEN
    RAISE EXCEPTION 'tag_not_owner' USING ERRCODE = '42501';
  END IF;
  IF NEW.tagged_user_id IS NULL OR NEW.tagged_user_id = NEW.tagged_by THEN
    RAISE EXCEPTION 'tag_self' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.tagged_user_id) THEN
    RAISE EXCEPTION 'tag_user_not_found' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_NAME || ':' || v_content_id::text, 0));
  IF TG_TABLE_NAME = 'collection_item_tags' THEN
    SELECT count(*) INTO v_count FROM public.collection_item_tags t
    WHERE t.item_id = NEW.item_id AND t.tagged_user_id <> NEW.tagged_user_id;
  ELSE
    SELECT count(*) INTO v_count FROM public.folder_tags t
    WHERE t.folder_id = NEW.folder_id AND t.tagged_user_id <> NEW.tagged_user_id;
  END IF;
  IF v_count >= 20 THEN
    RAISE EXCEPTION 'tag_limit_reached' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_content_tag() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS collection_item_tags_validate ON public.collection_item_tags;
CREATE TRIGGER collection_item_tags_validate
  BEFORE INSERT ON public.collection_item_tags
  FOR EACH ROW EXECUTE FUNCTION public.validate_content_tag();

DROP TRIGGER IF EXISTS folder_tags_validate ON public.folder_tags;
CREATE TRIGGER folder_tags_validate
  BEFORE INSERT ON public.folder_tags
  FOR EACH ROW EXECUTE FUNCTION public.validate_content_tag();

-- ── 4. RLS and privileges ──────────────────────────────────────────────────
ALTER TABLE public.collection_item_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folder_tags ENABLE ROW LEVEL SECURITY;

-- Read: exactly when the item/collection itself is readable by the caller.
-- The subqueries run under collection_items / folders RLS, so every
-- existing visibility rule applies unchanged.
DROP POLICY IF EXISTS collection_item_tags_select_visible ON public.collection_item_tags;
CREATE POLICY collection_item_tags_select_visible ON public.collection_item_tags
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.collection_items ci WHERE ci.id = collection_item_tags.item_id));

DROP POLICY IF EXISTS folder_tags_select_visible ON public.folder_tags;
CREATE POLICY folder_tags_select_visible ON public.folder_tags
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.folders f WHERE f.id = folder_tags.folder_id));

-- Add: owner only, never themselves (also checked, with error tokens, by
-- the trigger above).
DROP POLICY IF EXISTS collection_item_tags_insert_owner ON public.collection_item_tags;
CREATE POLICY collection_item_tags_insert_owner ON public.collection_item_tags
  FOR INSERT TO authenticated
  WITH CHECK (
    tagged_by = auth.uid()
    AND tagged_user_id <> auth.uid()
    AND EXISTS (SELECT 1 FROM public.collection_items ci WHERE ci.id = collection_item_tags.item_id AND ci.user_id = auth.uid())
  );

DROP POLICY IF EXISTS folder_tags_insert_owner ON public.folder_tags;
CREATE POLICY folder_tags_insert_owner ON public.folder_tags
  FOR INSERT TO authenticated
  WITH CHECK (
    tagged_by = auth.uid()
    AND tagged_user_id <> auth.uid()
    AND EXISTS (SELECT 1 FROM public.folders f WHERE f.id = folder_tags.folder_id AND f.user_id = auth.uid())
  );

-- Remove: the owner (any tag) or the tagged collector (their own).
DROP POLICY IF EXISTS collection_item_tags_delete ON public.collection_item_tags;
CREATE POLICY collection_item_tags_delete ON public.collection_item_tags
  FOR DELETE TO authenticated
  USING (
    tagged_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.collection_items ci WHERE ci.id = collection_item_tags.item_id AND ci.user_id = auth.uid())
  );

DROP POLICY IF EXISTS folder_tags_delete ON public.folder_tags;
CREATE POLICY folder_tags_delete ON public.folder_tags
  FOR DELETE TO authenticated
  USING (
    tagged_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.folders f WHERE f.id = folder_tags.folder_id AND f.user_id = auth.uid())
  );

REVOKE ALL ON public.collection_item_tags FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.folder_tags FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.collection_item_tags TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.folder_tags TO authenticated;

-- ── 5. Notifications ──────────────────────────────────────────────────────
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS item_id uuid REFERENCES public.collection_items(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES public.folders(id) ON DELETE CASCADE;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (ARRAY[
  'follow', 'like', 'comment', 'message', 'grail_rating',
  'ownership_transfer_requested', 'ownership_transfer_accepted',
  'ownership_transfer_declined', 'ownership_transfer_cancelled',
  'item_tag', 'folder_tag'
]));

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_item_tag_target_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_item_tag_target_check
  CHECK (type <> 'item_tag' OR item_id IS NOT NULL);
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_folder_tag_target_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_folder_tag_target_check
  CHECK (type <> 'folder_tag' OR folder_id IS NOT NULL);

-- One notification per tagged collector per item/collection.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_item_tag_unique
  ON public.notifications (user_id, item_id) WHERE type = 'item_tag';
CREATE UNIQUE INDEX IF NOT EXISTS notifications_folder_tag_unique
  ON public.notifications (user_id, folder_id) WHERE type = 'folder_tag';
-- ON DELETE CASCADE lookups.
CREATE INDEX IF NOT EXISTS notifications_item_id_idx ON public.notifications (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_folder_id_idx ON public.notifications (folder_id) WHERE folder_id IS NOT NULL;

-- New tag → notify the tagged collector, only if they can see the content
-- right now. Best-effort like create_message_notification: a notification
-- failure never undoes the tag (WARNING in the server log only).
CREATE OR REPLACE FUNCTION public.create_content_tag_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  BEGIN
    IF TG_TABLE_NAME = 'collection_item_tags' THEN
      IF public._item_visible_to(NEW.item_id, NEW.tagged_user_id) THEN
        INSERT INTO public.notifications (user_id, actor_id, type, item_id)
        VALUES (NEW.tagged_user_id, NEW.tagged_by, 'item_tag', NEW.item_id)
        ON CONFLICT (user_id, item_id) WHERE type = 'item_tag' DO NOTHING;
      END IF;
    ELSE
      IF public._folder_visible_to(NEW.folder_id, NEW.tagged_user_id) THEN
        INSERT INTO public.notifications (user_id, actor_id, type, folder_id)
        VALUES (NEW.tagged_user_id, NEW.tagged_by, 'folder_tag', NEW.folder_id)
        ON CONFLICT (user_id, folder_id) WHERE type = 'folder_tag' DO NOTHING;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'content tag notification failed (table %, tagged %, by %): %',
      TG_TABLE_NAME, NEW.tagged_user_id, NEW.tagged_by, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

-- Tag removed → its notification goes too (same as un-liking).
CREATE OR REPLACE FUNCTION public.delete_content_tag_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'collection_item_tags' THEN
    DELETE FROM public.notifications n
    WHERE n.type = 'item_tag' AND n.user_id = OLD.tagged_user_id AND n.item_id = OLD.item_id;
  ELSE
    DELETE FROM public.notifications n
    WHERE n.type = 'folder_tag' AND n.user_id = OLD.tagged_user_id AND n.folder_id = OLD.folder_id;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.create_content_tag_notification() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_content_tag_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS collection_item_tags_notify ON public.collection_item_tags;
CREATE TRIGGER collection_item_tags_notify
  AFTER INSERT ON public.collection_item_tags
  FOR EACH ROW EXECUTE FUNCTION public.create_content_tag_notification();
DROP TRIGGER IF EXISTS folder_tags_notify ON public.folder_tags;
CREATE TRIGGER folder_tags_notify
  AFTER INSERT ON public.folder_tags
  FOR EACH ROW EXECUTE FUNCTION public.create_content_tag_notification();

DROP TRIGGER IF EXISTS collection_item_tags_unnotify ON public.collection_item_tags;
CREATE TRIGGER collection_item_tags_unnotify
  AFTER DELETE ON public.collection_item_tags
  FOR EACH ROW EXECUTE FUNCTION public.delete_content_tag_notification();
DROP TRIGGER IF EXISTS folder_tags_unnotify ON public.folder_tags;
CREATE TRIGGER folder_tags_unnotify
  AFTER DELETE ON public.folder_tags
  FOR EACH ROW EXECUTE FUNCTION public.delete_content_tag_notification();

NOTIFY pgrst, 'reload schema';

COMMIT;
