-- ============================================================================
-- Content moderation enforcement — App Store moderation Phase 2B, M2.1.
--
-- Admins hide (pending review) or remove (confirmed violation) reported
-- content, and can restore it. Nothing is deleted: moderation is a
-- reversible read restriction recorded in public.moderated_content, and the
-- owner keeps seeing (and may delete) their own content.
--
--   Enforcement, all in the database:
--   * restrictive SELECT policies (moderation_read_guard) on the moderated
--     tables AND on dependent rows that are otherwise world-readable
--     (comments, likes, ratings, share rows, Grail slots, showcase,
--     notifications) — for signed-in and signed-out readers alike;
--   * folder moderation covers the whole subtree (nested folders, their
--     items, comments, likes, tags) through the shared visibility helpers;
--   * the item-image signing resolver reports moderated items/images as
--     not viewable, so the UNCHANGED signing Edge Function signs them for
--     the owner only;
--   * a restrictive Storage policy refuses new signed URLs for a moderated
--     DM photo (the sender keeps access);
--   * INSERT/UPDATE guards (moderation_target_guard) refuse new
--     interactions with moderated content and any redistribution of it
--     (reposts, quotes, item/collection share posts, share rows, DM item
--     cards, Grail/showcase placement, covers, re-pointing an image path,
--     moving items or subfolders out of a moderated folder).
--
--   NOT covered here (later gates — see the M2.1 report):
--   * get-folder-cover-signed-url reads cover items with the service role
--     and does not consult these helpers (Edge Function gate);
--   * snapshot copies already in the PUBLIC share-snapshots/avatars buckets
--     stay reachable by URL (M2.3 quarantine);
--   * signed URLs already issued (≤ 5 min item images, ≤ 1 h DM photos) and
--     device caches; profile fields (M2.2); suspension (M3).
--   * Registry and transfers are out of beta scope and untouched.
--
-- Report integration (one transaction each, audited in moderation_actions):
--   admin_hide_content    report → reviewing (claimed), content → hidden
--   admin_remove_content  report (+ related) → actioned/content_removed,
--                         content → removed
--   admin_restore_content content → lifted; linked reports → reviewing
--                         (kept), open (reopen) or dismissed (overturn) —
--                         never left actioned. Child-safety moderation needs
--                         a second admin, an explicit confirmation, a
--                         dedicated reason and a note.
--   my_moderation_status  the caller's own moderated content (state, date).
-- ============================================================================

-- ── 1. Table ────────────────────────────────────────────────────────────────
CREATE TABLE public.moderated_content (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type  text        NOT NULL CHECK (target_type IN (
                             'post', 'comment', 'item_comment', 'folder_comment', 'gallery_comment',
                             'message', 'collection_item', 'item_image', 'folder')),
  target_id    uuid        NOT NULL,          -- no FK: history outlives the content
  owner_id     uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  state        text        NOT NULL CHECK (state IN ('hidden', 'removed')),
  reason_code  text        NOT NULL CHECK (reason_code ~ '^[a-z_]{1,48}$'),
  child_safety boolean     NOT NULL DEFAULT false,
  report_id    uuid        NOT NULL REFERENCES public.content_reports (id) ON DELETE RESTRICT,
  created_by   uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  lifted_at    timestamptz,
  lifted_by    uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  lift_reason  text        CHECK (lift_reason IS NULL OR lift_reason ~ '^[a-z_]{1,48}$'),
  CONSTRAINT moderated_content_lift_shape CHECK ((lifted_at IS NULL) = (lift_reason IS NULL))
);
-- At most one active restriction per piece of content.
CREATE UNIQUE INDEX moderated_content_one_active ON public.moderated_content (target_type, target_id) WHERE lifted_at IS NULL;
CREATE INDEX moderated_content_active_type_idx ON public.moderated_content (target_type) INCLUDE (target_id, owner_id) WHERE lifted_at IS NULL;
CREATE INDEX moderated_content_report_idx ON public.moderated_content (report_id);
CREATE INDEX moderated_content_owner_idx ON public.moderated_content (owner_id) WHERE lifted_at IS NULL;

ALTER TABLE public.moderated_content ENABLE ROW LEVEL SECURITY;
-- No client access of any kind; the service role may read. Writes happen
-- only inside the admin functions below.
REVOKE ALL ON public.moderated_content FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.moderated_content TO service_role;

CREATE POLICY account_lifecycle_read_guard ON public.moderated_content AS RESTRICTIVE
  FOR SELECT TO public
  USING (NOT (SELECT private.caller_is_hidden()));
CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.moderated_content
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write();

-- History: never deleted; what was restricted, why and by whom never
-- changes. Only the state (hidden → removed), the child-safety flag
-- (false → true) and the lift fields move, and an account deletion may
-- null the account ids.
CREATE FUNCTION private.moderated_content_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.target_type IS DISTINCT FROM OLD.target_type
       OR NEW.target_id IS DISTINCT FROM OLD.target_id OR NEW.report_id IS DISTINCT FROM OLD.report_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.owner_id IS DISTINCT FROM OLD.owner_id AND NEW.owner_id IS NOT NULL)
       OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
       OR (NEW.lifted_by IS DISTINCT FROM OLD.lifted_by AND NEW.lifted_by IS NOT NULL AND OLD.lifted_at IS NOT NULL)
       OR (OLD.child_safety AND NOT NEW.child_safety)
       OR (OLD.state = 'removed' AND NEW.state = 'hidden')
       OR (OLD.lifted_at IS NOT NULL AND (NEW.lifted_at IS DISTINCT FROM OLD.lifted_at OR NEW.state IS DISTINCT FROM OLD.state)) THEN
      RAISE EXCEPTION 'moderated_content_immutable' USING ERRCODE = '42501';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'moderated_content_immutable' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION private.moderated_content_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER moderated_content_history BEFORE UPDATE OR DELETE ON public.moderated_content
  FOR EACH ROW EXECUTE FUNCTION private.moderated_content_guard();
CREATE TRIGGER moderated_content_no_truncate BEFORE TRUNCATE ON public.moderated_content
  FOR EACH STATEMENT EXECUTE FUNCTION private.moderated_content_guard();

-- ── 2. Reports and audit: link and widen (M1 → M2) ─────────────────────────
-- A report points at the restriction it led to. 'actioned' now exists, but
-- only as content_removed WITH a restriction behind it.
ALTER TABLE public.content_reports
  ADD COLUMN moderation_id uuid REFERENCES public.moderated_content (id) ON DELETE RESTRICT;
CREATE INDEX content_reports_moderation_idx ON public.content_reports (moderation_id) WHERE moderation_id IS NOT NULL;
ALTER TABLE public.content_reports
  DROP CONSTRAINT content_reports_outcome_m1,
  ADD CONSTRAINT content_reports_outcome_m2 CHECK (
    resolution IS NULL
    OR (status = 'dismissed' AND resolution IN ('no_violation', 'duplicate', 'administrative_closure'))
    OR (status = 'actioned' AND resolution = 'content_removed' AND moderation_id IS NOT NULL));

ALTER TABLE public.moderation_actions
  DROP CONSTRAINT moderation_actions_action_check,
  ADD CONSTRAINT moderation_actions_action_check
    CHECK (action IN ('claim', 'release', 'resolve', 'reopen', 'hide', 'remove', 'restore')),
  DROP CONSTRAINT moderation_actions_outcome_check,
  ADD CONSTRAINT moderation_actions_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('no_violation', 'duplicate', 'administrative_closure', 'content_removed'));

-- Reason codes, now also for hide / remove / restore.
CREATE OR REPLACE FUNCTION private.moderation_reason_valid(p_kind text, p_reason text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(CASE p_kind
    WHEN 'no_violation'           THEN p_reason IN ('within_guidelines', 'insufficient_evidence')
    WHEN 'duplicate'              THEN p_reason IN ('duplicate_report')
    WHEN 'administrative_closure' THEN p_reason IN ('target_deleted', 'account_deleted', 'out_of_scope', 'test_report')
    WHEN 'reopen'                 THEN p_reason IN ('new_information', 'resolved_in_error', 'quality_review')
    WHEN 'hide'                   THEN p_reason IN ('pending_review', 'urgent_risk')
    WHEN 'remove'                 THEN p_reason IN ('spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm',
                                                    'child_safety', 'scam_fraud', 'impersonation', 'intellectual_property',
                                                    'other_violation')
    WHEN 'restore'                THEN p_reason IN ('resolved_in_error', 'new_information', 'appeal_granted',
                                                    'child_safety_review_cleared')
  END, false);
$$;

-- ── 3. Lookup helpers ───────────────────────────────────────────────────────
-- Active restrictions of one kind that the CALLER may not see (everything
-- except their own content), as one set per query — the same pattern as
-- private.hidden_account_ids(). Called from RLS policies, so executable by
-- clients; it is in the private schema (not exposed through the API).
CREATE FUNCTION private.moderated_ids_for_caller(p_type text)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(m.target_id), '{}'::uuid[])
  FROM public.moderated_content m
  WHERE m.target_type = p_type AND m.lifted_at IS NULL AND m.owner_id IS DISTINCT FROM auth.uid();
$$;

-- Every folder inside a moderated folder's subtree (including it), for
-- folders the caller doesn't own. Depth-bounded like the visibility helper.
CREATE FUNCTION private.moderated_folder_tree_for_caller()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH RECURSIVE tree (id, depth) AS (
    SELECT m.target_id, 0 FROM public.moderated_content m
     WHERE m.target_type = 'folder' AND m.lifted_at IS NULL AND m.owner_id IS DISTINCT FROM auth.uid()
    UNION
    SELECT f.id, t.depth + 1 FROM public.folders f JOIN tree t ON f.parent_folder_id = t.id WHERE t.depth < 100
  )
  SELECT COALESCE(array_agg(DISTINCT tree.id), '{}'::uuid[]) FROM tree;
$$;

CREATE FUNCTION private.is_moderated(p_type text, p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.moderated_content m WHERE m.target_type = p_type AND m.target_id = p_id AND m.lifted_at IS NULL);
$$;

-- Is this folder, or any ancestor, moderated? (Regardless of who asks.)
CREATE FUNCTION private.folder_tree_moderated(p_folder uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH RECURSIVE up (id, parent, depth) AS (
    SELECT f.id, f.parent_folder_id, 0 FROM public.folders f WHERE f.id = p_folder
    UNION ALL
    SELECT f.id, f.parent_folder_id, u.depth + 1 FROM public.folders f JOIN up u ON f.id = u.parent WHERE u.depth < 100
  )
  SELECT p_folder IS NOT NULL AND EXISTS (
    SELECT 1 FROM up JOIN public.moderated_content m
      ON m.target_type = 'folder' AND m.target_id = up.id AND m.lifted_at IS NULL);
$$;

-- Hidden from others: the item itself or its folder tree is moderated.
CREATE FUNCTION private.item_hidden(p_item uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.is_moderated('collection_item', p_item)
      OR EXISTS (SELECT 1 FROM public.collection_items ci WHERE ci.id = p_item AND private.folder_tree_moderated(ci.folder_id));
$$;

-- Must not be redistributed: hidden, or any of its images is moderated
-- (a share/snapshot would copy the image).
CREATE FUNCTION private.item_restricted(p_item uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.item_hidden(p_item)
      OR EXISTS (SELECT 1 FROM public.collection_item_images i JOIN public.moderated_content m
                   ON m.target_type = 'item_image' AND m.target_id = i.id AND m.lifted_at IS NULL
                 WHERE i.item_id = p_item);
$$;

-- Does this storage path belong to a moderated item image?
CREATE FUNCTION private.image_path_moderated(p_path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_path IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.collection_item_images i JOIN public.moderated_content m
      ON m.target_type = 'item_image' AND m.target_id = i.id AND m.lifted_at IS NULL
    WHERE i.storage_path = p_path);
$$;

REVOKE ALL ON FUNCTION private.moderated_ids_for_caller(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.moderated_folder_tree_for_caller() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.moderated_ids_for_caller(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.moderated_folder_tree_for_caller() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.is_moderated(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.folder_tree_moderated(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.item_hidden(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.item_restricted(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.image_path_moderated(text) FROM PUBLIC, anon, authenticated;

-- ── 4. Shared visibility helpers ────────────────────────────────────────────
-- Folder visibility (RLS on folders and their comments/likes/tags, folder
-- signing, reporting, export): a moderated folder — or one inside a
-- moderated folder — is invisible to everyone but its owner. Otherwise
-- unchanged from 20261103120000.
CREATE OR REPLACE FUNCTION public._folder_is_effectively_visible_for(target_folder_id uuid, caller uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_is_public boolean;
  current_parent uuid;
  target_owner uuid;
  visited uuid[] := ARRAY[]::uuid[];
  hops integer := 0;
BEGIN
  IF target_folder_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT f.is_public, f.parent_folder_id, f.user_id
    INTO current_is_public, current_parent, target_owner
    FROM public.folders f
    WHERE f.id = target_folder_id;

  IF NOT FOUND THEN
    RETURN false; -- nonexistent folder — fail closed, never leak existence
  END IF;

  -- Account lifecycle: a hidden owner's folders are invisible to everyone,
  -- and a hidden caller sees no folders (added by 20261103120000).
  IF private.account_is_hidden(target_owner) OR private.account_is_hidden(caller) THEN
    RETURN false;
  END IF;

  -- The owner of the target folder always sees their own tree (see
  -- 20261103120000 for why this is scoped to the target's own owner).
  IF caller IS NOT NULL AND caller = target_owner THEN
    RETURN true;
  END IF;

  -- Content moderation (20261116120000): the folder or an ancestor is
  -- restricted — invisible to everyone else.
  IF private.folder_tree_moderated(target_folder_id) THEN
    RETURN false;
  END IF;

  LOOP
    IF NOT current_is_public THEN
      RETURN false; -- most-restrictive-wins: any non-public node blocks a non-owner
    END IF;

    IF current_parent IS NULL THEN
      RETURN true; -- reached the root; every node so far (incl. target) was public
    END IF;

    hops := hops + 1;
    IF hops > 100 OR current_parent = ANY(visited) THEN
      RETURN false; -- pathological/cyclic stored data — fail closed, never trust it
    END IF;
    visited := visited || current_parent;

    SELECT f.is_public, f.parent_folder_id
      INTO current_is_public, current_parent
      FROM public.folders f
      WHERE f.id = current_parent;

    IF NOT FOUND THEN
      RETURN false; -- broken ancestor chain — fail closed
    END IF;
  END LOOP;
END;
$$;

-- Item visibility for one viewer (reporting, export's received tags):
-- a hidden item is visible to its owner only — including through the Grail
-- showcase exception.
CREATE OR REPLACE FUNCTION public._item_visible_to(p_item_id uuid, p_viewer uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT NOT private.account_is_hidden(p_viewer) -- account lifecycle (20261103120000)
    AND EXISTS (
    SELECT 1 FROM public.collection_items ci
    WHERE ci.id = p_item_id
      AND NOT private.account_is_hidden(ci.user_id) -- account lifecycle (20261103120000)
      AND (ci.user_id = p_viewer OR NOT private.item_hidden(ci.id)) -- content moderation (20261116120000)
      AND (
        (
          public._folder_is_effectively_visible_for(ci.folder_id, p_viewer)
          AND (ci.is_public = true OR ci.user_id = p_viewer)
        )
        OR EXISTS (
          SELECT 1 FROM public.profile_grail_slots gs
          WHERE gs.entry_type = 'item'
            AND gs.item_id = ci.id
            AND gs.user_id = ci.user_id
        )
      )
  );
$$;

-- Folder visibility incl. the Grail showcase exception: the exception no
-- longer reaches a moderated folder (the first branch already handles the
-- owner and moderation).
CREATE OR REPLACE FUNCTION public._folder_visible_to(p_folder_id uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public._folder_is_effectively_visible_for(p_folder_id, p_user)
      OR (public.folder_is_grail_showcased(p_folder_id) AND NOT private.folder_tree_moderated(p_folder_id));
$$;

-- Item-image signing (service role, get-collection-item-image-signed-url):
-- a moderated image, item or folder tree is reported as not public, not in
-- a visible folder and not showcased, so the existing Edge Function's
-- canViewItem signs it for the OWNER only. Same signature and columns.
CREATE OR REPLACE FUNCTION public.resolve_item_images_for_signing(p_image_ids uuid[])
RETURNS TABLE(image_id uuid, item_id uuid, storage_path text, owner_id uuid, item_is_public boolean, folder_effectively_visible boolean, grail_showcased boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH resolved AS (
    SELECT
      img.id           AS image_id,
      img.item_id      AS item_id,
      img.storage_path AS storage_path,
      f.id             AS folder_id,
      f.user_id        AS owner_id,
      ci.is_public     AS item_is_public,
      (private.is_moderated('item_image', img.id) OR private.item_hidden(ci.id)) AS moderated -- 20261116120000
    FROM public.collection_item_images img
    JOIN public.collection_items ci ON ci.id = img.item_id
    JOIN public.folders f ON f.id = ci.folder_id
    WHERE img.id = ANY (p_image_ids)
      AND NOT private.account_is_hidden(f.user_id) -- account lifecycle (20261103120000)
  ),
  folder_visibility AS (
    SELECT d.folder_id, public._folder_is_effectively_visible_for(d.folder_id, NULL) AS visible
    FROM (SELECT DISTINCT r.folder_id FROM resolved r) d
  )
  SELECT
    r.image_id,
    r.item_id,
    r.storage_path,
    r.owner_id,
    r.item_is_public AND NOT r.moderated,
    fv.visible AND NOT r.moderated,
    NOT r.moderated AND EXISTS (
      SELECT 1
      FROM public.profile_grail_slots gs
      WHERE gs.entry_type = 'item'
        AND gs.item_id = r.item_id
        AND gs.user_id = r.owner_id
    )
  FROM resolved r
  JOIN folder_visibility fv ON fv.folder_id = r.folder_id;
$$;

-- ── 5. Read restrictions ────────────────────────────────────────────────────
-- Restrictive, so they combine (AND) with RLS, blocking and lifecycle
-- guards. The owner exemption lives inside moderated_ids_for_caller (it
-- omits the caller's own content); dependent rows additionally exempt the
-- caller's own like/comment/rating. (For comments and likes on a hidden
-- POST that exemption is currently moot: the existing account-lifecycle
-- guard requires the parent post to be readable — a tracked limitation.)
-- Folder subtrees are also hidden by _folder_is_effectively_visible_for.
DO $$
DECLARE
  P   constant text := '(SELECT private.moderated_ids_for_caller(''post''))::uuid[]';
  C   constant text := '(SELECT private.moderated_ids_for_caller(''comment''))::uuid[]';
  I   constant text := '(SELECT private.moderated_ids_for_caller(''collection_item''))::uuid[]';
  IMG constant text := '(SELECT private.moderated_ids_for_caller(''item_image''))::uuid[]';
  FT  constant text := '(SELECT private.moderated_folder_tree_for_caller())::uuid[]';
  ME  constant text := '(SELECT auth.uid())';
  v_t text;
  v_u text;
BEGIN
  FOR v_t, v_u IN VALUES
    ('posts', format('NOT COALESCE(id = ANY (%s), false) AND NOT COALESCE(item_id = ANY (%s), false) AND NOT COALESCE(folder_id = ANY (%s), false)', P, I, FT)),
    ('comments', format('NOT COALESCE(id = ANY (%s), false) AND (user_id = %s OR NOT COALESCE(post_id = ANY (%s), false))', C, ME, P)),
    ('likes', format('user_id = %s OR NOT COALESCE(post_id = ANY (%s), false)', ME, P)),
    ('grail_ratings', format('rater_user_id = %s OR NOT COALESCE(post_id = ANY (%s), false)', ME, P)),
    ('item_comments', format('NOT COALESCE(id = ANY (%s), false) AND (user_id = %s OR NOT COALESCE(item_id = ANY (%s), false))',
                             '(SELECT private.moderated_ids_for_caller(''item_comment''))::uuid[]', ME, I)),
    ('item_likes', format('user_id = %s OR NOT COALESCE(item_id = ANY (%s), false)', ME, I)),
    ('folder_comments', format('NOT COALESCE(id = ANY (%s), false)', '(SELECT private.moderated_ids_for_caller(''folder_comment''))::uuid[]')),
    ('gallery_comments', format('NOT COALESCE(id = ANY (%s), false)', '(SELECT private.moderated_ids_for_caller(''gallery_comment''))::uuid[]')),
    ('messages', format('NOT COALESCE(id = ANY (%s), false)', '(SELECT private.moderated_ids_for_caller(''message''))::uuid[]')),
    ('collection_items', format('NOT COALESCE(id = ANY (%s), false) AND NOT COALESCE(folder_id = ANY (%s), false)', I, FT)),
    ('collection_item_images', format('NOT COALESCE(id = ANY (%s), false) AND NOT COALESCE(item_id = ANY (%s), false)', IMG, I)),
    ('folders', format('NOT COALESCE(id = ANY (%s), false)', FT)),
    ('card_share_items', format('NOT COALESCE(item_id = ANY (%s), false) AND NOT COALESCE(post_id = ANY (%s), false)', I, P)),
    ('folder_share_items', format('NOT COALESCE(item_id = ANY (%s), false) AND NOT COALESCE(post_id = ANY (%s), false)', I, P)),
    ('rate_my_grail_cards', format('NOT COALESCE(item_id = ANY (%s), false) AND NOT COALESCE(post_id = ANY (%s), false)', I, P)),
    ('post_images', format('NOT COALESCE(post_id = ANY (%s), false) AND NOT COALESCE(item_id = ANY (%s), false)', P, I)),
    ('profile_grail_slots', format('NOT COALESCE(item_id = ANY (%s), false) AND NOT COALESCE(collection_id = ANY (%s), false)', I, FT)),
    ('profile_showcase_items', format('NOT COALESCE(item_id = ANY (%s), false)', I)),
    ('notifications', format('NOT COALESCE(post_id = ANY (%s), false) AND NOT COALESCE(comment_id = ANY (%s), false) AND NOT COALESCE(item_id = ANY (%s), false) AND NOT COALESCE(folder_id = ANY (%s), false)', P, C, I, FT))
  LOOP
    EXECUTE format('CREATE POLICY moderation_read_guard ON public.%I AS RESTRICTIVE FOR SELECT TO public USING (%s)', v_t, v_u);
  END LOOP;
END;
$$;

-- DM photos: no new signed URL for a moderated message's attachment
-- (path <conversation>/<message>/image.jpg); the sender (object owner)
-- keeps access. URLs already issued last until they expire (≤ 1 h).
CREATE POLICY moderation_dm_attachment_guard ON storage.objects AS RESTRICTIVE
  FOR SELECT TO public
  USING (bucket_id <> 'dm-attachments' OR owner = (SELECT auth.uid())
         OR NOT COALESCE((storage.foldername(name))[2] = ANY ((SELECT private.moderated_ids_for_caller('message'))::text[]), false));

-- ── 6. Interaction and redistribution guards ───────────────────────────────
-- BEFORE INSERT / UPDATE OF the referenced columns. Each argument is
-- <check>:<column>; a NULL or (on UPDATE) unchanged value is not checked:
--   post         a moderated post
--   item_hidden  an item that is hidden (itself or its folder tree)
--   item_share   an item that may not be redistributed (also: a moderated image)
--   folder       a folder inside a moderated subtree
--   image_path   a storage path of a moderated item image
--   leave_folder (UPDATE only) moving out of a moderated subtree; the
--                ON DELETE SET NULL of a deleted parent passes, because
--                the deleted parent is no longer part of any tree
-- Applies to everyone, owners included (owners keep view and delete).
CREATE FUNCTION private.reject_moderated_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_arg   text;
  v_kind  text;
  v_col   text;
  v_new   text;
  v_old   text;
  v_bad   boolean;
BEGIN
  FOREACH v_arg IN ARRAY TG_ARGV LOOP
    v_kind := split_part(v_arg, ':', 1);
    v_col := split_part(v_arg, ':', 2);
    v_new := to_jsonb(NEW) ->> v_col;
    v_old := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ->> v_col END;
    IF TG_OP = 'UPDATE' AND v_new IS NOT DISTINCT FROM v_old THEN
      CONTINUE;
    END IF;
    v_bad := CASE v_kind
      WHEN 'post'         THEN v_new IS NOT NULL AND private.is_moderated('post', v_new::uuid)
      WHEN 'item_hidden'  THEN v_new IS NOT NULL AND private.item_hidden(v_new::uuid)
      WHEN 'item_share'   THEN v_new IS NOT NULL AND private.item_restricted(v_new::uuid)
      WHEN 'folder'       THEN v_new IS NOT NULL AND private.folder_tree_moderated(v_new::uuid)
      WHEN 'image_path'   THEN private.image_path_moderated(v_new)
      WHEN 'leave_folder' THEN TG_OP = 'UPDATE' AND v_old IS NOT NULL AND private.folder_tree_moderated(v_old::uuid)
      ELSE true
    END;
    IF v_bad THEN
      RAISE EXCEPTION 'content_unavailable' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.reject_moderated_reference() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF repost_of_post_id, quote_of_post_id, item_id, folder_id ON public.posts
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('post:repost_of_post_id', 'post:quote_of_post_id', 'item_share:item_id', 'folder:folder_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF post_id ON public.comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('post:post_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF post_id ON public.likes
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('post:post_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF post_id ON public.grail_ratings
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('post:post_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF item_id ON public.item_comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('item_hidden:item_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF item_id ON public.item_likes
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('item_hidden:item_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF item_id ON public.saved_cards
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('item_hidden:item_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF item_id ON public.collection_item_tags
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('item_hidden:item_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF folder_id ON public.folder_comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('folder:folder_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF folder_id ON public.folder_likes
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('folder:folder_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF folder_id ON public.gallery_comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('folder:folder_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF folder_id ON public.saved_folders
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('folder:folder_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF folder_id ON public.folder_tags
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('folder:folder_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF item_id, post_id ON public.card_share_items
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('item_share:item_id', 'post:post_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF item_id, post_id ON public.folder_share_items
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('item_share:item_id', 'post:post_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF item_id, post_id ON public.rate_my_grail_cards
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('item_share:item_id', 'post:post_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF item_id, post_id ON public.post_images
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('item_share:item_id', 'post:post_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF attachment_item_id ON public.messages
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('item_share:attachment_item_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF item_id, collection_id ON public.profile_grail_slots
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('item_share:item_id', 'folder:collection_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF item_id ON public.profile_showcase_items
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('item_share:item_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF storage_path ON public.collection_item_images
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('image_path:storage_path');
CREATE TRIGGER moderation_target_guard BEFORE UPDATE OF folder_id ON public.collection_items
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('leave_folder:folder_id');
CREATE TRIGGER moderation_target_guard BEFORE INSERT OR UPDATE OF parent_folder_id, cover_item_id, cover_storage_path ON public.folders
  FOR EACH ROW EXECUTE FUNCTION private.reject_moderated_reference('leave_folder:parent_folder_id', 'item_share:cover_item_id', 'image_path:cover_storage_path');

-- ── 7. Admin actions ────────────────────────────────────────────────────────
-- Which row a report's enforcement restricts, and its owner (locked FOR
-- SHARE so it can't be deleted mid-transaction). Image scope: the
-- p_image_index-th image reference in a collection_item report's evidence.
-- Profiles are moderated field-by-field in M2.2.
CREATE FUNCTION private.moderation_resolve_target(r public.content_reports, p_image_index integer,
                                                  OUT m_type text, OUT m_id uuid, OUT m_owner uuid)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_path text;
BEGIN
  IF r.target_type = 'profile' THEN
    RAISE EXCEPTION 'unsupported_target' USING ERRCODE = '22023';
  END IF;
  IF p_image_index IS NOT NULL THEN
    IF r.target_type <> 'collection_item' OR p_image_index < 0 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    IF r.evidence IS NULL THEN
      RAISE EXCEPTION 'evidence_unavailable' USING ERRCODE = 'PT409';
    END IF;
    v_path := r.evidence -> 'image_refs' -> p_image_index ->> 'path';
    IF v_path IS NULL THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    m_type := 'item_image';
    SELECT i.id, ci.user_id INTO m_id, m_owner
      FROM public.collection_item_images i JOIN public.collection_items ci ON ci.id = i.item_id
     WHERE i.item_id = r.target_id AND i.storage_path = v_path
     LIMIT 1 FOR SHARE OF i;
  ELSE
    m_type := r.target_type;
    m_id := r.target_id;
    CASE r.target_type
      WHEN 'post'            THEN SELECT t.user_id INTO m_owner FROM public.posts t WHERE t.id = r.target_id FOR SHARE;
      WHEN 'comment'         THEN SELECT t.user_id INTO m_owner FROM public.comments t WHERE t.id = r.target_id FOR SHARE;
      WHEN 'item_comment'    THEN SELECT t.user_id INTO m_owner FROM public.item_comments t WHERE t.id = r.target_id FOR SHARE;
      WHEN 'folder_comment'  THEN SELECT t.user_id INTO m_owner FROM public.folder_comments t WHERE t.id = r.target_id FOR SHARE;
      WHEN 'gallery_comment' THEN SELECT t.user_id INTO m_owner FROM public.gallery_comments t WHERE t.id = r.target_id FOR SHARE;
      WHEN 'message'         THEN SELECT t.sender_id INTO m_owner FROM public.messages t WHERE t.id = r.target_id FOR SHARE;
      WHEN 'collection_item' THEN SELECT t.user_id INTO m_owner FROM public.collection_items t WHERE t.id = r.target_id FOR SHARE;
      WHEN 'folder'          THEN SELECT t.user_id INTO m_owner FROM public.folders t WHERE t.id = r.target_id FOR SHARE;
    END CASE;
    IF NOT FOUND THEN
      m_id := NULL;
    END IF;
  END IF;
  IF m_id IS NULL THEN
    RAISE EXCEPTION 'target_not_found' USING ERRCODE = 'PT409';
  END IF;
  -- Serialize every action on this piece of content (two admins acting on
  -- two different reports about it).
  PERFORM pg_advisory_xact_lock(hashtextextended('moderation:' || m_type || ':' || m_id::text, 0));
END;
$$;
REVOKE ALL ON FUNCTION private.moderation_resolve_target(public.content_reports, integer) FROM PUBLIC, anon, authenticated;

-- The restriction a report is linked to, if still active.
CREATE FUNCTION private.active_moderation_of(p_id uuid)
RETURNS public.moderated_content
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.* FROM public.moderated_content m WHERE m.id = p_id AND m.lifted_at IS NULL;
$$;
REVOKE ALL ON FUNCTION private.active_moderation_of(uuid) FROM PUBLIC, anon, authenticated;

-- Hide pending review: the report stays open for a decision (claimed by
-- the caller); the content is restricted at once.
CREATE FUNCTION public.admin_hide_content(
  p_report_id   uuid,
  p_reason_code text,
  p_note        text    DEFAULT NULL,
  p_image_index integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin  uuid := private.require_admin();
  r        public.content_reports;
  v_note   text;
  v_target record;
  v_mod    public.moderated_content;
  v_linked boolean := false;
BEGIN
  IF NOT private.moderation_reason_valid('hide', p_reason_code) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
  v_note := private.moderation_note(p_note);

  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.status IN ('actioned', 'dismissed') THEN
    RAISE EXCEPTION 'already_resolved' USING ERRCODE = 'PT409';
  END IF;
  IF r.status = 'reviewing' AND r.claimed_by IS DISTINCT FROM v_admin
     AND NOT private.moderation_claim_is_stale(r.claimed_by, r.claimed_at) THEN
    RAISE EXCEPTION 'claimed_by_other' USING ERRCODE = 'PT409';
  END IF;

  v_target := private.moderation_resolve_target(r, p_image_index);
  SELECT * INTO v_mod FROM public.moderated_content m
   WHERE m.target_type = v_target.m_type AND m.target_id = v_target.m_id AND m.lifted_at IS NULL FOR UPDATE;
  IF FOUND THEN
    IF v_mod.state = 'removed' THEN
      RAISE EXCEPTION 'already_removed' USING ERRCODE = 'PT409';
    END IF;
    IF r.moderation_id = v_mod.id AND r.status = 'reviewing' AND r.claimed_by = v_admin THEN
      RETURN jsonb_build_object('report_id', r.id, 'moderation_id', v_mod.id, 'state', v_mod.state,
                                'report_status', r.status, 'changed', false);
    END IF;
    v_linked := true;
    IF r.reason = 'child_safety' AND NOT v_mod.child_safety THEN
      UPDATE public.moderated_content SET child_safety = true WHERE id = v_mod.id;
    END IF;
  ELSE
    INSERT INTO public.moderated_content (target_type, target_id, owner_id, state, reason_code, child_safety, report_id, created_by)
    VALUES (v_target.m_type, v_target.m_id, v_target.m_owner, 'hidden', p_reason_code, r.reason = 'child_safety', r.id, v_admin)
    RETURNING * INTO v_mod;
  END IF;

  UPDATE public.content_reports
     SET status = 'reviewing', claimed_by = v_admin,
         claimed_at = CASE WHEN r.status = 'reviewing' AND r.claimed_by = v_admin THEN r.claimed_at ELSE now() END,
         moderation_id = v_mod.id
   WHERE id = r.id;
  PERFORM private.log_moderation_action(v_admin, r, 'hide', 'reviewing', NULL, p_reason_code, v_note,
    jsonb_build_object('moderation_id', v_mod.id, 'moderated_type', v_mod.target_type, 'moderated_id', v_mod.target_id,
                       'linked_existing', v_linked));
  RETURN jsonb_build_object('report_id', r.id, 'moderation_id', v_mod.id, 'state', 'hidden',
                            'report_status', 'reviewing', 'changed', true);
END;
$$;

-- Remove (confirmed violation): content → removed, report (and, by
-- default, the other pending reports on the same content) → actioned /
-- content_removed. Evidence becomes purgeable 90 days later.
CREATE FUNCTION public.admin_remove_content(
  p_report_id       uuid,
  p_reason_code     text,
  p_note            text    DEFAULT NULL,
  p_image_index     integer DEFAULT NULL,
  p_include_related boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin   uuid := private.require_admin();
  r         public.content_reports;
  v_rel     public.content_reports;
  v_note    text;
  v_target  record;
  v_mod     public.moderated_content;
  v_prev    public.moderated_content;
  v_from    text;
  v_child   boolean;
  v_related integer := 0;
  v_purge   timestamptz := now() + interval '90 days';
BEGIN
  IF NOT private.moderation_reason_valid('remove', p_reason_code) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
  IF p_include_related IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  v_note := private.moderation_note(p_note);

  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.status = 'actioned' THEN
    v_prev := private.active_moderation_of(r.moderation_id);
    IF v_prev.id IS NOT NULL AND v_prev.state = 'removed' AND r.resolution_reason = p_reason_code AND r.reviewed_by = v_admin THEN
      RETURN jsonb_build_object('report_id', r.id, 'moderation_id', v_prev.id, 'state', 'removed',
                                'report_status', 'actioned', 'changed', false, 'related_resolved', 0);
    END IF;
    RAISE EXCEPTION 'already_resolved' USING ERRCODE = 'PT409';
  ELSIF r.status = 'dismissed' THEN
    RAISE EXCEPTION 'already_resolved' USING ERRCODE = 'PT409';
  END IF;
  IF r.status = 'reviewing' AND r.claimed_by IS DISTINCT FROM v_admin
     AND NOT private.moderation_claim_is_stale(r.claimed_by, r.claimed_at) THEN
    RAISE EXCEPTION 'claimed_by_other' USING ERRCODE = 'PT409';
  END IF;

  -- A report already linked to an active hide removes THAT restriction.
  v_prev := private.active_moderation_of(r.moderation_id);
  IF v_prev.id IS NOT NULL THEN
    IF p_image_index IS NOT NULL AND v_prev.target_type <> 'item_image' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('moderation:' || v_prev.target_type || ':' || v_prev.target_id::text, 0));
    SELECT * INTO v_mod FROM public.moderated_content m WHERE m.id = v_prev.id AND m.lifted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'concurrent_change' USING ERRCODE = 'PT409'; -- restored meanwhile; retry
    END IF;
  ELSE
    v_target := private.moderation_resolve_target(r, p_image_index);
    SELECT * INTO v_mod FROM public.moderated_content m
     WHERE m.target_type = v_target.m_type AND m.target_id = v_target.m_id AND m.lifted_at IS NULL FOR UPDATE;
  END IF;

  v_child := r.reason = 'child_safety' OR p_reason_code = 'child_safety';
  IF v_mod.id IS NOT NULL THEN
    v_from := v_mod.state;
    UPDATE public.moderated_content
       SET state = 'removed',
           reason_code = CASE WHEN v_mod.state = 'hidden' THEN p_reason_code ELSE v_mod.reason_code END,
           child_safety = v_mod.child_safety OR v_child
     WHERE id = v_mod.id
    RETURNING * INTO v_mod;
  ELSE
    v_from := NULL;
    INSERT INTO public.moderated_content (target_type, target_id, owner_id, state, reason_code, child_safety, report_id, created_by)
    VALUES (v_target.m_type, v_target.m_id, v_target.m_owner, 'removed', p_reason_code, v_child, r.id, v_admin)
    RETURNING * INTO v_mod;
  END IF;

  UPDATE public.content_reports
     SET status = 'actioned', resolution = 'content_removed', resolution_reason = p_reason_code,
         reviewed_at = now(), reviewed_by = v_admin, claimed_by = NULL, claimed_at = NULL,
         evidence_purge_after = v_purge, moderation_id = v_mod.id
   WHERE id = r.id;
  PERFORM private.log_moderation_action(v_admin, r, 'remove', 'actioned', 'content_removed', p_reason_code, v_note,
    jsonb_build_object('moderation_id', v_mod.id, 'moderated_type', v_mod.target_type, 'moderated_id', v_mod.target_id,
                       'previous_state', v_from));

  -- Related: other pending reports on the same reported row (not for a
  -- single-image removal), unclaimed or mine; locked ones are skipped.
  IF p_include_related AND v_mod.target_type <> 'item_image' THEN
    FOR v_rel IN
      SELECT * FROM public.content_reports c
       WHERE c.target_type = r.target_type AND c.target_id = r.target_id AND c.id <> r.id
         AND (c.status = 'open' OR (c.status = 'reviewing' AND c.claimed_by = v_admin))
       ORDER BY c.created_at, c.id
       LIMIT 200
       FOR UPDATE SKIP LOCKED
    LOOP
      UPDATE public.content_reports
         SET status = 'actioned', resolution = 'content_removed', resolution_reason = p_reason_code,
             reviewed_at = now(), reviewed_by = v_admin, claimed_by = NULL, claimed_at = NULL,
             evidence_purge_after = v_purge, moderation_id = v_mod.id
       WHERE id = v_rel.id;
      PERFORM private.log_moderation_action(v_admin, v_rel, 'remove', 'actioned', 'content_removed', p_reason_code, NULL,
        jsonb_build_object('moderation_id', v_mod.id, 'via_report', r.id));
      v_related := v_related + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('report_id', r.id, 'moderation_id', v_mod.id, 'state', 'removed',
                            'report_status', 'actioned', 'changed', true, 'related_resolved', v_related);
END;
$$;

-- Restore: lifts the restriction. Every linked report gets a disposition,
-- so none is left 'actioned' over restored content:
--   keep_reviewing  only for a hidden restriction whose reports are still
--                   pending — they stay as they are, for a decision;
--   reopen          resolved reports go back to the queue (evidence intact,
--                   before its purge date);
--   overturn        every linked report → dismissed / no_violation /
--                   decision_overturned.
-- Child safety: never by the admin who applied or escalated it; needs
-- p_confirm_child_safety, reason child_safety_review_cleared and a note.
CREATE FUNCTION public.admin_restore_content(
  p_moderation_id        uuid,
  p_reason_code          text,
  p_note                 text    DEFAULT NULL,
  p_disposition          text    DEFAULT NULL,
  p_confirm_child_safety boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin   uuid := private.require_admin();
  m         public.moderated_content;
  r         public.content_reports;
  v_note    text;
  v_to      text;
  v_reports jsonb := '[]'::jsonb;
BEGIN
  IF NOT private.moderation_reason_valid('restore', p_reason_code) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
  IF p_disposition IS NULL OR p_disposition NOT IN ('keep_reviewing', 'reopen', 'overturn') THEN
    RAISE EXCEPTION 'invalid_disposition' USING ERRCODE = '22023';
  END IF;
  v_note := private.moderation_note(p_note);

  SELECT * INTO m FROM public.moderated_content c WHERE c.id = p_moderation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  -- Same lock order as hide/remove: reports first, then the content.
  PERFORM 1 FROM public.content_reports c WHERE c.moderation_id = m.id ORDER BY c.id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('moderation:' || m.target_type || ':' || m.target_id::text, 0));
  SELECT * INTO m FROM public.moderated_content c WHERE c.id = p_moderation_id FOR UPDATE;
  IF m.lifted_at IS NOT NULL THEN
    RETURN jsonb_build_object('moderation_id', m.id, 'state', 'lifted', 'changed', false, 'reports', '[]'::jsonb);
  END IF;

  IF m.child_safety THEN
    IF p_confirm_child_safety IS DISTINCT FROM true OR p_reason_code <> 'child_safety_review_cleared' OR v_note IS NULL THEN
      RAISE EXCEPTION 'child_safety_confirmation_required' USING ERRCODE = '42501';
    END IF;
    IF v_admin = m.created_by OR EXISTS (
         SELECT 1 FROM public.moderation_actions a
          WHERE a.admin_id = v_admin AND a.action IN ('hide', 'remove') AND a.metadata ->> 'moderation_id' = m.id::text) THEN
      RAISE EXCEPTION 'child_safety_second_admin_required' USING ERRCODE = '42501';
    END IF;
  ELSIF p_reason_code = 'child_safety_review_cleared' THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;

  IF p_disposition = 'keep_reviewing' AND (m.state <> 'hidden' OR EXISTS (
       SELECT 1 FROM public.content_reports c WHERE c.moderation_id = m.id AND c.status IN ('actioned', 'dismissed'))) THEN
    RAISE EXCEPTION 'invalid_disposition' USING ERRCODE = '22023';
  END IF;

  UPDATE public.moderated_content SET lifted_at = now(), lifted_by = v_admin, lift_reason = p_reason_code WHERE id = m.id;

  FOR r IN SELECT * FROM public.content_reports c WHERE c.moderation_id = m.id ORDER BY c.created_at, c.id FOR UPDATE LOOP
    v_to := r.status;
    IF p_disposition = 'overturn' AND r.status <> 'dismissed' THEN
      UPDATE public.content_reports
         SET status = 'dismissed', resolution = 'no_violation', resolution_reason = 'decision_overturned',
             reviewed_at = now(), reviewed_by = v_admin, claimed_by = NULL, claimed_at = NULL,
             evidence_purge_after = now() + interval '90 days'
       WHERE id = r.id;
      v_to := 'dismissed';
    ELSIF p_disposition = 'reopen' AND r.status = 'actioned' THEN
      IF r.evidence IS NULL OR r.evidence_purged_at IS NOT NULL THEN
        RAISE EXCEPTION 'evidence_unavailable' USING ERRCODE = 'PT409';
      END IF;
      IF r.evidence_purge_after IS NOT NULL AND r.evidence_purge_after <= now() THEN
        RAISE EXCEPTION 'retention_expired' USING ERRCODE = 'PT409';
      END IF;
      BEGIN
        UPDATE public.content_reports
           SET status = 'open', resolution = NULL, resolution_reason = NULL,
               reviewed_at = NULL, reviewed_by = NULL, evidence_purge_after = NULL
         WHERE id = r.id;
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'duplicate_open_report' USING ERRCODE = 'PT409';
      END;
      v_to := 'open';
    END IF;
    PERFORM private.log_moderation_action(v_admin, r, 'restore', v_to,
      CASE WHEN v_to = 'dismissed' AND r.status <> 'dismissed' THEN 'no_violation' END, p_reason_code, v_note,
      jsonb_build_object('moderation_id', m.id, 'disposition', p_disposition, 'previous_state', m.state,
                         'child_safety', m.child_safety));
    v_reports := v_reports || jsonb_build_object('id', r.id, 'status', v_to);
  END LOOP;

  -- Never leave a report claiming enforcement that no longer exists.
  IF EXISTS (SELECT 1 FROM public.content_reports c WHERE c.moderation_id = m.id AND c.status = 'actioned') THEN
    RAISE EXCEPTION 'restore_inconsistent' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('moderation_id', m.id, 'state', 'lifted', 'changed', true, 'reports', v_reports);
END;
$$;

-- The caller's OWN moderated content: state and date only — never who
-- reported it, why, or which admin acted.
CREATE FUNCTION public.my_moderation_status(p_target_type text, p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_target_type IS NULL OR p_target_type NOT IN ('post', 'comment', 'item_comment', 'folder_comment', 'gallery_comment',
                                                     'message', 'collection_item', 'item_image', 'folder') THEN
    RAISE EXCEPTION 'invalid_target_type' USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) > 200 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('target_type', m.target_type, 'target_id', m.target_id,
                                                       'state', m.state, 'since', m.created_at) ORDER BY m.created_at), '[]'::jsonb)
            FROM public.moderated_content m
           WHERE m.target_type = p_target_type AND m.target_id = ANY (p_ids)
             AND m.owner_id = v_uid AND m.lifted_at IS NULL);
END;
$$;

-- ── 8. M1 functions that must respect enforcement ──────────────────────────
-- admin_resolve_report: a report whose content is currently restricted
-- can't be dismissed (that would leave a restriction with no decision) —
-- use admin_remove_content or admin_restore_content; related reports
-- linked to an active restriction are skipped. Otherwise unchanged.
CREATE OR REPLACE FUNCTION public.admin_resolve_report(
  p_report_id       uuid,
  p_outcome         text,
  p_reason_code     text,
  p_note            text    DEFAULT NULL,
  p_include_related boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin   uuid := private.require_admin();
  r         public.content_reports;
  v_rel     public.content_reports;
  v_note    text;
  v_related integer := 0;
  v_purge   timestamptz := now() + interval '90 days';
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('no_violation', 'duplicate', 'administrative_closure') THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023';
  END IF;
  IF NOT private.moderation_reason_valid(p_outcome, p_reason_code) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
  IF p_include_related IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  v_note := private.moderation_note(p_note);

  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.status IN ('actioned', 'dismissed') THEN
    IF r.resolution = p_outcome AND r.resolution_reason = p_reason_code AND r.reviewed_by = v_admin THEN
      RETURN jsonb_build_object('id', r.id, 'status', r.status, 'changed', false, 'related_resolved', 0);
    END IF;
    RAISE EXCEPTION 'already_resolved' USING ERRCODE = 'PT409';
  END IF;
  IF r.status = 'reviewing' AND r.claimed_by IS DISTINCT FROM v_admin
     AND NOT private.moderation_claim_is_stale(r.claimed_by, r.claimed_at) THEN
    RAISE EXCEPTION 'claimed_by_other' USING ERRCODE = 'PT409';
  END IF;
  IF (private.active_moderation_of(r.moderation_id)).id IS NOT NULL THEN
    RAISE EXCEPTION 'content_moderated' USING ERRCODE = 'PT409';
  END IF;
  PERFORM private.moderation_check_closure(r, p_reason_code);

  UPDATE public.content_reports
     SET status = 'dismissed', resolution = p_outcome, resolution_reason = p_reason_code,
         reviewed_at = now(), reviewed_by = v_admin, claimed_by = NULL, claimed_at = NULL,
         evidence_purge_after = v_purge
   WHERE id = r.id;
  PERFORM private.log_moderation_action(v_admin, r, 'resolve', 'dismissed', p_outcome, p_reason_code, v_note, NULL);

  IF p_include_related THEN
    FOR v_rel IN
      SELECT * FROM public.content_reports c
       WHERE c.target_type = r.target_type AND c.target_id = r.target_id AND c.id <> r.id
         AND (c.status = 'open' OR (c.status = 'reviewing' AND c.claimed_by = v_admin))
         AND (private.active_moderation_of(c.moderation_id)).id IS NULL
       ORDER BY c.created_at, c.id
       LIMIT 200
       FOR UPDATE SKIP LOCKED
    LOOP
      UPDATE public.content_reports
         SET status = 'dismissed', resolution = p_outcome, resolution_reason = p_reason_code,
             reviewed_at = now(), reviewed_by = v_admin, claimed_by = NULL, claimed_at = NULL,
             evidence_purge_after = v_purge
       WHERE id = v_rel.id;
      PERFORM private.log_moderation_action(v_admin, v_rel, 'resolve', 'dismissed', p_outcome, p_reason_code, NULL,
        jsonb_build_object('via_report', r.id));
      v_related := v_related + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('id', r.id, 'status', 'dismissed', 'changed', true, 'related_resolved', v_related);
END;
$$;

-- admin_get_report: adds the restriction linked to this report, or any
-- active restriction on the same reported row.
CREATE FUNCTION private.moderation_state_view(r public.content_reports)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT (SELECT jsonb_build_object('id', m.id, 'target_type', m.target_type, 'state', m.state,
                                    'active', m.lifted_at IS NULL, 'child_safety', m.child_safety,
                                    'reason_code', m.reason_code, 'created_at', m.created_at,
                                    'lifted_at', m.lifted_at, 'lift_reason', m.lift_reason)
            FROM public.moderated_content m
           WHERE m.id = r.moderation_id
              OR (m.target_type = r.target_type AND m.target_id = r.target_id AND m.lifted_at IS NULL)
           ORDER BY (m.lifted_at IS NULL) DESC, m.created_at DESC
           LIMIT 1);
$$;
REVOKE ALL ON FUNCTION private.moderation_state_view(public.content_reports) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_get_report(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin   uuid := private.require_admin();
  r         public.content_reports;
  v_current jsonb;
BEGIN
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  v_current := private.moderation_target_current(r.target_type, r.target_id);

  RETURN jsonb_build_object(
    'report', jsonb_build_object(
      'id', r.id, 'target_type', r.target_type, 'target_id', r.target_id, 'reason', r.reason, 'details', r.details,
      'priority', r.priority, 'status', r.status, 'created_at', r.created_at, 'updated_at', r.updated_at,
      'claimed_at', r.claimed_at, 'claimed_by', private.moderation_admin_ref(r.claimed_by, v_admin),
      'reviewed_at', r.reviewed_at, 'reviewed_by', private.moderation_admin_ref(r.reviewed_by, v_admin),
      'resolution', r.resolution, 'resolution_reason', r.resolution_reason,
      'evidence_purge_after', r.evidence_purge_after, 'evidence_purged_at', r.evidence_purged_at),
    'evidence', private.moderation_evidence_view(r.evidence),
    'current', jsonb_build_object('exists', v_current IS NOT NULL, 'content', v_current),
    'moderation', private.moderation_state_view(r),
    'owner', private.moderation_account_summary(r.target_owner_id),
    'reporter', jsonb_build_object('present', r.reporter_id IS NOT NULL),
    'prior', jsonb_build_object(
      'same_target', (SELECT jsonb_build_object(
          'open', count(*) FILTER (WHERE o.status = 'open'), 'reviewing', count(*) FILTER (WHERE o.status = 'reviewing'),
          'actioned', count(*) FILTER (WHERE o.status = 'actioned'), 'dismissed', count(*) FILTER (WHERE o.status = 'dismissed'))
        FROM public.content_reports o WHERE o.target_type = r.target_type AND o.target_id = r.target_id AND o.id <> r.id),
      'same_owner', CASE WHEN r.target_owner_id IS NULL THEN NULL ELSE (SELECT jsonb_build_object(
          'open', count(*) FILTER (WHERE o.status = 'open'), 'reviewing', count(*) FILTER (WHERE o.status = 'reviewing'),
          'actioned', count(*) FILTER (WHERE o.status = 'actioned'), 'dismissed', count(*) FILTER (WHERE o.status = 'dismissed'))
        FROM public.content_reports o WHERE o.target_owner_id = r.target_owner_id AND o.id <> r.id) END,
      'recent_same_owner', CASE WHEN r.target_owner_id IS NULL THEN '[]'::jsonb ELSE (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', o.id, 'target_type', o.target_type, 'reason', o.reason, 'priority', o.priority, 'status', o.status,
          'resolution', o.resolution, 'created_at', o.created_at) ORDER BY o.created_at DESC, o.id DESC), '[]'::jsonb)
        FROM (SELECT * FROM public.content_reports o WHERE o.target_owner_id = r.target_owner_id AND o.id <> r.id
              ORDER BY o.created_at DESC, o.id DESC LIMIT 10) o) END),
    'history', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'action', a.action, 'from_status', a.from_status, 'to_status', a.to_status, 'outcome', a.outcome,
        'reason_code', a.reason_code, 'note', a.note, 'metadata', a.metadata, 'created_at', a.created_at,
        'admin', private.moderation_admin_ref(a.admin_id, v_admin)) ORDER BY a.created_at, a.id), '[]'::jsonb)
      FROM (SELECT * FROM public.moderation_actions a WHERE a.report_id = r.id ORDER BY a.created_at, a.id LIMIT 200) a));
END;
$$;

-- ── 9. Privileges ───────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.admin_hide_content(uuid, text, text, integer)',
    'public.admin_remove_content(uuid, text, text, integer, boolean)',
    'public.admin_restore_content(uuid, text, text, text, boolean)',
    'public.my_moderation_status(text, uuid[])']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
