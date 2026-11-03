-- pgTAP test for 20261108120000_account_deletion_monitoring.sql: monitoring
-- data is admin-only and identity-free; healthy, overdue, stuck, expired-
-- lease, failed and export states; scheduler failures (not configured,
-- inactive, missing runs, failing calls); alert open / deliver / reminder /
-- retry / resolve / reopen; run and dispatch recording; the monitor job
-- (inactive by default) and delivery-channel reporting, missing recipients,
-- webhook failures and delivery acknowledgement.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(107);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
CREATE FUNCTION pg_temp.logout() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid), pg_temp.logout() TO authenticated, anon, service_role;
CREATE FUNCTION pg_temp.snap() RETURNS jsonb LANGUAGE sql AS $$ SELECT private.account_monitoring_snapshot() $$;
CREATE FUNCTION pg_temp.issues() RETURNS text[] LANGUAGE sql AS $$
  SELECT ARRAY(SELECT jsonb_array_elements_text(private.account_monitoring_snapshot() -> 'issues') ORDER BY 1) $$;

-- Clean slate: no deletion / export work, no monitoring history, configured
-- and active scheduler.
ALTER TABLE public.account_lifecycle DISABLE TRIGGER USER;
DELETE FROM public.account_lifecycle;
DELETE FROM public.account_deletion_jobs;
DELETE FROM public.account_exports;
DELETE FROM private.account_maintenance_runs;
DELETE FROM private.account_maintenance_dispatches;
DELETE FROM private.account_monitoring_alerts;
-- The monitor job exactly as the migration left it (asserted in section 1).
CREATE TEMP TABLE mon_job_as_migrated AS SELECT active FROM cron.job WHERE jobname = 'account-deletion-monitor';
UPDATE private.account_monitoring_state SET scheduler_active_since = NULL, last_delivery_at = NULL, last_delivery_error = NULL,
  last_delivery_channels = '{}', email_channel = NULL, webhook_channel = NULL, webhook_signed = NULL, channels_reported_at = NULL;
DELETE FROM vault.secrets WHERE name IN ('username_reservation_key', 'project_url', 'account_maintenance_secret');
SELECT vault.create_secret(repeat('k', 48), 'username_reservation_key');
SELECT vault.create_secret('http://supabase_kong_cachecase:8000', 'project_url');
SELECT vault.create_secret(repeat('s', 40), 'account_maintenance_secret');
SELECT cron.alter_job(job_id := jobid, active := true) FROM cron.job WHERE jobname = 'account-maintenance';

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-00000a110001', 'mon-admin@example.invalid', '{"username":"mon_admin"}'),
  ('00000000-0000-4000-8000-00000a110002', 'mon-collector@example.invalid', '{"username":"mon_collector"}'),
  ('00000000-0000-4000-8000-00000a110003', 'mon-overdue@example.invalid', '{"username":"mon_overdue"}'),
  ('00000000-0000-4000-8000-00000a110004', 'mon-exports@example.invalid', '{"username":"mon_exports"}'),
  ('00000000-0000-4000-8000-00000a110005', 'mon-exports2@example.invalid', '{"username":"mon_exports2"}');
INSERT INTO public.admin_users (user_id) VALUES ('00000000-0000-4000-8000-00000a110001');

-- ── 1. Privileges ───────────────────────────────────────────────────────
CREATE TEMP TABLE mon_tables AS SELECT unnest(ARRAY['private.account_maintenance_dispatches', 'private.account_maintenance_runs',
  'private.account_monitoring_alerts', 'private.account_monitoring_state']::regclass[]) AS t;
SELECT is((SELECT count(*)::int FROM mon_tables, unnest(ARRAY['anon', 'authenticated', 'service_role']) r
  WHERE has_table_privilege(r, t, 'SELECT') OR has_table_privilege(r, t, 'INSERT') OR has_table_privilege(r, t, 'UPDATE') OR has_table_privilege(r, t, 'DELETE')), 0,
  'no client (or the service role) can read or write monitoring tables directly');
SELECT is((SELECT count(*)::int FROM mon_tables WHERE NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t)), 0, 'and RLS is on for all of them');
CREATE TEMP TABLE mon_private_fns AS SELECT unnest(ARRAY['private.account_monitoring_snapshot()', 'private.account_monitoring_check()',
  'private.run_account_monitor()', 'private.account_monitoring_notice_due(private.account_monitoring_alerts)']::regprocedure[]) AS fn;
SELECT is((SELECT count(*)::int FROM mon_private_fns, unnest(ARRAY['anon', 'authenticated', 'service_role']) r WHERE has_function_privilege(r, fn, 'EXECUTE')), 0,
  'internal monitoring functions are not callable by anyone but the owner');
CREATE TEMP TABLE mon_worker_fns AS SELECT unnest(ARRAY['public.account_maintenance_record_run(text,integer,integer,integer,text[])',
  'public.account_monitoring_claim_notices()', 'public.account_monitoring_record_delivery(timestamptz,text,text[])',
  'public.account_monitoring_report_channels(text,text,boolean)']::regprocedure[]) AS fn;
SELECT is((SELECT count(*)::int FROM mon_worker_fns WHERE has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')), 0,
  'worker/delivery functions are not callable by clients');
SELECT is((SELECT count(*)::int FROM mon_worker_fns WHERE has_function_privilege('service_role', fn, 'EXECUTE')), 4, 'the service role can call them');
SELECT ok(NOT has_function_privilege('anon', 'public.account_deletion_admin_summary()', 'EXECUTE'), 'anon cannot read the admin summary');
SELECT ok(NOT has_function_privilege('authenticated', 'private.run_account_maintenance()', 'EXECUTE'), 'the scheduled call stays private');
SELECT ok(EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'account-deletion-monitor' AND schedule = '*/15 * * * *'), 'the monitor job is scheduled every 15 minutes');
SELECT is((SELECT active FROM mon_job_as_migrated), false, 'and created inactive');

SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-00000a110002');
SELECT throws_ok($$ SELECT public.account_deletion_admin_summary() $$, '42501', 'forbidden', 'a normal collector cannot read the summary');
SELECT throws_ok($$ SELECT * FROM private.account_maintenance_runs $$, '42501', NULL, 'nor the run history');
SELECT throws_ok($$ SELECT * FROM private.account_monitoring_alerts $$, '42501', NULL, 'nor the alerts');
SELECT throws_ok($$ SELECT private.account_monitoring_snapshot() $$, '42501', NULL, 'nor the snapshot directly');
SELECT throws_ok($$ SELECT public.account_monitoring_claim_notices() $$, '42501', NULL, 'nor claim notices');
SELECT throws_ok($$ SELECT public.account_maintenance_record_run('ok', 1, 0, 0, '{}') $$, '42501', NULL, 'nor forge a run');
SELECT throws_ok($$ SELECT public.account_monitoring_report_channels('configured', 'configured', true) $$, '42501', NULL, 'nor forge a channel report');
SELECT pg_temp.logout();
RESET ROLE;

-- ── 2. Run recording ────────────────────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT lives_ok($$ SELECT public.account_maintenance_record_run('ok', 1200, 2, 0, '{}') $$, 'the service role records a run');
SELECT throws_ok($$ SELECT public.account_maintenance_record_run('great', 1, 0, 0, '{}') $$, '22023', 'invalid_outcome', 'outcomes are controlled');
SELECT throws_ok($$ SELECT public.account_maintenance_record_run('degraded', 1, 0, 0, ARRAY['user@example.com']) $$, '22023', 'invalid_error_codes',
  'error codes are controlled (nothing free-form, so nothing personal)');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM private.account_maintenance_runs), 1, 'one run recorded');

-- Dispatch recording: configured → request id; not configured → skipped.
SELECT ok(private.run_account_maintenance() IS NOT NULL, 'the scheduled call returns a pg_net request');
SELECT ok(EXISTS (SELECT 1 FROM private.account_maintenance_dispatches WHERE request_id IS NOT NULL), 'and records the dispatch');
DELETE FROM vault.secrets WHERE name = 'project_url';
SELECT ok(private.run_account_maintenance() IS NULL, 'without Vault values it skips');
SELECT ok(EXISTS (SELECT 1 FROM private.account_maintenance_dispatches WHERE skipped_reason = 'not_configured'), 'and records the skip');
SELECT vault.create_secret('http://supabase_kong_cachecase:8000', 'project_url');
DELETE FROM private.account_maintenance_dispatches;

-- ── 3. Healthy ──────────────────────────────────────────────────────────
SELECT private.account_monitoring_check();
SELECT is(pg_temp.snap() ->> 'status', 'healthy', 'healthy: configured, active, a recent successful run, no work');
SELECT is(pg_temp.issues(), '{}'::text[], 'no issues');
SELECT ok((pg_temp.snap() #>> '{scheduler,last_successful_run_at}') IS NOT NULL, 'the last successful run is reported');
SELECT is((pg_temp.snap() #>> '{scheduler,last_run_outcome}'), 'ok', 'with its outcome');
SELECT ok((SELECT scheduler_active_since FROM private.account_monitoring_state) IS NOT NULL, 'the check notes when the scheduler was first seen active');
SELECT is((SELECT count(*)::int FROM private.account_monitoring_alerts), 0, 'and opens no alerts');
SELECT is((public.account_monitoring_claim_notices() -> 'notices'), '[]'::jsonb, 'nothing to deliver');
-- Monitor configuration: job state and delivery channels.
SELECT is((pg_temp.snap() #>> '{alerts,monitor_active}')::boolean, false, 'the summary reports the monitor job inactive');
SELECT cron.alter_job(job_id := jobid, active := true) FROM cron.job WHERE jobname = 'account-deletion-monitor';
SELECT is((pg_temp.snap() #>> '{alerts,monitor_active}')::boolean, true, '…and active once activated');
SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname = 'account-deletion-monitor';
SELECT ok((pg_temp.snap() -> 'alerts' ->> 'channel_configured') IS NULL, 'channels not yet reported: delivery configuration unknown');
SELECT ok(private.run_account_monitor() IS NOT NULL, 'so the monitor calls account-monitor to get the report, even with nothing due');
SET LOCAL ROLE service_role;
SELECT public.account_monitoring_report_channels('missing_recipients', 'not_configured', false);
RESET ROLE;
SELECT is((pg_temp.snap() -> 'alerts' ->> 'channel_configured')::boolean, false, 'missing recipients and no webhook: no channel configured');
SELECT is((pg_temp.snap() #>> '{alerts,email}'), 'missing_recipients', 'with the email status');
SELECT throws_ok($$ SELECT public.account_monitoring_report_channels('mailto:ops@example.com', 'configured', true) $$, '22023', 'invalid_channel_report',
  'channel reports are status codes only (no addresses or URLs)');
SELECT public.account_monitoring_report_channels('not_configured', 'configured', true);
SELECT is((pg_temp.snap() -> 'alerts' ->> 'channel_configured')::boolean, true, 'a webhook is a configured channel');
SELECT is((pg_temp.snap() #>> '{alerts,webhook_signed}')::boolean, true, 'signed');
SELECT public.account_monitoring_report_channels('configured', 'invalid_url', true);
SELECT is((pg_temp.snap() #>> '{alerts,webhook_signed}')::boolean, false, 'an invalid webhook is never reported as signed');
SELECT ok(private.run_account_monitor() IS NULL, 'with a fresh channel report the monitor makes no call when nothing is due');
UPDATE private.account_monitoring_state SET channels_reported_at = now() - interval '7 hours';
SELECT ok(private.run_account_monitor() IS NOT NULL, 'a report over 6 h old is refreshed');
UPDATE private.account_monitoring_state SET channels_reported_at = now();

-- Inactive with no work is not an issue (before launch activation).
SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname = 'account-maintenance';
SELECT is(pg_temp.issues(), '{}'::text[], 'scheduler inactive with nothing pending: not an issue');
SELECT is((pg_temp.snap() #>> '{scheduler,active}')::boolean, false, 'but reported as inactive');
SELECT cron.alter_job(job_id := jobid, active := true) FROM cron.job WHERE jobname = 'account-maintenance';

-- ── 4. Deletion states ──────────────────────────────────────────────────
-- Overdue: the recovery window ended 2 h ago and nothing started it.
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for)
VALUES ('00000000-0000-4000-8000-00000a110003', 'pending_deletion', 'scheduled', now() - interval '2 hours');
-- Not yet overdue: ended 10 minutes ago (inside the 1-hour grace).
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for)
VALUES ('00000000-0000-4000-8000-00000a110005', 'pending_deletion', 'scheduled', now() - interval '10 minutes');
SELECT is((pg_temp.snap() #>> '{deletions,overdue_scheduled}')::int, 1, 'overdue: only the deletion more than 1 h past its window');
SELECT is((pg_temp.snap() #>> '{deletions,pending}')::int, 2, 'both are counted as pending');
SELECT is(pg_temp.issues(), '{deletions_overdue}'::text[], 'overdue is an issue');

-- In progress for 2 h with a lease that expired 30 min ago; a fresh one.
INSERT INTO public.account_deletion_jobs (user_id, mode, status, created_at, lease_until, next_attempt_at) VALUES
  (gen_random_uuid(), 'immediate', 'cleaning_storage', now() - interval '2 hours', now() - interval '30 minutes', now() + interval '1 day'),
  (gen_random_uuid(), 'immediate', 'queued', now() - interval '5 minutes', now() + interval '1 minute', now());
SELECT is((pg_temp.snap() #>> '{deletions,in_progress}')::int, 2, 'two deletions in progress');
SELECT is((pg_temp.snap() #>> '{deletions,stuck_over_1h}')::int, 1, 'one stuck for over an hour');
SELECT is((pg_temp.snap() #>> '{deletions,expired_leases}')::int, 1, 'one with an expired lease');
SELECT ok((pg_temp.snap() #>> '{deletions,oldest_stuck_since}') IS NOT NULL, 'with the oldest stuck time');

INSERT INTO public.account_deletion_jobs (user_id, mode, status, failed_at, last_error_code) VALUES
  (gen_random_uuid(), 'scheduled', 'failed', now(), 'storage_remove_failed');
SELECT is((pg_temp.snap() #>> '{deletions,failed}')::int, 1, 'one failed deletion');
SELECT is(pg_temp.snap() #> '{deletions,failure_codes}', '{"storage_remove_failed": 1}'::jsonb, 'with its code');
SELECT is(pg_temp.issues(), '{deletion_leases_expired,deletions_failed,deletions_overdue,deletions_stuck}'::text[], 'all four deletion issues');

-- ── 5. Export states ────────────────────────────────────────────────────
INSERT INTO public.account_exports (user_id, status, last_error_code, updated_at) VALUES
  ('00000000-0000-4000-8000-00000a110004', 'failed', 'archive_failed', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-00000a110004', 'failed', 'archive_failed', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-00000a110004', 'failed', 'export_abandoned', now() - interval '3 hours'),
  ('00000000-0000-4000-8000-00000a110004', 'failed', 'collect_failed', now() - interval '3 days'),
  ('00000000-0000-4000-8000-00000a110004', 'failed', 'collect_failed', now() - interval '9 days');
SELECT is((pg_temp.snap() #>> '{exports,failed_24h}')::int, 2, 'failed exports in 24 h (abandoned counted apart)');
SELECT is((pg_temp.snap() #>> '{exports,abandoned_24h}')::int, 1, 'abandoned exports in 24 h');
SELECT is((pg_temp.snap() #>> '{exports,failed_7d}')::int, 3, 'failed exports in 7 days (older ones ignored)');
SELECT is(pg_temp.snap() #> '{exports,failure_codes_7d}', '{"archive_failed": 2, "collect_failed": 1, "export_abandoned": 1}'::jsonb, 'with codes');
SELECT ok(NOT ('exports_failing' = ANY (pg_temp.issues())), 'two failures in 24 h are below the alert threshold');
INSERT INTO public.account_exports (user_id, status, last_error_code, updated_at) VALUES
  ('00000000-0000-4000-8000-00000a110004', 'failed', 'archive_failed', now() - interval '30 minutes');
SELECT ok('exports_failing' = ANY (pg_temp.issues()), 'three are an issue');
INSERT INTO public.account_exports (user_id, status, updated_at) VALUES
  ('00000000-0000-4000-8000-00000a110005', 'archiving', now() - interval '26 hours');
SELECT is((pg_temp.snap() #>> '{exports,stuck}')::int, 1, 'an export untouched for 26 h is stuck');
SELECT ok('exports_stuck' = ANY (pg_temp.issues()), 'and an issue (the sweep is not running)');

-- ── 6. Privacy ──────────────────────────────────────────────────────────
SELECT ok(pg_temp.snap()::text !~ '00000a11000' AND pg_temp.snap()::text !~ 'example\.invalid' AND pg_temp.snap()::text !~ 'mon_',
  'the snapshot holds no account ids, emails or usernames');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-00000a110001');
SELECT is((public.account_deletion_admin_summary() ->> 'failed')::int, 1, 'an admin sees the earlier summary fields (failed)');
SELECT is((public.account_deletion_admin_summary() ->> 'in_progress')::int, 2, '(in progress)');
SELECT is(public.account_deletion_admin_summary() -> 'failure_codes', '{"storage_remove_failed": 1}'::jsonb, '(failure codes)');
SELECT is(public.account_deletion_admin_summary() ->> 'status', 'attention', 'and the monitoring status');
SELECT is((public.account_deletion_admin_summary() #>> '{deletions,overdue_scheduled}')::int, 1, 'and the new counts');
SELECT ok(public.account_deletion_admin_summary()::text !~ '00000a11000', 'with no identities');
SELECT pg_temp.logout();
RESET ROLE;

-- ── 7. Alerts: open, deliver, no repeat, reminder, retry, resolve ───────
DELETE FROM public.account_exports;
DELETE FROM public.account_deletion_jobs WHERE status = 'cleaning_storage';
SELECT private.account_monitoring_check();
SELECT is((SELECT array_agg(code ORDER BY code) FROM private.account_monitoring_alerts WHERE resolved_at IS NULL),
  '{deletions_failed,deletions_overdue}'::text[], 'the check opens one alert per issue');
SELECT ok(private.run_account_monitor() IS NOT NULL, 'a due notice makes the monitor call account-monitor');
CREATE TEMP TABLE mon_claim AS SELECT public.account_monitoring_claim_notices() AS c;
SELECT is((SELECT jsonb_agg(n ->> 'kind' || ':' || (n ->> 'code')) FROM mon_claim, jsonb_array_elements(c -> 'notices') n),
  '["opened:deletions_failed", "opened:deletions_overdue"]'::jsonb, 'the claim returns both as opened');
SELECT is((public.account_monitoring_claim_notices() -> 'notices'), '[]'::jsonb, 'a second claim while delivery is in flight gets nothing');
SELECT throws_ok(format($$ SELECT public.account_monitoring_record_delivery(%L, NULL, '{}') $$, (SELECT c ->> 'claimed_at' FROM mon_claim)),
  '22023', 'invalid_delivery_report', 'delivery cannot be acknowledged without a channel that accepted it');
SELECT throws_ok(format($$ SELECT public.account_monitoring_record_delivery(%L, NULL, ARRAY['sms']) $$, (SELECT c ->> 'claimed_at' FROM mon_claim)),
  '22023', 'invalid_delivery_report', 'channels are controlled');
SELECT is((SELECT count(*)::int FROM private.account_monitoring_alerts WHERE notified_at IS NOT NULL), 0, 'nothing is acknowledged by a rejected report');
SELECT is(public.account_monitoring_record_delivery((SELECT (c ->> 'claimed_at')::timestamptz FROM mon_claim), NULL, ARRAY['webhook']), 2, 'delivery is acknowledged');
SELECT is((SELECT count(*)::int FROM private.account_monitoring_alerts WHERE notified_at IS NOT NULL), 2, 'both alerts are marked notified');
SELECT is(pg_temp.snap() #> '{alerts,last_delivery_channels}', '["webhook"]'::jsonb, 'with the channel that accepted it');
SELECT is((pg_temp.snap() #>> '{alerts,undelivered}')::int, 0, 'nothing undelivered');
UPDATE private.account_monitoring_alerts SET last_attempt_at = now() - interval '2 hours';
SELECT is((public.account_monitoring_claim_notices() -> 'notices'), '[]'::jsonb, 'a delivered alert is not repeated');

UPDATE private.account_monitoring_alerts SET notified_at = now() - interval '25 hours' WHERE code = 'deletions_failed';
DELETE FROM mon_claim;
INSERT INTO mon_claim SELECT public.account_monitoring_claim_notices();
SELECT is((SELECT c -> 'notices' -> 0 ->> 'kind' FROM mon_claim), 'reminder', 'still open after 24 h: a reminder');
SELECT public.account_monitoring_record_delivery((SELECT (c ->> 'claimed_at')::timestamptz FROM mon_claim), 'webhook_rejected');
SELECT ok((SELECT notified_at < now() - interval '24 hours' FROM private.account_monitoring_alerts WHERE code = 'deletions_failed'),
  'a rejected webhook does not acknowledge the reminder');
SELECT is((pg_temp.snap() #>> '{alerts,last_delivery_error}'), 'webhook_rejected', 'a failed delivery is reported to admins');
SELECT is(pg_temp.snap() #> '{alerts,last_delivery_channels}', '["webhook"]'::jsonb, 'the last successful channel is kept');
SELECT is((pg_temp.snap() #>> '{alerts,undelivered}')::int, 1, 'and counts as undelivered');
UPDATE private.account_monitoring_alerts SET last_attempt_at = now() - interval '30 minutes' WHERE code = 'deletions_failed';
SELECT is((public.account_monitoring_claim_notices() -> 'notices'), '[]'::jsonb, 'a failed delivery waits an hour before retrying');
UPDATE private.account_monitoring_alerts SET last_attempt_at = now() - interval '61 minutes' WHERE code = 'deletions_failed';
SELECT is((public.account_monitoring_claim_notices() #>> '{notices,0,kind}'), 'reminder', 'then retries');
SELECT public.account_monitoring_record_delivery((SELECT c ->> 'claimed_at' FROM mon_claim)::timestamptz, 'alert_recipients_missing');
SELECT is((pg_temp.snap() #>> '{alerts,last_delivery_error}'), 'alert_recipients_missing', 'missing recipients are reported as the delivery error');
SELECT throws_ok($$ SELECT public.account_monitoring_record_delivery(now(), 'Bad Error <x@y>') $$, '22023', 'invalid_delivery_report',
  'delivery errors are controlled codes');

-- Resolve the failed deletion.
DELETE FROM public.account_deletion_jobs WHERE status = 'failed';
SELECT private.account_monitoring_check();
SELECT ok((SELECT resolved_at IS NOT NULL FROM private.account_monitoring_alerts WHERE code = 'deletions_failed'), 'a cleared issue resolves its alert');
UPDATE private.account_monitoring_alerts SET last_attempt_at = now() - interval '2 hours', last_delivery_error = NULL;
SELECT is((public.account_monitoring_claim_notices() #>> '{notices,0}')::jsonb ->> 'kind', 'resolved', 'and a resolved notice is due');
-- Reopen: bookkeeping resets so the new opening is announced.
INSERT INTO public.account_deletion_jobs (user_id, mode, status, failed_at, last_error_code) VALUES
  (gen_random_uuid(), 'scheduled', 'failed', now(), 'auth_delete_failed');
SELECT private.account_monitoring_check();
SELECT ok((SELECT resolved_at IS NULL AND notified_at IS NULL AND last_attempt_at IS NULL FROM private.account_monitoring_alerts WHERE code = 'deletions_failed'),
  'a reopened alert starts fresh');
SELECT is((SELECT private.account_monitoring_notice_due(a) FROM private.account_monitoring_alerts a WHERE code = 'deletions_failed'), 'opened',
  'and is announced again');

-- ── 8. Scheduler failures ───────────────────────────────────────────────
DELETE FROM public.account_deletion_jobs;
DELETE FROM public.account_lifecycle;
-- Missing runs: active for an hour, last successful run an hour ago.
UPDATE private.account_maintenance_runs SET finished_at = now() - interval '1 hour';
UPDATE private.account_monitoring_state SET scheduler_active_since = now() - interval '1 hour';
SELECT is(pg_temp.issues(), '{maintenance_runs_missing}'::text[], 'no successful run for 30 min: missing runs');
-- A degraded run is not a successful one.
SELECT public.account_maintenance_record_run('degraded', 100, 0, 0, ARRAY['export_sweep_failed']);
SELECT is(pg_temp.issues(), '{maintenance_runs_missing}'::text[], 'a degraded run does not clear it');
SELECT is(pg_temp.snap() #> '{scheduler,last_run_error_codes}', '["export_sweep_failed"]'::jsonb, 'its codes are reported');
-- Just activated (no successful run yet): not missing until 30 min pass.
DELETE FROM private.account_maintenance_runs;
UPDATE private.account_monitoring_state SET scheduler_active_since = now() - interval '5 minutes';
SELECT is(pg_temp.issues(), '{}'::text[], 'freshly activated: not yet missing');

-- Failing calls: three answered with 500 (or timed out / no answer).
INSERT INTO net._http_response (id, status_code, timed_out, created) VALUES
  (990000001, 500, false, now()), (990000002, 500, false, now()), (990000003, NULL, true, now()), (990000004, 200, false, now());
INSERT INTO private.account_maintenance_dispatches (request_id, dispatched_at) VALUES
  (990000004, now() - interval '50 minutes'), (990000001, now() - interval '40 minutes'), (990000002, now() - interval '30 minutes');
SELECT is((pg_temp.snap() #>> '{scheduler,consecutive_failed_calls}')::int, 2, 'two failed calls since the last good one');
SELECT ok(NOT ('maintenance_calls_failing' = ANY (pg_temp.issues())), 'below the threshold');
INSERT INTO private.account_maintenance_dispatches (request_id, dispatched_at) VALUES (990000003, now() - interval '20 minutes');
SELECT ok('maintenance_calls_failing' = ANY (pg_temp.issues()), 'three in a row (a timeout counts): failing calls');
SELECT is((pg_temp.snap() #>> '{scheduler,consecutive_failed_calls}')::int, 3, 'counted');
INSERT INTO private.account_maintenance_dispatches (request_id, dispatched_at) VALUES (990000099, now() - interval '10 minutes');
SELECT is((pg_temp.snap() #>> '{scheduler,consecutive_failed_calls}')::int, 4, 'a call with no answer after 2 min counts too');
DELETE FROM private.account_maintenance_dispatches;

-- Invalid configuration.
DELETE FROM vault.secrets WHERE name = 'account_maintenance_secret';
SELECT vault.create_secret(repeat('s', 20), 'account_maintenance_secret');
SELECT is(pg_temp.issues(), '{scheduler_not_configured}'::text[], 'a short maintenance secret: not configured');
DELETE FROM vault.secrets WHERE name = 'account_maintenance_secret';
SELECT vault.create_secret(repeat('s', 40), 'account_maintenance_secret');
DELETE FROM vault.secrets WHERE name = 'username_reservation_key';
SELECT is(pg_temp.issues(), '{scheduler_not_configured}'::text[], 'no username key: not configured');
SELECT vault.create_secret(repeat('k', 48), 'username_reservation_key');

-- Inactive while deletions are pending.
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for)
VALUES ('00000000-0000-4000-8000-00000a110003', 'pending_deletion', 'scheduled', now() + interval '10 days');
SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname = 'account-maintenance';
SELECT is(pg_temp.issues(), '{scheduler_inactive}'::text[], 'inactive with a deletion pending: an issue');

-- (Calls through PostgREST, whose sessions load safeupdate, are covered by
-- scripts/integration/account-monitoring.ts; safeupdate can't be loaded here.)
ALTER TABLE public.account_lifecycle ENABLE TRIGGER USER;
SELECT * FROM finish();
ROLLBACK;
