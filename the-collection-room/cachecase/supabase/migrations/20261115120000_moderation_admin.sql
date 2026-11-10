-- ============================================================================
-- Admin report queue and audit trail — App Store moderation Phase 2B, M1.
--
-- Builds the smallest secure review backend on top of content_reports
-- (20261114120000_add_content_reports.sql). Admins list, read, claim,
-- release, resolve and reopen reports; every successful status change is
-- written, in the same transaction, to an append-only audit table.
--
-- NOT in this gate (M2/M3): hiding or removing content, suspending accounts,
-- media access, monitoring changes, the purge job, the admin UI. Because no
-- enforcement exists yet, the only resolutions are ones that are true
-- without it — no_violation, duplicate, administrative_closure — and all of
-- them dismiss the report. 'actioned' is unreachable at the database level
-- (content_reports_outcome_m1) until M2/M3 widen it together with the
-- enforcement that makes it true.
--
-- Authorization: every admin function is SECURITY DEFINER, starts with
-- private.require_admin() (auth.uid() must be in public.admin_users and not
-- pending deletion), and is executable by `authenticated` only. The app's
-- useIsAdmin hook is a UI gate, never a boundary. Clients have no
-- privileges on content_reports or moderation_actions, so neither PostgREST
-- nor GraphQL can reach them directly.
--
-- Reporter privacy: no admin function returns reporter_id or anything about
-- the reporter except whether the account still exists.
--
-- Errors (PostgREST maps PTxxx to that HTTP status):
--   42501 not_authenticated | forbidden | account_inactive
--   22023 invalid_* | note_too_long
--   PT404 not_found
--   PT409 claimed_by_other | already_resolved | not_resolved |
--         reopen_not_supported | evidence_unavailable | retention_expired |
--         duplicate_open_report | target_still_exists | account_still_exists
-- ============================================================================

-- ── 1. Admin check ──────────────────────────────────────────────────────────
-- Returns the caller's id, or refuses. A pending-deletion admin is refused
-- too (their writes would fail the lifecycle write guard anyway, and reads
-- through SECURITY DEFINER functions bypass the RLS read guard).
CREATE FUNCTION private.require_admin()
RETURNS uuid
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
  IF NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF private.account_is_hidden(v_uid) THEN
    RAISE EXCEPTION 'account_inactive' USING ERRCODE = '42501';
  END IF;
  RETURN v_uid;
END;
$$;
REVOKE ALL ON FUNCTION private.require_admin() FROM PUBLIC, anon, authenticated;

-- ── 2. Report columns for claiming and resolution ──────────────────────────
-- claimed_* : who is reviewing it (status 'reviewing' ⇔ claimed_at set; the
--             claimer id becomes NULL if that account is deleted, which
--             leaves a stale claim any admin can take over).
-- resolution / resolution_reason : the outcome and its reason code; set
--             exactly when the report is resolved. M1 allows only outcomes
--             that need no enforcement, all of which dismiss the report.
ALTER TABLE public.content_reports
  ADD COLUMN claimed_by        uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN claimed_at        timestamptz,
  ADD COLUMN resolution        text,
  ADD COLUMN resolution_reason text,
  ADD CONSTRAINT content_reports_claim_shape
    CHECK ((status = 'reviewing') = (claimed_at IS NOT NULL) AND (claimed_by IS NULL OR claimed_at IS NOT NULL)),
  ADD CONSTRAINT content_reports_outcome_shape
    CHECK ((status IN ('actioned', 'dismissed')) = (resolution IS NOT NULL) AND (resolution IS NULL) = (resolution_reason IS NULL)),
  -- Widened by M2/M3 together with the enforcement behind each new outcome.
  ADD CONSTRAINT content_reports_outcome_m1
    CHECK (resolution IS NULL OR (status = 'dismissed' AND resolution IN ('no_violation', 'duplicate', 'administrative_closure'))),
  ADD CONSTRAINT content_reports_resolution_reason_format
    CHECK (resolution_reason IS NULL OR resolution_reason ~ '^[a-z_]{1,48}$');

CREATE INDEX content_reports_claimed_by_idx ON public.content_reports (claimed_by) WHERE claimed_by IS NOT NULL;
CREATE INDEX content_reports_resolved_idx ON public.content_reports (status, reviewed_at DESC, id DESC) WHERE reviewed_at IS NOT NULL;

-- ── 3. Audit trail ──────────────────────────────────────────────────────────
-- One row per successful status change, written by the same transaction.
-- Append-only: no client privileges; the service role may only read; a
-- trigger refuses UPDATE, DELETE and TRUNCATE for everyone (the one allowed
-- update is an account deletion nulling admin_id / target_owner_id), and
-- only lets an admin insert rows in their own name, stamped with the clock.
-- A superuser can still bypass triggers (session_replication_role, ALTER
-- TABLE … DISABLE TRIGGER); that is unavoidable inside the database and is
-- why database superuser access must stay restricted to operators.
CREATE TABLE public.moderation_actions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  admin_id        uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  -- RESTRICT: a report with audit history can't be deleted.
  report_id       uuid        REFERENCES public.content_reports (id) ON DELETE RESTRICT,
  action          text        NOT NULL CHECK (action IN ('claim', 'release', 'resolve', 'reopen')),
  target_type     text        NOT NULL CHECK (target_type IN (
                                'profile', 'post', 'comment', 'item_comment', 'folder_comment',
                                'gallery_comment', 'message', 'collection_item', 'folder')),
  target_id       uuid        NOT NULL,
  target_owner_id uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  from_status     text        CHECK (from_status IN ('open', 'reviewing', 'actioned', 'dismissed')),
  to_status       text        CHECK (to_status IN ('open', 'reviewing', 'actioned', 'dismissed')),
  outcome         text        CHECK (outcome IS NULL OR outcome IN ('no_violation', 'duplicate', 'administrative_closure')),
  reason_code     text        CHECK (reason_code IS NULL OR reason_code ~ '^[a-z_]{1,48}$'),
  note            text        CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb
                              CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 2048)
);
CREATE INDEX moderation_actions_report_idx ON public.moderation_actions (report_id, created_at);
CREATE INDEX moderation_actions_admin_idx ON public.moderation_actions (admin_id, created_at);
CREATE INDEX moderation_actions_owner_idx ON public.moderation_actions (target_owner_id, created_at);

ALTER TABLE public.moderation_actions ENABLE ROW LEVEL SECURITY;
-- No policies: nothing for clients. (This project's default privileges give
-- every role full table rights, so revoke explicitly.)
REVOKE ALL ON public.moderation_actions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.moderation_actions TO service_role;

-- Account-lifecycle compatibility (every public table carries both; see
-- supabase/tests/database/account_lifecycle.test.sql).
CREATE POLICY account_lifecycle_read_guard ON public.moderation_actions AS RESTRICTIVE
  FOR SELECT TO public
  USING (NOT (SELECT private.caller_is_hidden()));
CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.moderation_actions
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write();

CREATE FUNCTION private.moderation_actions_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.admin_id IS NULL OR NEW.admin_id IS DISTINCT FROM auth.uid()
       OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = NEW.admin_id) THEN
      RAISE EXCEPTION 'moderation_action_forbidden' USING ERRCODE = '42501';
    END IF;
    -- The real time of this action (not the transaction start), so several
    -- actions in one transaction keep their order; never caller-supplied.
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only the ON DELETE SET NULL of a deleted account: ids → NULL, nothing else.
    IF (NEW.admin_id IS NULL OR NEW.admin_id IS NOT DISTINCT FROM OLD.admin_id)
       AND (NEW.target_owner_id IS NULL OR NEW.target_owner_id IS NOT DISTINCT FROM OLD.target_owner_id)
       AND (to_jsonb(NEW) - ARRAY['admin_id', 'target_owner_id']) = (to_jsonb(OLD) - ARRAY['admin_id', 'target_owner_id']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'moderation_actions_append_only' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION private.moderation_actions_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER moderation_actions_append_only BEFORE INSERT OR UPDATE OR DELETE ON public.moderation_actions
  FOR EACH ROW EXECUTE FUNCTION private.moderation_actions_guard();
CREATE TRIGGER moderation_actions_no_truncate BEFORE TRUNCATE ON public.moderation_actions
  FOR EACH STATEMENT EXECUTE FUNCTION private.moderation_actions_guard();

-- ── 4. Helpers (server-only) ────────────────────────────────────────────────
-- Reason codes allowed for each outcome (and for reopening).
CREATE FUNCTION private.moderation_reason_valid(p_kind text, p_reason text)
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
  END, false);
$$;

-- Internal note: trimmed, empty → NULL, at most 1,000 characters.
CREATE FUNCTION private.moderation_note(p_note text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF v IS NOT NULL AND char_length(v) > 1000 THEN
    RAISE EXCEPTION 'note_too_long' USING ERRCODE = '22023';
  END IF;
  RETURN v;
END;
$$;

-- A claim nobody is working on: claimer deleted, no longer an admin,
-- pending deletion, or the claim is over 24 hours old.
CREATE FUNCTION private.moderation_claim_is_stale(p_claimed_by uuid, p_claimed_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p_claimed_by IS NULL
      OR p_claimed_at < now() - interval '24 hours'
      OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = p_claimed_by)
      OR private.account_is_hidden(p_claimed_by);
$$;

-- Does the reported row still exist? (Looked up directly, ignoring RLS.)
CREATE FUNCTION private.moderation_target_exists(p_type text, p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE p_type
    WHEN 'profile'         THEN EXISTS (SELECT 1 FROM public.profiles t WHERE t.id = p_id)
    WHEN 'post'            THEN EXISTS (SELECT 1 FROM public.posts t WHERE t.id = p_id)
    WHEN 'comment'         THEN EXISTS (SELECT 1 FROM public.comments t WHERE t.id = p_id)
    WHEN 'item_comment'    THEN EXISTS (SELECT 1 FROM public.item_comments t WHERE t.id = p_id)
    WHEN 'folder_comment'  THEN EXISTS (SELECT 1 FROM public.folder_comments t WHERE t.id = p_id)
    WHEN 'gallery_comment' THEN EXISTS (SELECT 1 FROM public.gallery_comments t WHERE t.id = p_id)
    WHEN 'message'         THEN EXISTS (SELECT 1 FROM public.messages t WHERE t.id = p_id)
    WHEN 'collection_item' THEN EXISTS (SELECT 1 FROM public.collection_items t WHERE t.id = p_id)
    WHEN 'folder'          THEN EXISTS (SELECT 1 FROM public.folders t WHERE t.id = p_id)
    ELSE false
  END;
$$;

-- A storage reference, minus its path: which bucket, and whether the object
-- is still there. Paths (which embed account and conversation ids) never
-- leave the database; a later media gate signs by report and position.
CREATE FUNCTION private.moderation_media_ref(p_ref jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_ref IS NULL OR jsonb_typeof(p_ref) <> 'object' THEN NULL
    ELSE jsonb_build_object('bucket', p_ref ->> 'bucket',
      'available', EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = p_ref ->> 'bucket' AND o.name = p_ref ->> 'path'))
  END;
$$;

-- Stored evidence as admins see it: media references without paths.
CREATE FUNCTION private.moderation_evidence_view(p_evidence jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_evidence IS NULL THEN NULL
    ELSE (p_evidence - ARRAY['attachment_ref', 'cover_ref', 'image_refs']) || jsonb_strip_nulls(jsonb_build_object(
      'attachment_ref', private.moderation_media_ref(p_evidence -> 'attachment_ref'),
      'cover_ref', private.moderation_media_ref(p_evidence -> 'cover_ref'),
      'image_refs', CASE WHEN jsonb_typeof(p_evidence -> 'image_refs') = 'array' THEN
        (SELECT COALESCE(jsonb_agg(private.moderation_media_ref(x.e) ORDER BY x.n), '[]'::jsonb)
         FROM jsonb_array_elements(p_evidence -> 'image_refs') WITH ORDINALITY x (e, n)) END))
  END;
$$;

-- The reported row as it is NOW — that row only (for a message: that one
-- message, never its conversation), same bounds as the evidence. NULL when
-- it no longer exists.
CREATE FUNCTION private.moderation_target_current(p_type text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_type = 'profile' THEN
    SELECT jsonb_build_object('username', p.username, 'display_name', private.report_text(p.display_name),
      'bio', private.report_text(p.bio), 'tagline', private.report_text(p.tagline), 'location', private.report_text(p.location),
      'website', private.report_text(p.website), 'avatar_url', private.report_text(p.avatar_url))
      INTO v FROM public.profiles p WHERE p.id = p_id;
  ELSIF p_type = 'post' THEN
    SELECT jsonb_build_object('post_type', p.post_type, 'content', private.report_text(p.content), 'caption', private.report_text(p.caption),
      'image_url', private.report_text(p.image_url), 'repost_of_post_id', p.repost_of_post_id, 'quote_of_post_id', p.quote_of_post_id,
      'created_at', p.created_at)
      INTO v FROM public.posts p WHERE p.id = p_id;
  ELSIF p_type = 'comment' THEN
    SELECT jsonb_build_object('body', private.report_text(c.body), 'post_id', c.post_id, 'created_at', c.created_at)
      INTO v FROM public.comments c WHERE c.id = p_id;
  ELSIF p_type = 'item_comment' THEN
    SELECT jsonb_build_object('body', private.report_text(c.body), 'item_id', c.item_id, 'created_at', c.created_at)
      INTO v FROM public.item_comments c WHERE c.id = p_id;
  ELSIF p_type = 'folder_comment' THEN
    SELECT jsonb_build_object('body', private.report_text(c.body), 'folder_id', c.folder_id, 'created_at', c.created_at)
      INTO v FROM public.folder_comments c WHERE c.id = p_id;
  ELSIF p_type = 'gallery_comment' THEN
    SELECT jsonb_build_object('body', private.report_text(c.body), 'folder_id', c.folder_id,
      'player_key', private.report_text(c.player_key), 'created_at', c.created_at)
      INTO v FROM public.gallery_comments c WHERE c.id = p_id;
  ELSIF p_type = 'message' THEN
    SELECT jsonb_build_object('body', private.report_text(m.body), 'created_at', m.created_at,
      'attachment_type', m.attachment_type, 'attachment_item_id', m.attachment_item_id,
      'attachment_ref', private.moderation_media_ref(CASE WHEN m.attachment_storage_path IS NULL THEN NULL
                          ELSE jsonb_build_object('bucket', 'dm-attachments', 'path', m.attachment_storage_path) END))
      INTO v FROM public.messages m WHERE m.id = p_id;
  ELSIF p_type = 'collection_item' THEN
    SELECT jsonb_build_object('title', private.report_text(ci.title), 'description', private.report_text(ci.description),
      'item_type', ci.item_type, 'is_public', ci.is_public,
      'image_count', (SELECT count(*) FROM public.collection_item_images i WHERE i.item_id = ci.id))
      INTO v FROM public.collection_items ci WHERE ci.id = p_id;
  ELSIF p_type = 'folder' THEN
    SELECT jsonb_build_object('name', private.report_text(f.name), 'description', private.report_text(f.description),
      'is_public', f.is_public, 'has_cover', f.cover_storage_path IS NOT NULL OR f.cover_image_url IS NOT NULL)
      INTO v FROM public.folders f WHERE f.id = p_id;
  END IF;
  RETURN jsonb_strip_nulls(v);
END;
$$;

-- An account as admins see it in the queue: username and lifecycle state.
CREATE FUNCTION private.moderation_account_summary(p_user uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_user IS NULL THEN jsonb_build_object('present', false, 'account_state', 'deleted')
    ELSE jsonb_build_object('present', true,
      'username', (SELECT p.username FROM public.profiles p WHERE p.id = p_user),
      'account_state', COALESCE((SELECT l.state FROM public.account_lifecycle l WHERE l.user_id = p_user), 'active'))
  END;
$$;

-- An admin as other admins see them (claims, history).
CREATE FUNCTION private.moderation_admin_ref(p_user uuid, p_me uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_user IS NULL THEN NULL
    ELSE jsonb_build_object('username', (SELECT p.username FROM public.profiles p WHERE p.id = p_user), 'is_me', p_user = p_me)
  END;
$$;

-- One queue row. Never includes the reporter.
CREATE FUNCTION private.moderation_list_item(r public.content_reports, p_admin uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'target_type', r.target_type, 'reason', r.reason, 'priority', r.priority, 'status', r.status,
    'created_at', r.created_at, 'claimed_at', r.claimed_at,
    'claimed_by_me', COALESCE(r.claimed_by = p_admin, false) AND r.claimed_at IS NOT NULL,
    'reviewed_at', r.reviewed_at, 'resolution', r.resolution, 'resolution_reason', r.resolution_reason,
    'has_details', r.details IS NOT NULL,
    'excerpt', left(COALESCE(r.evidence ->> 'content', r.evidence ->> 'body', r.evidence ->> 'caption', r.evidence ->> 'title',
                             r.evidence ->> 'name', r.evidence ->> 'bio', r.evidence ->> 'display_name', r.evidence ->> 'username'), 140),
    'evidence_available', r.evidence IS NOT NULL,
    'target_exists', private.moderation_target_exists(r.target_type, r.target_id),
    'owner', private.moderation_account_summary(r.target_owner_id),
    'other_pending_on_target', (SELECT count(*) FROM public.content_reports o
                                WHERE o.target_type = r.target_type AND o.target_id = r.target_id
                                  AND o.id <> r.id AND o.status IN ('open', 'reviewing')));
$$;

-- Writes one audit row (the insert trigger re-checks the actor).
CREATE FUNCTION private.log_moderation_action(p_admin uuid, r public.content_reports, p_action text, p_to_status text,
                                              p_outcome text, p_reason text, p_note text, p_metadata jsonb)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  INSERT INTO public.moderation_actions (admin_id, report_id, action, target_type, target_id, target_owner_id,
                                         from_status, to_status, outcome, reason_code, note, metadata)
  VALUES (p_admin, r.id, p_action, r.target_type, r.target_id, r.target_owner_id,
          r.status, p_to_status, p_outcome, p_reason, p_note, COALESCE(p_metadata, '{}'::jsonb));
$$;

-- administrative_closure reasons that state a fact must be true.
CREATE FUNCTION private.moderation_check_closure(r public.content_reports, p_reason text)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_reason = 'target_deleted' AND private.moderation_target_exists(r.target_type, r.target_id) THEN
    RAISE EXCEPTION 'target_still_exists' USING ERRCODE = 'PT409';
  END IF;
  IF p_reason = 'account_deleted' AND r.target_owner_id IS NOT NULL THEN
    RAISE EXCEPTION 'account_still_exists' USING ERRCODE = 'PT409';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.moderation_reason_valid(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.moderation_note(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.moderation_claim_is_stale(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.moderation_target_exists(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.moderation_media_ref(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.moderation_evidence_view(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.moderation_target_current(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.moderation_account_summary(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.moderation_admin_ref(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.moderation_list_item(public.content_reports, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.log_moderation_action(uuid, public.content_reports, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.moderation_check_closure(public.content_reports, text) FROM PUBLIC, anon, authenticated;

-- ── 5. Queue ────────────────────────────────────────────────────────────────
-- Pending (open/reviewing): urgent first, then oldest first. Resolved
-- (actioned/dismissed): most recently resolved first. A page may not mix
-- the two. Keyset pagination: pass back next_cursor unchanged.
CREATE FUNCTION public.admin_list_reports(
  p_statuses    text[]  DEFAULT ARRAY['open', 'reviewing'],
  p_priority    text    DEFAULT NULL,
  p_target_type text    DEFAULT NULL,
  p_limit       integer DEFAULT 25,
  p_cursor      jsonb   DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin   uuid := private.require_admin();
  v_pending boolean;
  v_rank    integer;
  v_t       timestamptz;
  v_id      uuid;
  v_items   jsonb;
  v_last    jsonb;
  v_next    jsonb := NULL;
BEGIN
  IF p_statuses IS NULL OR cardinality(p_statuses) NOT BETWEEN 1 AND 4 OR array_position(p_statuses, NULL) IS NOT NULL
     OR NOT (p_statuses <@ ARRAY['open', 'reviewing', 'actioned', 'dismissed']) THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  IF p_statuses <@ ARRAY['open', 'reviewing'] THEN
    v_pending := true;
  ELSIF p_statuses <@ ARRAY['actioned', 'dismissed'] THEN
    v_pending := false;
  ELSE
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  IF p_priority IS NOT NULL AND p_priority NOT IN ('normal', 'urgent') THEN
    RAISE EXCEPTION 'invalid_priority' USING ERRCODE = '22023';
  END IF;
  IF p_target_type IS NOT NULL AND p_target_type NOT IN ('profile', 'post', 'comment', 'item_comment', 'folder_comment',
                                                          'gallery_comment', 'message', 'collection_item', 'folder') THEN
    RAISE EXCEPTION 'invalid_target_type' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  IF p_cursor IS NOT NULL THEN
    BEGIN
      v_t := (p_cursor ->> 't')::timestamptz;
      v_id := (p_cursor ->> 'id')::uuid;
      v_rank := (p_cursor ->> 'r')::integer;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_cursor' USING ERRCODE = '22023';
    END;
    IF jsonb_typeof(p_cursor) <> 'object' OR v_t IS NULL OR v_id IS NULL
       OR (v_pending AND v_rank IS DISTINCT FROM 0 AND v_rank IS DISTINCT FROM 1) OR (NOT v_pending AND v_rank IS NOT NULL) THEN
      RAISE EXCEPTION 'invalid_cursor' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_pending THEN
    SELECT COALESCE(jsonb_agg(private.moderation_list_item(q.rep, v_admin) ORDER BY q.rk, q.created_at, q.id), '[]'::jsonb)
      INTO v_items
      FROM (SELECT c AS rep, (c.priority <> 'urgent')::integer AS rk, c.created_at, c.id
              FROM public.content_reports c
             WHERE c.status = ANY (p_statuses)
               AND (p_priority IS NULL OR c.priority = p_priority)
               AND (p_target_type IS NULL OR c.target_type = p_target_type)
               AND (p_cursor IS NULL OR ((c.priority <> 'urgent')::integer, c.created_at, c.id) > (v_rank, v_t, v_id))
             ORDER BY 2, 3, 4
             LIMIT p_limit + 1) q;
  ELSE
    SELECT COALESCE(jsonb_agg(private.moderation_list_item(q.rep, v_admin) ORDER BY q.reviewed_at DESC, q.id DESC), '[]'::jsonb)
      INTO v_items
      FROM (SELECT c AS rep, c.reviewed_at, c.id
              FROM public.content_reports c
             WHERE c.status = ANY (p_statuses)
               AND (p_priority IS NULL OR c.priority = p_priority)
               AND (p_target_type IS NULL OR c.target_type = p_target_type)
               AND (p_cursor IS NULL OR (c.reviewed_at, c.id) < (v_t, v_id))
             ORDER BY 2 DESC, 3 DESC
             LIMIT p_limit + 1) q;
  END IF;

  IF jsonb_array_length(v_items) > p_limit THEN
    v_items := v_items - p_limit;                 -- drop the look-ahead row
    v_last := v_items -> (p_limit - 1);
    v_next := CASE WHEN v_pending
      THEN jsonb_build_object('r', CASE WHEN v_last ->> 'priority' = 'urgent' THEN 0 ELSE 1 END,
                              't', v_last -> 'created_at', 'id', v_last -> 'id')
      ELSE jsonb_build_object('t', v_last -> 'reviewed_at', 'id', v_last -> 'id') END;
  END IF;
  RETURN jsonb_build_object('items', v_items, 'next_cursor', v_next);
END;
$$;

-- Badge counts and ages; no identities, no content.
CREATE FUNCTION public.admin_report_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  RETURN (
    SELECT jsonb_build_object(
      'open', count(*) FILTER (WHERE c.status = 'open'),
      'reviewing', count(*) FILTER (WHERE c.status = 'reviewing'),
      'urgent_pending', count(*) FILTER (WHERE c.priority = 'urgent'),
      'claimed_by_me', count(*) FILTER (WHERE c.status = 'reviewing' AND c.claimed_by = v_admin),
      'oldest_pending_at', min(c.created_at),
      'oldest_open_at', min(c.created_at) FILTER (WHERE c.status = 'open'),
      'oldest_urgent_pending_at', min(c.created_at) FILTER (WHERE c.priority = 'urgent'))
    FROM public.content_reports c
    WHERE c.status IN ('open', 'reviewing'));
END;
$$;

-- One report: what was reported (stored evidence), what it looks like now,
-- the reported account, prior reports on the same content and account, and
-- the audit history. Nothing about the reporter but whether they still
-- exist; nothing beyond the one reported row.
CREATE FUNCTION public.admin_get_report(p_report_id uuid)
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

-- ── 6. Status changes ───────────────────────────────────────────────────────
--   open ──claim──▶ reviewing ──release──▶ open
--   open | reviewing (mine or stale) ──resolve──▶ dismissed
--   dismissed ──reopen──▶ open   (evidence intact, before its purge date)
-- Each locks the report row first, so concurrent admins serialize: the
-- second claimant sees 'reviewing' and gets claimed_by_other. A retry of a
-- change that already happened returns changed=false and writes nothing.

CREATE FUNCTION public.admin_claim_report(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin    uuid := private.require_admin();
  r          public.content_reports;
  v_takeover boolean := false;
BEGIN
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.status = 'reviewing' THEN
    IF r.claimed_by = v_admin THEN
      RETURN jsonb_build_object('id', r.id, 'status', r.status, 'changed', false);
    END IF;
    IF NOT private.moderation_claim_is_stale(r.claimed_by, r.claimed_at) THEN
      RAISE EXCEPTION 'claimed_by_other' USING ERRCODE = 'PT409';
    END IF;
    v_takeover := true;
  ELSIF r.status <> 'open' THEN
    RAISE EXCEPTION 'already_resolved' USING ERRCODE = 'PT409';
  END IF;

  UPDATE public.content_reports SET status = 'reviewing', claimed_by = v_admin, claimed_at = now() WHERE id = r.id;
  PERFORM private.log_moderation_action(v_admin, r, 'claim', 'reviewing', NULL, NULL, NULL,
    CASE WHEN v_takeover THEN jsonb_build_object('took_over_stale_claim', true) END);
  RETURN jsonb_build_object('id', r.id, 'status', 'reviewing', 'changed', true);
END;
$$;

CREATE FUNCTION public.admin_release_report(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  r       public.content_reports;
  v_stale boolean;
BEGIN
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.status = 'open' THEN
    RETURN jsonb_build_object('id', r.id, 'status', r.status, 'changed', false);
  ELSIF r.status <> 'reviewing' THEN
    RAISE EXCEPTION 'already_resolved' USING ERRCODE = 'PT409';
  END IF;
  v_stale := r.claimed_by IS DISTINCT FROM v_admin;
  IF v_stale AND NOT private.moderation_claim_is_stale(r.claimed_by, r.claimed_at) THEN
    RAISE EXCEPTION 'claimed_by_other' USING ERRCODE = 'PT409';
  END IF;

  UPDATE public.content_reports SET status = 'open', claimed_by = NULL, claimed_at = NULL WHERE id = r.id;
  PERFORM private.log_moderation_action(v_admin, r, 'release', 'open', NULL, NULL, NULL,
    CASE WHEN v_stale THEN jsonb_build_object('released_stale_claim', true) END);
  RETURN jsonb_build_object('id', r.id, 'status', 'open', 'changed', true);
END;
$$;

-- Resolves (dismisses) a report with an outcome that needs no enforcement.
-- p_include_related also resolves the other unclaimed (or mine) pending
-- reports on the same content, each with its own audit row; reports another
-- admin is working on, or that are locked right now, are left alone.
-- Evidence becomes purgeable 90 days after resolution (no purge job yet).
CREATE FUNCTION public.admin_resolve_report(
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
  -- content_hidden / content_removed / account_suspended are refused here:
  -- they arrive with the enforcement that makes them true (M2/M3).
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

-- Back to the queue — only a dismissed report (reopening an actioned one
-- would need its enforcement reversed: M2/M3), only while its evidence is
-- intact and before its purge date. The retention clock stops until the
-- report is resolved again.
CREATE FUNCTION public.admin_reopen_report(p_report_id uuid, p_reason_code text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  r       public.content_reports;
  v_note  text;
BEGIN
  IF NOT private.moderation_reason_valid('reopen', p_reason_code) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
  v_note := private.moderation_note(p_note);

  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.status IN ('open', 'reviewing') THEN
    RAISE EXCEPTION 'not_resolved' USING ERRCODE = 'PT409';
  ELSIF r.status = 'actioned' THEN
    RAISE EXCEPTION 'reopen_not_supported' USING ERRCODE = 'PT409';
  END IF;
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
    -- The same reporter has since filed a new open report on this content.
    RAISE EXCEPTION 'duplicate_open_report' USING ERRCODE = 'PT409';
  END;
  PERFORM private.log_moderation_action(v_admin, r, 'reopen', 'open', NULL, p_reason_code, v_note,
    jsonb_build_object('previous_outcome', r.resolution, 'previous_reason', r.resolution_reason));
  RETURN jsonb_build_object('id', r.id, 'status', 'open', 'changed', true);
END;
$$;

-- ── 7. Privileges ───────────────────────────────────────────────────────────
-- Signed-in callers only (each function checks admin_users itself); never
-- signed-out callers. The service role has no admin identity (auth.uid() is
-- NULL), so it is not granted either.
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.admin_list_reports(text[], text, text, integer, jsonb)',
    'public.admin_report_counts()',
    'public.admin_get_report(uuid)',
    'public.admin_claim_report(uuid)',
    'public.admin_release_report(uuid)',
    'public.admin_resolve_report(uuid, text, text, text, boolean)',
    'public.admin_reopen_report(uuid, text, text)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
