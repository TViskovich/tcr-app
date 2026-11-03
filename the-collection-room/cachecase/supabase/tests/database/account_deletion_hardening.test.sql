-- pgTAP test for 20261107120000_account_deletion_launch_hardening.sql
-- (Checkpoint 5): fail-closed username reservations, an inactive-by-default
-- scheduler and readiness, export-step leases vs. deletion, late-file
-- detection, audit retention, and cross-collector isolation of exports and
-- deletion jobs.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(41);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated, anon, service_role;

-- Start from a clean slate: no Vault values, no reservations.
DELETE FROM vault.secrets WHERE name IN ('username_reservation_key', 'project_url', 'account_maintenance_secret');
DELETE FROM private.username_reservations;

-- ── 1. Privileges ───────────────────────────────────────────────────────
CREATE TEMP TABLE hd_fns AS SELECT unnest(ARRAY[
  'public.account_export_take_lease(uuid,integer)', 'public.account_deletion_export_busy(uuid)',
  'public.account_deletion_late_files(integer)']::regprocedure[]) AS fn;
SELECT is((SELECT count(*)::int FROM hd_fns WHERE has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')), 0,
  'new worker functions are not callable by clients');
SELECT is((SELECT count(*)::int FROM hd_fns WHERE has_function_privilege('service_role', fn, 'EXECUTE')), 3, 'the service role can run them');
SELECT ok(NOT has_function_privilege('anon', 'public.account_deletion_preflight()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.account_deletion_preflight()', 'EXECUTE'), 'clients cannot read deletion readiness');

-- ── 2. Scheduler starts inactive; readiness ─────────────────────────────
SELECT ok(EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'account-maintenance' AND NOT active), 'the maintenance job is created inactive');
SELECT is(public.account_deletion_preflight(), '{"ready": false, "scheduler_configured": false, "username_key_configured": false}'::jsonb,
  'nothing configured: not ready');
SELECT vault.create_secret(repeat('k', 31), 'username_reservation_key');
SELECT is((public.account_deletion_preflight() ->> 'username_key_configured')::boolean, false, 'a key shorter than 32 characters is not accepted');
DELETE FROM vault.secrets WHERE name = 'username_reservation_key';
SELECT vault.create_secret(repeat('k', 48), 'username_reservation_key');
SELECT is(public.account_deletion_preflight(), '{"ready": false, "scheduler_configured": false, "username_key_configured": true}'::jsonb,
  'key alone: still not ready');
SELECT vault.create_secret('http://supabase_kong_cachecase:8000', 'project_url');
SELECT vault.create_secret(repeat('s', 31), 'account_maintenance_secret');
SELECT cron.alter_job(job_id := jobid, active := true) FROM cron.job WHERE jobname = 'account-maintenance';
SELECT is((public.account_deletion_preflight() ->> 'ready')::boolean, false, 'a maintenance secret shorter than 32 characters is not accepted');
DELETE FROM vault.secrets WHERE name = 'account_maintenance_secret';
SELECT vault.create_secret(repeat('s', 40), 'account_maintenance_secret');
SELECT is(public.account_deletion_preflight(), '{"ready": true, "scheduler_configured": true, "username_key_configured": true}'::jsonb,
  'key + Vault values + active job: ready');
SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname = 'account-maintenance';
SELECT is((public.account_deletion_preflight() ->> 'ready')::boolean, false, 'deactivating the job makes Delete Now unavailable again');

-- ── 3. Username reservations fail closed ────────────────────────────────
DELETE FROM vault.secrets WHERE name = 'username_reservation_key';
SELECT ok(NOT public.username_is_reserved('hd_alpha'), 'no reservations and no key: nothing can be reserved, the check answers false');
SELECT lives_ok($$ INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000d5c00001', 'hd-a@example.invalid', '{"username":"hd_alpha"}') $$, 'and sign-up works');
SELECT vault.create_secret(repeat('k', 48), 'username_reservation_key');
INSERT INTO private.username_reservations VALUES (private.username_hmac('hd_taken'), now() + interval '90 days');
SELECT ok(public.username_is_reserved('hd_taken'), 'with the key a reserved name is reported');
SELECT ok(public.username_is_reserved('  HD_Taken '), 'case and surrounding spaces don’t get around it');
SELECT ok(NOT public.username_is_reserved('hd_free'), 'a free name is not');
DELETE FROM vault.secrets WHERE name = 'username_reservation_key';
SELECT throws_ok($$ SELECT public.username_is_reserved('hd_free') $$, 'P0001', 'username_reservation_unavailable',
  'key removed while reservations exist: the check raises instead of answering');
SELECT throws_ok($$ INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000d5c00002', 'hd-b@example.invalid', '{"username":"hd_taken"}') $$, 'P0001', 'username_reservation_unavailable',
  'and sign-up is refused — even the reserved name can’t slip through');
SELECT vault.create_secret(repeat('k', 31), 'username_reservation_key');
SELECT throws_ok($$ INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000d5c00003', 'hd-c@example.invalid', '{"username":"hd_free2"}') $$, 'P0001', 'username_reservation_unavailable',
  'a key that is too short counts as missing');
DELETE FROM vault.secrets WHERE name = 'username_reservation_key';
SELECT vault.create_secret(repeat('k', 48), 'username_reservation_key');
SELECT throws_ok($$ INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000d5c00004', 'hd-d@example.invalid', '{"username":"hd_taken"}') $$, '23505', 'username_reserved',
  'key restored: the reserved name is refused');
SELECT lives_ok($$ INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000d5c00005', 'hd-e@example.invalid', '{"username":"hd_beta"}') $$, 'and other names work');

-- ── 4. Export steps vs. deletion ────────────────────────────────────────
-- A (…01) exports; B (…05) is another collector.
INSERT INTO public.account_exports (id, user_id, status, object_path, expires_at) VALUES
  ('00000000-0000-4000-8000-0000d5e00001', '00000000-0000-4000-8000-0000d5c00001', 'collecting', NULL, NULL),
  ('00000000-0000-4000-8000-0000d5e00005', '00000000-0000-4000-8000-0000d5c00005', 'ready', 'x/', now() + interval '7 days');
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.account_export_take_lease('00000000-0000-4000-8000-0000d5e00001', 90)), 1, 'an export step takes its lease');
SELECT is((SELECT count(*)::int FROM public.account_export_take_lease('00000000-0000-4000-8000-0000d5e00001', 90)), 0, 'a second step is refused while it is held');
SELECT is((SELECT count(*)::int FROM public.account_export_take_lease('00000000-0000-4000-8000-0000d5e00005', 90)), 0, 'a finished export takes no lease');
SELECT is((SELECT count(*)::int FROM public.account_export_take_lease(gen_random_uuid(), 90)), 0, 'an unknown export takes no lease');
-- A chooses Delete Now while the step is running.
CREATE TEMP TABLE hd_job AS SELECT * FROM public.account_deletion_start('00000000-0000-4000-8000-0000d5c00001', 'immediate');
SELECT ok(public.account_deletion_export_busy((SELECT id FROM hd_job)), 'the deletion worker sees the running export step and waits');
RESET ROLE;
UPDATE public.account_exports SET lease_until = now() - interval '1 second' WHERE id = '00000000-0000-4000-8000-0000d5e00001';
SET LOCAL ROLE service_role;
SELECT ok(NOT public.account_deletion_export_busy((SELECT id FROM hd_job)), 'once the lease ends it proceeds');
SELECT is((SELECT count(*)::int FROM public.account_export_take_lease('00000000-0000-4000-8000-0000d5e00001', 90)), 0,
  'and no new export step can start for a deleting account');
RESET ROLE;

-- ── 5. Isolation: one collector can't see or change another's export or
--      deletion job (no table privileges, private bucket, no policies) ──
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d5c00005');
SELECT throws_ok($$ SELECT count(*) FROM public.account_exports $$, '42501', NULL, 'clients cannot read any export job');
SELECT throws_ok($$ UPDATE public.account_exports SET status = 'failed' $$, '42501', NULL, 'or change one');
SELECT throws_ok($$ SELECT count(*) FROM public.account_export_parts $$, '42501', NULL, 'or read export parts');
SELECT throws_ok($$ SELECT count(*) FROM public.account_deletion_jobs $$, '42501', NULL, 'or read deletion jobs');
SELECT throws_ok($$ UPDATE public.account_deletion_jobs SET status = 'completed' $$, '42501', NULL, 'or change one');
RESET ROLE;
INSERT INTO storage.objects (bucket_id, name) VALUES ('account-exports', '00000000-0000-4000-8000-0000d5c00001/e/CacheCase-export.zip');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d5c00005');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'account-exports'), 0, 'another collector’s export archive is invisible through Storage');
SELECT pg_temp.login('00000000-0000-4000-8000-0000d5c00001');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'account-exports'), 0, 'archives are reachable only through short-lived signed links');
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true);

-- ── 6. Late files after completion ──────────────────────────────────────
UPDATE public.account_deletion_jobs SET status = 'completed', completed_at = now(), purge_after = now() + interval '30 days'
  WHERE id = (SELECT id FROM hd_job);
SET LOCAL ROLE service_role;
SELECT ok((SELECT id FROM hd_job) IN (SELECT * FROM public.account_deletion_late_files(10)), 'a completed deletion with a file left in its folders is found');
RESET ROLE;
SET LOCAL storage.allow_delete_query = 'true'; -- what the Storage API does
DELETE FROM storage.objects WHERE bucket_id = 'account-exports' AND name LIKE '00000000-0000-4000-8000-0000d5c00001/%';
SET LOCAL ROLE service_role;
SELECT ok((SELECT id FROM hd_job) NOT IN (SELECT * FROM public.account_deletion_late_files(10)), 'once removed it is no longer listed');
RESET ROLE;
INSERT INTO storage.objects (bucket_id, name) VALUES ('item-images', '00000000-0000-4000-8000-0000d5c00005/own.jpg');
SET LOCAL ROLE service_role;
SELECT ok((SELECT id FROM hd_job) NOT IN (SELECT * FROM public.account_deletion_late_files(10)), 'other collectors’ files never count');
RESET ROLE;

-- ── 7. Audit retention ──────────────────────────────────────────────────
INSERT INTO public.account_deletion_jobs (id, user_id, mode, status, failed_at) VALUES
  ('00000000-0000-4000-8000-0000d5f00001', gen_random_uuid(), 'immediate', 'failed', now() - interval '60 days');
INSERT INTO public.account_deletion_jobs (id, user_id, mode, status, completed_at, purge_after) VALUES
  ('00000000-0000-4000-8000-0000d5f00002', gen_random_uuid(), 'scheduled', 'completed', now() - interval '31 days', now() - interval '1 day');
INSERT INTO public.account_deletion_storage_queue (job_id, bucket, path) VALUES ('00000000-0000-4000-8000-0000d5f00002', 'avatars', 'x/old.jpg');
SET LOCAL ROLE service_role;
SELECT is((public.account_deletion_housekeeping() ->> 'jobs_purged')::int, 1, 'housekeeping deletes one job past its 30 days');
RESET ROLE;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs WHERE id = '00000000-0000-4000-8000-0000d5f00002')
      AND NOT EXISTS (SELECT 1 FROM public.account_deletion_storage_queue WHERE job_id = '00000000-0000-4000-8000-0000d5f00002'),
  'the job and its file manifest are gone');
SELECT ok(EXISTS (SELECT 1 FROM public.account_deletion_jobs WHERE id = (SELECT id FROM hd_job)), 'a recent completion is kept');
SELECT ok(EXISTS (SELECT 1 FROM public.account_deletion_jobs WHERE id = '00000000-0000-4000-8000-0000d5f00001'), 'a failed job is kept until an operator resolves it');

SELECT * FROM finish();
ROLLBACK;
