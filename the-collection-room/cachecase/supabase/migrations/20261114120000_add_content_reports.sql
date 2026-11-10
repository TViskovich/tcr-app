-- ============================================================================
-- Content reporting — App Store moderation Phase 2A, Gate 1 (database only).
--
-- A signed-in collector can report a profile, post, comment/reply, item,
-- collection or gallery comment, direct message, collection item or folder
-- they can see. Reports are write-only for collectors: nobody but trusted
-- server code (and, later, admin-only functions) can read them, so a
-- reported collector never learns who reported them — or that they were.
--
--   public.submit_report(type, id, reason, details)  SECURITY INVOKER
--     1. Reads the target UNDER THE CALLER'S RLS — the same privacy, block
--        and account-lifecycle rules the app sees. Anything the caller can't
--        see (fabricated, private, hidden, deleted) is a neutral not_found.
--     2. Hands off to private.file_content_report (SECURITY DEFINER, not
--        reachable through the API), which re-derives the owner and the
--        evidence from trusted rows, re-checks visibility itself (so a
--        direct call can't forge or bypass anything), applies duplicate
--        protection and rate limits under a per-reporter lock, and inserts.
--     Returns only {status: 'received', already_reported}.
--
-- Evidence: a bounded snapshot of ONLY the reported content (text ≤ 2,000
-- characters per field; media as storage references, never copies or URLs
-- to private files; for a message, that one message — not the
-- conversation). Immutable: it can only be purged (set to NULL) once its
-- retention date has passed, and only by trusted server code.
--
-- Retention: evidence_purge_after is set when a report is resolved (future
-- admin queue: resolution + 90 days). No cleanup job is created here.
-- Legal hold (future, not built): see section 6.
--
-- Deletion: reports outlive the reported content (no FK on target_id) and
-- both accounts (reporter/owner/reviewer ids → NULL), keeping the snapshot.
-- No notifications are created for anyone.
-- ============================================================================

-- ── 1. Table ────────────────────────────────────────────────────────────────
CREATE TABLE public.content_reports (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id           uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  target_type           text        NOT NULL CHECK (target_type IN (
                          'profile', 'post', 'comment', 'item_comment', 'folder_comment',
                          'gallery_comment', 'message', 'collection_item', 'folder')),
  target_id             uuid        NOT NULL,          -- no FK: reports outlive their content
  target_owner_id       uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  reason                text        NOT NULL CHECK (reason IN (
                          'spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm',
                          'child_safety', 'scam_fraud', 'impersonation', 'intellectual_property', 'other')),
  details               text        CHECK (details IS NULL OR char_length(details) BETWEEN 1 AND 500),
  evidence              jsonb       CHECK (evidence IS NULL OR (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 16384)),
  priority              text        NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  status                text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'actioned', 'dismissed')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  reviewed_at           timestamptz,
  reviewed_by           uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  evidence_purge_after  timestamptz,                   -- set on resolution (future: + 90 days)
  evidence_purged_at    timestamptz,
  CONSTRAINT content_reports_resolution_shape
    CHECK ((status IN ('actioned', 'dismissed')) = (reviewed_at IS NOT NULL) OR status = 'reviewing'),
  CONSTRAINT content_reports_purge_shape
    CHECK (evidence_purged_at IS NULL OR evidence IS NULL)
);

-- Admin queue (future): open/urgent first.
CREATE INDEX content_reports_queue_idx ON public.content_reports (status, priority, created_at);
CREATE INDEX content_reports_target_idx ON public.content_reports (target_type, target_id);
CREATE INDEX content_reports_owner_idx ON public.content_reports (target_owner_id, created_at);
-- Rate limits and duplicate checks.
CREATE INDEX content_reports_reporter_idx ON public.content_reports (reporter_id, created_at);
-- One open report per reporter and target (backstop for the duplicate check).
CREATE UNIQUE INDEX content_reports_one_open_per_reporter ON public.content_reports (reporter_id, target_type, target_id)
  WHERE status IN ('open', 'reviewing') AND reporter_id IS NOT NULL;

ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;
-- No client access of any kind: no policies, no privileges. (This
-- project's public schema grants clients full privileges by default.)
REVOKE ALL ON public.content_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.content_reports TO service_role;

-- Account-lifecycle compatibility (every public table carries both; see
-- supabase/tests/database/account_lifecycle.test.sql).
CREATE POLICY account_lifecycle_read_guard ON public.content_reports AS RESTRICTIVE
  FOR SELECT TO public
  USING (NOT (SELECT private.caller_is_hidden()));
CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.content_reports
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write();

-- ── 2. Immutability ─────────────────────────────────────────────────────────
-- What was reported, by whom and why never changes. Account deletion may
-- null the account ids (ON DELETE SET NULL); evidence may only be purged
-- (→ NULL) once evidence_purge_after has passed. Status and review fields
-- are for the future admin queue. Deleting a report is server-only.
CREATE FUNCTION private.content_reports_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF auth.uid() IS NOT NULL THEN
      RAISE EXCEPTION 'content_report_immutable' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.details IS DISTINCT FROM OLD.details
     OR NEW.priority IS DISTINCT FROM OLD.priority
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.reporter_id IS DISTINCT FROM OLD.reporter_id AND NEW.reporter_id IS NOT NULL)
     OR (NEW.target_owner_id IS DISTINCT FROM OLD.target_owner_id AND NEW.target_owner_id IS NOT NULL) THEN
    RAISE EXCEPTION 'content_report_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.evidence IS DISTINCT FROM OLD.evidence THEN
    IF NEW.evidence IS NOT NULL OR OLD.evidence_purge_after IS NULL OR OLD.evidence_purge_after > now() THEN
      RAISE EXCEPTION 'content_report_evidence_immutable' USING ERRCODE = '42501';
    END IF;
    NEW.evidence_purged_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.content_reports_guard_update() FROM PUBLIC;

CREATE TRIGGER content_reports_immutable BEFORE UPDATE OR DELETE ON public.content_reports
  FOR EACH ROW EXECUTE FUNCTION private.content_reports_guard_update();

-- ── 3. Evidence and filing (trusted server code) ───────────────────────────
-- Bounded text: at most 2,000 characters per field.
CREATE FUNCTION private.report_text(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_value IS NULL THEN NULL ELSE left(p_value, 2000) END;
$$;
REVOKE ALL ON FUNCTION private.report_text(text) FROM PUBLIC;

-- Re-derives the owner and the evidence from trusted rows, re-checks that
-- the reporter may see the target (so it can't be used to bypass
-- submit_report), then applies duplicate protection and rate limits under a
-- per-reporter lock and inserts. Not reachable through the API (private
-- schema); EXECUTE is granted to authenticated only because the
-- SECURITY INVOKER submit_report calls it as the caller.
CREATE FUNCTION private.file_content_report(p_target_type text, p_target_id uuid, p_reason text, p_details text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reporter uuid := auth.uid();
  v_owner    uuid;
  v_parent   uuid;
  v_evidence jsonb;
  v_visible  boolean := false;
  v_priority text;
  v_details  text := NULLIF(btrim(COALESCE(p_details, '')), '');
  v_row      record;
BEGIN
  IF v_reporter IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_target_type IS NULL OR p_target_type NOT IN ('profile', 'post', 'comment', 'item_comment', 'folder_comment',
                                                     'gallery_comment', 'message', 'collection_item', 'folder') THEN
    RAISE EXCEPTION 'invalid_target_type' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm',
                                           'child_safety', 'scam_fraud', 'impersonation', 'intellectual_property', 'other') THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;
  IF v_details IS NOT NULL AND char_length(v_details) > 500 THEN
    RAISE EXCEPTION 'details_too_long' USING ERRCODE = '22023';
  END IF;
  IF p_target_id IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF private.account_is_hidden(v_reporter) THEN
    RAISE EXCEPTION 'account_inactive' USING ERRCODE = '42501';
  END IF;

  -- Owner, evidence and an independent visibility check per type.
  IF p_target_type = 'profile' THEN
    SELECT p.id, p.username, p.display_name, p.bio, p.tagline, p.location, p.website, p.avatar_url
      INTO v_row FROM public.profiles p WHERE p.id = p_target_id;
    IF FOUND THEN
      v_owner := v_row.id;
      -- The profile owner must not have blocked the reporter (one-directional rule).
      v_visible := NOT EXISTS (SELECT 1 FROM public.user_blocks b WHERE b.blocker_id = v_owner AND b.blocked_id = v_reporter);
      v_evidence := jsonb_build_object('username', v_row.username, 'display_name', private.report_text(v_row.display_name),
        'bio', private.report_text(v_row.bio), 'tagline', private.report_text(v_row.tagline),
        'location', private.report_text(v_row.location), 'website', private.report_text(v_row.website),
        'avatar_url', private.report_text(v_row.avatar_url));
    END IF;
  ELSIF p_target_type = 'post' THEN
    SELECT p.user_id, p.post_type, p.content, p.caption, p.image_url, p.repost_of_post_id, p.quote_of_post_id, p.created_at
      INTO v_row FROM public.posts p WHERE p.id = p_target_id;
    IF FOUND THEN
      v_owner := v_row.user_id;
      v_visible := NOT private.users_blocked(v_reporter, v_owner);
      v_evidence := jsonb_build_object('post_type', v_row.post_type, 'content', private.report_text(v_row.content),
        'caption', private.report_text(v_row.caption), 'image_url', private.report_text(v_row.image_url),
        'repost_of_post_id', v_row.repost_of_post_id, 'quote_of_post_id', v_row.quote_of_post_id, 'created_at', v_row.created_at);
    END IF;
  ELSIF p_target_type = 'comment' THEN
    SELECT c.user_id, c.post_id, c.body, c.created_at, p.user_id AS post_owner
      INTO v_row FROM public.comments c JOIN public.posts p ON p.id = c.post_id WHERE c.id = p_target_id;
    IF FOUND THEN
      v_owner := v_row.user_id;
      v_visible := NOT private.users_blocked(v_reporter, v_owner) AND NOT private.users_blocked(v_reporter, v_row.post_owner)
        AND NOT private.account_is_hidden(v_row.post_owner);
      v_evidence := jsonb_build_object('body', private.report_text(v_row.body), 'post_id', v_row.post_id, 'created_at', v_row.created_at);
    END IF;
  ELSIF p_target_type = 'item_comment' THEN
    SELECT c.user_id, c.item_id, c.body, c.created_at INTO v_row FROM public.item_comments c WHERE c.id = p_target_id;
    IF FOUND THEN
      v_owner := v_row.user_id;
      v_parent := v_row.item_id;
      v_visible := public._item_visible_to(v_parent, v_reporter) AND NOT private.users_blocked(v_reporter, v_owner)
        AND NOT private.users_blocked(v_reporter, (SELECT ci.user_id FROM public.collection_items ci WHERE ci.id = v_parent));
      v_evidence := jsonb_build_object('body', private.report_text(v_row.body), 'item_id', v_row.item_id, 'created_at', v_row.created_at);
    END IF;
  ELSIF p_target_type IN ('folder_comment', 'gallery_comment') THEN
    IF p_target_type = 'folder_comment' THEN
      SELECT c.user_id, c.folder_id, c.body, c.created_at, NULL::text AS player_key INTO v_row FROM public.folder_comments c WHERE c.id = p_target_id;
    ELSE
      SELECT c.user_id, c.folder_id, c.body, c.created_at, c.player_key INTO v_row FROM public.gallery_comments c WHERE c.id = p_target_id;
    END IF;
    IF FOUND THEN
      v_owner := v_row.user_id;
      v_parent := v_row.folder_id;
      v_visible := public._folder_visible_to(v_parent, v_reporter) AND NOT private.users_blocked(v_reporter, v_owner)
        AND NOT private.users_blocked(v_reporter, (SELECT f.user_id FROM public.folders f WHERE f.id = v_parent));
      v_evidence := jsonb_build_object('body', private.report_text(v_row.body), 'folder_id', v_row.folder_id,
        'player_key', private.report_text(v_row.player_key), 'created_at', v_row.created_at);
    END IF;
  ELSIF p_target_type = 'message' THEN
    SELECT m.sender_id, m.conversation_id, m.body, m.created_at, m.attachment_type, m.attachment_item_id, m.attachment_storage_path
      INTO v_row FROM public.messages m WHERE m.id = p_target_id;
    IF FOUND THEN
      v_owner := v_row.sender_id;
      -- Participants only, conversation not hidden; blocking does NOT
      -- prevent reporting history. Only this one message is captured, and
      -- not the conversation id.
      v_visible := public.is_conversation_participant(v_row.conversation_id, v_reporter)
        AND NOT COALESCE(v_row.conversation_id = ANY (private.hidden_conversation_ids()), false);
      v_evidence := jsonb_build_object('body', private.report_text(v_row.body), 'created_at', v_row.created_at,
        'attachment_type', v_row.attachment_type, 'attachment_item_id', v_row.attachment_item_id,
        'attachment_ref', CASE WHEN v_row.attachment_storage_path IS NULL THEN NULL
                               ELSE jsonb_build_object('bucket', 'dm-attachments', 'path', private.report_text(v_row.attachment_storage_path)) END);
    END IF;
  ELSIF p_target_type = 'collection_item' THEN
    SELECT ci.user_id, ci.title, ci.description, ci.item_type, ci.is_public INTO v_row FROM public.collection_items ci WHERE ci.id = p_target_id;
    IF FOUND THEN
      v_owner := v_row.user_id;
      v_visible := public._item_visible_to(p_target_id, v_reporter) AND NOT private.users_blocked(v_reporter, v_owner);
      v_evidence := jsonb_build_object('title', private.report_text(v_row.title), 'description', private.report_text(v_row.description),
        'item_type', v_row.item_type, 'is_public', v_row.is_public,
        'image_refs', (SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', 'item-images', 'path', private.report_text(i.storage_path)) ORDER BY i.sort_order, i.created_at), '[]'::jsonb)
                       FROM (SELECT * FROM public.collection_item_images i WHERE i.item_id = p_target_id ORDER BY i.sort_order, i.created_at LIMIT 10) i));
    END IF;
  ELSIF p_target_type = 'folder' THEN
    SELECT f.user_id, f.name, f.description, f.is_public, f.cover_storage_path INTO v_row FROM public.folders f WHERE f.id = p_target_id;
    IF FOUND THEN
      v_owner := v_row.user_id;
      v_visible := public._folder_visible_to(p_target_id, v_reporter) AND NOT private.users_blocked(v_reporter, v_owner);
      v_evidence := jsonb_build_object('name', private.report_text(v_row.name), 'description', private.report_text(v_row.description),
        'is_public', v_row.is_public,
        'cover_ref', CASE WHEN v_row.cover_storage_path IS NULL THEN NULL
                          ELSE jsonb_build_object('bucket', 'item-images', 'path', private.report_text(v_row.cover_storage_path)) END);
    END IF;
  END IF;

  -- Not found, invisible, or the owner's account is hidden: one neutral answer.
  IF v_owner IS NULL OR NOT COALESCE(v_visible, false) OR private.account_is_hidden(v_owner) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_owner = v_reporter THEN
    RAISE EXCEPTION 'cannot_report_self' USING ERRCODE = '22023';
  END IF;

  -- Duplicates and rate limits, serialized per reporter.
  PERFORM pg_advisory_xact_lock(hashtextextended('content_report:' || v_reporter::text, 0));
  IF EXISTS (SELECT 1 FROM public.content_reports r WHERE r.reporter_id = v_reporter AND r.target_type = p_target_type
               AND r.target_id = p_target_id AND r.status IN ('open', 'reviewing')) THEN
    RETURN jsonb_build_object('status', 'received', 'already_reported', true);
  END IF;
  IF (SELECT count(*) FROM public.content_reports r WHERE r.reporter_id = v_reporter AND r.created_at > now() - interval '10 minutes') >= 5
     OR (SELECT count(*) FROM public.content_reports r WHERE r.reporter_id = v_reporter AND r.created_at > now() - interval '24 hours') >= 20 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
  END IF;

  v_priority := CASE WHEN p_reason IN ('child_safety', 'self_harm', 'violence') THEN 'urgent' ELSE 'normal' END;
  INSERT INTO public.content_reports (reporter_id, target_type, target_id, target_owner_id, reason, details, evidence, priority)
  VALUES (v_reporter, p_target_type, p_target_id, v_owner, p_reason, v_details,
          jsonb_build_object('v', 1, 'captured_at', now()) || jsonb_strip_nulls(v_evidence), v_priority)
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('status', 'received', 'already_reported', NOT FOUND);
END;
$$;
REVOKE ALL ON FUNCTION private.file_content_report(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.file_content_report(text, uuid, text, text) TO authenticated;

-- ── 4. Client entry point ───────────────────────────────────────────────────
-- SECURITY INVOKER: the visibility check is the caller's own RLS view of the
-- target (privacy, blocks, account lifecycle, DM participation). Only then
-- does trusted code file the report.
CREATE FUNCTION public.submit_report(p_target_type text, p_target_id uuid, p_reason text, p_details text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_seen boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  v_seen := CASE p_target_type
    WHEN 'profile'         THEN EXISTS (SELECT 1 FROM public.profiles t WHERE t.id = p_target_id)
    WHEN 'post'            THEN EXISTS (SELECT 1 FROM public.posts t WHERE t.id = p_target_id)
    WHEN 'comment'         THEN EXISTS (SELECT 1 FROM public.comments t WHERE t.id = p_target_id)
    WHEN 'item_comment'    THEN EXISTS (SELECT 1 FROM public.item_comments t WHERE t.id = p_target_id)
    WHEN 'folder_comment'  THEN EXISTS (SELECT 1 FROM public.folder_comments t WHERE t.id = p_target_id)
    WHEN 'gallery_comment' THEN EXISTS (SELECT 1 FROM public.gallery_comments t WHERE t.id = p_target_id)
    WHEN 'message'         THEN EXISTS (SELECT 1 FROM public.messages t WHERE t.id = p_target_id)
    WHEN 'collection_item' THEN EXISTS (SELECT 1 FROM public.collection_items t WHERE t.id = p_target_id)
    WHEN 'folder'          THEN EXISTS (SELECT 1 FROM public.folders t WHERE t.id = p_target_id)
    ELSE NULL
  END;
  IF v_seen IS NULL THEN
    RAISE EXCEPTION 'invalid_target_type' USING ERRCODE = '22023';
  END IF;
  IF NOT v_seen THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN private.file_content_report(p_target_type, p_target_id, p_reason, p_details);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_report(text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_report(text, uuid, text, text) TO authenticated;

-- ── 5. No notifications ─────────────────────────────────────────────────────
-- Nothing here inserts into notifications or calls any delivery path; the
-- reported collector is never told. (Admin alerting is a later gate and
-- will carry counts only.)

-- ── 6. Legal hold (design note — NOT implemented) ───────────────────────────
-- Evidence normally becomes purgeable at evidence_purge_after (set by the
-- future admin queue to resolution + 90 days). Exceptional preservation must
-- not be an open-ended flag. A future migration would add a separate
-- private.content_report_holds table: (report_id, held_by admin, legal basis
-- text, created_at, expires_at — mandatory, bounded, e.g. ≤ 1 year,
-- renewable only by a new audited row), written only through an
-- admin-checked SECURITY DEFINER function that also appends to the
-- moderation audit log. The purge path would skip reports with an
-- unexpired hold; expiry automatically restores normal retention.
