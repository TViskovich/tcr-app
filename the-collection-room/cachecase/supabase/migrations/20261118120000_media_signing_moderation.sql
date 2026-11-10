-- Phase 2B M2.3a — media signing and snapshot-copy security.
--
-- The image-signing and snapshot-copy Edge Functions run as the service role,
-- so none of M2.1's restrictive read guards or the blocking read guards apply
-- to them. This migration gives them narrowly scoped, service-role-only
-- helpers that answer exactly the questions those functions must ask, so the
-- database stays the single source of truth for moderation and blocks:
--
--   1. folder_cover_eligibility        get-folder-cover-signed-url
--   2. signing_blocked_image_ids       get-collection-item-image-signed-url
--   3. share_snapshot_copy_*           every public share-snapshots copy,
--      share_snapshot_eligible_items   recorded in a private ledger so a copy
--                                      is validated before it is made,
--                                      revalidated before it is published, and
--                                      cleaned up only by the operation that
--                                      created it
--   4. avatars / share-snapshots       no anonymous bucket listing; public
--                                      object URLs are unaffected
--
-- Nothing here is callable by anon or authenticated: every helper takes an
-- explicit caller id, so letting a collector call it would let them ask about
-- someone else's blocks or hidden content.

-- ── Shared private checks ───────────────────────────────────────────────────

-- True when an item-images object path is referenced by any record that must
-- keep it: an item image, a legacy item or folder cover URL, a post or
-- snapshot row still carrying an item-images URL, report evidence, an
-- in-progress account export, or (read-only, so a shared copy never deletes an
-- object Registry still points at) a Registry card URL. Used only to decide
-- that a "staging upload" is genuinely unreferenced before it is copied and
-- deleted.
CREATE FUNCTION private.item_images_path_protected(p_path text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH s AS (SELECT '/storage/v1/object/public/item-images/' || p_path AS suffix)
  SELECT p_path IS NULL
      OR EXISTS (SELECT 1 FROM public.collection_item_images i WHERE i.storage_path = p_path)
      OR EXISTS (SELECT 1 FROM public.folders f WHERE f.cover_storage_path = p_path)
      OR EXISTS (SELECT 1 FROM s, public.collection_item_images i WHERE right(i.image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.collection_items ci WHERE right(ci.image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.folders f WHERE right(f.cover_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.posts p
                 WHERE right(p.image_url, length(s.suffix)) = s.suffix
                    OR right(p.folder_cover_snapshot_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.post_images x WHERE right(x.image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.card_share_items x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.folder_share_items x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.rate_my_grail_cards x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.registered_cards x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM public.content_reports r
                 WHERE jsonb_path_exists(r.evidence, '$.** ? (@.bucket == "item-images" && @.path == $p)',
                                         jsonb_build_object('p', p_path)))
      OR EXISTS (SELECT 1 FROM public.account_export_entries e WHERE e.source_bucket = 'item-images' AND e.source_path = p_path);
$$;

REVOKE ALL ON FUNCTION private.item_images_path_protected(text) FROM PUBLIC, anon, authenticated, service_role;

-- ── 1. Folder covers ────────────────────────────────────────────────────────
-- One row per requested folder that exists. `authorized` replaces the Edge
-- Function's old visibility RPC + Grail-slot read:
--   owner (not hidden)                      -> always (M2.1: owners keep their
--                                              own moderated content)
--   anyone else                             -> owner not hidden, no block in
--                                              either direction, folder tree not
--                                              moderated, AND (effectively
--                                              visible OR the owner's own
--                                              Grail slot names it)
-- For a non-owner the cover must also skip restricted items:
--   restricted_item_ids     items in the folder (or its picked cover item)
--                           that are moderated, in a moderated folder tree, or
--                           whose primary image is moderated
--   cover_path_restricted   the uploaded cover path is a moderated item image
-- And for EVERY caller, a picked cover item must belong to the folder's own
-- owner (folders.cover_item_id has no ownership constraint, so a folder could
-- otherwise name another collector's private item).
CREATE FUNCTION public.folder_cover_eligibility(p_folder_ids uuid[], p_caller uuid)
RETURNS TABLE (folder_id uuid, authorized boolean, cover_item_owned boolean,
               cover_path_restricted boolean, restricted_item_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH f AS (
    SELECT f.id, f.user_id, f.cover_item_id, f.cover_storage_path,
           (p_caller IS NOT NULL AND p_caller = f.user_id) AS is_owner
    FROM public.folders f
    WHERE f.id = ANY (p_folder_ids) AND cardinality(p_folder_ids) <= 50
  ), a AS (
    SELECT f.*,
           (NOT private.account_is_hidden(f.user_id) AND NOT private.account_is_hidden(p_caller) AND (
              f.is_owner OR (
                NOT private.users_blocked(p_caller, f.user_id)
                AND NOT private.folder_tree_moderated(f.id)
                AND (public._folder_is_effectively_visible_for(f.id, p_caller)
                     OR EXISTS (SELECT 1 FROM public.profile_grail_slots g
                                WHERE g.entry_type = 'collection' AND g.collection_id = f.id AND g.user_id = f.user_id))))
           ) AS authorized
    FROM f
  )
  SELECT a.id,
         a.authorized,
         (a.cover_item_id IS NULL OR EXISTS (SELECT 1 FROM public.collection_items ci
                                              WHERE ci.id = a.cover_item_id AND ci.user_id = a.user_id)),
         (a.authorized AND NOT a.is_owner AND private.image_path_moderated(a.cover_storage_path)),
         CASE WHEN a.authorized AND NOT a.is_owner THEN ARRAY(
           SELECT m.target_id FROM public.moderated_content m
             JOIN public.collection_items ci ON ci.id = m.target_id
            WHERE m.target_type = 'collection_item' AND m.lifted_at IS NULL
              AND (ci.folder_id = a.id OR ci.id = a.cover_item_id)
           UNION
           SELECT i.item_id FROM public.moderated_content m
             JOIN public.collection_item_images i ON i.id = m.target_id
             JOIN public.collection_items ci ON ci.id = i.item_id
            WHERE m.target_type = 'item_image' AND m.lifted_at IS NULL AND i.is_primary
              AND (ci.folder_id = a.id OR ci.id = a.cover_item_id)
           UNION
           SELECT a.cover_item_id WHERE a.cover_item_id IS NOT NULL AND private.item_hidden(a.cover_item_id)
         ) ELSE '{}'::uuid[] END
  FROM a;
$$;

-- ── 2. Item images: blocks ──────────────────────────────────────────────────
-- Which of the requested images belong to an owner the caller has blocked or
-- been blocked by. resolve_item_images_for_signing stays caller-independent;
-- this is the caller-specific half. NULL caller (signed out) -> none.
CREATE FUNCTION public.signing_blocked_image_ids(p_caller uuid, p_image_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT img.id
  FROM public.collection_item_images img
  JOIN public.collection_items ci ON ci.id = img.item_id
  JOIN public.folders f ON f.id = ci.folder_id
  WHERE p_caller IS NOT NULL
    AND cardinality(p_image_ids) <= 50
    AND img.id = ANY (p_image_ids)
    AND f.user_id <> p_caller
    AND private.users_blocked(p_caller, f.user_id);
$$;

-- ── 3. Snapshot copies ──────────────────────────────────────────────────────
-- Every public share-snapshots copy made by a collector-facing Edge Function
-- is recorded here BEFORE it is made. The destination is derived from the row
-- id, so an object is attributable to exactly one operation, and cleanup can
-- only ever remove that operation's own destination. Rows also give M2.3b a
-- way to find copies of a later-moderated item even when no post references
-- them.
CREATE TABLE private.share_snapshot_copies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id   uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('item', 'folder_cover', 'post_photo')),
  item_id     uuid,             -- deliberately no FK: survives item deletion
  folder_id   uuid,
  source_path text NOT NULL,
  dest_base   text NOT NULL UNIQUE,
  dest_path   text UNIQUE,
  status      text NOT NULL DEFAULT 'reserved'
              CHECK (status IN ('reserved', 'published', 'rejected', 'discarded', 'removed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT share_snapshot_copies_shape CHECK (
    (kind = 'item' AND item_id IS NOT NULL) OR
    (kind = 'folder_cover' AND folder_id IS NOT NULL) OR
    (kind = 'post_photo' AND item_id IS NULL AND folder_id IS NULL))
);
CREATE INDEX share_snapshot_copies_item_idx ON private.share_snapshot_copies (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX share_snapshot_copies_open_idx ON private.share_snapshot_copies (status, created_at)
  WHERE status IN ('reserved', 'rejected', 'discarded');
ALTER TABLE private.share_snapshot_copies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.share_snapshot_copies FROM PUBLIC, anon, authenticated, service_role;

-- Why a copy must not happen (NULL = it may). Reasons are internal: Edge
-- Functions log them and return a generic failure, so no caller learns about
-- a block, a moderation restriction or a hidden account.
CREATE FUNCTION private.share_snapshot_problem(p_caller uuid, p_kind text, p_item uuid, p_folder uuid, p_source text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
  v_cover text;
  v_suffix text;
BEGIN
  IF p_caller IS NULL OR private.account_is_hidden(p_caller) THEN RETURN 'caller'; END IF;
  IF p_source IS NULL OR p_source !~ '^[^/\\]+(/[^/\\]+)+$' OR p_source LIKE '%..%' THEN
    RETURN 'source';
  END IF;
  IF private.image_path_moderated(p_source) THEN RETURN 'restricted'; END IF;

  IF p_kind = 'item' THEN
    SELECT ci.user_id INTO v_owner FROM public.collection_items ci WHERE ci.id = p_item;
    IF NOT FOUND OR private.account_is_hidden(v_owner) THEN RETURN 'source'; END IF;
    IF v_owner <> p_caller AND private.users_blocked(p_caller, v_owner) THEN RETURN 'source'; END IF;
    IF private.item_restricted(p_item) THEN RETURN 'restricted'; END IF;
    -- The path must really be this item's image (primary path, or a legacy
    -- item-images URL on the primary image or the item itself).
    v_suffix := '/storage/v1/object/public/item-images/' || p_source;
    IF NOT EXISTS (SELECT 1 FROM public.collection_item_images i
                   WHERE i.item_id = p_item AND i.is_primary
                     AND (i.storage_path = p_source OR right(i.image_url, length(v_suffix)) = v_suffix))
       AND NOT EXISTS (SELECT 1 FROM public.collection_items ci
                       WHERE ci.id = p_item AND right(ci.image_url, length(v_suffix)) = v_suffix) THEN
      RETURN 'source';
    END IF;
    RETURN NULL;

  ELSIF p_kind = 'folder_cover' THEN
    SELECT f.user_id, f.cover_storage_path INTO v_owner, v_cover FROM public.folders f WHERE f.id = p_folder;
    IF NOT FOUND OR private.account_is_hidden(v_owner) THEN RETURN 'source'; END IF;
    IF v_owner <> p_caller AND private.users_blocked(p_caller, v_owner) THEN RETURN 'source'; END IF;
    IF private.folder_tree_moderated(p_folder) THEN RETURN 'restricted'; END IF;
    IF v_cover IS DISTINCT FROM p_source THEN RETURN 'source'; END IF;
    RETURN NULL;

  ELSIF p_kind = 'post_photo' THEN
    -- Only a genuine staging upload: inside the caller's own namespace and
    -- referenced by nothing that must keep it.
    IF split_part(p_source, '/', 1) <> p_caller::text THEN RETURN 'source'; END IF;
    IF private.item_images_path_protected(p_source) THEN RETURN 'referenced'; END IF;
    RETURN NULL;
  END IF;
  RETURN 'kind';
END;
$$;
REVOKE ALL ON FUNCTION private.share_snapshot_problem(uuid, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- Validates and reserves a copy. Returns {ok, copy_id, destination} where
-- destination is the object path WITHOUT its extension (the Edge Function
-- appends the extension of the validated MIME type), or {ok:false, reason}.
CREATE FUNCTION public.share_snapshot_copy_begin(
  p_caller uuid, p_kind text, p_item_id uuid, p_folder_id uuid,
  p_source_path text, p_snapshot_type text, p_target_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_problem text;
  v_id uuid := gen_random_uuid();
  v_dest text;
BEGIN
  IF p_kind IN ('item', 'folder_cover') AND (p_target_id IS NULL OR p_snapshot_type IS NULL
       OR p_snapshot_type NOT IN ('post', 'card_share', 'rate_my_grails', 'folder_share')
       OR (p_kind = 'folder_cover' AND p_snapshot_type <> 'folder_share')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  v_problem := private.share_snapshot_problem(p_caller, p_kind, p_item_id, p_folder_id, p_source_path);
  IF v_problem IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_problem);
  END IF;

  v_dest := CASE p_kind
    WHEN 'item'         THEN format('%s/%s/%s/%s-%s', p_caller, p_snapshot_type, p_target_id, p_item_id, v_id)
    WHEN 'folder_cover' THEN format('%s/folder_share/%s/cover-%s', p_caller, p_target_id, v_id)
    ELSE                     format('%s/post-upload/%s', p_caller, v_id)
  END;

  INSERT INTO private.share_snapshot_copies (id, caller_id, kind, item_id, folder_id, source_path, dest_base)
  VALUES (v_id, p_caller, p_kind,
          CASE WHEN p_kind = 'item' THEN p_item_id END,
          CASE WHEN p_kind = 'folder_cover' THEN p_folder_id END,
          p_source_path, v_dest);

  RETURN jsonb_build_object('ok', true, 'copy_id', v_id, 'destination', v_dest);
END;
$$;

-- Revalidates a reserved copy after its object was uploaded and before its
-- URL is handed to anyone. {ok:true, delete_source} publishes it;
-- {ok:false} marks it rejected (the caller must then discard it).
-- delete_source is true only for a staging upload that is still unreferenced.
CREATE FUNCTION public.share_snapshot_copy_publish(p_copy_id uuid, p_dest_path text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r private.share_snapshot_copies;
  v_problem text;
BEGIN
  SELECT * INTO r FROM private.share_snapshot_copies WHERE id = p_copy_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'state');
  END IF;
  IF p_dest_path IS NULL OR p_dest_path NOT IN (
       SELECT r.dest_base || '.' || e FROM unnest(ARRAY['jpg', 'png', 'webp', 'heic', 'heif']) e) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'destination');
  END IF;

  v_problem := private.share_snapshot_problem(r.caller_id, r.kind, r.item_id, r.folder_id, r.source_path);
  UPDATE private.share_snapshot_copies
     SET dest_path = p_dest_path,
         status = CASE WHEN v_problem IS NULL THEN 'published' ELSE 'rejected' END,
         updated_at = now()
   WHERE id = p_copy_id;
  IF v_problem IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_problem);
  END IF;
  RETURN jsonb_build_object('ok', true, 'delete_source', r.kind = 'post_photo');
END;
$$;

-- Marks copies discarded and returns the ONLY object paths the caller may
-- remove for them: the recorded destination, or (when the upload outcome is
-- unknown) that operation's own destination with each allowed extension.
-- Copies already removed, or never this function's to discard, return nothing.
CREATE FUNCTION public.share_snapshot_copy_discard(p_copy_ids uuid[])
RETURNS TABLE (copy_id uuid, paths text[])
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE private.share_snapshot_copies c
     SET status = 'discarded', updated_at = now()
   WHERE c.id = ANY (p_copy_ids) AND cardinality(p_copy_ids) <= 50
     AND c.status IN ('reserved', 'published', 'rejected', 'discarded')
  RETURNING c.id,
            CASE WHEN c.dest_path IS NOT NULL THEN ARRAY[c.dest_path]
                 ELSE ARRAY(SELECT c.dest_base || '.' || e FROM unnest(ARRAY['jpg','png','webp','heic','heif']) e) END;
$$;

-- Records that a discarded copy's objects were removed from Storage.
CREATE FUNCTION public.share_snapshot_copy_removed(p_copy_ids uuid[])
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH u AS (
    UPDATE private.share_snapshot_copies c SET status = 'removed', updated_at = now()
     WHERE c.id = ANY (p_copy_ids) AND c.status = 'discarded'
    RETURNING 1)
  SELECT count(*)::integer FROM u;
$$;

-- Which of these items may be republished by this caller (not restricted,
-- owner not hidden, no block). Used to pick folder-share items up front so a
-- restricted item is skipped rather than failing the whole share.
CREATE FUNCTION public.share_snapshot_eligible_items(p_caller uuid, p_item_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT ci.id FROM public.collection_items ci
  WHERE p_caller IS NOT NULL AND NOT private.account_is_hidden(p_caller)
    AND cardinality(p_item_ids) <= 500
    AND ci.id = ANY (p_item_ids)
    AND NOT private.account_is_hidden(ci.user_id)
    AND (ci.user_id = p_caller OR NOT private.users_blocked(p_caller, ci.user_id))
    AND NOT private.item_restricted(ci.id);
$$;

-- Server-role only. Each takes an explicit caller id, so no collector may call
-- them (they would reveal other collectors' blocks and hidden content).
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.folder_cover_eligibility(uuid[], uuid)',
    'public.signing_blocked_image_ids(uuid, uuid[])',
    'public.share_snapshot_copy_begin(uuid, text, uuid, uuid, text, text, uuid)',
    'public.share_snapshot_copy_publish(uuid, text)',
    'public.share_snapshot_copy_discard(uuid[])',
    'public.share_snapshot_copy_removed(uuid[])',
    'public.share_snapshot_eligible_items(uuid, uuid[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;

-- ── 4. Public buckets: no anonymous listing ─────────────────────────────────
-- Public-bucket object URLs (/object/public/…) are served without consulting
-- these policies, so dropping the "anyone may SELECT" rows stops listing and
-- API reads by strangers but leaves every public image URL working. Owners
-- keep SELECT on their own folder, which Storage needs for remove().
DROP POLICY avatars_select_public ON storage.objects;
DROP POLICY share_snapshots_select_public ON storage.objects;

CREATE POLICY avatars_select_own ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

CREATE POLICY share_snapshots_select_own ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'share-snapshots' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

NOTIFY pgrst, 'reload schema';
