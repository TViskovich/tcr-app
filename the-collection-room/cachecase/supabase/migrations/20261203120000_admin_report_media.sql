-- ============================================================================
-- Report-scoped media inspection, media restoration and profile-field release
-- from the admin report screen — Phase 2B M5.3.
--
-- Media inspection (Edge Function admin-report-media):
--   The only media an administrator can open from a report is the media
--   recorded in THAT report's evidence when it was filed (DM photo, folder
--   cover, item images, the post image, the avatar), addressed by its
--   position in private.report_media_refs — never by a path, bucket or URL
--   from the app. report_media_authorize (service role only) re-checks the
--   admin's standing, that the object is still at its recorded location (a
--   quarantined original is NOT served: quarantine copies stay
--   service-only), and, for child-safety reports, an explicit confirmation.
--   Every request — allowed or refused — is appended to
--   private.report_media_access. The function then signs that one object
--   for 60 seconds. Storage policies and bucket privacy are unchanged.
--
-- Media restoration (existing Edge Function admin-media-restore):
--   admin_report_evidence lists the quarantine jobs held by THIS report's
--   restrictions and, read-only, whether each can be restored now (the same
--   rules media_quarantine_authorize applies). admin-media-restore accepts an
--   optional report_id; media_quarantine_report_scope (service role only)
--   then refuses any job not held by that report's restrictions. Restoring
--   media stays a separate, manual, audited step; the private quarantine
--   copy is kept; child-safety media still needs a second administrator.
--
-- Profile-field release: admin_report_enforce gains release_profile_fields
--   (existing admin_release_profile_fields: the owner may edit the field
--   again; nothing is restored) and image_index for hide/remove of one item
--   image (existing admin_hide_content / admin_remove_content).
--
-- Legal holds: admin_report_evidence lists the ACTIVE holds on the report,
--   its quarantine copies, its profile fields and the reported account —
--   type, basis code and dates only (never the basis note). No hold
--   operation is added; holds block purging, not these decisions.
--
-- Not changed: tables other than the new access log, policies, buckets,
-- existing functions other than admin_report_enforce (redefined above its
-- M5.2 body), retention, Registry, Transfers, account deletion and export.
-- ============================================================================

-- ── 1. Access log (append-only) ─────────────────────────────────────────────
CREATE TABLE private.report_media_access (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  admin_id     uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  report_id    uuid REFERENCES public.content_reports (id) ON DELETE SET NULL,
  ref          integer NOT NULL,
  kind         text,
  child_safety boolean NOT NULL DEFAULT false,
  allowed      boolean NOT NULL,
  reason       text CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,48}$')
);
CREATE INDEX report_media_access_report_idx ON private.report_media_access (report_id, created_at);
ALTER TABLE private.report_media_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.report_media_access FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.report_media_access_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Only an account deletion may null the ids (ON DELETE SET NULL).
  IF TG_OP = 'UPDATE'
     AND (NEW.admin_id IS NULL OR NEW.admin_id IS NOT DISTINCT FROM OLD.admin_id)
     AND (NEW.report_id IS NULL OR NEW.report_id IS NOT DISTINCT FROM OLD.report_id)
     AND (to_jsonb(NEW) - ARRAY['admin_id', 'report_id']) = (to_jsonb(OLD) - ARRAY['admin_id', 'report_id']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'report_media_access_append_only' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION private.report_media_access_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER report_media_access_append_only BEFORE UPDATE OR DELETE ON private.report_media_access
  FOR EACH ROW EXECUTE FUNCTION private.report_media_access_guard();
CREATE TRIGGER report_media_access_no_truncate BEFORE TRUNCATE ON private.report_media_access
  FOR EACH STATEMENT EXECUTE FUNCTION private.report_media_access_guard();

-- ── 2. The media a report's evidence recorded ───────────────────────────────
-- Fixed order: DM photo, folder cover, item images (by position), post
-- image, avatar. ref is 1-based; image_index is the position the existing
-- hide/remove functions take for a single item image.
CREATE FUNCTION private.report_media_refs(r public.content_reports)
RETURNS TABLE (ref integer, kind text, bucket text, path text, image_index integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT (row_number() OVER (ORDER BY x.o1, x.o2))::integer, x.kind, x.bucket, x.path, x.image_index
    FROM (
      SELECT 1 AS o1, 0 AS o2, 'dm_photo' AS kind, r.evidence -> 'attachment_ref' ->> 'bucket' AS bucket,
             r.evidence -> 'attachment_ref' ->> 'path' AS path, NULL::integer AS image_index
       WHERE jsonb_typeof(r.evidence -> 'attachment_ref') = 'object'
      UNION ALL
      SELECT 2, 0, 'folder_cover', r.evidence -> 'cover_ref' ->> 'bucket', r.evidence -> 'cover_ref' ->> 'path', NULL
       WHERE jsonb_typeof(r.evidence -> 'cover_ref') = 'object'
      UNION ALL
      SELECT 3, (e.n - 1)::integer, 'item_image', e.v ->> 'bucket', e.v ->> 'path', (e.n - 1)::integer
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.evidence -> 'image_refs') = 'array' THEN r.evidence -> 'image_refs' ELSE '[]'::jsonb END)
             WITH ORDINALITY e (v, n)
       WHERE jsonb_typeof(e.v) = 'object'
      UNION ALL
      SELECT 4, 0, 'post_image', 'share-snapshots', private.public_object_path(r.evidence ->> 'image_url', 'share-snapshots'), NULL
       WHERE jsonb_typeof(r.evidence -> 'image_url') = 'string'
      UNION ALL
      SELECT 5, 0, 'avatar', 'avatars', private.public_object_path(r.evidence ->> 'avatar_url', 'avatars'), NULL
       WHERE jsonb_typeof(r.evidence -> 'avatar_url') = 'string'
    ) x
   WHERE x.bucket IN ('dm-attachments', 'item-images', 'share-snapshots', 'avatars') AND x.path IS NOT NULL AND x.path <> '';
$$;

-- Restrictions decided through this report, and the quarantine jobs they hold.
CREATE FUNCTION private.report_media_job_ids(r public.content_reports)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT DISTINCT h.quarantine_id
    FROM private.media_quarantine_holds h
   WHERE h.moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.id = r.moderation_id OR m.report_id = r.id)
      OR h.profile_field_id IN (SELECT f.id FROM public.moderated_profile_fields f
                                 WHERE f.report_id = r.id
                                    OR f.moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.id = r.moderation_id OR m.report_id = r.id));
$$;

-- Whether a job can be restored now, by p_admin — read-only, the same rules
-- media_quarantine_authorize applies (which re-checks, and records the
-- request, when admin-media-restore runs). Confirmation is asked separately.
CREATE FUNCTION private.report_media_restore_blocker(j private.media_quarantine, p_admin uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN j.desired <> 'restore' OR EXISTS (SELECT 1 FROM private.media_quarantine_holds h
           WHERE h.quarantine_id = j.id AND (h.ended_at IS NULL OR h.end_disposition <> 'restore')) THEN 'not_released'
    WHEN j.state = 'restored' THEN 'already_restored'
    WHEN j.state NOT IN ('restore_pending', 'restoring') THEN 'not_restorable'
    WHEN j.needs_attention THEN 'needs_attention'
    WHEN NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = j.owner_id) THEN 'owner_deleted'
    WHEN private.account_is_hidden(j.owner_id) THEN 'owner_unavailable'
    WHEN j.child_safety AND EXISTS (SELECT 1 FROM private.media_quarantine_holds h JOIN public.moderated_content m ON m.id = h.moderation_id
           WHERE h.quarantine_id = j.id AND m.created_by = p_admin) THEN 'second_admin_required'
  END;
$$;

REVOKE ALL ON FUNCTION private.report_media_refs(public.content_reports) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.report_media_job_ids(public.content_reports) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.report_media_restore_blocker(private.media_quarantine, uuid) FROM PUBLIC, anon, authenticated;

-- ── 3. Evidence, restoration and holds of one report (admin, read-only) ─────
CREATE FUNCTION public.admin_report_evidence(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  r       public.content_reports;
  v_cs    boolean;
BEGIN
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  v_cs := private.report_is_child_safety(r.id);

  RETURN jsonb_build_object(
    'version', private.report_review_version(r),
    'child_safety', v_cs,
    -- No bucket, path or URL: ref is what the viewer asks for.
    'media', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ref', m.ref, 'kind', m.kind, 'image_index', m.image_index,
               'available', EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = m.bucket AND o.name = m.path),
               'child_safety', v_cs OR COALESCE(q.child_safety, false),
               'quarantine', CASE WHEN q.id IS NULL THEN NULL ELSE jsonb_build_object(
                   'state', q.state, 'desired', q.desired, 'needs_attention', q.needs_attention, 'legal_hold', q.legal_hold) END,
               'image_restricted', m.image_index IS NOT NULL AND EXISTS (
                   SELECT 1 FROM public.moderated_content mc JOIN public.collection_item_images i ON i.id = mc.target_id
                    WHERE mc.target_type = 'item_image' AND mc.lifted_at IS NULL AND i.item_id = r.target_id AND i.storage_path = m.path))
             ORDER BY m.ref)
        FROM private.report_media_refs(r) m
        LEFT JOIN LATERAL (SELECT x.* FROM private.media_quarantine x
                            WHERE x.source_bucket = m.bucket AND x.source_path = m.path
                            ORDER BY x.created_at DESC LIMIT 1) q ON true), '[]'::jsonb),
    'jobs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', j.id, 'kind', j.media_kind, 'state', j.state, 'desired', j.desired,
               'child_safety', j.child_safety, 'legal_hold', j.legal_hold, 'needs_attention', j.needs_attention,
               'error', CASE WHEN j.last_error IS NULL THEN NULL WHEN j.last_error ~ '^[a-z_]{1,48}$' THEN j.last_error ELSE 'error' END,
               'attempts', j.attempts, 'updated_at', j.updated_at, 'restored_at', j.restored_at,
               'restore_blocked', private.report_media_restore_blocker(j, v_admin))
             ORDER BY j.created_at, j.id)
        FROM private.media_quarantine j WHERE j.id IN (SELECT private.report_media_job_ids(r))), '[]'::jsonb),
    -- Active holds only; never the basis note or the people involved.
    'legal_holds', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'subject', h.subject_kind, 'hold_type', h.hold_type, 'basis_code', h.basis_code,
               'placed_at', h.placed_at, 'expires_at', h.expires_at, 'release_requested', h.release_requested_at IS NOT NULL)
             ORDER BY h.placed_at)
        FROM private.moderation_legal_holds h
       WHERE h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at > now())
         AND ((h.subject_kind = 'report' AND h.subject_id = r.id)
           OR (h.subject_kind = 'quarantine_copy' AND h.subject_id IN (SELECT private.report_media_job_ids(r)))
           OR (h.subject_kind = 'profile_field' AND h.subject_id IN (SELECT f.id FROM public.moderated_profile_fields f
                                                                      WHERE f.report_id = r.id OR f.moderation_id = r.moderation_id))
           OR (h.subject_kind = 'account' AND h.subject_id = r.target_owner_id))), '[]'::jsonb));
END;
$$;

-- ── 4. Service-only authorizers for the Edge Functions ──────────────────────
-- admin-report-media: may p_admin see media ref p_ref of report p_report_id?
-- Returns the bucket and path to sign ONLY when allowed. Every call is logged.
CREATE FUNCTION public.report_media_authorize(p_admin uuid, p_report_id uuid, p_ref integer, p_confirm_child_safety boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r      public.content_reports;
  m      record;
  q      private.media_quarantine;
  v_cs   boolean := false;
  v_why  text;
BEGIN
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = p_admin)
     OR private.account_is_hidden(p_admin) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF p_report_id IS NULL OR p_ref IS NULL OR p_ref < 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_argument');
  END IF;
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT * INTO m FROM private.report_media_refs(r) x WHERE x.ref = p_ref;
  IF m.ref IS NULL THEN
    v_why := 'not_found';
  ELSE
    SELECT * INTO q FROM private.media_quarantine x WHERE x.source_bucket = m.bucket AND x.source_path = m.path
     ORDER BY x.created_at DESC LIMIT 1;
    v_cs := private.report_is_child_safety(r.id) OR COALESCE(q.child_safety, false);
    IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = m.bucket AND o.name = m.path) THEN
      v_why := CASE WHEN q.id IS NOT NULL AND q.state IN ('quarantined', 'restore_pending', 'restoring') THEN 'quarantined' ELSE 'unavailable' END;
    ELSIF v_cs AND NOT COALESCE(p_confirm_child_safety, false) THEN
      v_why := 'child_safety_confirmation_required';
    END IF;
  END IF;
  INSERT INTO private.report_media_access (admin_id, report_id, ref, kind, child_safety, allowed, reason)
  VALUES (p_admin, r.id, p_ref, m.kind, v_cs, v_why IS NULL, v_why);
  IF v_why IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'allowed', false, 'reason', v_why, 'child_safety', v_cs);
  END IF;
  RETURN jsonb_build_object('ok', true, 'allowed', true, 'bucket', m.bucket, 'path', m.path, 'kind', m.kind, 'child_safety', v_cs);
END;
$$;

-- admin-media-restore with a report_id: the requested jobs NOT held by that
-- report's restrictions (refused as not_in_report).
CREATE FUNCTION public.media_quarantine_report_scope(p_report_id uuid, p_job_ids uuid[])
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.content_reports;
BEGIN
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  IF NOT FOUND THEN
    RETURN p_job_ids;
  END IF;
  RETURN ARRAY(SELECT x FROM unnest(p_job_ids) x WHERE x NOT IN (SELECT private.report_media_job_ids(r)));
END;
$$;

-- ── 5. admin_report_enforce: + release_profile_fields, + image_index ───────
-- The M5.2 body (20261202120000) with two additions:
--   release_profile_fields  existing admin_release_profile_fields (options:
--                           fields, confirm_child_safety); same locking as a
--                           profile restore.
--   p_options.image_index   integer, hide/remove one collection-item image —
--                           the image_index admin_report_evidence lists.
CREATE OR REPLACE FUNCTION public.admin_report_enforce(
  p_report_id        uuid,
  p_action           text,
  p_expected_version text,
  p_reason_code      text,
  p_note             text  DEFAULT NULL,
  p_options          jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin   uuid := private.require_admin();
  r         public.content_reports;
  m         public.moderated_content;
  v_opts    jsonb := COALESCE(p_options, '{}'::jsonb);
  v_related boolean;
  v_disp    text;
  v_confirm boolean;
  v_fields  text[];
  v_expires timestamptz;
  v_image   integer;
  v_res     jsonb;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('hide', 'remove', 'restore', 'clear_profile_fields', 'restore_profile_fields',
                                          'release_profile_fields', 'suspend', 'lift_suspension') THEN
    RAISE EXCEPTION 'invalid_action' USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL THEN
    RAISE EXCEPTION 'invalid_version' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_opts) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_related := (v_opts ->> 'include_related')::boolean;
    v_disp := v_opts ->> 'disposition';
    v_confirm := COALESCE((v_opts ->> 'confirm_child_safety')::boolean, false);
    v_expires := (v_opts ->> 'expires_at')::timestamptz;
    v_image := (v_opts ->> 'image_index')::integer;   -- 20261203120000
    IF v_opts ? 'fields' THEN
      IF jsonb_typeof(v_opts -> 'fields') <> 'array' THEN RAISE EXCEPTION 'bad'; END IF;
      v_fields := ARRAY(SELECT jsonb_array_elements_text(v_opts -> 'fields'));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END;

  -- Lock: the report; for a restore, every report linked to its restriction
  -- (ascending id, as admin_restore_content and the profile restore do).
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF p_action IN ('restore', 'restore_profile_fields', 'release_profile_fields') AND r.moderation_id IS NOT NULL THEN
    PERFORM 1 FROM public.content_reports c WHERE c.id = r.id OR c.moderation_id = r.moderation_id ORDER BY c.id FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.content_reports c WHERE c.id = r.id FOR UPDATE;
  END IF;
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  IF private.report_review_version(r) IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'report_changed' USING ERRCODE = 'PT409';
  END IF;

  IF p_action IN ('hide', 'remove', 'clear_profile_fields') THEN
    IF r.status IN ('open', 'reviewing') AND private.report_review_claim(r, v_admin) <> 'mine' THEN
      RAISE EXCEPTION 'claim_required' USING ERRCODE = 'PT409';
    END IF;
    IF p_action = 'hide' THEN
      v_res := public.admin_hide_content(r.id, p_reason_code, p_note, v_image);
    ELSIF p_action = 'remove' THEN
      v_res := public.admin_remove_content(r.id, p_reason_code, p_note, v_image, COALESCE(v_related, true));
    ELSE
      v_res := public.admin_clear_profile_fields(r.id, v_fields, p_reason_code, p_note, COALESCE(v_related, false));
    END IF;
  ELSIF p_action = 'restore' THEN
    m := private.report_enforcement_restriction(r);
    IF m.id IS NULL OR m.lifted_at IS NOT NULL THEN
      RAISE EXCEPTION 'not_restricted' USING ERRCODE = 'PT409';
    END IF;
    IF m.id IS DISTINCT FROM r.moderation_id THEN
      RAISE EXCEPTION 'restricted_via_other_report' USING ERRCODE = 'PT409';
    END IF;
    v_res := public.admin_restore_content(m.id, p_reason_code, p_note, v_disp, v_confirm);
  ELSIF p_action = 'restore_profile_fields' THEN
    IF r.target_type <> 'profile' THEN
      RAISE EXCEPTION 'unsupported_target' USING ERRCODE = '22023';
    END IF;
    v_res := public.admin_restore_profile_fields(r.target_id, v_fields, p_reason_code, p_note, v_disp, v_confirm);
  ELSIF p_action = 'release_profile_fields' THEN
    -- The owner may edit these fields again; their values are not restored.
    IF r.target_type <> 'profile' THEN
      RAISE EXCEPTION 'unsupported_target' USING ERRCODE = '22023';
    END IF;
    IF v_disp IS NOT NULL THEN
      -- A release never decides the reports; refuse rather than ignore.
      RAISE EXCEPTION 'invalid_disposition' USING ERRCODE = '22023';
    END IF;
    v_res := public.admin_release_profile_fields(r.target_id, v_fields, p_reason_code, p_note, v_confirm);
  ELSIF p_action = 'suspend' THEN
    IF r.target_owner_id IS NULL THEN
      RAISE EXCEPTION 'owner_unavailable' USING ERRCODE = 'PT409';
    END IF;
    v_res := public.admin_suspend_account(r.target_owner_id, p_reason_code, v_expires, p_note, r.id);
  ELSE
    IF r.target_owner_id IS NULL THEN
      RAISE EXCEPTION 'owner_unavailable' USING ERRCODE = 'PT409';
    END IF;
    v_res := public.admin_lift_suspension(r.target_owner_id, p_reason_code, p_note, v_confirm);
  END IF;

  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  -- Suspension views carry account ids and the note; the screen re-reads
  -- the enforcement state instead.
  RETURN jsonb_build_object('action', p_action, 'changed', COALESCE((v_res ->> 'changed')::boolean, true),
                            'report_status', r.status, 'version', private.report_review_version(r),
                            'related_resolved', COALESCE((v_res ->> 'related_resolved')::integer, 0),
                            'cleared', v_res -> 'cleared', 'already_locked', v_res -> 'already_locked',
                            'ended', v_res -> 'ended', 'not_restricted', v_res -> 'not_restricted',
                            'public_media_still_reachable', v_res -> 'public_media_still_reachable',
                            'profile_restriction', v_res -> 'profile_restriction',
                            'media', private.report_enforcement_media(COALESCE((v_res ->> 'moderation_id')::uuid, r.moderation_id)));
END;
$$;

-- ── 6. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.admin_report_evidence(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_report_evidence(uuid) TO authenticated;
-- The Edge Functions' service-role client only.
REVOKE ALL ON FUNCTION public.report_media_authorize(uuid, uuid, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_media_authorize(uuid, uuid, integer, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.media_quarantine_report_scope(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_quarantine_report_scope(uuid, uuid[]) TO service_role;
-- admin_report_enforce keeps its M5.2 grants (CREATE OR REPLACE).

NOTIFY pgrst, 'reload schema';
