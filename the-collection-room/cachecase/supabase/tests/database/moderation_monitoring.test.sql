-- pgTAP test for 20261127120000_moderation_monitoring.sql (Phase 2B M4 step 5B).
-- Turns alert delivery (and briefly the quarantine scheduler switch) ON
-- inside one rolled-back transaction, so it runs ONLY on an isolated
-- disposable local stack, and only when the session says so:
--   PGOPTIONS='-c cachecase.isolated_stack=on' (or SET it first).
-- pg_net only sends requests whose transaction committed: nothing queued
-- here is ever sent.

BEGIN;
DO $$ BEGIN
  IF current_setting('cachecase.isolated_stack', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'refusing: monitoring tests enable alert delivery and run only on an isolated stack (cachecase.isolated_stack=on)';
  END IF;
END $$;
SELECT plan(100);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated, service_role;
CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e76000' || lpad(n::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.q(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e77000' || lpad(n::text, 2, '0'))::uuid $$;
GRANT EXECUTE ON FUNCTION pg_temp.u(int), pg_temp.q(int) TO authenticated, service_role;
-- A synthetic quarantine job (triggers on; the 5A scheduler switch is off).
CREATE FUNCTION pg_temp.mq(n int, p_bucket text, p_cs boolean, p_age interval, p_state text DEFAULT 'pending', p_desired text DEFAULT 'quarantine',
                           p_attention boolean DEFAULT false, p_error text DEFAULT NULL, p_attempts int DEFAULT 0, p_lease_age interval DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id, quarantine_path,
                                        child_safety, legal_hold, state, desired, needs_attention, last_error, attempts, lease_token, lease_expires_at,
                                        created_at, source_sha256, quarantine_sha256, source_removed_at)
  VALUES (pg_temp.q(n), p_bucket, pg_temp.u(1) || '/mon-' || n || '.jpg', pg_temp.u(1),
          CASE p_bucket WHEN 'avatars' THEN 'avatar' ELSE 'item_image' END, 'profile', pg_temp.u(1), 'q/' || pg_temp.q(n) || '/original',
          p_cs, p_cs, p_state, p_desired, p_attention, p_error, p_attempts,
          CASE WHEN p_lease_age IS NOT NULL THEN gen_random_uuid() END, now() - p_lease_age, now() - p_age,
          repeat('a', 64), repeat('a', 64), CASE WHEN p_state IN ('restore_pending', 'restoring', 'quarantined') THEN now() END)
  RETURNING id $$;
CREATE FUNCTION pg_temp.evaluated() RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(code || '=' || item_count, ',' ORDER BY code) FROM private.moderation_monitoring_evaluate() $$;
CREATE FUNCTION pg_temp.issue(p_code text) RETURNS private.moderation_monitoring_issues LANGUAGE sql SECURITY DEFINER AS $$
  SELECT * FROM private.moderation_monitoring_issues WHERE issue_key = p_code AND resolved_at IS NULL $$;
GRANT EXECUTE ON FUNCTION pg_temp.issue(text) TO authenticated;
CREATE FUNCTION pg_temp.due(p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT private.moderation_monitoring_notice_due(i) FROM private.moderation_monitoring_issues i WHERE i.issue_key = p_code
   ORDER BY i.opened_at DESC LIMIT 1 $$;
CREATE FUNCTION pg_temp.claim() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN public.moderation_monitoring_claim();
END;
$$;
CREATE TEMP TABLE v (k text PRIMARY KEY, val text);
GRANT ALL ON v TO authenticated, service_role;

-- ── 1. Shape and privileges ─────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r,
                  unnest(ARRAY['private.moderation_monitoring_codes', 'private.moderation_monitoring_issues', 'private.moderation_monitoring_events',
                               'private.moderation_monitoring_deliveries', 'private.moderation_monitoring_dispatches',
                               'private.moderation_monitoring_state', 'private.moderation_monitoring_config_changes']) t
           WHERE has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')), 0, 'no API role can touch monitoring tables');
SELECT is((SELECT string_agg(code || ':' || severity, ',' ORDER BY code) FROM private.moderation_monitoring_codes),
  'child_safety_unquarantined:critical,integrity_failure:critical,public_origin_reachable:critical,public_removal_overdue:critical,'
  'purge_approval_pending:routine,purge_run_incomplete:routine,quarantine_attempts_exhausted:high,quarantine_lease_stale:routine,'
  'quarantine_needs_attention:high,restore_conflict:routine,scheduler_stalled:high,urgent_reports_overdue:high',
  'twelve issue codes with the approved severities');
SELECT is((SELECT string_agg(code, ',') FROM private.moderation_monitoring_codes WHERE detection = 'origin_probe'), 'public_origin_reachable',
  'the origin/CDN condition is catalogued as needing a hosted probe, not SQL');
SELECT is((SELECT delivery_enabled::text || ':' || urgent_report_minutes FROM private.moderation_monitoring_state), 'false:60',
  'delivery is OFF by default; urgent threshold 60 min (placeholder)');
SELECT is((SELECT schedule || '|' || active::text || '|' || command FROM cron.job WHERE jobname = 'moderation-monitor'),
  '*/5 * * * *|false|SELECT private.run_moderation_monitor()', 'monitor job: every 5 minutes, created INACTIVE');
SELECT is((SELECT string_agg(jobname || ':' || active::text, ',' ORDER BY jobname) FROM cron.job),
  'account-deletion-monitor:false,account-maintenance:false,media-quarantine-worker:false,moderation-monitor:false',
  'every scheduled job is inactive; existing ones unchanged');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.moderation_monitoring_claim()', 'public.moderation_monitoring_record_delivery(uuid,text,text[])',
             'public.moderation_monitoring_report_channels(text,text)']::regprocedure[]) f JOIN pg_proc p ON p.oid = f
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND has_function_privilege('service_role', f, 'EXECUTE')
             AND NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE')), 3,
  'delivery RPCs: definer, pinned, service role only');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.admin_moderation_monitoring_overview()', 'public.admin_acknowledge_moderation_issue(uuid)']::regprocedure[]) f
           JOIN pg_proc p ON p.oid = f
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%'
             AND has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
             AND NOT has_function_privilege('service_role', f, 'EXECUTE')), 2, 'admin RPCs: definer, pinned, require_admin, signed in only');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'private' AND (p.proname LIKE 'moderation_monitoring%' OR p.proname = 'run_moderation_monitor')
              AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   OR has_function_privilege('service_role', p.oid, 'EXECUTE'))), 0, 'internal helpers: no API role');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public', 'private') AND p.prosecdef AND p.proname ~ '(moderation_monitor|moderation_issue)'
              AND p.proconfig IS DISTINCT FROM ARRAY['search_path=""']), 0, 'every new definer function pins search_path');
SELECT is((SELECT provolatile::text FROM pg_proc WHERE oid = 'private.moderation_monitoring_evaluate()'::regprocedure), 's',
  'evaluation is STABLE: it cannot write');
SELECT throws_ok($$INSERT INTO private.moderation_monitoring_codes VALUES ('x', 'purge', 'routine', 'sql', '/admin/x', 'x')$$, '42501', NULL,
  'the code catalogue is fixed');
SELECT is((pg_temp.claim()) ->> 'status', 'disabled', 'claim by default: delivery disabled');
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_deliveries), 0, '…nothing claimed for delivery');

-- ── 2. Detection ────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT pg_temp.u(n), 'mon-' || n || '@example.invalid', jsonb_build_object('username', 'mon_' || n) FROM generate_series(1, 4) n;
INSERT INTO public.admin_users (user_id) VALUES (pg_temp.u(3)), (pg_temp.u(4));
SELECT pg_temp.mq(1, 'item-images', true, interval '12 minutes');                 -- child safety, overdue
SELECT pg_temp.mq(2, 'item-images', true, interval '2 minutes');                  -- child safety, not yet overdue
SELECT pg_temp.mq(3, 'avatars', false, interval '20 minutes');                    -- public, removal overdue
SELECT pg_temp.mq(4, 'item-images', false, interval '20 minutes');                -- private: not a public removal
SELECT pg_temp.mq(5, 'item-images', false, interval '1 hour', 'copied', 'quarantine', true, 'hash_mismatch', 1);
SELECT pg_temp.mq(6, 'item-images', false, interval '1 hour', 'pending', 'quarantine', true, 'copy_failed', 5);
SELECT pg_temp.mq(7, 'item-images', false, interval '1 hour', 'pending', 'quarantine', true, 'source_read_failed', 2);
SELECT pg_temp.mq(8, 'item-images', false, interval '1 hour', 'restore_pending', 'restore', true, 'destination_occupied', 1);
SELECT pg_temp.mq(9, 'item-images', false, interval '30 minutes', 'copied', 'quarantine', false, NULL, 1, interval '20 minutes');
SET LOCAL session_replication_role = replica;
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, reason, priority, status, created_at, updated_at) VALUES
  (pg_temp.q(50), pg_temp.u(2), 'profile', pg_temp.q(70), 'child_safety', 'urgent', 'open', now() - interval '2 hours', now()),
  (pg_temp.q(51), pg_temp.u(2), 'profile', pg_temp.q(71), 'child_safety', 'urgent', 'open', now() - interval '10 minutes', now()),
  (pg_temp.q(52), pg_temp.u(2), 'profile', pg_temp.q(72), 'spam', 'normal', 'open', now() - interval '3 hours', now());
INSERT INTO private.retention_purge_runs (id, category, policy_key, policy_period, item_count, set_digest, prepared_by, prepared_at,
                                          approval_expires_at, status, closed_at) VALUES
  (pg_temp.q(60), 'report_evidence', 'report_evidence_after_resolution', interval '90 days', 1, md5('a'), pg_temp.u(3),
   now() - interval '5 minutes', now() + interval '25 minutes', 'prepared', NULL),
  (pg_temp.q(61), 'report_evidence', 'report_evidence_after_resolution', interval '90 days', 1, md5('b'), pg_temp.u(3),
   now() - interval '2 hours', now() - interval '90 minutes', 'expired', now() - interval '1 hour');
SET LOCAL session_replication_role = origin;

SELECT is(pg_temp.evaluated(),
  'child_safety_unquarantined=1,integrity_failure=1,public_removal_overdue=1,purge_approval_pending=1,purge_run_incomplete=1,'
  'quarantine_attempts_exhausted=1,quarantine_lease_stale=1,quarantine_needs_attention=1,restore_conflict=1,urgent_reports_overdue=1',
  'every SQL condition is detected, with the right counts (thresholds respected)');
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_evaluate() WHERE code = 'public_origin_reachable'), 0,
  'the origin/CDN condition is never claimed from database state');
SELECT is((SELECT oldest_at FROM private.moderation_monitoring_evaluate() WHERE code = 'child_safety_unquarantined'),
  (SELECT created_at FROM private.media_quarantine WHERE id = pg_temp.q(1)), 'the oldest affected time is reported');
UPDATE private.media_quarantine_scheduler_config SET enabled = true;
SELECT is((SELECT item_count FROM private.moderation_monitoring_evaluate() WHERE code = 'scheduler_stalled'), 5,
  'scheduler on, work waiting over 10 min, no completed run → scheduler_stalled (claimable jobs counted)');
INSERT INTO private.media_quarantine_scheduler_runs (trigger, status, finished_at, duration_ms) VALUES ('sweep', 'completed', clock_timestamp(), 10);
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_evaluate() WHERE code = 'scheduler_stalled'), 0, '…a completed run clears it');
DELETE FROM private.media_quarantine_scheduler_runs;
UPDATE private.media_quarantine_scheduler_config SET enabled = false;
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_evaluate() WHERE code = 'scheduler_stalled'), 0,
  'scheduler off: not "stalled" (the overdue-removal issues still fire)');
UPDATE private.moderation_monitoring_state SET urgent_report_minutes = 5 WHERE id;
SELECT is((SELECT item_count FROM private.moderation_monitoring_evaluate() WHERE code = 'urgent_reports_overdue'), 2, 'the urgent threshold is configurable');
SELECT is((SELECT urgent_report_minutes || ':' || changed_by FROM private.moderation_monitoring_config_changes ORDER BY id DESC LIMIT 1), '5:postgres',
  '…and changing it is recorded');
UPDATE private.moderation_monitoring_state SET urgent_report_minutes = 60 WHERE id;

-- ── 3. Lifecycle ────────────────────────────────────────────────────────
SELECT is((private.moderation_monitoring_check()) ->> 'opened', '10', 'a check opens one issue per condition');
SELECT is((private.moderation_monitoring_check()) ->> 'opened', '0', 'a second check opens nothing new');
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_issues WHERE resolved_at IS NULL), 10, '…no duplicate open issues');
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_events WHERE event = 'opened'), 10, 'each opening is recorded once');
SELECT throws_ok($$INSERT INTO private.moderation_monitoring_issues (issue_key, code, severity, item_count, peak_count)
                   VALUES ('integrity_failure', 'integrity_failure', 'critical', 1, 1)$$, '23505', NULL,
  'a second open issue for the same identity is impossible');
SELECT is((SELECT severity FROM pg_temp.issue('child_safety_unquarantined')), 'critical', 'severity comes from the catalogue');
SELECT pg_temp.mq(10, 'item-images', true, interval '12 minutes');
SELECT is((private.moderation_monitoring_check()) ->> 'worsened', '1', 'a rising count is recorded as worse');
SELECT is((SELECT item_count || '/' || peak_count FROM pg_temp.issue('child_safety_unquarantined')), '2/2', '…count and peak updated');
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_events e JOIN private.moderation_monitoring_issues i ON i.id = e.issue_id
            WHERE i.issue_key = 'child_safety_unquarantined' AND e.event = 'worsened'), 1, '…with a worsened event');
INSERT INTO v SELECT 'urgent_id', (pg_temp.issue('urgent_reports_overdue')).id::text;
SET LOCAL session_replication_role = replica;
DELETE FROM public.content_reports WHERE id = pg_temp.q(50);
SET LOCAL session_replication_role = origin;
SELECT is((private.moderation_monitoring_check()) ->> 'resolved', '1', 'a cleared condition resolves its issue');
SELECT isnt((SELECT resolved_at FROM private.moderation_monitoring_issues WHERE id = (SELECT val::uuid FROM v WHERE k = 'urgent_id')), NULL, '…resolved_at set');
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_events WHERE issue_id = (SELECT val::uuid FROM v WHERE k = 'urgent_id') AND event = 'resolved'), 1,
  '…with a resolved event');
SET LOCAL session_replication_role = replica;
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, reason, priority, status, created_at, updated_at)
VALUES (pg_temp.q(53), pg_temp.u(2), 'profile', pg_temp.q(73), 'child_safety', 'urgent', 'open', now() - interval '3 hours', now());
SET LOCAL session_replication_role = origin;
SELECT private.moderation_monitoring_check();
SELECT isnt((pg_temp.issue('urgent_reports_overdue')).id, (SELECT val::uuid FROM v WHERE k = 'urgent_id'), 'a recurrence is a new issue; the old one stays resolved');
SELECT throws_ok($$UPDATE private.moderation_monitoring_issues SET resolved_at = NULL WHERE id = (SELECT val::uuid FROM v WHERE k = 'urgent_id')$$, '42501', NULL,
  'a resolved issue cannot be reopened');
SELECT throws_ok($$UPDATE private.moderation_monitoring_issues SET code = 'restore_conflict' WHERE issue_key = 'integrity_failure'$$, '42501', NULL,
  'an issue''s identity is fixed');
SELECT throws_ok($$UPDATE private.moderation_monitoring_events SET event = 'resolved'$$, '42501', NULL, 'events are append-only');
SELECT throws_ok($$DELETE FROM private.moderation_monitoring_events$$, '42501', NULL, '…and cannot be deleted');

-- Acknowledgement
SELECT pg_temp.login(pg_temp.u(3));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'ack', (public.admin_acknowledge_moderation_issue((pg_temp.issue('quarantine_needs_attention')).id))::text;
RESET ROLE;
SELECT is((SELECT val::jsonb ->> 'resolved' FROM v WHERE k = 'ack'), 'false', 'acknowledging never resolves');
SELECT is((SELECT (acknowledged_by = pg_temp.u(3))::text || ':' || (resolved_at IS NULL)::text FROM pg_temp.issue('quarantine_needs_attention')), 'true:true',
  '…the issue stays open, acknowledged by that admin');
SELECT is((SELECT actor_id FROM private.moderation_monitoring_events e JOIN private.moderation_monitoring_issues i ON i.id = e.issue_id
            WHERE i.issue_key = 'quarantine_needs_attention' AND e.event = 'acknowledged'), pg_temp.u(3), '…recorded with the admin');
SET LOCAL ROLE authenticated;
SELECT is((public.admin_acknowledge_moderation_issue((pg_temp.issue('quarantine_needs_attention')).id)) ->> 'changed', 'false', 'acknowledging twice changes nothing');
SELECT is((public.admin_acknowledge_moderation_issue((SELECT val::uuid FROM v WHERE k = 'urgent_id'))) ->> 'reason', 'already_resolved',
  'a resolved issue cannot be acknowledged');
SELECT throws_ok($$SELECT public.admin_acknowledge_moderation_issue(gen_random_uuid())$$, 'PT404', NULL, 'unknown issue → not found');
RESET ROLE;
SELECT pg_temp.login(pg_temp.u(2));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.admin_acknowledge_moderation_issue(gen_random_uuid())$$, '42501', NULL, 'collectors cannot acknowledge');
SELECT throws_ok($$SELECT public.admin_moderation_monitoring_overview()$$, '42501', NULL, 'collectors cannot read monitoring');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.admin_moderation_monitoring_overview()$$, '42501', NULL, 'nor can the service role call admin RPCs');
RESET ROLE;
SELECT pg_temp.mq(11, 'item-images', false, interval '1 hour', 'pending', 'quarantine', true, 'source_read_failed', 1);
SELECT private.moderation_monitoring_check();
SELECT is((pg_temp.issue('quarantine_needs_attention')).acknowledged_at, NULL, 'getting worse clears an acknowledgement');

-- ── 4. Notices ──────────────────────────────────────────────────────────
SELECT is(pg_temp.due('child_safety_unquarantined'), 'opened', 'a new critical issue is owed an opening notice');
SELECT is(pg_temp.due('restore_conflict'), NULL, 'routine issues are never notified individually');
UPDATE private.moderation_monitoring_state SET delivery_enabled = true WHERE id;
SELECT is((SELECT delivery_enabled::text FROM private.moderation_monitoring_config_changes ORDER BY id DESC LIMIT 1), 'true', 'switching delivery on is recorded');
INSERT INTO v SELECT 'c1', pg_temp.claim()::text;
SELECT is((SELECT jsonb_array_length(val::jsonb -> 'notices') FROM v WHERE k = 'c1'),
  (SELECT count(*)::int FROM private.moderation_monitoring_issues WHERE resolved_at IS NULL AND severity IN ('critical', 'high')),
  'the claim takes every critical and high issue');
SELECT is((SELECT array_agg(DISTINCT fk ORDER BY fk) FROM v, jsonb_array_elements(v.val::jsonb -> 'notices') n, jsonb_object_keys(n) fk WHERE v.k = 'c1'),
  ARRAY['admin_ref', 'category', 'code', 'count', 'kind', 'oldest_at', 'severity'], 'a notice carries only code, category, severity, count, age and admin page');
SELECT is((SELECT array_agg(DISTINCT fk ORDER BY fk) FROM v, jsonb_array_elements(v.val::jsonb -> 'summary') n, jsonb_object_keys(n) fk WHERE v.k = 'c1'),
  ARRAY['acknowledged', 'category', 'code', 'count', 'oldest_at', 'severity'], 'the daily summary carries the same kind of fields only');
SELECT is((SELECT (val::jsonb -> 'notices' -> 0 ->> 'severity') FROM v WHERE k = 'c1'), 'critical', 'critical issues come first');
SELECT is((SELECT count(*)::int FROM v WHERE k = 'c1' AND (val LIKE '%' || pg_temp.u(1) || '%' OR val LIKE '%' || pg_temp.u(2) || '%'
            OR val LIKE '%' || pg_temp.q(1) || '%' OR val LIKE '%mon-%' OR val LIKE '%q/%' OR val LIKE '%aaaaaaaa%' OR val LIKE '%example.invalid%')), 0,
  'no account, job or report id, path, hash or address leaves in a claim');
SELECT is((SELECT jsonb_array_length(pg_temp.claim() -> 'notices')), 0, 'a claim in flight is not handed out twice');
SET LOCAL ROLE service_role;
SELECT is(public.moderation_monitoring_record_delivery((SELECT (val::jsonb ->> 'claim_id')::uuid FROM v WHERE k = 'c1'), NULL, ARRAY['webhook']),
  (SELECT jsonb_array_length(val::jsonb -> 'notices') FROM v WHERE k = 'c1'), 'a delivered claim is recorded for every notice');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_issues WHERE claim_id IS NOT NULL OR (severity <> 'routine' AND resolved_at IS NULL AND notified_at IS NULL)), 0,
  '…every non-routine issue marked notified, no claim left');
SELECT is((SELECT outcome || ':' || array_to_string(channels, ',') FROM private.moderation_monitoring_deliveries WHERE id = (SELECT (val::jsonb ->> 'claim_id')::uuid FROM v WHERE k = 'c1')),
  'delivered:webhook', '…the delivery recorded');
SELECT isnt((SELECT summary_sent_at FROM private.moderation_monitoring_state), NULL, '…and the daily summary marked sent');
SELECT is((pg_temp.claim()) -> 'claim_id', NULL, 'unchanged issues are not notified again (nothing to claim)');
UPDATE private.moderation_monitoring_issues SET notified_at = now() - interval '2 hours' WHERE resolved_at IS NULL AND severity <> 'routine';
SELECT is(pg_temp.due('child_safety_unquarantined'), 'reminder', 'unresolved child safety repeats hourly');
SELECT is(pg_temp.due('integrity_failure'), NULL, 'other unchanged issues do not repeat within 24 h');
SELECT pg_temp.mq(12, 'item-images', false, interval '1 hour', 'copied', 'quarantine', true, 'destination_conflict', 1);
SELECT private.moderation_monitoring_check();
SELECT is(pg_temp.due('integrity_failure'), 'worsened', 'a worse issue is notified again (at most hourly)');
UPDATE private.moderation_monitoring_issues SET notified_at = now() - interval '25 hours', notified_count = item_count
 WHERE resolved_at IS NULL AND severity <> 'routine';
SELECT is(pg_temp.due('quarantine_attempts_exhausted'), 'reminder', 'after 24 h an open issue is reminded');
SELECT pg_temp.login(pg_temp.u(4));
SET LOCAL ROLE authenticated;
SELECT public.admin_acknowledge_moderation_issue((pg_temp.issue('quarantine_attempts_exhausted')).id);
SELECT public.admin_acknowledge_moderation_issue((pg_temp.issue('integrity_failure')).id);
RESET ROLE;
SELECT is(pg_temp.due('quarantine_attempts_exhausted'), NULL, 'an acknowledged ordinary issue is not reminded');
SELECT is(pg_temp.due('integrity_failure'), 'reminder', 'an acknowledged critical issue still is');

-- Failed delivery and retry
INSERT INTO v SELECT 'c2', pg_temp.claim()::text;
SET LOCAL ROLE service_role;
SELECT public.moderation_monitoring_record_delivery((SELECT (val::jsonb ->> 'claim_id')::uuid FROM v WHERE k = 'c2'), 'webhook_rejected', '{}');
RESET ROLE;
SELECT is((SELECT delivery_failures || ':' || last_delivery_error FROM pg_temp.issue('integrity_failure')), '1:webhook_rejected', 'a failed delivery is recorded per issue');
SELECT is((SELECT outcome FROM private.moderation_monitoring_deliveries WHERE id = (SELECT (val::jsonb ->> 'claim_id')::uuid FROM v WHERE k = 'c2')), 'failed', '…and per delivery');
SELECT is(pg_temp.due('integrity_failure'), NULL, 'no immediate resend after a failure');
UPDATE private.moderation_monitoring_issues SET last_attempt_at = now() - interval '16 minutes' WHERE resolved_at IS NULL;
SELECT is(pg_temp.due('integrity_failure'), 'reminder', 'retried after 15 minutes');
INSERT INTO v SELECT 'c3', pg_temp.claim()::text;
SET LOCAL ROLE service_role;
SELECT public.moderation_monitoring_record_delivery((SELECT (val::jsonb ->> 'claim_id')::uuid FROM v WHERE k = 'c3'), 'resend_unreachable', '{}');
RESET ROLE;
UPDATE private.moderation_monitoring_issues SET last_attempt_at = now() - interval '16 minutes' WHERE resolved_at IS NULL;
SELECT is(pg_temp.due('integrity_failure'), NULL, 'the second failure backs off longer (30 minutes)');
UPDATE private.moderation_monitoring_issues SET last_attempt_at = now() - interval '31 minutes' WHERE resolved_at IS NULL;
SELECT is(pg_temp.due('integrity_failure'), 'reminder', '…then retries');
UPDATE private.moderation_monitoring_issues SET claim_id = gen_random_uuid(), claimed_kind = 'reminder', last_attempt_at = now() - interval '6 minutes',
                                                delivery_failures = 0, last_delivery_error = NULL
 WHERE issue_key = 'integrity_failure' AND resolved_at IS NULL;
SELECT is(pg_temp.due('integrity_failure'), 'reminder', 'a claim abandoned by a crashed sender is reclaimed after 5 minutes');
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.moderation_monitoring_record_delivery(gen_random_uuid(), NULL, ARRAY['email'])$$, '22023', NULL, 'unknown claims cannot be reported');
SELECT throws_ok($$SELECT public.moderation_monitoring_record_delivery((SELECT (val::jsonb ->> 'claim_id')::uuid FROM v WHERE k = 'c1'), NULL, ARRAY['email'])$$, '22023', NULL,
  'a finished claim cannot be reported again');
SELECT throws_ok($$SELECT public.moderation_monitoring_report_channels('configured', 'https://x')$$, '22023', NULL, 'channel reports are status codes only');
RESET ROLE;

-- Resolution notice
UPDATE private.moderation_monitoring_issues SET claim_id = NULL, claimed_kind = NULL, notified_at = now() - interval '2 hours',
                                                last_attempt_at = NULL, delivery_failures = 0, last_delivery_error = NULL
 WHERE resolved_at IS NULL;
INSERT INTO v SELECT 'pub_id', (pg_temp.issue('public_removal_overdue')).id::text;
SET LOCAL session_replication_role = replica;
DELETE FROM private.media_quarantine_events WHERE quarantine_id = pg_temp.q(3);
DELETE FROM private.media_quarantine WHERE id = pg_temp.q(3);
SET LOCAL session_replication_role = origin;
SELECT private.moderation_monitoring_check();
SELECT is((SELECT private.moderation_monitoring_notice_due(i) FROM private.moderation_monitoring_issues i WHERE i.id = (SELECT val::uuid FROM v WHERE k = 'pub_id')),
  'resolved', 'a notified issue that clears is owed a resolution notice');
SELECT is((SELECT private.moderation_monitoring_notice_due(i) FROM private.moderation_monitoring_issues i WHERE i.id = (SELECT val::uuid FROM v WHERE k = 'urgent_id')),
  NULL, 'an issue resolved before it was ever notified owes nothing');
INSERT INTO v SELECT 'c4', pg_temp.claim()::text;
SELECT is((SELECT count(*)::int FROM v, jsonb_array_elements(v.val::jsonb -> 'notices') n WHERE v.k = 'c4' AND n ->> 'kind' = 'resolved'), 1, '…claimed as "resolved"');
SET LOCAL ROLE service_role;
SELECT public.moderation_monitoring_record_delivery((SELECT (val::jsonb ->> 'claim_id')::uuid FROM v WHERE k = 'c4'), NULL, ARRAY['email', 'webhook']);
RESET ROLE;
SELECT is((SELECT private.moderation_monitoring_notice_due(i) FROM private.moderation_monitoring_issues i WHERE i.id = (SELECT val::uuid FROM v WHERE k = 'pub_id')),
  NULL, '…and owes nothing once delivered');
SELECT is(private.moderation_monitoring_summary_due(), false, 'the summary is not due again within 24 h');
UPDATE private.moderation_monitoring_state SET summary_sent_at = now() - interval '25 hours', summary_claimed_at = now() - interval '25 hours' WHERE id;
SELECT is(private.moderation_monitoring_summary_due(), true, '…and is after 24 h');

-- ── 5. Dispatch ─────────────────────────────────────────────────────────
UPDATE private.moderation_monitoring_state SET delivery_enabled = false WHERE id;
INSERT INTO v VALUES ('q0', (SELECT count(*) FROM net.http_request_queue)::text);
SELECT is(private.run_moderation_monitor(), NULL, 'delivery off: the monitor call dispatches nothing…');
SELECT isnt((SELECT last_check_at FROM private.moderation_monitoring_state), NULL, '…but still records the issues');
UPDATE private.moderation_monitoring_state SET delivery_enabled = true WHERE id;
SELECT is(private.run_moderation_monitor(), NULL, 'no Vault configuration: nothing dispatched');
SELECT is((SELECT skipped_reason FROM private.moderation_monitoring_dispatches ORDER BY id DESC LIMIT 1), 'not_configured', '…recorded as not_configured');
SELECT vault.create_secret('http://supabase_kong_cachecase-m4-replay:8000', 'project_url');
SELECT vault.create_secret(repeat('m', 40), 'moderation_monitor_secret');
SELECT isnt(private.run_moderation_monitor(), NULL, 'configured and owed: one request queued (sent only if this transaction commits)');
SELECT is((SELECT method || ' ' || url || ' ' || (headers ->> 'Authorization' = 'Bearer ' || repeat('m', 40))::text FROM net.http_request_queue ORDER BY id DESC LIMIT 1),
  'POST http://supabase_kong_cachecase-m4-replay:8000/functions/v1/moderation-monitor true', '…to this project''s monitor, with the dedicated secret');
SELECT is((SELECT convert_from(body, 'utf8') FROM net.http_request_queue ORDER BY id DESC LIMIT 1), '{}', '…carrying nothing');
UPDATE private.moderation_monitoring_issues SET notified_at = now(), notified_count = item_count, resolve_notified_at = COALESCE(resolve_notified_at, CASE WHEN resolved_at IS NOT NULL THEN now() END)
 WHERE claim_id IS NULL;
UPDATE private.moderation_monitoring_state SET summary_sent_at = now(), channels_reported_at = now() WHERE id;
SELECT is(private.run_moderation_monitor(), NULL, 'nothing owed: no request');

-- ── 6. Admin overview and pruning ───────────────────────────────────────
SELECT pg_temp.login(pg_temp.u(3));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'ov', public.admin_moderation_monitoring_overview()::text;
RESET ROLE;
SELECT is((SELECT (val::jsonb -> 'open' -> 0 ->> 'severity') || ':' || (val::jsonb ->> 'monitor_active') || ':' || (val::jsonb -> 'needs_origin_probe' ->> 0)
             FROM v WHERE k = 'ov'), 'critical:false:public_origin_reachable', 'admins see open issues (critical first), the inactive job and probe-only codes');
SELECT is((SELECT jsonb_array_length(val::jsonb -> 'open') FROM v WHERE k = 'ov'), (SELECT count(*)::int FROM private.moderation_monitoring_issues WHERE resolved_at IS NULL),
  'every open issue is visible, routine included');
UPDATE private.moderation_monitoring_state SET delivery_enabled = false WHERE id;
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::int FROM jsonb_array_elements(public.admin_moderation_monitoring_overview() -> 'open') x WHERE x ->> 'severity' = 'critical'), 2,
  'critical issues stay visible with delivery off');
RESET ROLE;
SELECT private.moderation_monitoring_check();
SET LOCAL session_replication_role = replica;
UPDATE private.moderation_monitoring_issues SET opened_at = now() - interval '100 days', resolved_at = now() - interval '95 days'
 WHERE id = (SELECT val::uuid FROM v WHERE k = 'urgent_id');
SET LOCAL session_replication_role = origin;
SELECT private.moderation_monitoring_check();
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_issues WHERE id = (SELECT val::uuid FROM v WHERE k = 'urgent_id')), 0,
  'resolved issues are pruned after 90 days…');
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_events WHERE issue_id = (SELECT val::uuid FROM v WHERE k = 'urgent_id')), 0, '…with their history');
SELECT is((SELECT count(*)::int FROM private.moderation_monitoring_issues WHERE resolved_at IS NULL AND severity = 'critical'), 2, 'open issues are never pruned');
SELECT throws_ok($$DELETE FROM private.moderation_monitoring_issues WHERE resolved_at IS NULL$$, '42501', NULL, 'issues cannot be deleted outside pruning');

SELECT * FROM finish();
ROLLBACK;
