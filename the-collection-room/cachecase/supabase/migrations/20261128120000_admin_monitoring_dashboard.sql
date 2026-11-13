-- Phase 2B M4 step 5C: administrator monitoring dashboard (read side).
--
-- Read-only, admin-only RPCs for the in-app operations dashboard, built on
-- the existing records (5B monitoring, 5A scheduler runs, M2.3 quarantine
-- jobs, 4B purge runs). Nothing here changes a scheduler, sends anything,
-- approves or executes a purge, or resolves an issue.
--
--   1. private.moderation_monitoring_affected(): the records behind every
--      SQL-detectable condition. moderation_monitoring_evaluate() is
--      redefined as its aggregate, so an issue's count and the list an admin
--      investigates can never disagree.
--   2. admin_moderation_issue_detail / admin_moderation_issue_history:
--      one issue with its lifecycle and the internal references (job, report,
--      purge run or item ids) of the records currently affected; issue
--      history including resolved ones. These references are for admins
--      only — they never appear in alert payloads (5B allow-list).
--   3. admin_media_quarantine_scheduler_runs: recent scheduled runs.
--   4. Per-channel delivery outcomes: moderation_monitoring_record_delivery
--      gains a 4-argument form recording each failed channel's error code
--      even when the other channel delivered; admin_moderation_delivery_history
--      reports them. The 3-argument form is kept (it records no per-channel
--      errors).
--   5. admin_retention_purge_dashboard: purge runs with their effective state
--      (an approval window that has lapsed reads "expired" before the next
--      action closes it), windows, item states and whether the viewer
--      prepared or approved each run. Informational only: approval and
--      execution stay in the 4B RPCs, which re-check everything.
--
-- Every admin RPC calls private.require_admin() (an active admin, not
-- suspended or pending deletion) and is executable by `authenticated` only.
-- No field exposes reporters, collectors, paths, evidence, report text,
-- hashes, notes, recipients, URLs or secrets.

-- ── 1. Affected records ─────────────────────────────────────────────────────
-- ref_kind: quarantine_job | content_report | purge_run | purge_item.
-- detail_code: the job's / item's error code, the report's reason, or the
-- run's category. `since` is the time that ages the record for its condition.
CREATE FUNCTION private.moderation_monitoring_affected()
RETURNS TABLE (code text, ref_kind text, ref_id uuid, since timestamptz, state text, detail_code text, child_safety boolean, attempts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH s AS (SELECT * FROM private.moderation_monitoring_state LIMIT 1),
  q AS (
    SELECT j.*,
           j.desired IN ('quarantine', 'retain') AND j.state IN ('pending', 'copied', 'verified', 'failed') AS unremoved,
           j.source_bucket IN (SELECT b.id FROM storage.buckets b WHERE b.public) AS public_source,
           (j.needs_attention AND j.last_error = ANY (private.moderation_monitoring_integrity_errors())) AS integrity,
           (j.needs_attention AND j.last_error = ANY (private.moderation_monitoring_restore_errors())) AS restore_conflict
      FROM private.media_quarantine j
     WHERE j.state NOT IN ('restored', 'cancelled', 'source_missing') OR j.needs_attention
  ),
  claimable AS (
    SELECT j.id, j.state, j.child_safety, j.attempts,
           GREATEST(j.created_at, COALESCE(j.next_attempt_at, j.created_at), COALESCE(j.lease_expires_at, j.created_at)) AS waiting_since
      FROM private.media_quarantine j
     WHERE NOT j.needs_attention
       AND (j.lease_expires_at IS NULL OR j.lease_expires_at < clock_timestamp())
       AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= clock_timestamp())
       AND ((j.desired IN ('quarantine', 'retain') AND j.state IN ('pending', 'copied', 'verified'))
            OR (j.desired = 'restore' AND j.state IN ('copied', 'verified')))
  ),
  purge_attention AS (
    SELECT i.id, i.run_id, i.updated_at, i.state, i.last_error, i.attempts,
           i.last_error = ANY (private.moderation_monitoring_integrity_errors()) AS integrity
      FROM private.retention_purge_items i WHERE i.state = 'needs_attention'
  )
  SELECT 'child_safety_unquarantined', 'quarantine_job', id, created_at, state, last_error, child_safety, attempts
    FROM q WHERE unremoved AND child_safety AND created_at < clock_timestamp() - interval '5 minutes'
  UNION ALL
  SELECT 'public_removal_overdue', 'quarantine_job', id, created_at, state, last_error, child_safety, attempts
    FROM q WHERE unremoved AND NOT child_safety AND public_source AND created_at < clock_timestamp() - interval '15 minutes'
  UNION ALL
  SELECT 'integrity_failure', 'quarantine_job', id, updated_at, state, last_error, child_safety, attempts FROM q WHERE integrity
  UNION ALL
  SELECT 'integrity_failure', 'purge_item', p.id, p.updated_at, p.state, p.last_error, false, p.attempts FROM purge_attention p WHERE p.integrity
  UNION ALL
  SELECT 'scheduler_stalled', 'quarantine_job', c.id, c.waiting_since, c.state, NULL, c.child_safety, c.attempts
    FROM claimable c
   WHERE private.media_quarantine_scheduler_enabled()
     AND EXISTS (SELECT 1 FROM claimable c2 WHERE c2.waiting_since < clock_timestamp() - interval '10 minutes')
     AND NOT EXISTS (SELECT 1 FROM private.media_quarantine_scheduler_runs r
                      WHERE r.status = 'completed' AND r.finished_at > clock_timestamp() - interval '10 minutes')
  UNION ALL
  SELECT 'quarantine_attempts_exhausted', 'quarantine_job', id, updated_at, state, last_error, child_safety, attempts
    FROM q WHERE needs_attention AND NOT integrity AND NOT restore_conflict
     AND (last_error = 'attempts_exhausted' OR attempts >= private.media_quarantine_max_attempts())
  UNION ALL
  SELECT 'quarantine_needs_attention', 'quarantine_job', id, updated_at, state, last_error, child_safety, attempts
    FROM q WHERE needs_attention AND NOT integrity AND NOT restore_conflict
     AND last_error IS DISTINCT FROM 'attempts_exhausted' AND attempts < private.media_quarantine_max_attempts()
  UNION ALL
  SELECT 'urgent_reports_overdue', 'content_report', r.id, r.created_at, r.status, r.reason, r.reason = 'child_safety', NULL
    FROM public.content_reports r, s
   WHERE r.priority = 'urgent' AND r.status IN ('open', 'reviewing')
     AND r.created_at < clock_timestamp() - make_interval(mins => s.urgent_report_minutes)
  UNION ALL
  SELECT 'restore_conflict', 'quarantine_job', id, updated_at, state, last_error, child_safety, attempts FROM q WHERE restore_conflict
  UNION ALL
  SELECT 'quarantine_lease_stale', 'quarantine_job', id, lease_expires_at, state, last_error, child_safety, attempts
    FROM q WHERE lease_token IS NOT NULL AND NOT child_safety AND lease_expires_at < clock_timestamp() - interval '10 minutes'
  UNION ALL
  SELECT 'purge_approval_pending', 'purge_run', r.id, r.prepared_at, r.status, r.category, false, NULL
    FROM private.retention_purge_runs r WHERE r.status = 'prepared' AND r.approval_expires_at > clock_timestamp()
  UNION ALL
  SELECT 'purge_run_incomplete', 'purge_run', r.id, COALESCE(r.closed_at, r.execution_expires_at), r.status, r.category, false, NULL
    FROM private.retention_purge_runs r
   WHERE (r.status = 'expired' AND r.closed_at > clock_timestamp() - interval '168 hours')
      OR (r.status = 'approved' AND r.execution_expires_at < clock_timestamp())
      OR EXISTS (SELECT 1 FROM purge_attention p WHERE p.run_id = r.id AND NOT p.integrity);
$$;

-- Same contract as 20261127120000 (code, count, oldest), now derived from
-- the affected records.
CREATE OR REPLACE FUNCTION private.moderation_monitoring_evaluate()
RETURNS TABLE (code text, item_count integer, oldest_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT a.code, count(*)::int, min(a.since) FROM private.moderation_monitoring_affected() a GROUP BY a.code;
$$;

-- ── 2. Issues for admins ────────────────────────────────────────────────────
CREATE FUNCTION private.moderation_issue_status(i private.moderation_monitoring_issues)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT CASE WHEN i.resolved_at IS NOT NULL THEN 'resolved' WHEN i.acknowledged_at IS NOT NULL THEN 'acknowledged' ELSE 'active' END $$;

CREATE FUNCTION private.moderation_issue_json(i private.moderation_monitoring_issues)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', i.id, 'code', i.code, 'category', c.category, 'severity', i.severity, 'detection', c.detection,
    'description', c.description, 'admin_ref', c.admin_ref, 'status', private.moderation_issue_status(i),
    'count', i.item_count, 'peak_count', i.peak_count, 'oldest_at', i.oldest_at,
    'opened_at', i.opened_at, 'last_seen_at', i.last_seen_at, 'resolved_at', i.resolved_at,
    'acknowledged_at', i.acknowledged_at, 'acknowledged_by', i.acknowledged_by,
    'notified_at', i.notified_at, 'resolve_notified_at', i.resolve_notified_at,
    'delivery_failures', i.delivery_failures, 'last_delivery_error', i.last_delivery_error, 'last_attempt_at', i.last_attempt_at)
    FROM private.moderation_monitoring_codes c WHERE c.code = i.code;
$$;

-- One issue: its lifecycle, recent history (newest first) and — while it is
-- open — the records currently affected (paged).
CREATE FUNCTION public.admin_moderation_issue_detail(p_issue_id uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  i private.moderation_monitoring_issues;
  v_total integer := 0;
  v_items jsonb := '[]'::jsonb;
BEGIN
  PERFORM private.require_admin();
  IF p_issue_id IS NULL OR p_offset IS NULL OR p_offset < 0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO i FROM private.moderation_monitoring_issues x WHERE x.id = p_issue_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF i.resolved_at IS NULL THEN
    SELECT count(*)::int INTO v_total FROM private.moderation_monitoring_affected() a WHERE a.code = i.code;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('ref_kind', a.ref_kind, 'ref_id', a.ref_id, 'since', a.since, 'state', a.state,
                                                 'detail_code', a.detail_code, 'child_safety', a.child_safety, 'attempts', a.attempts)
                              ORDER BY a.since, a.ref_id), '[]'::jsonb)
      INTO v_items
      FROM (SELECT * FROM private.moderation_monitoring_affected() a WHERE a.code = i.code
             ORDER BY a.since, a.ref_id OFFSET p_offset LIMIT p_limit) a;
  END IF;
  RETURN jsonb_build_object(
    'issue', private.moderation_issue_json(i),
    'affected', jsonb_build_object('live', i.resolved_at IS NULL, 'total', v_total, 'offset', p_offset, 'limit', p_limit, 'items', v_items),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', e.at, 'event', e.event, 'count', e.item_count, 'notice_kind', e.notice_kind,
                                                           'error_code', e.error_code, 'actor_id', e.actor_id) ORDER BY e.id DESC)
                          FROM (SELECT * FROM private.moderation_monitoring_events e WHERE e.issue_id = i.id ORDER BY e.id DESC LIMIT 100) e), '[]'::jsonb));
END;
$$;

-- Issues by status, newest first; p_before pages on opened_at.
CREATE FUNCTION public.admin_moderation_issue_history(p_status text DEFAULT 'resolved', p_limit integer DEFAULT 25, p_before timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_items jsonb;
  v_last timestamptz;
BEGIN
  PERFORM private.require_admin();
  IF p_status IS NULL OR p_status NOT IN ('active', 'acknowledged', 'resolved', 'all') OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(jsonb_agg(private.moderation_issue_json(x) ORDER BY x.opened_at DESC, x.id), '[]'::jsonb), min(x.opened_at)
    INTO v_items, v_last
    FROM (SELECT * FROM private.moderation_monitoring_issues i
           WHERE (p_status = 'all' OR private.moderation_issue_status(i) = p_status)
             AND (p_before IS NULL OR i.opened_at < p_before)
           ORDER BY i.opened_at DESC, i.id LIMIT p_limit) x;
  RETURN jsonb_build_object('items', v_items,
                            'next_before', CASE WHEN jsonb_array_length(v_items) = p_limit THEN v_last END);
END;
$$;

-- ── 3. Scheduler runs ───────────────────────────────────────────────────────
CREATE FUNCTION public.admin_media_quarantine_scheduler_runs(p_limit integer DEFAULT 25, p_before timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_items jsonb;
  v_last timestamptz;
BEGIN
  PERFORM private.require_admin();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', r.id, 'trigger', r.trigger,
           -- a run still "running" past the stale threshold has died
           'status', CASE WHEN r.status = 'running' AND r.started_at < clock_timestamp() - private.media_quarantine_scheduler_stale_after()
                          THEN 'stale' ELSE r.status END,
           'started_at', r.started_at, 'finished_at', r.finished_at, 'jobs', r.jobs, 'outcomes', r.outcomes,
           'error_code', r.error_code, 'duration_ms', r.duration_ms) ORDER BY r.started_at DESC, r.id), '[]'::jsonb),
         min(r.started_at)
    INTO v_items, v_last
    FROM (SELECT * FROM private.media_quarantine_scheduler_runs x
           WHERE p_before IS NULL OR x.started_at < p_before ORDER BY x.started_at DESC, x.id LIMIT p_limit) r;
  RETURN jsonb_build_object('items', v_items, 'next_before', CASE WHEN jsonb_array_length(v_items) = p_limit THEN v_last END);
END;
$$;

-- ── 4. Per-channel delivery outcomes ────────────────────────────────────────
ALTER TABLE private.moderation_monitoring_deliveries
  ADD COLUMN channel_errors jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT moderation_monitoring_deliveries_channel_errors CHECK (
    jsonb_typeof(channel_errors) = 'object' AND (channel_errors - 'email' - 'webhook') = '{}'::jsonb);

-- p_channel_errors: {"email": "<code>", "webhook": "<code>"} for each channel
-- that was attempted and failed (also when the other one delivered).
CREATE FUNCTION public.moderation_monitoring_record_delivery(p_claim_id uuid, p_error text, p_channels text[], p_channel_errors jsonb)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_rows integer;
  v_ok boolean := p_error IS NULL;
  v_errors jsonb := COALESCE(p_channel_errors, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_errors) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(v_errors) e
                 WHERE e.key NOT IN ('email', 'webhook') OR jsonb_typeof(e.value) <> 'string' OR (e.value #>> '{}') !~ '^[a-z_]{1,48}$'
                    OR e.key = ANY (COALESCE(p_channels, '{}'))) THEN
    RAISE EXCEPTION 'invalid_delivery_report' USING ERRCODE = '22023';
  END IF;
  v_rows := public.moderation_monitoring_record_delivery(p_claim_id, p_error, p_channels);
  UPDATE private.moderation_monitoring_deliveries SET channel_errors = v_errors WHERE id = p_claim_id;
  RETURN v_rows;
END;
$$;

-- Delivery attempts (newest first) with per-channel outcomes, 24-hour totals
-- per channel, and open issues whose notices keep failing.
CREATE FUNCTION public.admin_moderation_delivery_history(p_limit integer DEFAULT 25, p_before timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_items jsonb;
  v_last timestamptz;
BEGIN
  PERFORM private.require_admin();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', d.id, 'claimed_at', d.claimed_at, 'finished_at', d.finished_at,
           'outcome', CASE WHEN d.outcome = 'claimed' AND d.claimed_at < clock_timestamp() - interval '5 minutes' THEN 'abandoned'
                           WHEN d.outcome = 'claimed' THEN 'in_flight' ELSE d.outcome END,
           'partial', d.outcome = 'delivered' AND d.channel_errors <> '{}'::jsonb,
           'notice_count', d.notice_count, 'includes_summary', d.includes_summary,
           'delivered_channels', to_jsonb(d.channels), 'channel_errors', d.channel_errors, 'error_code', d.error_code)
           ORDER BY d.claimed_at DESC, d.id), '[]'::jsonb),
         min(d.claimed_at)
    INTO v_items, v_last
    FROM (SELECT * FROM private.moderation_monitoring_deliveries x
           WHERE p_before IS NULL OR x.claimed_at < p_before ORDER BY x.claimed_at DESC, x.id LIMIT p_limit) d;
  RETURN jsonb_build_object(
    'items', v_items,
    'next_before', CASE WHEN jsonb_array_length(v_items) = p_limit THEN v_last END,
    'channels_24h', (SELECT jsonb_build_object(
        'email', jsonb_build_object('delivered', count(*) FILTER (WHERE 'email' = ANY (d.channels)),
                                    'failed', count(*) FILTER (WHERE d.channel_errors ? 'email')),
        'webhook', jsonb_build_object('delivered', count(*) FILTER (WHERE 'webhook' = ANY (d.channels)),
                                      'failed', count(*) FILTER (WHERE d.channel_errors ? 'webhook')),
        'failed_attempts', count(*) FILTER (WHERE d.outcome = 'failed'))
      FROM private.moderation_monitoring_deliveries d WHERE d.claimed_at > clock_timestamp() - interval '24 hours'),
    'retrying', COALESCE((SELECT jsonb_agg(jsonb_build_object('issue_id', i.id, 'code', i.code, 'severity', i.severity,
                                                             'failures', i.delivery_failures, 'last_delivery_error', i.last_delivery_error,
                                                             'last_attempt_at', i.last_attempt_at) ORDER BY i.delivery_failures DESC, i.code)
                            FROM private.moderation_monitoring_issues i WHERE i.delivery_failures > 0), '[]'::jsonb));
END;
$$;

-- ── 5. Purge runs for the dashboard (read-only) ─────────────────────────────
CREATE FUNCTION private.retention_purge_display_status(r private.retention_purge_runs)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN r.status = 'prepared' AND r.approval_expires_at <= clock_timestamp() THEN 'expired'
    WHEN r.status = 'approved' AND r.execution_expires_at <= clock_timestamp()
         AND EXISTS (SELECT 1 FROM private.retention_purge_items i WHERE i.run_id = r.id AND i.state IN ('pending', 'failed')) THEN 'expired'
    WHEN EXISTS (SELECT 1 FROM private.retention_purge_items i WHERE i.run_id = r.id AND i.state = 'needs_attention') THEN 'needs_attention'
    ELSE r.status END;
$$;

CREATE FUNCTION public.admin_retention_purge_dashboard(p_status text DEFAULT NULL, p_limit integer DEFAULT 25, p_before timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  v_items jsonb;
  v_last timestamptz;
BEGIN
  IF (p_status IS NOT NULL AND p_status NOT IN ('prepared', 'approved', 'expired', 'cancelled', 'completed', 'needs_attention'))
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', r.id, 'category', r.category, 'stored_status', r.status, 'status', r.display,
           'item_count', r.item_count,
           'items_by_state', (SELECT COALESCE(jsonb_object_agg(s.state, s.n), '{}'::jsonb)
                                FROM (SELECT i.state, count(*) AS n FROM private.retention_purge_items i WHERE i.run_id = r.id GROUP BY i.state) s),
           'prepared_at', r.prepared_at, 'approval_expires_at', r.approval_expires_at,
           'approved_at', r.approved_at, 'execution_expires_at', r.execution_expires_at, 'closed_at', r.closed_at,
           'prepared_by_viewer', r.prepared_by IS NOT DISTINCT FROM v_admin,
           'approved_by_viewer', r.approved_by IS NOT DISTINCT FROM v_admin,
           -- informational only; admin_retention_approve_run re-checks everything when an approval is submitted
           'viewer_may_approve', r.display = 'prepared' AND r.prepared_by IS DISTINCT FROM v_admin)
           ORDER BY r.prepared_at DESC, r.id), '[]'::jsonb),
         min(r.prepared_at)
    INTO v_items, v_last
    FROM (SELECT x.*, private.retention_purge_display_status(x) AS display FROM private.retention_purge_runs x
           WHERE (p_before IS NULL OR x.prepared_at < p_before)
             AND (p_status IS NULL OR private.retention_purge_display_status(x) = p_status)
           ORDER BY x.prepared_at DESC, x.id LIMIT p_limit) r;
  RETURN jsonb_build_object(
    'items', v_items,
    'next_before', CASE WHEN jsonb_array_length(v_items) = p_limit THEN v_last END,
    'pending_approval', (SELECT count(*) FROM private.retention_purge_runs x WHERE private.retention_purge_display_status(x) = 'prepared'),
    'needs_attention', (SELECT count(*) FROM private.retention_purge_runs x WHERE private.retention_purge_display_status(x) = 'needs_attention'));
END;
$$;

-- ── 6. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION private.moderation_monitoring_affected(), private.moderation_issue_status(private.moderation_monitoring_issues),
                       private.moderation_issue_json(private.moderation_monitoring_issues),
                       private.retention_purge_display_status(private.retention_purge_runs)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.moderation_monitoring_record_delivery(uuid, text, text[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderation_monitoring_record_delivery(uuid, text, text[], jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.admin_moderation_issue_detail(uuid, integer, integer), public.admin_moderation_issue_history(text, integer, timestamptz),
                       public.admin_media_quarantine_scheduler_runs(integer, timestamptz), public.admin_moderation_delivery_history(integer, timestamptz),
                       public.admin_retention_purge_dashboard(text, integer, timestamptz)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_moderation_issue_detail(uuid, integer, integer), public.admin_moderation_issue_history(text, integer, timestamptz),
                          public.admin_media_quarantine_scheduler_runs(integer, timestamptz), public.admin_moderation_delivery_history(integer, timestamptz),
                          public.admin_retention_purge_dashboard(text, integer, timestamptz)
  TO authenticated;
