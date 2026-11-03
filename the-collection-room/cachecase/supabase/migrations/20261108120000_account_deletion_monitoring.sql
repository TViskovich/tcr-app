-- ============================================================================
-- Account deletion monitoring — beta launch hardening.
--
-- Operational health of the deletion and Download My Data system, for
-- admins and for automatic alerts. Counts, timestamps and controlled codes
-- only: no account identities, emails, usernames or paths are stored,
-- returned or sent.
--
--   1. The maintenance worker records each full run (outcome, duration,
--      controlled error codes); the scheduled call records each dispatch
--      and its pg_net request, so failed HTTP calls are visible even when
--      the worker never starts.
--   2. private.account_monitoring_snapshot() computes health: last
--      successful run, overdue scheduled deletions, jobs in progress for
--      over an hour, expired leases, failed deletions, failed / abandoned /
--      stuck exports, scheduler configuration and repeated call failures.
--   3. account_deletion_admin_summary() (admins only) returns it, keeping
--      its earlier fields.
--   4. A separate pg_cron job (every 15 minutes, in SQL, independent of the
--      worker and its Edge Function) records which issues are open and,
--      when an issue opens, is still open after 24 h, or resolves, asks the
--      account-monitor Edge Function to deliver a notice (Resend email
--      and/or a webhook, when configured). It is created INACTIVE: an
--      operator activates it once the worker, secrets and alert delivery
--      are verified (deployment runbook).
--   5. account-monitor reports which delivery channels it has configured
--      (it holds the channel secrets; the database cannot see them), on
--      every call and at least every 6 h, so admins can see whether alerts
--      can reach anyone and whether the monitor job is active.
--
-- Nothing here is on the deletion path: the worker writes one row per run,
-- after its work, and ignores a failure to do so.
-- ============================================================================

-- ── Tables (private schema, no client or service-role table access) ──────

CREATE TABLE private.account_maintenance_dispatches (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispatched_at  timestamptz NOT NULL DEFAULT now(),
  request_id     bigint,                                    -- pg_net request; NULL when skipped
  skipped_reason text CHECK (skipped_reason IN ('not_configured')),
  CONSTRAINT account_maintenance_dispatches_shape CHECK ((request_id IS NULL) = (skipped_reason IS NOT NULL))
);
CREATE INDEX account_maintenance_dispatches_at ON private.account_maintenance_dispatches (dispatched_at DESC);

CREATE TABLE private.account_maintenance_runs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finished_at    timestamptz NOT NULL DEFAULT now(),
  outcome        text NOT NULL CHECK (outcome IN ('ok', 'degraded', 'not_ready', 'failed')),
  duration_ms    integer CHECK (duration_ms >= 0),
  jobs_processed integer NOT NULL DEFAULT 0 CHECK (jobs_processed >= 0),
  job_errors     integer NOT NULL DEFAULT 0 CHECK (job_errors >= 0),
  error_codes    text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX account_maintenance_runs_at ON private.account_maintenance_runs (finished_at DESC);
CREATE INDEX account_maintenance_runs_ok ON private.account_maintenance_runs (finished_at DESC) WHERE outcome = 'ok';

-- One row per issue code. A reopened issue reuses its row with a new
-- opened_at; delivery bookkeeping resets with it.
CREATE TABLE private.account_monitoring_alerts (
  code                text PRIMARY KEY CHECK (code ~ '^[a-z_]{1,48}$'),
  opened_at           timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  resolved_at         timestamptz,
  notified_at         timestamptz,    -- last delivered open/reminder notice
  resolve_notified_at timestamptz,
  last_attempt_at     timestamptz,    -- last claim for delivery
  claimed_kind        text CHECK (claimed_kind IN ('opened', 'reminder', 'resolved')),
  last_delivery_error text CHECK (last_delivery_error ~ '^[a-z_]{1,48}$')
);

CREATE TABLE private.account_monitoring_state (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  scheduler_active_since timestamptz,  -- first check that saw the job active
  last_check_at          timestamptz,
  last_delivery_at       timestamptz,
  last_delivery_error    text CHECK (last_delivery_error ~ '^[a-z_]{1,48}$'),
  last_delivery_channels text[] NOT NULL DEFAULT '{}',
  -- Reported by account-monitor (channel secrets are Edge Function secrets).
  email_channel          text CHECK (email_channel IN ('configured', 'not_configured', 'missing_recipients', 'missing_sender')),
  webhook_channel        text CHECK (webhook_channel IN ('configured', 'not_configured', 'invalid_url')),
  webhook_signed         boolean,
  channels_reported_at   timestamptz
);
INSERT INTO private.account_monitoring_state (id) VALUES (true);

-- private is USAGE-granted to clients (for policy helpers), so revoke
-- explicitly; RLS without policies is a second barrier.
REVOKE ALL ON private.account_maintenance_dispatches, private.account_maintenance_runs,
  private.account_monitoring_alerts, private.account_monitoring_state FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE private.account_maintenance_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.account_maintenance_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.account_monitoring_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.account_monitoring_state ENABLE ROW LEVEL SECURITY;

-- Failed and stuck exports are found by age.
CREATE INDEX account_exports_monitor ON public.account_exports (updated_at)
  WHERE status IN ('queued', 'collecting', 'archiving', 'failed');

-- ── The scheduled call now records each dispatch ───────────────────────────
CREATE OR REPLACE FUNCTION private.run_account_maintenance()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
  v_request bigint;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'account_maintenance_secret' LIMIT 1;
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE LOG 'account-maintenance: project_url / account_maintenance_secret not configured in Vault; skipped';
    INSERT INTO private.account_maintenance_dispatches (skipped_reason) VALUES ('not_configured');
    RETURN NULL;
  END IF;
  v_request := net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/account-maintenance',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  INSERT INTO private.account_maintenance_dispatches (request_id) VALUES (v_request);
  RETURN v_request;
END;
$$;
REVOKE ALL ON FUNCTION private.run_account_maintenance() FROM PUBLIC, anon, authenticated;

-- ── Worker: record a full run (service role only) ──────────────────────────
CREATE FUNCTION public.account_maintenance_record_run(
  p_outcome text, p_duration_ms integer, p_jobs_processed integer, p_job_errors integer, p_error_codes text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('ok', 'degraded', 'not_ready', 'failed') THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(COALESCE(p_error_codes, '{}')) c WHERE c IS NULL OR c !~ '^[a-z_]{1,48}$')
     OR cardinality(COALESCE(p_error_codes, '{}')) > 20 THEN
    RAISE EXCEPTION 'invalid_error_codes' USING ERRCODE = '22023';
  END IF;
  INSERT INTO private.account_maintenance_runs (outcome, duration_ms, jobs_processed, job_errors, error_codes)
  VALUES (p_outcome, GREATEST(COALESCE(p_duration_ms, 0), 0), GREATEST(COALESCE(p_jobs_processed, 0), 0),
          GREATEST(COALESCE(p_job_errors, 0), 0), COALESCE(p_error_codes, '{}'));
END;
$$;

-- ── Health snapshot (no identities) ────────────────────────────────────────
-- Thresholds:
--   overdue scheduled deletion   recovery window ended > 1 h ago, not started
--   stuck job                    open for > 1 h
--   expired lease                lease ended > 15 min ago and not reclaimed
--   missing runs                 no successful run for > 30 min while active
--   function failing             last 3 answered calls failed (non-2xx,
--                                timeout, no answer within 2 min)
--   exports failing              ≥ 3 failed (not abandoned) in 24 h
--   export stuck                 in progress, untouched for > 25 h (the
--                                maintenance sweep abandons them at 24 h)
CREATE FUNCTION private.account_monitoring_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
  v_active boolean;
  v_vault_ok boolean;
  v_key_ok boolean;
  v_since timestamptz;
  v_first_dispatch timestamptz;
  v_last_ok timestamptz;
  v_last_run private.account_maintenance_runs;
  v_last_dispatch timestamptz;
  v_last_skip timestamptz;
  v_fail_streak integer;
  v_last_status integer;
  v_pending integer;
  v_overdue integer;
  v_oldest_overdue timestamptz;
  j record;
  e record;
  v_job_codes jsonb;
  v_export_codes jsonb;
  v_alerts record;
  v_state private.account_monitoring_state;
  v_monitor_active boolean;
  v_issues text[] := '{}';
BEGIN
  SELECT COALESCE(bool_or(active), false) INTO v_active FROM cron.job WHERE jobname = 'account-maintenance';
  v_key_ok := private.username_hmac('preflight') IS NOT NULL;
  v_vault_ok := EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url' AND decrypted_secret LIKE 'http%')
            AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'account_maintenance_secret' AND length(decrypted_secret) >= 32);
  SELECT * INTO v_state FROM private.account_monitoring_state;
  v_since := v_state.scheduler_active_since;
  SELECT COALESCE(bool_or(active), false) INTO v_monitor_active FROM cron.job WHERE jobname = 'account-deletion-monitor';

  SELECT max(finished_at) INTO v_last_ok FROM private.account_maintenance_runs WHERE outcome = 'ok';
  SELECT * INTO v_last_run FROM private.account_maintenance_runs ORDER BY finished_at DESC LIMIT 1;
  SELECT max(dispatched_at) FILTER (WHERE request_id IS NOT NULL),
         max(dispatched_at) FILTER (WHERE request_id IS NULL),
         min(dispatched_at) FILTER (WHERE request_id IS NOT NULL AND dispatched_at > v_now - interval '1 day')
    INTO v_last_dispatch, v_last_skip, v_first_dispatch
    FROM private.account_maintenance_dispatches;

  -- Consecutive failed calls, newest first, among calls old enough to have
  -- an answer and young enough that pg_net still keeps it (6 h).
  WITH recent AS (
    SELECT d.dispatched_at, r.status_code,
           (r.id IS NOT NULL AND r.status_code BETWEEN 200 AND 299 AND NOT COALESCE(r.timed_out, false) AND r.error_msg IS NULL) AS ok
    FROM private.account_maintenance_dispatches d
    LEFT JOIN net._http_response r ON r.id = d.request_id
    WHERE d.request_id IS NOT NULL
      AND d.dispatched_at > v_now - interval '6 hours' AND d.dispatched_at < v_now - interval '2 minutes'
    ORDER BY d.dispatched_at DESC
    LIMIT 10
  ), numbered AS (
    SELECT ok, status_code, row_number() OVER (ORDER BY dispatched_at DESC) AS n FROM recent
  )
  SELECT COALESCE(min(n) FILTER (WHERE ok) - 1, count(*))::int, max(status_code) FILTER (WHERE n = 1)
    INTO v_fail_streak, v_last_status FROM numbered;

  SELECT count(*)::int INTO v_pending FROM public.account_lifecycle WHERE state = 'pending_deletion';
  SELECT count(*)::int, min(scheduled_for) INTO v_overdue, v_oldest_overdue
    FROM public.account_lifecycle WHERE state = 'pending_deletion' AND scheduled_for < v_now - interval '1 hour';

  SELECT count(*) FILTER (WHERE status <> 'failed')::int AS in_progress,
         count(*) FILTER (WHERE status <> 'failed' AND created_at < v_now - interval '1 hour')::int AS stuck,
         min(created_at) FILTER (WHERE status <> 'failed' AND created_at < v_now - interval '1 hour') AS oldest_stuck,
         count(*) FILTER (WHERE status <> 'failed' AND lease_until < v_now - interval '15 minutes')::int AS expired_leases,
         count(*) FILTER (WHERE status = 'failed')::int AS failed,
         min(failed_at) FILTER (WHERE status = 'failed') AS oldest_failed
    INTO j
    FROM public.account_deletion_jobs
    WHERE status IN ('queued', 'cleaning_storage', 'deleting_account', 'failed');
  SELECT COALESCE(jsonb_object_agg(code, n), '{}'::jsonb) INTO v_job_codes FROM (
    SELECT COALESCE(last_error_code, 'unknown') AS code, count(*) AS n
    FROM public.account_deletion_jobs WHERE status = 'failed' GROUP BY 1) t;

  SELECT count(*) FILTER (WHERE status = 'failed' AND last_error_code IS DISTINCT FROM 'export_abandoned' AND updated_at > v_now - interval '24 hours')::int AS failed_24h,
         count(*) FILTER (WHERE status = 'failed' AND last_error_code = 'export_abandoned' AND updated_at > v_now - interval '24 hours')::int AS abandoned_24h,
         count(*) FILTER (WHERE status = 'failed' AND last_error_code IS DISTINCT FROM 'export_abandoned')::int AS failed_7d,
         count(*) FILTER (WHERE status = 'failed' AND last_error_code = 'export_abandoned')::int AS abandoned_7d,
         count(*) FILTER (WHERE status <> 'failed' AND updated_at < v_now - interval '25 hours')::int AS stuck
    INTO e
    FROM public.account_exports
    WHERE status IN ('queued', 'collecting', 'archiving', 'failed')
      AND (status <> 'failed' OR updated_at > v_now - interval '7 days');
  SELECT COALESCE(jsonb_object_agg(code, n), '{}'::jsonb) INTO v_export_codes FROM (
    SELECT COALESCE(last_error_code, 'unknown') AS code, count(*) AS n
    FROM public.account_exports
    WHERE status = 'failed' AND updated_at > v_now - interval '7 days' GROUP BY 1) t;

  SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
         count(*) FILTER (WHERE (resolved_at IS NULL AND (notified_at IS NULL OR last_delivery_error IS NOT NULL))
                            OR (resolved_at IS NOT NULL AND notified_at IS NOT NULL AND resolve_notified_at IS NULL))::int AS undelivered
    INTO v_alerts FROM private.account_monitoring_alerts;

  -- Issues (controlled codes, most urgent first).
  IF NOT (v_key_ok AND v_vault_ok) AND (v_active OR v_pending > 0 OR j.in_progress > 0) THEN
    v_issues := array_append(v_issues, 'scheduler_not_configured');
  END IF;
  IF NOT v_active AND (v_pending > 0 OR j.in_progress > 0) THEN
    v_issues := array_append(v_issues, 'scheduler_inactive');
  END IF;
  IF v_active AND GREATEST(v_last_ok, COALESCE(v_since, v_first_dispatch)) < v_now - interval '30 minutes' THEN
    v_issues := array_append(v_issues, 'maintenance_runs_missing');
  END IF;
  IF v_fail_streak >= 3 THEN v_issues := array_append(v_issues, 'maintenance_calls_failing'); END IF;
  IF j.failed > 0 THEN v_issues := array_append(v_issues, 'deletions_failed'); END IF;
  IF v_overdue > 0 THEN v_issues := array_append(v_issues, 'deletions_overdue'); END IF;
  IF j.stuck > 0 THEN v_issues := array_append(v_issues, 'deletions_stuck'); END IF;
  IF j.expired_leases > 0 THEN v_issues := array_append(v_issues, 'deletion_leases_expired'); END IF;
  IF e.failed_24h >= 3 THEN v_issues := array_append(v_issues, 'exports_failing'); END IF;
  IF e.stuck > 0 THEN v_issues := array_append(v_issues, 'exports_stuck'); END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN cardinality(v_issues) = 0 THEN 'healthy' ELSE 'attention' END,
    'issues', to_jsonb(v_issues),
    'checked_at', v_now,
    'scheduler', jsonb_build_object(
      'active', v_active,
      'configured', v_key_ok AND v_vault_ok,
      'username_key_configured', v_key_ok,
      'last_successful_run_at', v_last_ok,
      'last_run_at', v_last_run.finished_at,
      'last_run_outcome', v_last_run.outcome,
      'last_run_error_codes', to_jsonb(COALESCE(v_last_run.error_codes, '{}')),
      'last_dispatch_at', v_last_dispatch,
      'last_skipped_at', v_last_skip,
      'consecutive_failed_calls', COALESCE(v_fail_streak, 0),
      'last_call_status', v_last_status),
    'deletions', jsonb_build_object(
      'pending', v_pending,
      'overdue_scheduled', v_overdue,
      'oldest_overdue_since', v_oldest_overdue,
      'in_progress', j.in_progress,
      'stuck_over_1h', j.stuck,
      'oldest_stuck_since', j.oldest_stuck,
      'expired_leases', j.expired_leases,
      'failed', j.failed,
      'oldest_failed_at', j.oldest_failed,
      'failure_codes', v_job_codes),
    'exports', jsonb_build_object(
      'failed_24h', e.failed_24h,
      'abandoned_24h', e.abandoned_24h,
      'failed_7d', e.failed_7d,
      'abandoned_7d', e.abandoned_7d,
      'stuck', e.stuck,
      'failure_codes_7d', v_export_codes),
    'alerts', jsonb_build_object(
      'monitor_active', v_monitor_active,
      -- NULL until account-monitor has reported its channels.
      'channel_configured', CASE WHEN v_state.channels_reported_at IS NOT NULL
                                 THEN v_state.email_channel = 'configured' OR v_state.webhook_channel = 'configured' END,
      'email', v_state.email_channel,
      'webhook', v_state.webhook_channel,
      'webhook_signed', v_state.webhook_signed,
      'channels_reported_at', v_state.channels_reported_at,
      'open', v_alerts.open,
      'undelivered', v_alerts.undelivered,
      'last_delivery_at', v_state.last_delivery_at,
      'last_delivery_error', v_state.last_delivery_error,
      'last_delivery_channels', to_jsonb(v_state.last_delivery_channels))
  );
END;
$$;
REVOKE ALL ON FUNCTION private.account_monitoring_snapshot() FROM PUBLIC, anon, authenticated, service_role;

-- ── Admin summary: earlier fields plus the snapshot ────────────────────────
CREATE OR REPLACE FUNCTION public.account_deletion_admin_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_snap jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  v_snap := private.account_monitoring_snapshot();
  RETURN v_snap || jsonb_build_object(
    'failed', (v_snap #>> '{deletions,failed}')::int,
    'in_progress', (v_snap #>> '{deletions,in_progress}')::int,
    'oldest_failed_at', v_snap #> '{deletions,oldest_failed_at}',
    'failure_codes', v_snap #> '{deletions,failure_codes}');
END;
$$;
REVOKE ALL ON FUNCTION public.account_deletion_admin_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_deletion_admin_summary() TO authenticated, service_role;

-- ── Alert state ────────────────────────────────────────────────────────────
-- Which notice an alert row is due, if any: 'opened' when an issue first
-- appears, 'reminder' every 24 h while open, 'resolved' once it clears
-- (only if its opening was delivered). A claim blocks a repeat for 5 min
-- (delivery in flight); a failed delivery is retried after 1 h.
CREATE FUNCTION private.account_monitoring_notice_due(a private.account_monitoring_alerts)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN a.last_attempt_at > now() - CASE WHEN a.last_delivery_error IS NULL THEN interval '5 minutes' ELSE interval '1 hour' END THEN NULL
    WHEN a.resolved_at IS NULL AND a.notified_at IS NULL THEN 'opened'
    WHEN a.resolved_at IS NULL AND a.notified_at < now() - interval '24 hours' THEN 'reminder'
    WHEN a.resolved_at IS NOT NULL AND a.notified_at IS NOT NULL AND a.resolve_notified_at IS NULL THEN 'resolved'
  END;
$$;
REVOKE ALL ON FUNCTION private.account_monitoring_notice_due(private.account_monitoring_alerts) FROM PUBLIC, anon, authenticated, service_role;

-- Records the current issues as open / resolved alerts; prunes old history.
CREATE FUNCTION private.account_monitoring_check()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_active boolean;
  v_snap jsonb;
  v_issues text[];
BEGIN
  SELECT COALESCE(bool_or(active), false) INTO v_active FROM cron.job WHERE jobname = 'account-maintenance';
  UPDATE private.account_monitoring_state
  SET scheduler_active_since = CASE WHEN v_active THEN COALESCE(scheduler_active_since, now()) END,
      last_check_at = now()
  WHERE id;  -- every UPDATE has a WHERE (PostgREST sessions load safeupdate)

  v_snap := private.account_monitoring_snapshot();
  v_issues := ARRAY(SELECT jsonb_array_elements_text(v_snap -> 'issues'));

  INSERT INTO private.account_monitoring_alerts AS a (code, opened_at, last_seen_at)
  SELECT code, now(), now() FROM unnest(v_issues) AS code
  ON CONFLICT (code) DO UPDATE SET
    last_seen_at = now(),
    opened_at = CASE WHEN a.resolved_at IS NULL THEN a.opened_at ELSE now() END,
    notified_at = CASE WHEN a.resolved_at IS NULL THEN a.notified_at END,
    resolve_notified_at = CASE WHEN a.resolved_at IS NULL THEN a.resolve_notified_at END,
    last_attempt_at = CASE WHEN a.resolved_at IS NULL THEN a.last_attempt_at END,
    claimed_kind = CASE WHEN a.resolved_at IS NULL THEN a.claimed_kind END,
    last_delivery_error = CASE WHEN a.resolved_at IS NULL THEN a.last_delivery_error END,
    resolved_at = NULL;
  UPDATE private.account_monitoring_alerts SET resolved_at = now()
  WHERE resolved_at IS NULL AND NOT (code = ANY (v_issues));

  DELETE FROM private.account_maintenance_runs WHERE finished_at < now() - interval '14 days';
  DELETE FROM private.account_maintenance_dispatches WHERE dispatched_at < now() - interval '14 days';
  DELETE FROM private.account_monitoring_alerts
  WHERE resolved_at < now() - interval '30 days' AND (notified_at IS NULL OR resolve_notified_at IS NOT NULL);

  -- Recompute so the returned alert counts include this check.
  RETURN private.account_monitoring_snapshot();
END;
$$;
REVOKE ALL ON FUNCTION private.account_monitoring_check() FROM PUBLIC, anon, authenticated, service_role;

-- ── Delivery (account-monitor Edge Function, service role only) ────────────
-- Claims every due notice at once and returns them with the snapshot.
-- claimed_at identifies this claim when reporting the outcome.
CREATE FUNCTION public.account_monitoring_claim_notices()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_snap jsonb;
  v_notices jsonb;
BEGIN
  v_snap := private.account_monitoring_check();
  WITH claimed AS (
    UPDATE private.account_monitoring_alerts a
    SET claimed_kind = private.account_monitoring_notice_due(a), last_attempt_at = now()
    WHERE private.account_monitoring_notice_due(a) IS NOT NULL
    RETURNING a.code, a.claimed_kind, a.opened_at, a.resolved_at
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', code, 'kind', claimed_kind, 'opened_at', opened_at, 'resolved_at', resolved_at)
                            ORDER BY resolved_at NULLS FIRST, code), '[]'::jsonb)
    INTO v_notices FROM claimed;
  RETURN jsonb_build_object('claimed_at', now(), 'notices', v_notices, 'snapshot', v_snap);
END;
$$;

-- Reports the outcome of a claim: p_error NULL = delivered (acknowledged by
-- at least one channel, named in p_channels).
CREATE FUNCTION public.account_monitoring_record_delivery(p_claimed_at timestamptz, p_error text, p_channels text[] DEFAULT '{}')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_claimed_at IS NULL OR (p_error IS NOT NULL AND p_error !~ '^[a-z_]{1,48}$')
     OR NOT (COALESCE(p_channels, '{}') <@ ARRAY['email', 'webhook'])
     OR (p_error IS NULL AND cardinality(COALESCE(p_channels, '{}')) = 0) THEN
    RAISE EXCEPTION 'invalid_delivery_report' USING ERRCODE = '22023';
  END IF;
  UPDATE private.account_monitoring_alerts
  SET notified_at = CASE WHEN p_error IS NULL AND claimed_kind IN ('opened', 'reminder') THEN now() ELSE notified_at END,
      resolve_notified_at = CASE WHEN p_error IS NULL AND claimed_kind = 'resolved' THEN now() ELSE resolve_notified_at END,
      last_delivery_error = p_error
  WHERE last_attempt_at = p_claimed_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  UPDATE private.account_monitoring_state
  SET last_delivery_at = CASE WHEN p_error IS NULL THEN now() ELSE last_delivery_at END,
      last_delivery_error = p_error,
      last_delivery_channels = CASE WHEN p_error IS NULL THEN COALESCE(p_channels, '{}') ELSE last_delivery_channels END
  WHERE id;
  RETURN v_rows;
END;
$$;

-- account-monitor reports its delivery channels (status codes only; no
-- addresses or URLs).
CREATE FUNCTION public.account_monitoring_report_channels(p_email text, p_webhook text, p_webhook_signed boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_email IS NULL OR p_email NOT IN ('configured', 'not_configured', 'missing_recipients', 'missing_sender')
     OR p_webhook IS NULL OR p_webhook NOT IN ('configured', 'not_configured', 'invalid_url') THEN
    RAISE EXCEPTION 'invalid_channel_report' USING ERRCODE = '22023';
  END IF;
  UPDATE private.account_monitoring_state
  SET email_channel = p_email, webhook_channel = p_webhook,
      webhook_signed = p_webhook = 'configured' AND COALESCE(p_webhook_signed, false),
      channels_reported_at = now()
  WHERE id;
END;
$$;

REVOKE ALL ON FUNCTION public.account_maintenance_record_run(text, integer, integer, integer, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_monitoring_claim_notices() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_monitoring_record_delivery(timestamptz, text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_monitoring_report_channels(text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_maintenance_record_run(text, integer, integer, integer, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_monitoring_claim_notices() TO service_role;
GRANT EXECUTE ON FUNCTION public.account_monitoring_record_delivery(timestamptz, text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_monitoring_report_channels(text, text, boolean) TO service_role;

-- ── The monitor's scheduled call ───────────────────────────────────────────
-- Runs the check in SQL (so issues are recorded even when Edge Functions
-- are down) and calls account-monitor only when a notice is due, or its
-- channel report is missing or older than 6 h.
CREATE FUNCTION private.run_account_monitor()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  PERFORM private.account_monitoring_check();
  IF NOT EXISTS (SELECT 1 FROM private.account_monitoring_alerts a WHERE private.account_monitoring_notice_due(a) IS NOT NULL)
     AND EXISTS (SELECT 1 FROM private.account_monitoring_state WHERE channels_reported_at > now() - interval '6 hours') THEN
    RETURN NULL;
  END IF;
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'account_maintenance_secret' LIMIT 1;
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE LOG 'account-monitor: project_url / account_maintenance_secret not configured in Vault; notice not sent';
    RETURN NULL;
  END IF;
  RETURN net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/account-monitor',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
END;
$$;
REVOKE ALL ON FUNCTION private.run_account_monitor() FROM PUBLIC, anon, authenticated, service_role;

-- Created INACTIVE, like account-maintenance: activated explicitly once the
-- worker, secrets and alert delivery have been verified.
SELECT cron.schedule('account-deletion-monitor', '*/15 * * * *', 'SELECT private.run_account_monitor()');
SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname = 'account-deletion-monitor';
