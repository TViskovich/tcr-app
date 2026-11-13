-- Phase 2B M4 step 5B: moderation monitoring and alerting (LOCAL; delivery OFF).
--
-- Detects moderation problems from database state, records each one as an
-- issue with a stable identity and an auditable lifecycle, and — only when
-- delivery is switched on — hands due notices to the moderation-monitor Edge
-- Function, which sends them by email (Resend) and/or a signed webhook.
--
--   1. private.moderation_monitoring_evaluate() (read-only) reports every
--      condition that is true right now: code, count, oldest timestamp.
--      Database job state is the evidence of progress. Nothing here claims a
--      file is gone from a CDN or the physical object store; conditions that
--      need a hosted Storage-origin probe are catalogued as detection
--      'origin_probe' and are never opened from SQL.
--   2. private.moderation_monitoring_check() turns that into issues: opens
--      one issue per condition (at most one open issue per identity, enforced
--      by a unique index), records when it worsens, resolves it when the
--      condition clears. One check at a time (advisory lock).
--   3. Notices: critical and high issues are notified when they open, when
--      they worsen (at most hourly), as a reminder after 24 h (child safety:
--      hourly), and when they resolve. Routine issues travel only in a daily
--      summary. Acknowledging an issue silences ordinary reminders but never
--      resolves it, and is cleared if the issue worsens.
--   4. Delivery is OFF by default (moderation_monitoring_state.
--      delivery_enabled = false); issues are still recorded and visible to
--      admins. The pg_cron job "moderation-monitor" (every 5 minutes) is
--      created INACTIVE.
--
-- Privacy: issues, notices and summaries carry codes, categories, severities,
-- counts and timestamps only — never reporters, collectors, account or job
-- ids, paths, hashes, text, evidence or notes.

-- ── 1. Catalogue of issue codes ─────────────────────────────────────────────
CREATE TABLE private.moderation_monitoring_codes (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z_]{1,48}$'),
  category    text NOT NULL CHECK (category IN ('quarantine', 'integrity', 'storage', 'scheduler', 'reports', 'restore', 'purge')),
  severity    text NOT NULL CHECK (severity IN ('critical', 'high', 'routine')),
  detection   text NOT NULL CHECK (detection IN ('sql', 'origin_probe')),
  admin_ref   text NOT NULL CHECK (admin_ref ~ '^/admin/[a-z/-]{1,60}$'),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200)
);
INSERT INTO private.moderation_monitoring_codes (code, category, severity, detection, admin_ref, description) VALUES
  ('child_safety_unquarantined',    'quarantine', 'critical', 'sql',          '/admin/moderation/quarantine',
   'Child-safety media not yet quarantined more than 5 minutes after the decision.'),
  ('public_removal_overdue',        'quarantine', 'critical', 'sql',          '/admin/moderation/quarantine',
   'Public media still at its public source more than 15 minutes after a removal decision.'),
  ('integrity_failure',             'integrity',  'critical', 'sql',          '/admin/moderation/quarantine',
   'A checksum, copy or object-identity check failed and was flagged for review.'),
  ('public_origin_reachable',       'storage',    'critical', 'origin_probe', '/admin/moderation/quarantine',
   'A removed public original still served by the Storage origin or CDN (needs a hosted origin probe; not detectable in SQL).'),
  ('scheduler_stalled',             'scheduler',  'high',     'sql',          '/admin/moderation/quarantine',
   'The quarantine scheduler is on, work has waited over 10 minutes, and no scheduled run completed in that time.'),
  ('quarantine_attempts_exhausted', 'quarantine', 'high',     'sql',          '/admin/moderation/quarantine',
   'Quarantine jobs used their whole retry budget and need an admin.'),
  ('quarantine_needs_attention',    'quarantine', 'high',     'sql',          '/admin/moderation/quarantine',
   'Quarantine jobs flagged for an admin for another reason.'),
  ('urgent_reports_overdue',        'reports',    'high',     'sql',          '/admin/moderation/reports',
   'Urgent reports waiting longer than the review threshold.'),
  ('restore_conflict',              'restore',    'routine',  'sql',          '/admin/moderation/quarantine',
   'Restorations blocked by a conflict (destination occupied, owner unavailable or held again).'),
  ('quarantine_lease_stale',        'quarantine', 'routine',  'sql',          '/admin/moderation/quarantine',
   'Non-child-safety quarantine leases expired over 10 minutes ago and were not picked up again.'),
  ('purge_approval_pending',        'purge',      'routine',  'sql',          '/admin/moderation/retention',
   'Manual purge runs waiting for a second administrator''s approval.'),
  ('purge_run_incomplete',          'purge',      'routine',  'sql',          '/admin/moderation/retention',
   'Manual purge runs that expired, ran out of time, or have items needing attention.');

-- ── 2. Issues and their history ─────────────────────────────────────────────
-- issue_key is the issue's stable identity. Every condition here is
-- aggregate (a count of affected records, never which ones), so the key is
-- the code; the format leaves room for a ':<scope>' suffix.
CREATE TABLE private.moderation_monitoring_issues (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_key           text NOT NULL CHECK (issue_key ~ '^[a-z_]{1,48}(:[a-z0-9_]{1,32})?$'),
  code                text NOT NULL REFERENCES private.moderation_monitoring_codes (code),
  severity            text NOT NULL CHECK (severity IN ('critical', 'high', 'routine')),
  opened_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at         timestamptz,
  item_count          integer NOT NULL CHECK (item_count >= 0),
  peak_count          integer NOT NULL CHECK (peak_count >= 0),
  oldest_at           timestamptz,
  acknowledged_at     timestamptz,
  acknowledged_by     uuid,                 -- admin user id; no FK, so history survives account deletion
  notified_at         timestamptz,          -- last delivered opened/worsened/reminder notice
  notified_count      integer,
  resolve_notified_at timestamptz,
  claim_id            uuid,                 -- delivery in flight
  claimed_kind        text CHECK (claimed_kind IN ('opened', 'worsened', 'reminder', 'resolved')),
  last_attempt_at     timestamptz,
  delivery_failures   integer NOT NULL DEFAULT 0 CHECK (delivery_failures >= 0),
  last_delivery_error text CHECK (last_delivery_error ~ '^[a-z_]{1,48}$'),
  CONSTRAINT moderation_monitoring_issues_ack CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  CONSTRAINT moderation_monitoring_issues_claim CHECK ((claim_id IS NULL) = (claimed_kind IS NULL)),
  CONSTRAINT moderation_monitoring_issues_resolved CHECK (resolved_at IS NULL OR resolved_at >= opened_at)
);
-- One open issue per identity.
CREATE UNIQUE INDEX moderation_monitoring_one_open ON private.moderation_monitoring_issues (issue_key) WHERE resolved_at IS NULL;
CREATE INDEX moderation_monitoring_issues_resolved ON private.moderation_monitoring_issues (resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX moderation_monitoring_issues_claim ON private.moderation_monitoring_issues (claim_id) WHERE claim_id IS NOT NULL;

CREATE TABLE private.moderation_monitoring_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id    uuid NOT NULL REFERENCES private.moderation_monitoring_issues (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  event       text NOT NULL CHECK (event IN ('opened', 'worsened', 'acknowledged', 'resolved', 'notice_claimed', 'notice_delivered', 'notice_failed')),
  item_count  integer CHECK (item_count >= 0),
  notice_kind text CHECK (notice_kind IN ('opened', 'worsened', 'reminder', 'resolved')),
  error_code  text CHECK (error_code ~ '^[a-z_]{1,48}$'),
  actor_id    uuid                       -- the acknowledging admin; NULL for the monitor itself
);
CREATE INDEX moderation_monitoring_events_issue ON private.moderation_monitoring_events (issue_id, id);

-- One row per delivery attempt (its id is the webhook delivery id).
CREATE TABLE private.moderation_monitoring_deliveries (
  id               uuid PRIMARY KEY,
  claimed_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at      timestamptz,
  notice_count     integer NOT NULL CHECK (notice_count BETWEEN 0 AND 20),
  includes_summary boolean NOT NULL DEFAULT false,
  outcome          text NOT NULL DEFAULT 'claimed' CHECK (outcome IN ('claimed', 'delivered', 'failed')),
  channels         text[] NOT NULL DEFAULT '{}' CHECK (channels <@ ARRAY['email', 'webhook']),
  error_code       text CHECK (error_code ~ '^[a-z_]{1,48}$')
);
CREATE INDEX moderation_monitoring_deliveries_at ON private.moderation_monitoring_deliveries (claimed_at DESC);

CREATE TABLE private.moderation_monitoring_dispatches (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispatched_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id     bigint,
  skipped_reason text CHECK (skipped_reason IN ('not_configured', 'dispatch_failed')),
  CONSTRAINT moderation_monitoring_dispatches_shape CHECK ((request_id IS NULL) = (skipped_reason IS NOT NULL))
);
CREATE INDEX moderation_monitoring_dispatches_at ON private.moderation_monitoring_dispatches (dispatched_at DESC);

-- ── 3. State and the delivery switch ────────────────────────────────────────
CREATE TABLE private.moderation_monitoring_state (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  delivery_enabled       boolean NOT NULL DEFAULT false,
  -- Placeholder pending an approved review target (operational decision).
  urgent_report_minutes  integer NOT NULL DEFAULT 60 CHECK (urgent_report_minutes BETWEEN 5 AND 1440),
  last_check_at          timestamptz,
  last_delivery_at       timestamptz,
  last_delivery_error    text CHECK (last_delivery_error ~ '^[a-z_]{1,48}$'),
  last_delivery_channels text[] NOT NULL DEFAULT '{}',
  summary_sent_at        timestamptz,
  summary_claim_id       uuid,
  summary_claimed_at     timestamptz,
  summary_failed         boolean NOT NULL DEFAULT false,
  email_channel          text CHECK (email_channel IN ('configured', 'not_configured', 'missing_recipients', 'too_many_recipients', 'missing_sender')),
  webhook_channel        text CHECK (webhook_channel IN ('configured', 'not_configured', 'invalid_url', 'missing_secret')),
  channels_reported_at   timestamptz,
  changed_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_by             text NOT NULL DEFAULT session_user
);
INSERT INTO private.moderation_monitoring_state DEFAULT VALUES;

CREATE TABLE private.moderation_monitoring_config_changes (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changed_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivery_enabled      boolean NOT NULL,
  urgent_report_minutes integer NOT NULL,
  changed_by            text NOT NULL
);

ALTER TABLE private.moderation_monitoring_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.moderation_monitoring_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.moderation_monitoring_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.moderation_monitoring_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.moderation_monitoring_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.moderation_monitoring_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.moderation_monitoring_config_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.moderation_monitoring_codes, private.moderation_monitoring_issues, private.moderation_monitoring_events,
                    private.moderation_monitoring_deliveries, private.moderation_monitoring_dispatches,
                    private.moderation_monitoring_state, private.moderation_monitoring_config_changes
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. Integrity guards ─────────────────────────────────────────────────────
-- History rows are append-only; the monitor's own bounded pruning (and the
-- cascade from a pruned issue) is the only deletion, flagged for the
-- duration of that statement.
CREATE FUNCTION private.moderation_monitoring_pruning()
RETURNS boolean LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT current_setting('cachecase.moderation_monitoring_prune', true) IS NOT DISTINCT FROM 'on' $$;

CREATE FUNCTION private.moderation_monitoring_history_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND private.moderation_monitoring_pruning() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'moderation_monitoring_history_immutable' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER moderation_monitoring_events_append_only BEFORE UPDATE OR DELETE ON private.moderation_monitoring_events
  FOR EACH ROW EXECUTE FUNCTION private.moderation_monitoring_history_guard();
CREATE TRIGGER moderation_monitoring_config_changes_append_only BEFORE UPDATE OR DELETE ON private.moderation_monitoring_config_changes
  FOR EACH ROW EXECUTE FUNCTION private.moderation_monitoring_history_guard();
CREATE TRIGGER moderation_monitoring_codes_fixed BEFORE INSERT OR UPDATE OR DELETE ON private.moderation_monitoring_codes
  FOR EACH ROW EXECUTE FUNCTION private.moderation_monitoring_history_guard();

CREATE FUNCTION private.moderation_monitoring_no_truncate()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'moderation_monitoring_history_immutable' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER moderation_monitoring_events_no_truncate BEFORE TRUNCATE ON private.moderation_monitoring_events
  FOR EACH STATEMENT EXECUTE FUNCTION private.moderation_monitoring_no_truncate();
CREATE TRIGGER moderation_monitoring_issues_no_truncate BEFORE TRUNCATE ON private.moderation_monitoring_issues
  FOR EACH STATEMENT EXECUTE FUNCTION private.moderation_monitoring_no_truncate();
CREATE TRIGGER moderation_monitoring_codes_no_truncate BEFORE TRUNCATE ON private.moderation_monitoring_codes
  FOR EACH STATEMENT EXECUTE FUNCTION private.moderation_monitoring_no_truncate();
CREATE TRIGGER moderation_monitoring_config_changes_no_truncate BEFORE TRUNCATE ON private.moderation_monitoring_config_changes
  FOR EACH STATEMENT EXECUTE FUNCTION private.moderation_monitoring_no_truncate();
CREATE TRIGGER moderation_monitoring_state_no_truncate BEFORE TRUNCATE ON private.moderation_monitoring_state
  FOR EACH STATEMENT EXECUTE FUNCTION private.moderation_monitoring_no_truncate();

-- An issue's identity and history are fixed; a resolved issue never reopens
-- (a recurrence is a new issue). Deleted only by pruning.
CREATE FUNCTION private.moderation_monitoring_issue_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF private.moderation_monitoring_pruning() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'moderation_monitoring_history_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.issue_key IS DISTINCT FROM OLD.issue_key OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.peak_count < OLD.peak_count
     OR (OLD.resolved_at IS NOT NULL AND (NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
         OR NEW.item_count IS DISTINCT FROM OLD.item_count OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at
         OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)) THEN
    RAISE EXCEPTION 'moderation_monitoring_history_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER moderation_monitoring_issues_guard BEFORE UPDATE OR DELETE ON private.moderation_monitoring_issues
  FOR EACH ROW EXECUTE FUNCTION private.moderation_monitoring_issue_guard();

CREATE FUNCTION private.moderation_monitoring_state_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'moderation_monitoring_state_fixed' USING ERRCODE = '42501';
  END IF;
  IF NEW.delivery_enabled IS DISTINCT FROM OLD.delivery_enabled OR NEW.urgent_report_minutes IS DISTINCT FROM OLD.urgent_report_minutes THEN
    NEW.changed_at := clock_timestamp();
    NEW.changed_by := session_user;
    INSERT INTO private.moderation_monitoring_config_changes (delivery_enabled, urgent_report_minutes, changed_by)
    VALUES (NEW.delivery_enabled, NEW.urgent_report_minutes, session_user);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER moderation_monitoring_state_update BEFORE UPDATE ON private.moderation_monitoring_state
  FOR EACH ROW EXECUTE FUNCTION private.moderation_monitoring_state_guard();
CREATE TRIGGER moderation_monitoring_state_fixed BEFORE INSERT OR DELETE ON private.moderation_monitoring_state
  FOR EACH ROW EXECUTE FUNCTION private.moderation_monitoring_state_guard();

-- ── 5. Evaluation (read-only) ───────────────────────────────────────────────
-- Error codes recorded on flagged jobs, by meaning.
CREATE FUNCTION private.moderation_monitoring_integrity_errors()
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT ARRAY['hash_mismatch', 'destination_conflict', 'source_changed', 'unverified_copy', 'copy_missing',
                   'invalid_source', 'restore_verify_failed', 'copy_size_mismatch',
                   'object_reappeared', 'object_missing_unverified', 'unexpected_target'] $$;
CREATE FUNCTION private.moderation_monitoring_restore_errors()
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT ARRAY['destination_occupied', 'owner_unavailable', 'held_again'] $$;

-- Every SQL-detectable condition that holds right now (count > 0 only).
CREATE FUNCTION private.moderation_monitoring_evaluate()
RETURNS TABLE (code text, item_count integer, oldest_at timestamptz)
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
    SELECT j.id, GREATEST(j.created_at, COALESCE(j.next_attempt_at, j.created_at), COALESCE(j.lease_expires_at, j.created_at)) AS waiting_since
      FROM private.media_quarantine j
     WHERE NOT j.needs_attention
       AND (j.lease_expires_at IS NULL OR j.lease_expires_at < clock_timestamp())
       AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= clock_timestamp())
       AND ((j.desired IN ('quarantine', 'retain') AND j.state IN ('pending', 'copied', 'verified'))
            OR (j.desired = 'restore' AND j.state IN ('copied', 'verified')))
  ),
  purge_attention AS (
    SELECT i.run_id, i.updated_at, i.last_error = ANY (private.moderation_monitoring_integrity_errors()) AS integrity
      FROM private.retention_purge_items i WHERE i.state = 'needs_attention'
  ),
  c AS (
    SELECT 'child_safety_unquarantined' AS code, count(*)::int AS n, min(created_at) AS oldest
      FROM q WHERE unremoved AND child_safety AND created_at < clock_timestamp() - interval '5 minutes'
    UNION ALL
    SELECT 'public_removal_overdue', count(*)::int, min(created_at)
      FROM q WHERE unremoved AND NOT child_safety AND public_source AND created_at < clock_timestamp() - interval '15 minutes'
    UNION ALL
    SELECT 'integrity_failure', (SELECT count(*) FROM q WHERE integrity)::int + (SELECT count(*) FROM purge_attention WHERE integrity)::int,
           LEAST((SELECT min(updated_at) FROM q WHERE integrity), (SELECT min(updated_at) FROM purge_attention WHERE integrity))
    UNION ALL
    SELECT 'scheduler_stalled', count(*)::int, min(waiting_since)
      FROM claimable
     WHERE private.media_quarantine_scheduler_enabled()
       AND EXISTS (SELECT 1 FROM claimable c2 WHERE c2.waiting_since < clock_timestamp() - interval '10 minutes')
       AND NOT EXISTS (SELECT 1 FROM private.media_quarantine_scheduler_runs r
                        WHERE r.status = 'completed' AND r.finished_at > clock_timestamp() - interval '10 minutes')
    UNION ALL
    SELECT 'quarantine_attempts_exhausted', count(*)::int, min(updated_at)
      FROM q WHERE needs_attention AND NOT integrity AND NOT restore_conflict
       AND (last_error = 'attempts_exhausted' OR attempts >= private.media_quarantine_max_attempts())
    UNION ALL
    SELECT 'quarantine_needs_attention', count(*)::int, min(updated_at)
      FROM q WHERE needs_attention AND NOT integrity AND NOT restore_conflict
       AND last_error IS DISTINCT FROM 'attempts_exhausted' AND attempts < private.media_quarantine_max_attempts()
    UNION ALL
    SELECT 'urgent_reports_overdue', count(*)::int, min(r.created_at)
      FROM public.content_reports r, s
     WHERE r.priority = 'urgent' AND r.status IN ('open', 'reviewing')
       AND r.created_at < clock_timestamp() - make_interval(mins => s.urgent_report_minutes)
    UNION ALL
    SELECT 'restore_conflict', count(*)::int, min(updated_at) FROM q WHERE restore_conflict
    UNION ALL
    SELECT 'quarantine_lease_stale', count(*)::int, min(lease_expires_at)
      FROM q WHERE lease_token IS NOT NULL AND NOT child_safety AND lease_expires_at < clock_timestamp() - interval '10 minutes'
    UNION ALL
    SELECT 'purge_approval_pending', count(*)::int, min(r.prepared_at)
      FROM private.retention_purge_runs r WHERE r.status = 'prepared' AND r.approval_expires_at > clock_timestamp()
    UNION ALL
    SELECT 'purge_run_incomplete', count(*)::int, min(COALESCE(r.closed_at, r.execution_expires_at))
      FROM private.retention_purge_runs r
     WHERE (r.status = 'expired' AND r.closed_at > clock_timestamp() - interval '168 hours')
        OR (r.status = 'approved' AND r.execution_expires_at < clock_timestamp())
        OR EXISTS (SELECT 1 FROM purge_attention p WHERE p.run_id = r.id AND NOT p.integrity)
  )
  SELECT c.code, c.n, c.oldest FROM c WHERE c.n > 0;
$$;

-- ── 6. Lifecycle ────────────────────────────────────────────────────────────
-- One check at a time; a concurrent check returns {skipped: busy}.
CREATE FUNCTION private.moderation_monitoring_check()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r record;
  i private.moderation_monitoring_issues;
  v_keys text[] := '{}';
  v_opened integer := 0;
  v_worsened integer := 0;
  v_resolved integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('moderation_monitoring_check')) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'busy');
  END IF;
  FOR r IN SELECT e.code, e.item_count, e.oldest_at, c.severity
             FROM private.moderation_monitoring_evaluate() e
             JOIN private.moderation_monitoring_codes c ON c.code = e.code AND c.detection = 'sql'
            ORDER BY e.code LOOP
    v_keys := v_keys || r.code;
    SELECT * INTO i FROM private.moderation_monitoring_issues x WHERE x.issue_key = r.code AND x.resolved_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO private.moderation_monitoring_issues (issue_key, code, severity, item_count, peak_count, oldest_at)
      VALUES (r.code, r.code, r.severity, r.item_count, r.item_count, r.oldest_at) RETURNING * INTO i;
      INSERT INTO private.moderation_monitoring_events (issue_id, event, item_count) VALUES (i.id, 'opened', r.item_count);
      v_opened := v_opened + 1;
    ELSE
      UPDATE private.moderation_monitoring_issues
         SET last_seen_at = clock_timestamp(), item_count = r.item_count, oldest_at = r.oldest_at,
             peak_count = GREATEST(peak_count, r.item_count),
             -- worse than ever before: an acknowledgement no longer applies
             acknowledged_at = CASE WHEN r.item_count > i.peak_count THEN NULL ELSE acknowledged_at END,
             acknowledged_by = CASE WHEN r.item_count > i.peak_count THEN NULL ELSE acknowledged_by END
       WHERE id = i.id;
      IF r.item_count > i.peak_count THEN
        INSERT INTO private.moderation_monitoring_events (issue_id, event, item_count) VALUES (i.id, 'worsened', r.item_count);
        v_worsened := v_worsened + 1;
      END IF;
    END IF;
  END LOOP;

  WITH res AS (
    UPDATE private.moderation_monitoring_issues
       SET resolved_at = clock_timestamp()
     WHERE resolved_at IS NULL AND NOT (issue_key = ANY (v_keys))
    RETURNING id)
  INSERT INTO private.moderation_monitoring_events (issue_id, event, item_count) SELECT id, 'resolved', 0 FROM res;
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  -- Bounded history: resolved issues (and their events) after 90 days once
  -- nothing is owed to them; delivery and dispatch records after 30 days.
  PERFORM set_config('cachecase.moderation_monitoring_prune', 'on', true);
  DELETE FROM private.moderation_monitoring_issues
   WHERE resolved_at < clock_timestamp() - interval '2160 hours'
     AND (notified_at IS NULL OR resolve_notified_at IS NOT NULL) AND claim_id IS NULL;
  PERFORM set_config('cachecase.moderation_monitoring_prune', 'off', true);
  DELETE FROM private.moderation_monitoring_deliveries WHERE claimed_at < clock_timestamp() - interval '720 hours';
  DELETE FROM private.moderation_monitoring_dispatches WHERE dispatched_at < clock_timestamp() - interval '720 hours';

  UPDATE private.moderation_monitoring_state SET last_check_at = clock_timestamp() WHERE id;
  RETURN jsonb_build_object('skipped', false, 'opened', v_opened, 'worsened', v_worsened, 'resolved', v_resolved,
                            'open', (SELECT count(*) FROM private.moderation_monitoring_issues WHERE resolved_at IS NULL));
END;
$$;

-- Which notice an issue is owed, if any.
--   routine issues: none (daily summary only);
--   a claim in flight blocks for 5 minutes; a failed delivery backs off
--   15 min, 30, 60, 120, 240, then every 6 h;
--   open:      'opened' once; 'worsened' when its count rose since the last
--              notice (at most hourly); 'reminder' hourly for child safety,
--              otherwise after 24 h (not while acknowledged, unless critical);
--   resolved:  'resolved', only if an opening notice was delivered.
CREATE FUNCTION private.moderation_monitoring_notice_due(i private.moderation_monitoring_issues)
RETURNS text
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN i.severity = 'routine' THEN NULL
    WHEN i.claim_id IS NOT NULL AND i.last_attempt_at > clock_timestamp() - interval '5 minutes' THEN NULL
    WHEN i.last_delivery_error IS NOT NULL AND i.last_attempt_at > clock_timestamp()
         - LEAST(interval '6 hours', interval '15 minutes' * power(2, GREATEST(LEAST(i.delivery_failures, 6) - 1, 0))) THEN NULL
    WHEN i.resolved_at IS NULL AND i.notified_at IS NULL THEN 'opened'
    WHEN i.resolved_at IS NULL AND i.item_count > COALESCE(i.notified_count, 0)
         AND i.notified_at < clock_timestamp() - interval '1 hour' THEN 'worsened'
    WHEN i.resolved_at IS NULL AND i.code = 'child_safety_unquarantined'
         AND i.notified_at < clock_timestamp() - interval '1 hour' THEN 'reminder'
    WHEN i.resolved_at IS NULL AND (i.acknowledged_at IS NULL OR i.severity = 'critical')
         AND i.notified_at < clock_timestamp() - interval '24 hours' THEN 'reminder'
    WHEN i.resolved_at IS NOT NULL AND i.notified_at IS NOT NULL AND i.resolve_notified_at IS NULL THEN 'resolved'
  END;
$$;

-- The daily summary is owed when delivery is on, issues are open, and none
-- was delivered in 24 h (a claim blocks 5 minutes; a failure backs off 1 h).
CREATE FUNCTION private.moderation_monitoring_summary_due()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.delivery_enabled
     AND EXISTS (SELECT 1 FROM private.moderation_monitoring_issues i WHERE i.resolved_at IS NULL)
     AND (s.summary_sent_at IS NULL OR s.summary_sent_at < clock_timestamp() - interval '24 hours')
     AND (s.summary_claimed_at IS NULL OR s.summary_claimed_at < clock_timestamp()
          - CASE WHEN s.summary_failed THEN interval '1 hour' ELSE interval '5 minutes' END)
    FROM private.moderation_monitoring_state s;
$$;

-- ── 7. Delivery (moderation-monitor Edge Function; service role only) ───────
-- Runs a check, then — only when delivery is on — claims up to 20 due
-- notices (critical first) and, if owed, the daily summary. The returned
-- fields are the ONLY data that may leave the database.
CREATE FUNCTION public.moderation_monitoring_claim()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_check jsonb;
  v_claim uuid := gen_random_uuid();
  v_notices jsonb;
  v_summary jsonb;
  v_count integer;
BEGIN
  v_check := private.moderation_monitoring_check();
  IF (v_check ->> 'skipped')::boolean THEN
    RETURN jsonb_build_object('status', 'busy');
  END IF;
  IF NOT (SELECT delivery_enabled FROM private.moderation_monitoring_state) THEN
    RETURN jsonb_build_object('status', 'disabled', 'open', v_check -> 'open');
  END IF;

  WITH due AS (
    SELECT i.id, private.moderation_monitoring_notice_due(i) AS kind
      FROM private.moderation_monitoring_issues i
     WHERE private.moderation_monitoring_notice_due(i) IS NOT NULL
     ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, i.opened_at
     LIMIT 20
     FOR UPDATE SKIP LOCKED),
  claimed AS (
    UPDATE private.moderation_monitoring_issues i
       SET claim_id = v_claim, claimed_kind = due.kind, last_attempt_at = clock_timestamp()
      FROM due WHERE i.id = due.id
    RETURNING i.id, i.code, i.severity, i.item_count, i.oldest_at, i.claimed_kind, i.opened_at),
  ev AS (
    INSERT INTO private.moderation_monitoring_events (issue_id, event, item_count, notice_kind)
    SELECT id, 'notice_claimed', item_count, claimed_kind FROM claimed)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'kind', cl.claimed_kind, 'code', cl.code, 'category', c.category, 'severity', cl.severity,
           'count', cl.item_count, 'oldest_at', cl.oldest_at, 'admin_ref', c.admin_ref)
           ORDER BY CASE cl.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, cl.opened_at), '[]'::jsonb),
         count(*)
    INTO v_notices, v_count
    FROM claimed cl JOIN private.moderation_monitoring_codes c ON c.code = cl.code;

  IF private.moderation_monitoring_summary_due() THEN
    UPDATE private.moderation_monitoring_state SET summary_claim_id = v_claim, summary_claimed_at = clock_timestamp() WHERE id;
    SELECT jsonb_agg(jsonb_build_object('code', i.code, 'category', c.category, 'severity', i.severity,
                                        'count', i.item_count, 'oldest_at', i.oldest_at, 'acknowledged', i.acknowledged_at IS NOT NULL)
                     ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, i.code)
      INTO v_summary
      FROM private.moderation_monitoring_issues i JOIN private.moderation_monitoring_codes c ON c.code = i.code
     WHERE i.resolved_at IS NULL;
  END IF;

  IF v_count = 0 AND v_summary IS NULL THEN
    RETURN jsonb_build_object('status', 'ok', 'notices', '[]'::jsonb, 'summary', NULL);
  END IF;
  INSERT INTO private.moderation_monitoring_deliveries (id, notice_count, includes_summary)
  VALUES (v_claim, v_count, v_summary IS NOT NULL);
  RETURN jsonb_build_object('status', 'ok', 'claim_id', v_claim, 'claimed_at', clock_timestamp(),
                            'notices', v_notices, 'summary', v_summary);
END;
$$;

-- Outcome of a claim. p_error NULL = delivered (acknowledged by at least one
-- channel named in p_channels).
CREATE FUNCTION public.moderation_monitoring_record_delivery(p_claim_id uuid, p_error text, p_channels text[] DEFAULT '{}')
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_rows integer;
  v_ok boolean := p_error IS NULL;
BEGIN
  IF p_claim_id IS NULL OR (p_error IS NOT NULL AND p_error !~ '^[a-z_]{1,48}$')
     OR NOT (COALESCE(p_channels, '{}') <@ ARRAY['email', 'webhook'])
     OR (v_ok AND cardinality(COALESCE(p_channels, '{}')) = 0)
     OR NOT EXISTS (SELECT 1 FROM private.moderation_monitoring_deliveries d WHERE d.id = p_claim_id AND d.outcome = 'claimed') THEN
    RAISE EXCEPTION 'invalid_delivery_report' USING ERRCODE = '22023';
  END IF;
  WITH done AS (
    UPDATE private.moderation_monitoring_issues
       SET notified_at = CASE WHEN v_ok AND claimed_kind <> 'resolved' THEN clock_timestamp() ELSE notified_at END,
           notified_count = CASE WHEN v_ok AND claimed_kind <> 'resolved' THEN item_count ELSE notified_count END,
           resolve_notified_at = CASE WHEN v_ok AND claimed_kind = 'resolved' THEN clock_timestamp() ELSE resolve_notified_at END,
           delivery_failures = CASE WHEN v_ok THEN 0 ELSE delivery_failures + 1 END,
           last_delivery_error = p_error,
           claim_id = NULL, claimed_kind = NULL
     WHERE claim_id = p_claim_id
    RETURNING id),
  ev AS (
    INSERT INTO private.moderation_monitoring_events (issue_id, event, error_code)
    SELECT id, CASE WHEN v_ok THEN 'notice_delivered' ELSE 'notice_failed' END, p_error FROM done)
  SELECT count(*) INTO v_rows FROM done;
  UPDATE private.moderation_monitoring_state
     SET summary_sent_at = CASE WHEN summary_claim_id = p_claim_id AND v_ok THEN clock_timestamp() ELSE summary_sent_at END,
         summary_failed = CASE WHEN summary_claim_id = p_claim_id THEN NOT v_ok ELSE summary_failed END,
         summary_claim_id = CASE WHEN summary_claim_id = p_claim_id THEN NULL ELSE summary_claim_id END,
         last_delivery_at = CASE WHEN v_ok THEN clock_timestamp() ELSE last_delivery_at END,
         last_delivery_error = p_error,
         last_delivery_channels = CASE WHEN v_ok THEN COALESCE(p_channels, '{}') ELSE last_delivery_channels END
   WHERE id;
  UPDATE private.moderation_monitoring_deliveries
     SET finished_at = clock_timestamp(), outcome = CASE WHEN v_ok THEN 'delivered' ELSE 'failed' END,
         channels = COALESCE(p_channels, '{}'), error_code = p_error
   WHERE id = p_claim_id;
  RETURN v_rows;
END;
$$;

-- moderation-monitor reports its channels (status codes only).
CREATE FUNCTION public.moderation_monitoring_report_channels(p_email text, p_webhook text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_email IS NULL OR p_email NOT IN ('configured', 'not_configured', 'missing_recipients', 'too_many_recipients', 'missing_sender')
     OR p_webhook IS NULL OR p_webhook NOT IN ('configured', 'not_configured', 'invalid_url', 'missing_secret') THEN
    RAISE EXCEPTION 'invalid_channel_report' USING ERRCODE = '22023';
  END IF;
  UPDATE private.moderation_monitoring_state
     SET email_channel = p_email, webhook_channel = p_webhook, channels_reported_at = clock_timestamp()
   WHERE id;
END;
$$;

-- ── 8. Scheduled call (pg_cron, every 5 minutes, INACTIVE) ──────────────────
-- Checks in SQL (issues are recorded even when Edge Functions are down);
-- calls moderation-monitor only when delivery is on AND something is owed
-- (or the channel report is missing / older than 6 h). pg_net sends only
-- after COMMIT.
CREATE FUNCTION private.run_moderation_monitor()
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
  v_request bigint;
BEGIN
  PERFORM private.moderation_monitoring_check();
  IF NOT (SELECT delivery_enabled FROM private.moderation_monitoring_state) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM private.moderation_monitoring_issues i WHERE private.moderation_monitoring_notice_due(i) IS NOT NULL)
     AND NOT private.moderation_monitoring_summary_due()
     AND EXISTS (SELECT 1 FROM private.moderation_monitoring_state WHERE channels_reported_at > clock_timestamp() - interval '6 hours') THEN
    RETURN NULL;
  END IF;
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'moderation_monitor_secret' LIMIT 1;
  IF v_url IS NULL OR v_url NOT LIKE 'http%' OR v_secret IS NULL OR length(v_secret) < 32 THEN
    RAISE LOG 'moderation-monitor: project_url / moderation_monitor_secret not configured in Vault; not dispatched';
    INSERT INTO private.moderation_monitoring_dispatches (skipped_reason) VALUES ('not_configured');
    RETURN NULL;
  END IF;
  BEGIN
    v_request := net.http_post(
      url := rtrim(v_url, '/') || '/functions/v1/moderation-monitor',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'moderation-monitor: dispatch failed (%)', SQLSTATE;
    INSERT INTO private.moderation_monitoring_dispatches (skipped_reason) VALUES ('dispatch_failed');
    RETURN NULL;
  END;
  INSERT INTO private.moderation_monitoring_dispatches (request_id) VALUES (v_request);
  RETURN v_request;
END;
$$;

-- ── 9. Admin operations ─────────────────────────────────────────────────────
-- Current state for admins (runs a check first, so open critical issues are
-- visible even with delivery off or failing). Issue ids appear here for
-- acknowledgement only; they never leave in alerts.
CREATE FUNCTION public.admin_moderation_monitoring_overview()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  s private.moderation_monitoring_state;
BEGIN
  PERFORM private.require_admin();
  PERFORM private.moderation_monitoring_check();
  SELECT * INTO s FROM private.moderation_monitoring_state;
  RETURN jsonb_build_object(
    'delivery_enabled', s.delivery_enabled,
    'monitor_active', COALESCE((SELECT j.active FROM cron.job j WHERE j.jobname = 'moderation-monitor'), false),
    'urgent_report_minutes', s.urgent_report_minutes,
    'channels', jsonb_build_object('email', COALESCE(s.email_channel, 'unknown'), 'webhook', COALESCE(s.webhook_channel, 'unknown'),
                                   'reported_at', s.channels_reported_at),
    'last_check_at', s.last_check_at,
    'last_delivery_at', s.last_delivery_at,
    'last_delivery_error', s.last_delivery_error,
    'summary_sent_at', s.summary_sent_at,
    'open', COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'id', i.id, 'code', i.code, 'category', c.category, 'severity', i.severity, 'count', i.item_count,
               'peak_count', i.peak_count, 'oldest_at', i.oldest_at, 'opened_at', i.opened_at, 'last_seen_at', i.last_seen_at,
               'acknowledged_at', i.acknowledged_at, 'notified_at', i.notified_at, 'last_delivery_error', i.last_delivery_error,
               'admin_ref', c.admin_ref)
               ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, i.opened_at)
             FROM private.moderation_monitoring_issues i JOIN private.moderation_monitoring_codes c ON c.code = i.code
            WHERE i.resolved_at IS NULL), '[]'::jsonb),
    'resolved_24h', (SELECT count(*) FROM private.moderation_monitoring_issues i WHERE i.resolved_at > clock_timestamp() - interval '24 hours'),
    'needs_origin_probe', (SELECT jsonb_agg(c.code ORDER BY c.code) FROM private.moderation_monitoring_codes c WHERE c.detection = 'origin_probe'));
END;
$$;

-- Acknowledge = "an admin is on it". Never resolves the issue; ordinary
-- reminders pause until it worsens or resolves; critical reminders continue.
CREATE FUNCTION public.admin_acknowledge_moderation_issue(p_issue_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid;
  i private.moderation_monitoring_issues;
BEGIN
  v_admin := private.require_admin();
  SELECT * INTO i FROM private.moderation_monitoring_issues x WHERE x.id = p_issue_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF i.resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_resolved');
  END IF;
  IF i.acknowledged_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'acknowledged', true, 'resolved', false, 'changed', false);
  END IF;
  UPDATE private.moderation_monitoring_issues SET acknowledged_at = clock_timestamp(), acknowledged_by = v_admin WHERE id = i.id;
  INSERT INTO private.moderation_monitoring_events (issue_id, event, item_count, actor_id) VALUES (i.id, 'acknowledged', i.item_count, v_admin);
  RETURN jsonb_build_object('ok', true, 'acknowledged', true, 'resolved', false, 'changed', true);
END;
$$;

-- ── 10. Privileges ──────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION private.moderation_monitoring_pruning(), private.moderation_monitoring_history_guard(),
                       private.moderation_monitoring_no_truncate(), private.moderation_monitoring_issue_guard(),
                       private.moderation_monitoring_state_guard(), private.moderation_monitoring_integrity_errors(),
                       private.moderation_monitoring_restore_errors(), private.moderation_monitoring_evaluate(),
                       private.moderation_monitoring_check(), private.moderation_monitoring_notice_due(private.moderation_monitoring_issues),
                       private.moderation_monitoring_summary_due(), private.run_moderation_monitor()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.moderation_monitoring_claim(), public.moderation_monitoring_record_delivery(uuid, text, text[]),
                       public.moderation_monitoring_report_channels(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderation_monitoring_claim(), public.moderation_monitoring_record_delivery(uuid, text, text[]),
                          public.moderation_monitoring_report_channels(text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.admin_moderation_monitoring_overview(), public.admin_acknowledge_moderation_issue(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_moderation_monitoring_overview(), public.admin_acknowledge_moderation_issue(uuid)
  TO authenticated;

-- ── 11. Monitor job: created INACTIVE ───────────────────────────────────────
SELECT cron.schedule('moderation-monitor', '*/5 * * * *', 'SELECT private.run_moderation_monitor()');
SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname = 'moderation-monitor';
