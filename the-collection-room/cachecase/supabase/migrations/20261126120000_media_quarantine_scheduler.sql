-- Phase 2B M4 step 5A: automatic media-quarantine scheduler (LOCAL; OFF).
--
-- Runs the EXISTING quarantine worker (20261119120000, 20261120120000,
-- 20261121120000) without an administrator at the keyboard. Nothing about the
-- worker's state machine, leases, retries, checksums or source-removal checks
-- changes; this migration only adds a way to start it.
--
-- Dispatch (both OFF by default, behind ONE switch):
--   * kick  — after a quarantine job is queued (or a job becomes child
--             safety), private.media_quarantine_dispatch() queues one pg_net
--             request. pg_net sends only requests whose transaction
--             COMMITTED: a rolled-back moderation sends nothing. Throttled:
--             at most one kick per 10 s (child safety: its own 5 s window),
--             and one kicking transaction at a time.
--   * sweep — pg_cron job "media-quarantine-worker", every minute, created
--             INACTIVE. When run, it dispatches only if the switch is on AND
--             claimable work exists.
--   Switch: private.media_quarantine_scheduler_config.enabled (false). Only a
--   database operator can change it (no API role has any privilege); every
--   change is recorded. Activation is a separate, documented, approved step
--   (docs/launch/media-quarantine-operations-runbook.md).
--
-- Authentication: the Edge Function media-quarantine-scheduled accepts only
-- MEDIA_QUARANTINE_WORKER_SECRET (Vault: media_quarantine_worker_secret),
-- compared in constant time. The secret authorizes nothing by itself: the
-- function must then open a run with media_quarantine_scheduler_begin()
-- (service role only), which refuses while the switch is off, when two
-- scheduled runs are already active, or above 20 runs a minute.
--
-- Identity: scheduled steps are recorded with actor_kind = 'scheduler', the
-- run id and NO actor_id — no administrator is invented. Admin worker steps
-- are recorded with actor_kind = 'admin'.
--
-- Scope: quarantine only. A scheduled run can never move a job to restoring
-- or restored (refused here, in media_quarantine_advance), never claims
-- restore work, and has no access to purge runs, reports or suspensions.
--
-- Records: dispatches and runs carry counts, outcome codes and durations only
-- — never paths, owners, hashes or media.

-- ── 1. Switch ───────────────────────────────────────────────────────────────
CREATE TABLE private.media_quarantine_scheduler_config (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled     boolean NOT NULL DEFAULT false,
  changed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_by  text NOT NULL DEFAULT session_user
);
INSERT INTO private.media_quarantine_scheduler_config DEFAULT VALUES;

CREATE TABLE private.media_quarantine_scheduler_changes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  enabled     boolean NOT NULL,
  changed_by  text NOT NULL
);

CREATE FUNCTION private.media_quarantine_scheduler_config_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'media_quarantine_scheduler_config_fixed' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'media_quarantine_scheduler_config_fixed' USING ERRCODE = '42501';
  END IF;
  NEW.changed_at := clock_timestamp();
  NEW.changed_by := session_user;
  IF NEW.enabled IS DISTINCT FROM OLD.enabled THEN
    INSERT INTO private.media_quarantine_scheduler_changes (enabled, changed_by) VALUES (NEW.enabled, session_user);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_quarantine_scheduler_config_update BEFORE UPDATE ON private.media_quarantine_scheduler_config
  FOR EACH ROW EXECUTE FUNCTION private.media_quarantine_scheduler_config_guard();
CREATE TRIGGER media_quarantine_scheduler_config_fixed BEFORE INSERT OR DELETE ON private.media_quarantine_scheduler_config
  FOR EACH ROW EXECUTE FUNCTION private.media_quarantine_scheduler_config_guard();
CREATE TRIGGER media_quarantine_scheduler_config_no_truncate BEFORE TRUNCATE ON private.media_quarantine_scheduler_config
  FOR EACH STATEMENT EXECUTE FUNCTION private.media_quarantine_scheduler_config_guard();

CREATE FUNCTION private.media_quarantine_scheduler_changes_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'media_quarantine_scheduler_changes_immutable' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER media_quarantine_scheduler_changes_append_only BEFORE UPDATE OR DELETE ON private.media_quarantine_scheduler_changes
  FOR EACH ROW EXECUTE FUNCTION private.media_quarantine_scheduler_changes_guard();
CREATE TRIGGER media_quarantine_scheduler_changes_no_truncate BEFORE TRUNCATE ON private.media_quarantine_scheduler_changes
  FOR EACH STATEMENT EXECUTE FUNCTION private.media_quarantine_scheduler_changes_guard();

CREATE FUNCTION private.media_quarantine_scheduler_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT COALESCE((SELECT c.enabled FROM private.media_quarantine_scheduler_config c), false) $$;

-- ── 2. Dispatches and runs (monitoring; codes and counts only) ──────────────
CREATE TABLE private.media_quarantine_dispatches (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispatched_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  source         text NOT NULL CHECK (source IN ('kick', 'sweep')),
  child_safety   boolean NOT NULL DEFAULT false,
  request_id     bigint,                                   -- pg_net request; NULL when skipped
  skipped_reason text CHECK (skipped_reason IN ('not_configured', 'dispatch_failed')),
  CONSTRAINT media_quarantine_dispatches_shape CHECK ((request_id IS NULL) = (skipped_reason IS NOT NULL))
);
CREATE INDEX media_quarantine_dispatches_at ON private.media_quarantine_dispatches (dispatched_at DESC);

CREATE TABLE private.media_quarantine_scheduler_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger      text NOT NULL CHECK (trigger IN ('kick', 'sweep', 'operator')),
  started_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'abandoned', 'refused')),
  jobs         integer NOT NULL DEFAULT 0 CHECK (jobs BETWEEN 0 AND 5),
  outcomes     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(outcomes) = 'object'),
  error_code   text CHECK (error_code ~ '^[a-z_]{1,48}$'),
  duration_ms  integer CHECK (duration_ms >= 0),
  CONSTRAINT media_quarantine_scheduler_runs_shape CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX media_quarantine_scheduler_runs_at ON private.media_quarantine_scheduler_runs (started_at DESC);
CREATE INDEX media_quarantine_scheduler_runs_running ON private.media_quarantine_scheduler_runs (started_at) WHERE status = 'running';

ALTER TABLE private.media_quarantine_scheduler_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.media_quarantine_scheduler_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.media_quarantine_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.media_quarantine_scheduler_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.media_quarantine_scheduler_config, private.media_quarantine_scheduler_changes,
                    private.media_quarantine_dispatches, private.media_quarantine_scheduler_runs
  FROM PUBLIC, anon, authenticated, service_role;

-- A run still "running" this long after it started has died (25 s budget plus
-- one in-flight job under its 120 s lease): it no longer counts as active and
-- can no longer advance jobs.
CREATE FUNCTION private.media_quarantine_scheduler_stale_after()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT interval '180 seconds' $$;

CREATE FUNCTION private.media_quarantine_scheduler_reap()
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE private.media_quarantine_scheduler_runs
     SET status = 'abandoned', finished_at = clock_timestamp(), error_code = 'stale'
   WHERE status = 'running' AND started_at < clock_timestamp() - private.media_quarantine_scheduler_stale_after();
$$;

-- ── 3. Events: who performed a step ─────────────────────────────────────────
ALTER TABLE private.media_quarantine_events
  ADD COLUMN actor_kind text CHECK (actor_kind IN ('admin', 'scheduler')),
  ADD COLUMN scheduler_run_id uuid,
  ADD CONSTRAINT media_quarantine_events_scheduler_actor CHECK (
    (actor_kind IS DISTINCT FROM 'scheduler' OR (actor_id IS NULL AND scheduler_run_id IS NOT NULL))
    AND (scheduler_run_id IS NULL OR actor_kind = 'scheduler'));

-- A scheduler event never borrows a user id from the session.
CREATE OR REPLACE FUNCTION private.media_quarantine_event_actor()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.actor_kind IS NOT DISTINCT FROM 'scheduler' THEN
    RETURN NEW;
  END IF;
  NEW.actor_id := COALESCE(NEW.actor_id, auth.uid());
  RETURN NEW;
END;
$$;

-- ── 4. Advance (unchanged except for the actor) ─────────────────────────────
-- Copied from 20261120120000. New: p_facts.scheduler_run (a running
-- scheduler run, no admin actor) records the step as the scheduler's, and a
-- scheduler step may never move a job to restoring or restored.
CREATE OR REPLACE FUNCTION public.media_quarantine_advance(p_id uuid, p_lease uuid, p_to_state text, p_facts jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  j private.media_quarantine;
  v_err text := NULLIF(p_facts ->> 'error', '');
  v_actor uuid := NULLIF(p_facts ->> 'actor', '')::uuid;
  v_run uuid := NULLIF(p_facts ->> 'scheduler_run', '')::uuid;
  v_kind text;
  v_src boolean;
  v_copy_size bigint;
  v_copy boolean;
  v_attention boolean;
  v_reason text;
BEGIN
  IF v_run IS NOT NULL THEN
    IF v_actor IS NOT NULL OR p_to_state IN ('restoring', 'restored')
       OR NOT EXISTS (SELECT 1 FROM private.media_quarantine_scheduler_runs r
                       WHERE r.id = v_run AND r.status = 'running'
                         AND r.started_at >= clock_timestamp() - private.media_quarantine_scheduler_stale_after()) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'scheduler_refused');
    END IF;
    v_kind := 'scheduler';
  ELSIF v_actor IS NOT NULL THEN
    v_kind := 'admin';
  END IF;

  SELECT * INTO j FROM private.media_quarantine q WHERE q.id = p_id FOR UPDATE;
  IF NOT FOUND OR p_lease IS NULL OR j.lease_token IS DISTINCT FROM p_lease OR j.lease_expires_at < clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease');
  END IF;
  v_src := EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = j.source_bucket AND o.name = j.source_path);
  SELECT (o.metadata ->> 'size')::bigint INTO v_copy_size FROM storage.objects o
   WHERE o.bucket_id = j.quarantine_bucket AND o.name = j.quarantine_path;
  v_copy := FOUND;

  -- Storage-verified preconditions (never trust the worker's own report).
  v_reason := CASE
    WHEN p_to_state IN ('copied', 'verified') AND NOT v_copy THEN 'copy_missing'
    WHEN p_to_state IN ('copied', 'verified') AND v_copy_size IS DISTINCT FROM COALESCE((p_facts ->> 'size_bytes')::bigint, j.size_bytes) THEN 'copy_size_mismatch'
    WHEN p_to_state = 'quarantined' AND (p_facts ->> 'source_removed') IS DISTINCT FROM 'true' THEN 'source_not_removed'
    WHEN p_to_state = 'quarantined' AND v_src THEN 'source_still_present'
    WHEN p_to_state = 'quarantined' AND NOT v_copy THEN 'copy_missing'
    WHEN p_to_state = 'quarantined' AND j.desired = 'quarantine'
         AND NOT EXISTS (SELECT 1 FROM private.media_quarantine_holds h WHERE h.quarantine_id = j.id AND h.ended_at IS NULL) THEN 'no_active_hold'
    WHEN p_to_state = 'source_missing' AND v_src THEN 'source_still_present'
    WHEN p_to_state = 'cancelled' AND j.state IN ('copied', 'verified') AND j.desired <> 'restore' THEN 'still_held'
    -- Cancelling is only safe while the source is still in place; once it is
    -- gone the verified copy is the file, so it must be recorded quarantined.
    WHEN p_to_state = 'cancelled' AND j.state IN ('copied', 'verified') AND NOT v_src THEN 'source_absent'
    WHEN p_to_state = 'restoring' AND (j.desired <> 'restore' OR EXISTS (
           SELECT 1 FROM private.media_quarantine_holds h WHERE h.quarantine_id = j.id AND (h.ended_at IS NULL OR h.end_disposition <> 'restore'))) THEN 'still_held'
    WHEN p_to_state = 'restored' AND NOT v_src THEN 'source_not_restored'
    WHEN p_to_state = 'restored' AND NOT v_copy THEN 'copy_missing'
  END;
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;

  v_attention := v_err IS NOT NULL AND ((p_facts ->> 'permanent') IS NOT DISTINCT FROM 'true'
                                       OR j.attempts >= private.media_quarantine_max_attempts());
  BEGIN
    UPDATE private.media_quarantine
       SET state = p_to_state,
           source_sha256 = COALESCE(source_sha256, p_facts ->> 'source_sha256'),
           quarantine_sha256 = COALESCE(p_facts ->> 'quarantine_sha256', quarantine_sha256),
           size_bytes = COALESCE(size_bytes, (p_facts ->> 'size_bytes')::bigint),
           mime_type = COALESCE(mime_type, p_facts ->> 'mime_type'),
           source_removed_at = CASE WHEN p_to_state = 'quarantined' THEN clock_timestamp() ELSE source_removed_at END,
           quarantined_at = CASE WHEN p_to_state = 'quarantined' THEN clock_timestamp() ELSE quarantined_at END,
           restored_at = CASE WHEN p_to_state = 'restored' THEN clock_timestamp() ELSE restored_at END,
           -- The private copy is never purged here; a non-legal-hold copy gets a
           -- retention date for M4 once it is no longer needed as evidence.
           retain_until = CASE
             WHEN legal_hold THEN NULL
             WHEN p_to_state = 'quarantined' AND desired = 'retain' THEN COALESCE(retain_until, clock_timestamp() + interval '90 days')
             WHEN p_to_state IN ('restored', 'cancelled') THEN COALESCE(retain_until, clock_timestamp() + interval '90 days')
             ELSE retain_until END,
           last_error = v_err,
           needs_attention = needs_attention OR v_attention,
           next_attempt_at = CASE WHEN v_err IS NOT NULL AND NOT v_attention
                                  THEN clock_timestamp() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST(attempts, 7))::integer)) END,
           attempts = CASE WHEN v_err IS NULL AND p_to_state <> state THEN 0 ELSE attempts END,
           lease_token = CASE WHEN v_err IS NOT NULL OR p_to_state IN ('quarantined', 'restored', 'cancelled', 'source_missing', 'failed') THEN NULL ELSE lease_token END,
           lease_expires_at = CASE WHEN v_err IS NOT NULL OR p_to_state IN ('quarantined', 'restored', 'cancelled', 'source_missing', 'failed') THEN NULL ELSE lease_expires_at END
     WHERE id = p_id;
  EXCEPTION WHEN check_violation OR invalid_parameter_value THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  END;
  INSERT INTO private.media_quarantine_events (quarantine_id, event, from_state, to_state, actor_id, actor_kind, scheduler_run_id, detail)
  VALUES (p_id, CASE WHEN v_attention THEN 'needs_attention' WHEN v_err IS NOT NULL THEN 'worker_retry' ELSE 'worker_step' END,
          j.state, p_to_state, v_actor, v_kind, v_run, jsonb_strip_nulls(jsonb_build_object('error', v_err, 'attempt', j.attempts)));
  -- Every hold ended with "restore" while the worker was removing the source:
  -- the file is now only in quarantine, so it goes straight to restore_pending
  -- (an admin restores it; nothing is lost or left stranded).
  IF p_to_state = 'quarantined' AND j.desired = 'restore' THEN
    UPDATE private.media_quarantine SET state = 'restore_pending' WHERE id = p_id;
    INSERT INTO private.media_quarantine_events (quarantine_id, event, from_state, to_state, actor_id, actor_kind, scheduler_run_id)
    VALUES (p_id, 'released', 'quarantined', 'restore_pending', v_actor, v_kind, v_run);
  END IF;
  RETURN jsonb_build_object('ok', true, 'needs_attention', v_attention,
                            'state', (SELECT q.state FROM private.media_quarantine q WHERE q.id = p_id));
END;
$$;

-- ── 5. Scheduled runs (service role only; called by the Edge Function) ──────
-- The second, server-side authorization after the secret: the switch must be
-- on, fewer than 2 scheduled runs active, and fewer than 20 started in the
-- last minute. Refusals are recorded (status 'refused').
CREATE FUNCTION public.media_quarantine_scheduler_begin(p_trigger text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_reason text;
  v_id uuid;
BEGIN
  IF p_trigger IS NULL OR p_trigger NOT IN ('kick', 'sweep', 'operator') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  -- Serialize starts so the concurrency limit is exact.
  PERFORM pg_advisory_xact_lock(hashtext('media_quarantine_scheduler_begin'));
  PERFORM private.media_quarantine_scheduler_reap();
  v_reason := CASE
    WHEN NOT private.media_quarantine_scheduler_enabled() THEN 'disabled'
    WHEN (SELECT count(*) FROM private.media_quarantine_scheduler_runs r WHERE r.status = 'running') >= 2 THEN 'busy'
    WHEN (SELECT count(*) FROM private.media_quarantine_scheduler_runs r
           WHERE r.status <> 'refused' AND r.started_at > clock_timestamp() - interval '60 seconds') >= 20 THEN 'rate_limited'
  END;
  IF v_reason IS NOT NULL THEN
    INSERT INTO private.media_quarantine_scheduler_runs (trigger, status, finished_at, error_code, duration_ms)
    VALUES (p_trigger, 'refused', clock_timestamp(), v_reason, 0);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;
  INSERT INTO private.media_quarantine_scheduler_runs (trigger) VALUES (p_trigger) RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'run_id', v_id);
END;
$$;

CREATE FUNCTION public.media_quarantine_scheduler_finish(p_run_id uuid, p_status text, p_jobs integer, p_outcomes jsonb,
                                                         p_error text, p_duration_ms integer)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_run_id IS NULL OR p_status NOT IN ('completed', 'failed') OR p_jobs IS NULL OR p_jobs NOT BETWEEN 0 AND 5
     OR p_outcomes IS NULL OR jsonb_typeof(p_outcomes) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(p_outcomes) e
                 WHERE e.key NOT IN ('quarantined', 'restore_pending', 'source_missing', 'cancelled', 'retry_scheduled',
                                     'needs_attention', 'lease_lost', 'interrupted', 'skipped')
                    OR jsonb_typeof(e.value) <> 'number' OR (e.value)::text !~ '^[0-5]$')
     OR (p_error IS NOT NULL AND p_error !~ '^[a-z_]{1,48}$')
     OR p_duration_ms IS NULL OR p_duration_ms < 0 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  UPDATE private.media_quarantine_scheduler_runs
     SET status = p_status, finished_at = clock_timestamp(), jobs = p_jobs, outcomes = p_outcomes,
         error_code = p_error, duration_ms = p_duration_ms
   WHERE id = p_run_id AND status = 'running';
  RETURN jsonb_build_object('ok', FOUND);
END;
$$;

-- ── 6. Dispatch (pg_net; sent only after COMMIT) ────────────────────────────
-- Claimable now: exactly media_quarantine_claim's selection (quarantine work,
-- not flagged, lease free, back-off over).
CREATE FUNCTION private.media_quarantine_claimable(p_child_safety_only boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.media_quarantine q
     WHERE NOT q.needs_attention
       AND (q.lease_expires_at IS NULL OR q.lease_expires_at < clock_timestamp())
       AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= clock_timestamp())
       AND ((q.desired IN ('quarantine', 'retain') AND q.state IN ('pending', 'copied', 'verified'))
            OR (q.desired = 'restore' AND q.state IN ('copied', 'verified')))
       AND (NOT p_child_safety_only OR q.child_safety))
$$;

-- Queues one request to the scheduled worker. Never raises: a dispatch
-- problem must not fail the moderation decision that caused it (the sweep
-- recovers). The URL and secret come from Vault only.
CREATE FUNCTION private.media_quarantine_dispatch(p_source text, p_child_safety boolean)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
  v_request bigint;
BEGIN
  IF NOT private.media_quarantine_scheduler_enabled() THEN
    RETURN NULL;
  END IF;
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'media_quarantine_worker_secret' LIMIT 1;
  IF v_url IS NULL OR v_url NOT LIKE 'http%' OR v_secret IS NULL OR length(v_secret) < 32 THEN
    RAISE LOG 'media-quarantine-scheduler: project_url / media_quarantine_worker_secret not configured in Vault; not dispatched';
    INSERT INTO private.media_quarantine_dispatches (source, child_safety, skipped_reason) VALUES (p_source, p_child_safety, 'not_configured');
    RETURN NULL;
  END IF;
  BEGIN
    v_request := net.http_post(
      url := rtrim(v_url, '/') || '/functions/v1/media-quarantine-scheduled',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
      body := jsonb_build_object('trigger', p_source),
      timeout_milliseconds := 45000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'media-quarantine-scheduler: dispatch failed (%)', SQLSTATE;
    INSERT INTO private.media_quarantine_dispatches (source, child_safety, skipped_reason) VALUES (p_source, p_child_safety, 'dispatch_failed');
    RETURN NULL;
  END;
  INSERT INTO private.media_quarantine_dispatches (source, child_safety, request_id) VALUES (p_source, p_child_safety, v_request);
  RETURN v_request;
END;
$$;

-- Event-driven kick. Throttled: one kicking transaction at a time; at most
-- one kick per 10 s, and a child-safety job gets its own kick unless a
-- child-safety kick went out in the last 5 s. Whatever is throttled is picked
-- up by the worker already on its way, or by the next sweep.
CREATE FUNCTION private.media_quarantine_kick()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cs boolean := NEW.child_safety;
BEGIN
  IF NOT private.media_quarantine_scheduler_enabled() THEN
    RETURN NULL;
  END IF;
  IF NOT (NEW.desired IN ('quarantine', 'retain') AND NEW.state IN ('pending', 'copied', 'verified')) THEN
    RETURN NULL;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('media_quarantine_kick'), CASE WHEN v_cs THEN 1 ELSE 0 END) THEN
    RETURN NULL;   -- another transaction is kicking right now
  END IF;
  IF EXISTS (SELECT 1 FROM private.media_quarantine_dispatches d
              WHERE d.source = 'kick'
                AND (CASE WHEN v_cs THEN d.child_safety AND d.dispatched_at > clock_timestamp() - interval '5 seconds'
                          ELSE d.dispatched_at > clock_timestamp() - interval '10 seconds' END)) THEN
    RETURN NULL;
  END IF;
  PERFORM private.media_quarantine_dispatch('kick', v_cs);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'media-quarantine-scheduler: kick skipped (%)', SQLSTATE;
  RETURN NULL;
END;
$$;
CREATE TRIGGER media_quarantine_kick_queued AFTER INSERT ON private.media_quarantine
  FOR EACH ROW EXECUTE FUNCTION private.media_quarantine_kick();
CREATE TRIGGER media_quarantine_kick_child_safety AFTER UPDATE OF child_safety ON private.media_quarantine
  FOR EACH ROW WHEN (NEW.child_safety AND NOT OLD.child_safety) EXECUTE FUNCTION private.media_quarantine_kick();

-- Periodic sweep (pg_cron). Dispatches only when switched on AND work is
-- claimable; reaps dead runs; keeps 30 days of dispatch/run records.
CREATE FUNCTION private.run_media_quarantine_sweep()
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT private.media_quarantine_scheduler_enabled() THEN
    RETURN NULL;
  END IF;
  PERFORM private.media_quarantine_scheduler_reap();
  DELETE FROM private.media_quarantine_dispatches WHERE dispatched_at < clock_timestamp() - interval '720 hours';
  DELETE FROM private.media_quarantine_scheduler_runs WHERE status <> 'running' AND started_at < clock_timestamp() - interval '720 hours';
  IF NOT private.media_quarantine_claimable() THEN
    RETURN NULL;
  END IF;
  RETURN private.media_quarantine_dispatch('sweep', private.media_quarantine_claimable(true));
END;
$$;

-- ── 7. Admin visibility (read-only; codes and counts only) ──────────────────
CREATE FUNCTION public.admin_media_quarantine_scheduler_status()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM private.require_admin();
  RETURN jsonb_build_object(
    'enabled', private.media_quarantine_scheduler_enabled(),
    'sweep_active', COALESCE((SELECT j.active FROM cron.job j WHERE j.jobname = 'media-quarantine-worker'), false),
    'running', (SELECT count(*) FROM private.media_quarantine_scheduler_runs r WHERE r.status = 'running'),
    'last_completed_at', (SELECT max(r.finished_at) FROM private.media_quarantine_scheduler_runs r WHERE r.status = 'completed'),
    'last_failed_at', (SELECT max(r.finished_at) FROM private.media_quarantine_scheduler_runs r WHERE r.status IN ('failed', 'abandoned')),
    'runs_24h', (SELECT COALESCE(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
                   FROM (SELECT r.status, count(*) AS n FROM private.media_quarantine_scheduler_runs r
                          WHERE r.started_at > clock_timestamp() - interval '24 hours' GROUP BY r.status) s),
    'dispatches_24h', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                         FROM (SELECT COALESCE(d.skipped_reason, 'sent') AS k, count(*) AS n FROM private.media_quarantine_dispatches d
                                WHERE d.dispatched_at > clock_timestamp() - interval '24 hours' GROUP BY 1) s),
    'claimable', private.media_quarantine_claimable(),
    'child_safety_claimable', private.media_quarantine_claimable(true));
END;
$$;

-- ── 8. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION private.media_quarantine_scheduler_config_guard(), private.media_quarantine_scheduler_changes_guard(),
                       private.media_quarantine_scheduler_enabled(), private.media_quarantine_scheduler_stale_after(),
                       private.media_quarantine_scheduler_reap(), private.media_quarantine_claimable(boolean),
                       private.media_quarantine_dispatch(text, boolean), private.media_quarantine_kick(),
                       private.run_media_quarantine_sweep()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.media_quarantine_scheduler_begin(text),
                       public.media_quarantine_scheduler_finish(uuid, text, integer, jsonb, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_quarantine_scheduler_begin(text),
                          public.media_quarantine_scheduler_finish(uuid, text, integer, jsonb, text, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.admin_media_quarantine_scheduler_status() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_media_quarantine_scheduler_status() TO authenticated;

-- ── 9. Sweep job: created INACTIVE ──────────────────────────────────────────
-- Activation is a separate, approved operator step (runbook); the switch in
-- section 1 must ALSO be turned on before anything is dispatched.
SELECT cron.schedule('media-quarantine-worker', '* * * * *', 'SELECT private.run_media_quarantine_sweep()');
SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname = 'media-quarantine-worker';
