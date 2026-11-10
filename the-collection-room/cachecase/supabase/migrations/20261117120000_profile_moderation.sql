-- ============================================================================
-- Profile field moderation — App Store moderation Phase 2B, M2.2.
--
-- Admins clear individual abusive profile fields. The original value is
-- kept server-side for a justified restoration, and ONLY that field is
-- locked: every other field stays editable.
--
--   Supported fields (all nullable text, all editable through
--   profiles_update_own): display_name, bio, tagline, location, website,
--   hero_display_name, avatar_url, hero_image_url, showcase_badge_url.
--   Not supported: username (identity — suspension or support rename),
--   the fixed-choice array/theme/variant fields.
--
--   Clearing sets the field to NULL in public.profiles itself, so every
--   reader — profile screens, search, blocked lists, the public Registry —
--   sees the cleared value; no other table caches these fields.
--   Clearing an IMAGE URL does NOT revoke its public avatars-bucket object:
--   anyone holding the URL can still fetch it until M2.3 quarantine.
--
--   Lock: profile_field_lock (BEFORE UPDATE) refuses any change to a
--   locked field by anyone — the owner through PostgREST/upserts, the
--   service role, other functions — except the admin functions below,
--   which run as the owning role with a transaction-local flag set. A
--   save that re-sends the cleared (blank) value passes, so the profile
--   editor's whole-profile save still works for unrelated fields.
--
--   Field states: active (locked, original kept), restored (original
--   written back), released (lock lifted, original NOT restored — the owner
--   may write a new value; superseded through an authorized decision).
--
--   Report integration: one umbrella row in moderated_content
--   (target_type 'profile') per profile with active field locks; the
--   report links to it and becomes actioned / content_removed only in the
--   same transaction that clears a field. Restoring the last field lifts
--   the umbrella and gives its reports a disposition (never left actioned
--   over restored content); releasing keeps them actioned (the removal
--   stands). Child safety: second admin + confirmation + reason + note.
--
--   Privacy: originals are readable only through admin functions; the
--   owner-facing my_profile_moderation() returns field names and dates.
--   Account deletion deletes the originals (ON DELETE CASCADE); history
--   (umbrella, audit, reports) stays, anonymised.
-- ============================================================================

-- ── 1. Umbrella, audit actions, reason codes ───────────────────────────────
ALTER TABLE public.moderated_content
  DROP CONSTRAINT moderated_content_target_type_check,
  ADD CONSTRAINT moderated_content_target_type_check CHECK (target_type IN (
    'post', 'comment', 'item_comment', 'folder_comment', 'gallery_comment',
    'message', 'collection_item', 'item_image', 'folder', 'profile'));

ALTER TABLE public.moderation_actions
  DROP CONSTRAINT moderation_actions_action_check,
  ADD CONSTRAINT moderation_actions_action_check CHECK (action IN (
    'claim', 'release', 'resolve', 'reopen', 'hide', 'remove', 'restore',
    'clear_profile_fields', 'restore_profile_fields', 'release_profile_fields'));

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
    WHEN 'release'                THEN p_reason IN ('owner_may_edit', 'policy_review', 'child_safety_review_cleared')
  END, false);
$$;

-- ── 2. Field restrictions ───────────────────────────────────────────────────
CREATE TABLE public.moderated_profile_fields (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  field          text        NOT NULL CHECK (field IN ('display_name', 'bio', 'tagline', 'location', 'website',
                                                       'hero_display_name', 'avatar_url', 'hero_image_url', 'showcase_badge_url')),
  original_value text        NOT NULL CHECK (char_length(original_value) BETWEEN 1 AND 10000),
  moderation_id  uuid        NOT NULL REFERENCES public.moderated_content (id) ON DELETE RESTRICT,
  report_id      uuid        NOT NULL REFERENCES public.content_reports (id) ON DELETE RESTRICT,
  created_by     uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'restored', 'released')),
  ended_at       timestamptz,
  ended_by       uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  end_reason     text        CHECK (end_reason IS NULL OR end_reason ~ '^[a-z_]{1,48}$'),
  CONSTRAINT moderated_profile_fields_end_shape
    CHECK ((status = 'active') = (ended_at IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX moderated_profile_fields_one_active ON public.moderated_profile_fields (user_id, field) WHERE status = 'active';
CREATE INDEX moderated_profile_fields_moderation_idx ON public.moderated_profile_fields (moderation_id);
CREATE INDEX moderated_profile_fields_report_idx ON public.moderated_profile_fields (report_id);

ALTER TABLE public.moderated_profile_fields ENABLE ROW LEVEL SECURITY;
-- No access for any API role — not even the service role: original values
-- are read only inside the admin functions below.
REVOKE ALL ON public.moderated_profile_fields FROM PUBLIC, anon, authenticated, service_role;

CREATE POLICY account_lifecycle_read_guard ON public.moderated_profile_fields AS RESTRICTIVE
  FOR SELECT TO public
  USING (NOT (SELECT private.caller_is_hidden()));
CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.moderated_profile_fields
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write();

-- History: the restricted field and its original never change; a row only
-- ends (active → restored | released), account ids may be nulled, and rows
-- disappear only with the account itself (ON DELETE CASCADE — by then the
-- account row is gone).
CREATE FUNCTION private.moderated_profile_fields_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.field IS DISTINCT FROM OLD.field
       OR NEW.original_value IS DISTINCT FROM OLD.original_value OR NEW.moderation_id IS DISTINCT FROM OLD.moderation_id
       OR NEW.report_id IS DISTINCT FROM OLD.report_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
       OR (OLD.status <> 'active' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
                                       OR NEW.end_reason IS DISTINCT FROM OLD.end_reason
                                       OR (NEW.ended_by IS DISTINCT FROM OLD.ended_by AND NEW.ended_by IS NOT NULL))) THEN
      RAISE EXCEPTION 'moderated_profile_field_immutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id) THEN
    RETURN OLD; -- the account itself is being deleted
  END IF;
  RAISE EXCEPTION 'moderated_profile_field_immutable' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION private.moderated_profile_fields_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER moderated_profile_fields_history BEFORE UPDATE OR DELETE ON public.moderated_profile_fields
  FOR EACH ROW EXECUTE FUNCTION private.moderated_profile_fields_guard();
CREATE TRIGGER moderated_profile_fields_no_truncate BEFORE TRUNCATE ON public.moderated_profile_fields
  FOR EACH STATEMENT EXECUTE FUNCTION private.moderated_profile_fields_guard();

-- ── 3. The lock ─────────────────────────────────────────────────────────────
-- Locked field names for one profile. Called by the lock trigger as the
-- updating role, so it must be executable by API roles; it returns names
-- only and lives in the private schema (not exposed through the API).
CREATE FUNCTION private.locked_profile_fields(p_user uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(f.field ORDER BY f.field), '{}'::text[])
  FROM public.moderated_profile_fields f WHERE f.user_id = p_user AND f.status = 'active';
$$;
REVOKE ALL ON FUNCTION private.locked_profile_fields(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.locked_profile_fields(uuid) TO anon, authenticated, service_role;

-- SECURITY INVOKER on purpose: current_user is the role performing the
-- UPDATE. Only the admin functions (SECURITY DEFINER, owned by postgres)
-- can be 'postgres' here AND set the transaction-local flag; a collector,
-- the service role or any other caller is refused. A blank re-send of a
-- cleared field (NULL vs '') keeps the stored value instead of failing.
CREATE FUNCTION private.enforce_profile_field_locks()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_locked text[];
  v_f      text;
  v_new    text;
  v_old    text;
BEGIN
  v_locked := private.locked_profile_fields(OLD.id);
  IF cardinality(v_locked) = 0 THEN
    RETURN NEW;
  END IF;
  IF current_user = 'postgres' AND current_setting('cachecase.profile_moderation_write', true) = 'on' THEN
    RETURN NEW;
  END IF;
  FOREACH v_f IN ARRAY v_locked LOOP
    v_new := to_jsonb(NEW) ->> v_f;
    v_old := to_jsonb(OLD) ->> v_f;
    IF v_new IS DISTINCT FROM v_old THEN
      IF NULLIF(btrim(COALESCE(v_new, '')), '') IS NULL AND NULLIF(btrim(COALESCE(v_old, '')), '') IS NULL THEN
        NEW := jsonb_populate_record(NEW, jsonb_build_object(v_f, v_old));
      ELSE
        RAISE EXCEPTION 'profile_field_locked' USING ERRCODE = '42501', DETAIL = v_f;
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.enforce_profile_field_locks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.enforce_profile_field_locks() TO anon, authenticated, service_role;

CREATE TRIGGER profile_field_lock
  BEFORE UPDATE OF display_name, bio, tagline, location, website, hero_display_name,
                   avatar_url, hero_image_url, showcase_badge_url ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.enforce_profile_field_locks();

-- ── 4. Helpers for the admin functions ──────────────────────────────────────
CREATE FUNCTION private.profile_fields_valid(p_fields text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_fields IS NOT NULL AND cardinality(p_fields) BETWEEN 1 AND 9 AND array_position(p_fields, NULL) IS NULL
     AND p_fields <@ ARRAY['display_name', 'bio', 'tagline', 'location', 'website', 'hero_display_name',
                           'avatar_url', 'hero_image_url', 'showcase_badge_url']
     AND cardinality(p_fields) = (SELECT count(DISTINCT f) FROM unnest(p_fields) f);
$$;

-- Writes one profile field through the lock (admin functions only).
CREATE FUNCTION private.write_moderated_profile_field(p_user uuid, p_field text, p_value text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT private.profile_fields_valid(ARRAY[p_field]) THEN
    RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('cachecase.profile_moderation_write', 'on', true);
  EXECUTE format('UPDATE public.profiles SET %I = $1 WHERE id = $2', p_field) USING p_value, p_user;
  PERFORM set_config('cachecase.profile_moderation_write', 'off', true);
END;
$$;

-- For an image field: does the original still point at an existing
-- avatars-bucket object? (Non-bucket URLs are not checked.)
CREATE FUNCTION private.profile_media_present(p_field text, p_value text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_field NOT IN ('avatar_url', 'hero_image_url', 'showcase_badge_url') THEN true
    WHEN substring(p_value FROM '/storage/v1/object/public/avatars/([^?#]+)') IS NULL THEN true
    ELSE EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'avatars'
                   AND o.name = substring(p_value FROM '/storage/v1/object/public/avatars/([^?#]+)'))
  END;
$$;

-- Same child-safety rule as admin_restore_content: not the admin who
-- applied it, explicit confirmation, the dedicated reason (for restore),
-- and a note.
CREATE FUNCTION private.check_profile_child_safety(m public.moderated_content, p_admin uuid, p_reason text,
                                                   p_note text, p_confirm boolean)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF m.child_safety THEN
    IF p_confirm IS DISTINCT FROM true OR p_reason <> 'child_safety_review_cleared' OR p_note IS NULL THEN
      RAISE EXCEPTION 'child_safety_confirmation_required' USING ERRCODE = '42501';
    END IF;
    IF p_admin = m.created_by OR EXISTS (
         SELECT 1 FROM public.moderation_actions a
          WHERE a.admin_id = p_admin AND a.action = 'clear_profile_fields' AND a.metadata ->> 'moderation_id' = m.id::text) THEN
      RAISE EXCEPTION 'child_safety_second_admin_required' USING ERRCODE = '42501';
    END IF;
  ELSIF p_reason = 'child_safety_review_cleared' THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.profile_fields_valid(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.write_moderated_profile_field(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.profile_media_present(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.check_profile_child_safety(public.moderated_content, uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;

-- ── 5. Admin: clear ─────────────────────────────────────────────────────────
-- Clears the selected fields of a reported profile (report target_type
-- 'profile'), locks them, and resolves the report actioned/content_removed
-- — only if at least one field is now restricted. Fields already locked
-- are linked, blank fields are skipped (nothing to remove).
CREATE FUNCTION public.admin_clear_profile_fields(
  p_report_id       uuid,
  p_fields          text[],
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
  v_prof    jsonb;
  v_mod     public.moderated_content;
  v_f       text;
  v_cur     text;
  v_cleared text[] := '{}';
  v_locked  text[] := '{}';
  v_empty   text[] := '{}';
  v_related integer := 0;
  v_purge   timestamptz := now() + interval '90 days';
BEGIN
  IF NOT private.moderation_reason_valid('remove', p_reason_code) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
  IF NOT private.profile_fields_valid(p_fields) THEN
    RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023';
  END IF;
  IF p_include_related IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  v_note := private.moderation_note(p_note);

  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.target_type <> 'profile' THEN
    RAISE EXCEPTION 'unsupported_target' USING ERRCODE = '22023';
  END IF;
  IF r.status = 'actioned' THEN
    IF r.reviewed_by = v_admin AND r.resolution_reason = p_reason_code
       AND (private.active_moderation_of(r.moderation_id)).id IS NOT NULL
       AND p_fields <@ private.locked_profile_fields(r.target_id) THEN
      RETURN jsonb_build_object('report_id', r.id, 'moderation_id', r.moderation_id, 'report_status', 'actioned',
                                'changed', false, 'cleared', '[]'::jsonb, 'already_locked', to_jsonb(p_fields),
                                'empty', '[]'::jsonb, 'related_resolved', 0, 'public_media_still_reachable', '[]'::jsonb);
    END IF;
    RAISE EXCEPTION 'already_resolved' USING ERRCODE = 'PT409';
  ELSIF r.status = 'dismissed' THEN
    RAISE EXCEPTION 'already_resolved' USING ERRCODE = 'PT409';
  END IF;
  IF r.status = 'reviewing' AND r.claimed_by IS DISTINCT FROM v_admin
     AND NOT private.moderation_claim_is_stale(r.claimed_by, r.claimed_at) THEN
    RAISE EXCEPTION 'claimed_by_other' USING ERRCODE = 'PT409';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('moderation:profile:' || r.target_id::text, 0));
  SELECT to_jsonb(p) INTO v_prof FROM public.profiles p WHERE p.id = r.target_id FOR UPDATE;
  IF v_prof IS NULL THEN
    RAISE EXCEPTION 'target_not_found' USING ERRCODE = 'PT409';
  END IF;

  FOREACH v_f IN ARRAY p_fields LOOP
    v_cur := v_prof ->> v_f;
    IF v_f = ANY (private.locked_profile_fields(r.target_id)) THEN
      v_locked := v_locked || v_f;
    ELSIF NULLIF(btrim(COALESCE(v_cur, '')), '') IS NULL THEN
      v_empty := v_empty || v_f;
    ELSE
      v_cleared := v_cleared || v_f;
    END IF;
  END LOOP;
  IF cardinality(v_cleared) = 0 AND cardinality(v_locked) = 0 THEN
    RAISE EXCEPTION 'nothing_to_clear' USING ERRCODE = 'PT409';
  END IF;

  SELECT * INTO v_mod FROM public.moderated_content m
   WHERE m.target_type = 'profile' AND m.target_id = r.target_id AND m.lifted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.moderated_content (target_type, target_id, owner_id, state, reason_code, child_safety, report_id, created_by)
    VALUES ('profile', r.target_id, r.target_id, 'removed', p_reason_code,
            r.reason = 'child_safety' OR p_reason_code = 'child_safety', r.id, v_admin)
    RETURNING * INTO v_mod;
  ELSIF NOT v_mod.child_safety AND (r.reason = 'child_safety' OR p_reason_code = 'child_safety') THEN
    UPDATE public.moderated_content SET child_safety = true WHERE id = v_mod.id RETURNING * INTO v_mod;
  END IF;

  FOREACH v_f IN ARRAY v_cleared LOOP
    INSERT INTO public.moderated_profile_fields (user_id, field, original_value, moderation_id, report_id, created_by)
    VALUES (r.target_id, v_f, left(v_prof ->> v_f, 10000), v_mod.id, r.id, v_admin);
    PERFORM private.write_moderated_profile_field(r.target_id, v_f, NULL);
  END LOOP;

  UPDATE public.content_reports
     SET status = 'actioned', resolution = 'content_removed', resolution_reason = p_reason_code,
         reviewed_at = now(), reviewed_by = v_admin, claimed_by = NULL, claimed_at = NULL,
         evidence_purge_after = v_purge, moderation_id = v_mod.id
   WHERE id = r.id;
  -- Field NAMES only — never values.
  PERFORM private.log_moderation_action(v_admin, r, 'clear_profile_fields', 'actioned', 'content_removed', p_reason_code, v_note,
    jsonb_build_object('moderation_id', v_mod.id, 'fields', to_jsonb(v_cleared), 'already_locked', to_jsonb(v_locked),
                       'empty', to_jsonb(v_empty)));

  IF p_include_related THEN
    FOR v_rel IN
      SELECT * FROM public.content_reports c
       WHERE c.target_type = 'profile' AND c.target_id = r.target_id AND c.id <> r.id
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
      PERFORM private.log_moderation_action(v_admin, v_rel, 'clear_profile_fields', 'actioned', 'content_removed', p_reason_code, NULL,
        jsonb_build_object('moderation_id', v_mod.id, 'via_report', r.id));
      v_related := v_related + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('report_id', r.id, 'moderation_id', v_mod.id, 'report_status', 'actioned', 'changed', true,
    'cleared', to_jsonb(v_cleared), 'already_locked', to_jsonb(v_locked), 'empty', to_jsonb(v_empty),
    'related_resolved', v_related,
    -- Clearing a URL does not revoke the public object (M2.3 quarantine).
    'public_media_still_reachable', to_jsonb(ARRAY(SELECT f FROM unnest(v_cleared) f
                                                    WHERE f IN ('avatar_url', 'hero_image_url', 'showcase_badge_url'))));
END;
$$;

-- ── 6. Admin: inspect ───────────────────────────────────────────────────────
-- The only place original values leave the database (admins, active
-- restrictions only).
CREATE FUNCTION public.admin_profile_moderation_status(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  RETURN jsonb_build_object(
    'account', private.moderation_account_summary(CASE WHEN EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN p_user_id END),
    'moderation', (SELECT jsonb_build_object('id', m.id, 'child_safety', m.child_safety, 'reason_code', m.reason_code,
                                             'created_at', m.created_at, 'report_id', m.report_id)
                     FROM public.moderated_content m
                    WHERE m.target_type = 'profile' AND m.target_id = p_user_id AND m.lifted_at IS NULL),
    'fields', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'field', f.field, 'status', f.status, 'created_at', f.created_at, 'report_id', f.report_id,
                 'created_by', private.moderation_admin_ref(f.created_by, v_admin),
                 'ended_at', f.ended_at, 'end_reason', f.end_reason, 'ended_by', private.moderation_admin_ref(f.ended_by, v_admin),
                 'original_value', CASE WHEN f.status = 'active' THEN f.original_value END,
                 'current_is_cleared', NULLIF(btrim(COALESCE(to_jsonb(p) ->> f.field, '')), '') IS NULL)
                 ORDER BY f.created_at DESC, f.field), '[]'::jsonb)
               FROM public.moderated_profile_fields f LEFT JOIN public.profiles p ON p.id = f.user_id
              WHERE f.user_id = p_user_id));
END;
$$;

-- ── 7. Admin: restore and release ──────────────────────────────────────────
-- Shared body. p_mode 'restore' writes each original back (refusing if
-- the field no longer holds its cleared value, or if an image original's
-- object is gone); 'release' only lifts the lock. When the LAST active
-- field of the profile ends, the umbrella is lifted: restore then needs a
-- disposition for its reports (reopen | overturn — never left actioned);
-- release keeps them actioned (the removal stands).
CREATE FUNCTION private.end_profile_field_restrictions(p_mode text, p_user_id uuid, p_fields text[], p_reason_code text,
                                                       p_note text, p_disposition text, p_confirm_child_safety boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_admin   uuid := auth.uid();
  v_note    text;
  m         public.moderated_content;
  r         public.content_reports;
  v_prof    jsonb;
  fr        public.moderated_profile_fields;
  v_ended   text[] := '{}';
  v_skipped text[] := '{}';
  v_last    boolean;
  v_to      text;
  v_reports jsonb := '[]'::jsonb;
BEGIN
  IF NOT private.moderation_reason_valid(p_mode, p_reason_code) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
  IF NOT private.profile_fields_valid(p_fields) THEN
    RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023';
  END IF;
  IF p_disposition IS NOT NULL AND (p_mode = 'release' OR p_disposition NOT IN ('reopen', 'overturn')) THEN
    RAISE EXCEPTION 'invalid_disposition' USING ERRCODE = '22023';
  END IF;
  v_note := private.moderation_note(p_note);

  SELECT * INTO m FROM public.moderated_content c
   WHERE c.target_type = 'profile' AND c.target_id = p_user_id AND c.lifted_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('user_id', p_user_id, 'changed', false, 'ended', '[]'::jsonb,
                              'not_restricted', to_jsonb(p_fields), 'profile_restriction', 'none');
  END IF;
  -- Lock order shared with every other moderation action: reports, then
  -- the content (advisory + rows).
  PERFORM 1 FROM public.content_reports c WHERE c.moderation_id = m.id ORDER BY c.id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('moderation:profile:' || p_user_id::text, 0));
  SELECT * INTO m FROM public.moderated_content c WHERE c.id = m.id FOR UPDATE;
  IF m.lifted_at IS NOT NULL THEN
    RAISE EXCEPTION 'concurrent_change' USING ERRCODE = 'PT409';
  END IF;
  PERFORM private.check_profile_child_safety(m, v_admin, p_reason_code, v_note, p_confirm_child_safety);
  SELECT to_jsonb(p) INTO v_prof FROM public.profiles p WHERE p.id = p_user_id FOR UPDATE;
  IF v_prof IS NULL THEN
    RAISE EXCEPTION 'target_not_found' USING ERRCODE = 'PT409';
  END IF;

  FOR fr IN SELECT * FROM public.moderated_profile_fields f
             WHERE f.user_id = p_user_id AND f.status = 'active' AND f.field = ANY (p_fields)
             ORDER BY f.field FOR UPDATE LOOP
    IF p_mode = 'restore' THEN
      IF NULLIF(btrim(COALESCE(v_prof ->> fr.field, '')), '') IS NOT NULL THEN
        RAISE EXCEPTION 'field_changed' USING ERRCODE = 'PT409', DETAIL = fr.field;  -- never overwrite a newer value
      END IF;
      IF NOT private.profile_media_present(fr.field, fr.original_value) THEN
        RAISE EXCEPTION 'original_media_missing' USING ERRCODE = 'PT409', DETAIL = fr.field;
      END IF;
    END IF;
    UPDATE public.moderated_profile_fields
       SET status = CASE WHEN p_mode = 'restore' THEN 'restored' ELSE 'released' END,
           ended_at = now(), ended_by = v_admin, end_reason = p_reason_code
     WHERE id = fr.id;
    IF p_mode = 'restore' THEN
      PERFORM private.write_moderated_profile_field(p_user_id, fr.field, fr.original_value);
    END IF;
    v_ended := v_ended || fr.field;
  END LOOP;
  v_skipped := ARRAY(SELECT f FROM unnest(p_fields) f WHERE f <> ALL (v_ended));
  IF cardinality(v_ended) = 0 THEN
    RETURN jsonb_build_object('user_id', p_user_id, 'changed', false, 'ended', '[]'::jsonb,
                              'not_restricted', to_jsonb(v_skipped), 'profile_restriction', 'active');
  END IF;

  v_last := NOT EXISTS (SELECT 1 FROM public.moderated_profile_fields f WHERE f.moderation_id = m.id AND f.status = 'active');
  IF p_mode = 'restore' AND (v_last <> (p_disposition IS NOT NULL)) THEN
    -- A disposition decides the reports exactly when the last field is restored.
    RAISE EXCEPTION 'invalid_disposition' USING ERRCODE = '22023';
  END IF;
  IF v_last THEN
    UPDATE public.moderated_content SET lifted_at = now(), lifted_by = v_admin, lift_reason = p_reason_code WHERE id = m.id;
  END IF;

  FOR r IN SELECT * FROM public.content_reports c WHERE c.moderation_id = m.id ORDER BY c.created_at, c.id LOOP
    v_to := r.status;
    IF v_last AND p_disposition = 'overturn' AND r.status <> 'dismissed' THEN
      UPDATE public.content_reports
         SET status = 'dismissed', resolution = 'no_violation', resolution_reason = 'decision_overturned',
             reviewed_at = now(), reviewed_by = v_admin, claimed_by = NULL, claimed_at = NULL,
             evidence_purge_after = now() + interval '90 days'
       WHERE id = r.id;
      v_to := 'dismissed';
    ELSIF v_last AND p_disposition = 'reopen' AND r.status = 'actioned' THEN
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
    PERFORM private.log_moderation_action(v_admin, r, p_mode || '_profile_fields', v_to,
      CASE WHEN v_to = 'dismissed' AND r.status <> 'dismissed' THEN 'no_violation' END, p_reason_code, v_note,
      jsonb_build_object('moderation_id', m.id, 'fields', to_jsonb(v_ended), 'disposition', p_disposition,
                         'profile_restriction', CASE WHEN v_last THEN 'lifted' ELSE 'active' END, 'child_safety', m.child_safety));
    v_reports := v_reports || jsonb_build_object('id', r.id, 'status', v_to);
  END LOOP;

  RETURN jsonb_build_object('user_id', p_user_id, 'changed', true, 'ended', to_jsonb(v_ended),
                            'not_restricted', to_jsonb(v_skipped),
                            'profile_restriction', CASE WHEN v_last THEN 'lifted' ELSE 'active' END, 'reports', v_reports);
END;
$$;
REVOKE ALL ON FUNCTION private.end_profile_field_restrictions(text, uuid, text[], text, text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.admin_restore_profile_fields(
  p_user_id              uuid,
  p_fields               text[],
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
  v_admin uuid := private.require_admin();
BEGIN
  RETURN private.end_profile_field_restrictions('restore', p_user_id, p_fields, p_reason_code, p_note, p_disposition, p_confirm_child_safety);
END;
$$;

CREATE FUNCTION public.admin_release_profile_fields(
  p_user_id              uuid,
  p_fields               text[],
  p_reason_code          text,
  p_note                 text    DEFAULT NULL,
  p_confirm_child_safety boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  RETURN private.end_profile_field_restrictions('release', p_user_id, p_fields, p_reason_code, p_note, NULL, p_confirm_child_safety);
END;
$$;

-- ── 8. Owner-facing contract ────────────────────────────────────────────────
-- The caller's own locked fields: names and dates only — never the
-- original value, the report, the reporter or the admin.
CREATE FUNCTION public.my_profile_moderation()
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
  RETURN jsonb_build_object('locked_fields', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('field', f.field, 'since', f.created_at) ORDER BY f.field), '[]'::jsonb)
      FROM public.moderated_profile_fields f WHERE f.user_id = v_uid AND f.status = 'active'));
END;
$$;

-- ── 9. Profile umbrellas are not restored through admin_restore_content ────

-- Unchanged from 20261116120000 except the profile guard right after the
-- restriction is read.
CREATE OR REPLACE FUNCTION public.admin_restore_content(
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
  -- Profile field restrictions (20261117120000) restore field-by-field.
  IF m.target_type = 'profile' THEN
    RAISE EXCEPTION 'use_profile_restore' USING ERRCODE = '22023';
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

-- ── 10. Privileges ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.admin_clear_profile_fields(uuid, text[], text, text, boolean)',
    'public.admin_profile_moderation_status(uuid)',
    'public.admin_restore_profile_fields(uuid, text[], text, text, text, boolean)',
    'public.admin_release_profile_fields(uuid, text[], text, text, boolean)',
    'public.my_profile_moderation()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
