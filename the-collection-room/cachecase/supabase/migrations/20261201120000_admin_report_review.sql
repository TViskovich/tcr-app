-- ============================================================================
-- Administrator report review — Phase 2B M5.1.
--
-- Read-only views and one concurrency-checked entry point for the admin
-- Reports screens (app/admin/reports*, lib/admin-reports*). No new
-- enforcement: nothing here hides, removes, restores, suspends or deletes
-- anything, and no existing function, table or policy is changed.
--
--   admin_report_queue         the queue by view (open, claimed, mine,
--                              reopened, actioned, dismissed), filtered by
--                              content type, reason, priority and age, keyset
--                              paginated. Metadata only: no report text, no
--                              evidence excerpt, no account identities.
--   admin_report_case          admin_get_report (M1/M2.1, unchanged) with
--                              media URLs withheld and the target id
--                              dropped, plus the case facts the screen needs:
--                              version, child safety, legal hold, claim
--                              state, evidence state, reopen count and
--                              which existing actions currently apply.
--   admin_report_case_action   claim | release | dismiss | reopen, but only
--                              if the report is still at the version the
--                              admin was looking at (report_changed
--                              otherwise). It locks the report row and then
--                              calls the EXISTING function, which keeps
--                              every check, transition and audit row of its
--                              own. Dismiss is admin_resolve_report with its
--                              three enforcement-free outcomes only.
--
-- Authorization: each function is SECURITY DEFINER, starts with
-- private.require_admin() (signed in, in admin_users, not suspended, not
-- pending deletion) and is executable by `authenticated` only.
--
-- Reporter privacy: as in M1 — nothing about the reporter except whether
-- the account still exists.
--
-- Errors: as M1, plus
--   22023 invalid_view | invalid_reason | invalid_age | invalid_sort |
--         invalid_action | invalid_version
--   PT409 report_changed
-- ============================================================================

-- ── 1. Helpers (server-only) ────────────────────────────────────────────────
-- Claim position relative to the caller: none | mine | other | stale.
CREATE FUNCTION private.report_review_claim(r public.content_reports, p_admin uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN r.status <> 'reviewing' THEN 'none'
    WHEN r.claimed_by = p_admin THEN 'mine'
    WHEN private.moderation_claim_is_stale(r.claimed_by, r.claimed_at) THEN 'stale'
    ELSE 'other'
  END;
$$;

-- available | purged | missing
CREATE FUNCTION private.report_review_evidence(r public.content_reports)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN r.evidence IS NOT NULL THEN 'available'
              WHEN r.evidence_purged_at IS NOT NULL THEN 'purged'
              ELSE 'missing' END;
$$;

CREATE FUNCTION private.report_review_reopens(p_report_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT count(*)::integer FROM public.moderation_actions a WHERE a.report_id = p_report_id AND a.action = 'reopen';
$$;

-- The case version: updated_at (microseconds; bumped by every report update,
-- including evidence purges) and the number of audit rows (one per case
-- change), so two changes are told apart even within one transaction.
CREATE FUNCTION private.report_review_version(r public.content_reports)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT (extract(epoch FROM r.updated_at) * 1000000)::bigint::text || '.'
      || (SELECT count(*) FROM public.moderation_actions a WHERE a.report_id = r.id)::text;
$$;

-- Top-level *_url values (avatar_url, image_url) are replaced by their key
-- names in withheld_media: the review screens never load media from a URL.
CREATE FUNCTION private.report_review_withhold_urls(p jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) <> 'object' THEN p
    ELSE (SELECT COALESCE(jsonb_object_agg(k, v) FILTER (WHERE k !~ '_url$'), '{}'::jsonb)
                 || CASE WHEN bool_or(k ~ '_url$' AND jsonb_typeof(v) = 'string')
                         THEN jsonb_build_object('withheld_media',
                                jsonb_agg(k ORDER BY k) FILTER (WHERE k ~ '_url$' AND jsonb_typeof(v) = 'string'))
                         ELSE '{}'::jsonb END
            FROM jsonb_each(p) e (k, v))
  END;
$$;

-- One queue row: metadata only.
CREATE FUNCTION private.report_review_row(r public.content_reports, p_admin uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'target_type', r.target_type, 'reason', r.reason, 'priority', r.priority, 'status', r.status,
    'child_safety', private.report_is_child_safety(r.id),
    'created_at', r.created_at, 'claimed_at', r.claimed_at, 'claim', private.report_review_claim(r, p_admin),
    'reviewed_at', r.reviewed_at, 'resolution', r.resolution,
    'reopened', private.report_review_reopens(r.id) > 0,
    'evidence', private.report_review_evidence(r),
    'version', private.report_review_version(r));
$$;

REVOKE ALL ON FUNCTION private.report_review_claim(public.content_reports, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.report_review_evidence(public.content_reports) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.report_review_reopens(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.report_review_version(public.content_reports) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.report_review_withhold_urls(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.report_review_row(public.content_reports, uuid) FROM PUBLIC, anon, authenticated;

-- ── 2. Queue ────────────────────────────────────────────────────────────────
-- Views: open (unclaimed), claimed (anyone), mine, reopened (pending and
-- reopened at least once), actioned, dismissed.
-- Sort: pending views — priority (urgent first, then oldest; default),
-- oldest, newest by submission; resolved views — newest (default) or
-- oldest by resolution time.
-- Age (by submission): under_24h | 1_to_7d | over_7d.
-- Keyset pagination: pass next_cursor back unchanged with the same view,
-- sort and filters. counts (first page only) are pending totals.
CREATE FUNCTION public.admin_report_queue(
  p_view        text    DEFAULT 'open',
  p_target_type text    DEFAULT NULL,
  p_reason      text    DEFAULT NULL,
  p_priority    text    DEFAULT NULL,
  p_age         text    DEFAULT NULL,
  p_sort        text    DEFAULT NULL,
  p_limit       integer DEFAULT 25,
  p_cursor      jsonb   DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin    uuid := private.require_admin();
  v_resolved boolean;
  v_sort     text;
  v_asc      boolean;
  v_lo       timestamptz;
  v_hi       timestamptz;
  v_rank     integer;
  v_t        timestamptz;
  v_id       uuid;
  v_items    jsonb;
  v_last     jsonb;
  v_next     jsonb := NULL;
  v_counts   jsonb := NULL;
BEGIN
  IF p_view IS NULL OR p_view NOT IN ('open', 'claimed', 'mine', 'reopened', 'actioned', 'dismissed') THEN
    RAISE EXCEPTION 'invalid_view' USING ERRCODE = '22023';
  END IF;
  v_resolved := p_view IN ('actioned', 'dismissed');
  IF p_target_type IS NOT NULL AND p_target_type NOT IN ('profile', 'post', 'comment', 'item_comment', 'folder_comment',
                                                          'gallery_comment', 'message', 'collection_item', 'folder') THEN
    RAISE EXCEPTION 'invalid_target_type' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NOT NULL AND p_reason NOT IN ('spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm',
                                                'child_safety', 'scam_fraud', 'impersonation', 'intellectual_property', 'other') THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;
  IF p_priority IS NOT NULL AND p_priority NOT IN ('normal', 'urgent') THEN
    RAISE EXCEPTION 'invalid_priority' USING ERRCODE = '22023';
  END IF;
  IF p_age IS NOT NULL AND p_age NOT IN ('under_24h', '1_to_7d', 'over_7d') THEN
    RAISE EXCEPTION 'invalid_age' USING ERRCODE = '22023';
  END IF;
  v_sort := COALESCE(p_sort, CASE WHEN v_resolved THEN 'newest' ELSE 'priority' END);
  IF v_sort NOT IN ('priority', 'oldest', 'newest') OR (v_resolved AND v_sort = 'priority') THEN
    RAISE EXCEPTION 'invalid_sort' USING ERRCODE = '22023';
  END IF;
  v_asc := v_sort IN ('priority', 'oldest');
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
    IF jsonb_typeof(p_cursor) <> 'object' OR v_t IS NULL OR v_id IS NULL OR v_rank IS NULL
       OR p_cursor ->> 'v' IS DISTINCT FROM p_view OR p_cursor ->> 's' IS DISTINCT FROM v_sort
       OR v_rank NOT IN (0, 1) OR (v_sort <> 'priority' AND v_rank <> 0) THEN
      RAISE EXCEPTION 'invalid_cursor' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_lo := CASE p_age WHEN '1_to_7d' THEN now() - interval '7 days' WHEN 'under_24h' THEN now() - interval '24 hours' END;
  v_hi := CASE p_age WHEN '1_to_7d' THEN now() - interval '24 hours' WHEN 'over_7d' THEN now() - interval '7 days' END;

  WITH base AS (
    SELECT c AS rep,
           CASE WHEN v_sort = 'priority' THEN (c.priority <> 'urgent')::integer ELSE 0 END AS rk,
           CASE WHEN v_resolved THEN c.reviewed_at ELSE c.created_at END AS t,
           c.id
      FROM public.content_reports c
     WHERE CASE p_view
             WHEN 'open'      THEN c.status = 'open'
             WHEN 'claimed'   THEN c.status = 'reviewing'
             WHEN 'mine'      THEN c.status = 'reviewing' AND c.claimed_by = v_admin
             WHEN 'reopened'  THEN c.status IN ('open', 'reviewing')
                                   AND EXISTS (SELECT 1 FROM public.moderation_actions a WHERE a.report_id = c.id AND a.action = 'reopen')
             WHEN 'actioned'  THEN c.status = 'actioned'
             WHEN 'dismissed' THEN c.status = 'dismissed'
           END
       AND (p_target_type IS NULL OR c.target_type = p_target_type)
       AND (p_reason IS NULL OR c.reason = p_reason)
       AND (p_priority IS NULL OR c.priority = p_priority)
       AND (v_lo IS NULL OR c.created_at >= v_lo)
       AND (v_hi IS NULL OR c.created_at < v_hi)
  ), page AS (
    SELECT * FROM base b
     WHERE v_asc AND (p_cursor IS NULL OR (b.rk, b.t, b.id) > (v_rank, v_t, v_id))
     ORDER BY b.rk, b.t, b.id
     LIMIT p_limit + 1
  ), page_desc AS (
    SELECT * FROM base b
     WHERE NOT v_asc AND (p_cursor IS NULL OR (b.rk, b.t, b.id) < (v_rank, v_t, v_id))
     ORDER BY b.rk DESC, b.t DESC, b.id DESC
     LIMIT p_limit + 1
  )
  SELECT COALESCE(jsonb_agg(private.report_review_row(x.rep, v_admin) || jsonb_build_object('_k', jsonb_build_object('r', x.rk, 't', x.t))
                            ORDER BY x.n), '[]'::jsonb)
    INTO v_items
    FROM (SELECT p.*, row_number() OVER (ORDER BY p.rk, p.t, p.id) AS n FROM page p
          UNION ALL
          SELECT d.*, row_number() OVER (ORDER BY d.rk DESC, d.t DESC, d.id DESC) AS n FROM page_desc d) x;

  IF jsonb_array_length(v_items) > p_limit THEN
    v_items := v_items - p_limit;                 -- drop the look-ahead row
    v_last := v_items -> (p_limit - 1);
    v_next := jsonb_build_object('v', p_view, 's', v_sort, 'r', v_last -> '_k' -> 'r', 't', v_last -> '_k' -> 't', 'id', v_last -> 'id');
  END IF;
  SELECT COALESCE(jsonb_agg(e - '_k' ORDER BY n), '[]'::jsonb) INTO v_items
    FROM jsonb_array_elements(v_items) WITH ORDINALITY x (e, n);

  IF p_cursor IS NULL THEN
    SELECT jsonb_build_object(
        'open', count(*) FILTER (WHERE c.status = 'open'),
        'claimed', count(*) FILTER (WHERE c.status = 'reviewing'),
        'mine', count(*) FILTER (WHERE c.status = 'reviewing' AND c.claimed_by = v_admin),
        'reopened', count(*) FILTER (WHERE private.report_review_reopens(c.id) > 0),
        'urgent', count(*) FILTER (WHERE c.priority = 'urgent'),
        'child_safety', count(*) FILTER (WHERE private.report_is_child_safety(c.id)))
      INTO v_counts
      FROM public.content_reports c
     WHERE c.status IN ('open', 'reviewing');
  END IF;
  RETURN jsonb_build_object('items', v_items, 'next_cursor', v_next, 'counts', v_counts);
END;
$$;

-- ── 3. Case ─────────────────────────────────────────────────────────────────
-- admin_get_report (unchanged: it re-checks the admin and raises not_found)
-- minus media URLs and the target id, plus the case facts. `can` and
-- `blocked` are hints for the screen; each action re-checks on the server.
CREATE FUNCTION public.admin_report_case(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin    uuid := private.require_admin();
  v          jsonb := public.admin_get_report(p_report_id);
  r          public.content_reports;
  v_claim    text;
  v_evidence text;
  v_restrict boolean;
  v_reopen   text := NULL;
  v_dismiss  text := NULL;
BEGIN
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  v_claim := private.report_review_claim(r, v_admin);
  v_evidence := private.report_review_evidence(r);
  v_restrict := (private.active_moderation_of(r.moderation_id)).id IS NOT NULL;

  IF r.status IN ('open', 'reviewing') THEN
    v_reopen := 'not_resolved';
    IF v_restrict THEN v_dismiss := 'content_moderated';
    ELSIF v_claim = 'other' THEN v_dismiss := 'claimed_by_other';
    ELSIF v_claim <> 'mine' THEN v_dismiss := 'claim_first';
    END IF;
  ELSE
    v_dismiss := 'already_resolved';
    IF r.status = 'actioned' THEN v_reopen := 'reopen_not_supported';
    ELSIF v_evidence <> 'available' THEN v_reopen := 'evidence_unavailable';
    ELSIF r.evidence_purge_after IS NOT NULL AND r.evidence_purge_after <= now() THEN v_reopen := 'retention_expired';
    END IF;
  END IF;

  v := jsonb_set(v, '{report}', (v -> 'report') - 'target_id');
  v := jsonb_set(v, '{evidence}', COALESCE(private.report_review_withhold_urls(v -> 'evidence'), 'null'::jsonb));
  v := jsonb_set(v, '{current,content}', COALESCE(private.report_review_withhold_urls(v -> 'current' -> 'content'), 'null'::jsonb));
  RETURN v || jsonb_build_object('case', jsonb_build_object(
    'version', private.report_review_version(r),
    'child_safety', private.report_is_child_safety(r.id),
    'legal_hold', private.legal_hold_active('report', r.id),
    'claim', v_claim,
    'evidence', v_evidence,
    'reopen_count', private.report_review_reopens(r.id),
    'content_restricted', v_restrict,
    'can', jsonb_build_object(
      'claim', r.status = 'open' OR v_claim = 'stale',
      'release', v_claim IN ('mine', 'stale'),
      'dismiss', v_dismiss IS NULL,
      'reopen', v_reopen IS NULL),
    'blocked', jsonb_strip_nulls(jsonb_build_object('dismiss', v_dismiss, 'reopen', v_reopen))));
END;
$$;

-- ── 4. Version-checked case actions ─────────────────────────────────────────
-- Locks the report, refuses if it changed since p_expected_version (the
-- case's or queue row's `version`), then calls the existing function in
-- the same transaction.
CREATE FUNCTION public.admin_report_case_action(
  p_report_id        uuid,
  p_action           text,
  p_expected_version text,
  p_outcome          text DEFAULT NULL,
  p_reason_code      text DEFAULT NULL,
  p_note             text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  r       public.content_reports;
  v_res   jsonb;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('claim', 'release', 'dismiss', 'reopen') THEN
    RAISE EXCEPTION 'invalid_action' USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL THEN
    RAISE EXCEPTION 'invalid_version' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF private.report_review_version(r) IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'report_changed' USING ERRCODE = 'PT409';
  END IF;

  IF p_action = 'claim' THEN
    v_res := public.admin_claim_report(p_report_id);
  ELSIF p_action = 'release' THEN
    v_res := public.admin_release_report(p_report_id);
  ELSIF p_action = 'dismiss' THEN
    v_res := public.admin_resolve_report(p_report_id, p_outcome, p_reason_code, p_note, false);
  ELSE
    v_res := public.admin_reopen_report(p_report_id, p_reason_code, p_note);
  END IF;

  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  RETURN v_res || jsonb_build_object('version', private.report_review_version(r));
END;
$$;

-- ── 5. Privileges ───────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.admin_report_queue(text, text, text, text, text, text, integer, jsonb)',
    'public.admin_report_case(uuid)',
    'public.admin_report_case_action(uuid, text, text, text, text, text)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
