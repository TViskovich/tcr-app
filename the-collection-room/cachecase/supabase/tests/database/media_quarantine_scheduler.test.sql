-- pgTAP test for 20261126120000_media_quarantine_scheduler.sql (Phase 2B M4 step 5A).
-- Turns the scheduler switch ON inside one rolled-back transaction, so it
-- runs ONLY on an isolated disposable local stack, and only when the session
-- says so:  PGOPTIONS='-c cachecase.isolated_stack=on' (or SET it first).
-- Anywhere else it stops at the first statement. pg_net only sends requests
-- whose transaction committed, so nothing queued here is ever sent.

BEGIN;
DO $$ BEGIN
  IF current_setting('cachecase.isolated_stack', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'refusing: scheduler tests enable automatic dispatch and run only on an isolated stack (cachecase.isolated_stack=on)';
  END IF;
END $$;
SELECT plan(64);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated, service_role;
CREATE FUNCTION pg_temp.q(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e75000' || lpad(n::text, 2, '0'))::uuid $$;
GRANT EXECUTE ON FUNCTION pg_temp.q(int) TO authenticated, service_role;
-- A fresh queued job, as private.queue_media_hold creates one (triggers on).
CREATE FUNCTION pg_temp.job(n int, cs boolean DEFAULT false) RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id,
                                        quarantine_path, child_safety, legal_hold)
  VALUES (pg_temp.q(n), 'avatars', '00000000-0000-4000-8000-0000e7500001/sched-' || n || '.jpg', '00000000-0000-4000-8000-0000e7500001',
          'avatar', 'profile', '00000000-0000-4000-8000-0000e7500001', 'q/' || pg_temp.q(n) || '/original', cs, cs)
  RETURNING id $$;
CREATE FUNCTION pg_temp.sent() RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM private.media_quarantine_dispatches WHERE request_id IS NOT NULL $$;
CREATE FUNCTION pg_temp.queued() RETURNS int LANGUAGE sql AS $$ SELECT count(*)::int FROM net.http_request_queue $$;
CREATE FUNCTION pg_temp.backdate() RETURNS void LANGUAGE sql AS $$
  UPDATE private.media_quarantine_dispatches SET dispatched_at = dispatched_at - interval '60 seconds' $$;
CREATE TEMP TABLE v (k text PRIMARY KEY, val text);
GRANT ALL ON v TO authenticated, service_role;

-- ── 1. Shape and privileges ─────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r,
                  unnest(ARRAY['private.media_quarantine_scheduler_config', 'private.media_quarantine_scheduler_changes',
                               'private.media_quarantine_dispatches', 'private.media_quarantine_scheduler_runs']) t
           WHERE has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')), 0, 'no API role can read or change the switch, dispatches or runs');
SELECT is((SELECT count(*)::int FROM private.media_quarantine_scheduler_config), 1, 'exactly one switch row');
SELECT is((SELECT enabled FROM private.media_quarantine_scheduler_config), false, 'automatic dispatch is OFF by default');
SELECT is((SELECT schedule || '|' || active::text || '|' || command FROM cron.job WHERE jobname = 'media-quarantine-worker'),
  '* * * * *|false|SELECT private.run_media_quarantine_sweep()', 'sweep job: every minute, created INACTIVE, calls only the sweep');
SELECT is((SELECT string_agg(jobname || '=' || schedule || ':' || command, ';' ORDER BY jobname) FROM cron.job
            WHERE jobname IN ('account-maintenance', 'account-deletion-monitor')),
  'account-deletion-monitor=*/15 * * * *:SELECT private.run_account_monitor();account-maintenance=*/10 * * * *:SELECT private.run_account_maintenance()',
  'existing account jobs unchanged');
SELECT is((SELECT count(*)::int FROM cron.job WHERE command ILIKE '%restore%' OR command ILIKE '%purge%'), 0, 'no scheduled restoration or purge');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.media_quarantine_scheduler_begin(text)',
             'public.media_quarantine_scheduler_finish(uuid,text,integer,jsonb,text,integer)']::regprocedure[]) f
           JOIN pg_proc p ON p.oid = f
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND has_function_privilege('service_role', f, 'EXECUTE')
             AND NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE')), 2,
  'begin/finish: definer, pinned, service role only');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['private.media_quarantine_scheduler_enabled()', 'private.media_quarantine_scheduler_reap()',
             'private.media_quarantine_claimable(boolean)', 'private.media_quarantine_dispatch(text,boolean)', 'private.media_quarantine_kick()',
             'private.run_media_quarantine_sweep()', 'private.media_quarantine_scheduler_stale_after()']::regprocedure[]) f
           WHERE has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
              OR has_function_privilege('service_role', f, 'EXECUTE')), 0, 'dispatch, kick, sweep and helpers: no API role');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.oid = 'public.admin_media_quarantine_scheduler_status()'::regprocedure
            AND p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%'
            AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')), 1, 'status: admin only, signed in');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public', 'private') AND p.prosecdef
              AND (p.proname LIKE '%scheduler%' OR p.proname IN ('media_quarantine_dispatch', 'media_quarantine_kick', 'media_quarantine_claimable',
                                                                  'run_media_quarantine_sweep', 'media_quarantine_advance'))
              AND p.proconfig IS DISTINCT FROM ARRAY['search_path=""']), 0, 'every new definer function pins search_path');
SELECT throws_ok($$INSERT INTO private.media_quarantine_scheduler_config (id) VALUES (true)$$, '42501', NULL, 'a second switch row is refused');
SELECT throws_ok($$DELETE FROM private.media_quarantine_scheduler_config$$, '42501', NULL, 'the switch row cannot be deleted');
SELECT throws_ok($$INSERT INTO private.media_quarantine_events (quarantine_id, event, actor_id, actor_kind, scheduler_run_id)
                   VALUES (NULL, 'x', '00000000-0000-4000-8000-0000e7500001', 'scheduler', gen_random_uuid())$$, '23514', NULL,
  'a scheduler event can never carry a user id');
SELECT throws_ok($$INSERT INTO private.media_quarantine_events (quarantine_id, event, actor_kind) VALUES (NULL, 'x', 'scheduler')$$, '23514', NULL,
  'a scheduler event must name its run');

-- ── 2. Switch OFF: nothing is dispatched ────────────────────────────────
INSERT INTO v VALUES ('q0', pg_temp.queued()::text);
SELECT pg_temp.job(1);
SELECT pg_temp.job(2, true);
SELECT is((SELECT count(*)::int FROM private.media_quarantine_dispatches), 0, 'OFF: queued jobs (child safety included) record no dispatch');
SELECT is(pg_temp.queued(), (SELECT val::int FROM v WHERE k = 'q0'), 'OFF: no pg_net request is queued');
SELECT is(private.run_media_quarantine_sweep(), NULL, 'OFF: the sweep dispatches nothing, even with work waiting');
SELECT is(private.media_quarantine_dispatch('sweep', false), NULL, 'OFF: a direct dispatch call sends nothing');
SET LOCAL ROLE service_role;
SELECT is(public.media_quarantine_scheduler_begin('kick') ->> 'reason', 'disabled', 'OFF: the database refuses to open a run');
RESET ROLE;
SELECT is((SELECT status || ':' || error_code FROM private.media_quarantine_scheduler_runs), 'refused:disabled', '…and records the refusal');

-- ── 3. Switch ON, Vault not configured ──────────────────────────────────
UPDATE private.media_quarantine_scheduler_config SET enabled = true;
SELECT is((SELECT enabled::text || ':' || changed_by FROM private.media_quarantine_scheduler_changes ORDER BY id DESC LIMIT 1),
  'true:postgres', 'switching on is recorded with who did it');
SELECT pg_temp.job(3);
SELECT is((SELECT string_agg(source || ':' || skipped_reason, ',') FROM private.media_quarantine_dispatches), 'kick:not_configured',
  'no URL/secret in Vault → recorded as not_configured, nothing sent');
SELECT is(pg_temp.queued(), (SELECT val::int FROM v WHERE k = 'q0'), '…and no request queued');

-- ── 4. Switch ON, configured: kicks ─────────────────────────────────────
SELECT vault.create_secret('http://supabase_kong_cachecase-m4-replay:8000', 'project_url');
SELECT vault.create_secret(repeat('t', 40), 'media_quarantine_worker_secret');
SELECT pg_temp.backdate();
SELECT pg_temp.job(4);
SELECT is(pg_temp.sent(), 1, 'a queued job sends one kick');
SELECT is(pg_temp.queued(), (SELECT val::int FROM v WHERE k = 'q0') + 1, '…as one pg_net request (sent only if this transaction commits)');
SELECT is((SELECT method || ' ' || url FROM net.http_request_queue ORDER BY id DESC LIMIT 1),
  'POST http://supabase_kong_cachecase-m4-replay:8000/functions/v1/media-quarantine-scheduled', '…to the scheduled worker of THIS project only');
SELECT is((SELECT convert_from(body, 'utf8')::jsonb FROM net.http_request_queue ORDER BY id DESC LIMIT 1), '{"trigger": "kick"}'::jsonb,
  '…carrying only the trigger');
SELECT is((SELECT headers ->> 'Authorization' = 'Bearer ' || repeat('t', 40) FROM net.http_request_queue ORDER BY id DESC LIMIT 1), true,
  '…authenticated with the dedicated worker secret');
SELECT is((SELECT count(*)::int FROM private.media_quarantine_dispatches d WHERE d.skipped_reason IS NULL AND d.request_id IS NULL), 0,
  'dispatch records hold no URL or secret (request id only)');
SELECT pg_temp.job(5);
SELECT pg_temp.job(6);
SELECT is(pg_temp.sent(), 1, 'more jobs within 10 s: throttled to the one kick');
SELECT pg_temp.job(7, true);
SELECT is((SELECT count(*)::int FROM private.media_quarantine_dispatches WHERE child_safety AND request_id IS NOT NULL), 1,
  'a child-safety job still gets its own kick');
SELECT pg_temp.job(8, true);
SELECT is(pg_temp.sent(), 2, '…throttled to one per 5 s itself');
SELECT pg_temp.backdate();
UPDATE private.media_quarantine SET child_safety = true, legal_hold = true WHERE id = pg_temp.q(5);
SELECT is((SELECT count(*)::int FROM private.media_quarantine_dispatches WHERE child_safety AND request_id IS NOT NULL), 2,
  'a job that becomes child safety is kicked immediately');
UPDATE private.media_quarantine SET attempts = attempts WHERE id = pg_temp.q(6);
SELECT is(pg_temp.sent(), 3, 'other updates do not kick');
SELECT pg_temp.backdate();
INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id,
                                      quarantine_path, state, desired, size_bytes, source_sha256, quarantine_sha256, source_removed_at)
VALUES (pg_temp.q(30), 'avatars', '00000000-0000-4000-8000-0000e7500001/sched-30.jpg', '00000000-0000-4000-8000-0000e7500001', 'avatar',
        'profile', '00000000-0000-4000-8000-0000e7500001', 'q/' || pg_temp.q(30) || '/original', 'restore_pending', 'restore', 3,
        repeat('c', 64), repeat('c', 64), now());
SELECT is(pg_temp.sent(), 3, 'restore work never kicks the scheduler');

-- ── 5. Sweep ────────────────────────────────────────────────────────────
SELECT pg_temp.backdate();
SELECT isnt(private.run_media_quarantine_sweep(), NULL, 'ON with claimable work: the sweep dispatches');
SELECT is((SELECT source || ':' || child_safety::text FROM private.media_quarantine_dispatches ORDER BY id DESC LIMIT 1), 'sweep:true',
  '…flagged child safety when such work waits');
UPDATE private.media_quarantine SET lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes'
 WHERE id IN (SELECT pg_temp.q(n) FROM generate_series(1, 8) n);
SELECT is(private.run_media_quarantine_sweep(), NULL, 'nothing claimable (all leased): the sweep sends nothing');
UPDATE private.media_quarantine SET lease_token = NULL, lease_expires_at = NULL WHERE id IN (SELECT pg_temp.q(n) FROM generate_series(1, 8) n);

-- ── 6. Runs: second authorization, concurrency, rate ───────────────────
SET LOCAL ROLE service_role;
INSERT INTO v SELECT 'r1', public.media_quarantine_scheduler_begin('kick') ->> 'run_id';
INSERT INTO v SELECT 'r2', public.media_quarantine_scheduler_begin('sweep') ->> 'run_id';
SELECT is(public.media_quarantine_scheduler_begin('kick') ->> 'reason', 'busy', 'at most 2 scheduled runs at once');
SELECT throws_ok($$SELECT public.media_quarantine_scheduler_begin('restore')$$, '22023', NULL, 'unknown triggers are refused');
SELECT throws_ok($$SELECT public.media_quarantine_scheduler_finish((SELECT val::uuid FROM v WHERE k = 'r1'), 'completed', 1,
                     '{"restored": 1}'::jsonb, NULL, 10)$$, '22023', NULL, 'finish: unknown outcome codes are refused');
SELECT throws_ok($$SELECT public.media_quarantine_scheduler_finish((SELECT val::uuid FROM v WHERE k = 'r1'), 'completed', 1,
                     '{"quarantined": 1}'::jsonb, 'has a/path', 10)$$, '22023', NULL, 'finish: free-text errors are refused');
RESET ROLE;

-- ── 7. Scheduler steps are attributed to the scheduler, never a user ────
SET LOCAL ROLE service_role;
INSERT INTO v SELECT 'lease', (SELECT lease_token::text FROM public.media_quarantine_claim(1, 60) LIMIT 1);
RESET ROLE;
INSERT INTO v SELECT 'claimed', id::text FROM private.media_quarantine WHERE lease_token = (SELECT val::uuid FROM v WHERE k = 'lease');
SELECT is((SELECT val::uuid FROM v WHERE k = 'claimed'), pg_temp.q(2), 'claims still take child safety first');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7500001');   -- a user id in the session must not leak into scheduler events
SET LOCAL ROLE service_role;
SELECT is(public.media_quarantine_advance((SELECT val::uuid FROM v WHERE k = 'claimed'), (SELECT val::uuid FROM v WHERE k = 'lease'), 'pending',
            jsonb_build_object('error', 'copy_failed', 'scheduler_run', (SELECT val FROM v WHERE k = 'r1'))) ->> 'ok', 'true',
  'a scheduler step is accepted for a running run');
RESET ROLE;
SELECT is((SELECT actor_kind || ':' || (actor_id IS NULL)::text || ':' || (scheduler_run_id = (SELECT val::uuid FROM v WHERE k = 'r1'))::text
             FROM private.media_quarantine_events WHERE quarantine_id = pg_temp.q(2) ORDER BY id DESC LIMIT 1), 'scheduler:true:true',
  '…recorded as actor_kind scheduler with the run id and no user id');
SELECT is((SELECT last_error || ':' || (next_attempt_at > now())::text FROM private.media_quarantine WHERE id = pg_temp.q(2)), 'copy_failed:true',
  '…with the existing back-off unchanged');
SET LOCAL ROLE service_role;
INSERT INTO v SELECT 'lease2', (SELECT lease_token::text FROM public.media_quarantine_claim(1, 60) LIMIT 1);
INSERT INTO v VALUES ('claimed2', NULL);
RESET ROLE;
UPDATE v SET val = (SELECT id::text FROM private.media_quarantine WHERE lease_token = (SELECT val::uuid FROM v WHERE k = 'lease2')) WHERE k = 'claimed2';
SET LOCAL ROLE service_role;
SELECT is(public.media_quarantine_advance((SELECT val::uuid FROM v WHERE k = 'claimed2'), (SELECT val::uuid FROM v WHERE k = 'lease2'), 'pending',
            jsonb_build_object('error', 'x', 'scheduler_run', (SELECT val FROM v WHERE k = 'r1'), 'actor', '00000000-0000-4000-8000-0000e7500001')) ->> 'reason',
  'scheduler_refused', 'a scheduler step cannot also claim an admin actor');
SELECT is(public.media_quarantine_advance((SELECT val::uuid FROM v WHERE k = 'claimed2'), (SELECT val::uuid FROM v WHERE k = 'lease2'), 'restoring',
            jsonb_build_object('scheduler_run', (SELECT val FROM v WHERE k = 'r1'))) ->> 'reason', 'scheduler_refused', 'a scheduler step can never start a restoration');
SELECT is(public.media_quarantine_advance((SELECT val::uuid FROM v WHERE k = 'claimed2'), (SELECT val::uuid FROM v WHERE k = 'lease2'), 'restored',
            jsonb_build_object('scheduler_run', (SELECT val FROM v WHERE k = 'r1'))) ->> 'reason', 'scheduler_refused', '…nor finish one');
SELECT is(public.media_quarantine_advance((SELECT val::uuid FROM v WHERE k = 'claimed2'), (SELECT val::uuid FROM v WHERE k = 'lease2'), 'pending',
            jsonb_build_object('error', 'x', 'scheduler_run', gen_random_uuid())) ->> 'reason', 'scheduler_refused', 'an unknown run is refused');
SELECT is(public.media_quarantine_scheduler_finish((SELECT val::uuid FROM v WHERE k = 'r2'), 'completed', 2, '{"quarantined": 2}'::jsonb, NULL, 1200) ->> 'ok',
  'true', 'finish records a completed run');
SELECT is(public.media_quarantine_scheduler_finish((SELECT val::uuid FROM v WHERE k = 'r2'), 'failed', 0, '{}'::jsonb, 'x', 1) ->> 'ok',
  'false', 'a finished run cannot be finished again');
SELECT is(public.media_quarantine_advance((SELECT val::uuid FROM v WHERE k = 'claimed2'), (SELECT val::uuid FROM v WHERE k = 'lease2'), 'pending',
            jsonb_build_object('error', 'x', 'scheduler_run', (SELECT val FROM v WHERE k = 'r2'))) ->> 'reason', 'scheduler_refused',
  'a finished run can no longer advance jobs');
SELECT is(public.media_quarantine_advance((SELECT val::uuid FROM v WHERE k = 'claimed2'), (SELECT val::uuid FROM v WHERE k = 'lease2'), 'pending',
            jsonb_build_object('error', 'copy_failed', 'actor', '00000000-0000-4000-8000-0000e7500002')) ->> 'ok', 'true',
  'admin worker steps still work');
RESET ROLE;
SELECT is((SELECT actor_kind || ':' || actor_id::text FROM private.media_quarantine_events WHERE quarantine_id = (SELECT val::uuid FROM v WHERE k = 'claimed2')
            ORDER BY id DESC LIMIT 1), 'admin:00000000-0000-4000-8000-0000e7500002', '…recorded as actor_kind admin with the admin id');

-- ── 8. Dead runs, rate limit ────────────────────────────────────────────
UPDATE private.media_quarantine_scheduler_runs SET started_at = started_at - interval '200 seconds' WHERE id = (SELECT val::uuid FROM v WHERE k = 'r1');
SET LOCAL ROLE service_role;
INSERT INTO v SELECT 'r3', public.media_quarantine_scheduler_begin('kick') ->> 'run_id';
RESET ROLE;
SELECT is((SELECT status || ':' || error_code FROM private.media_quarantine_scheduler_runs WHERE id = (SELECT val::uuid FROM v WHERE k = 'r1')),
  'abandoned:stale', 'a run that died is reaped as abandoned…');
SELECT isnt((SELECT val FROM v WHERE k = 'r3'), NULL, '…and frees its slot');
SET LOCAL ROLE service_role;
SELECT is(public.media_quarantine_advance(pg_temp.q(2), gen_random_uuid(), 'pending',
            jsonb_build_object('error', 'x', 'scheduler_run', (SELECT val FROM v WHERE k = 'r1'))) ->> 'reason', 'scheduler_refused',
  'an abandoned run can no longer advance jobs');
RESET ROLE;
INSERT INTO private.media_quarantine_scheduler_runs (trigger, status, finished_at, duration_ms)
SELECT 'kick', 'completed', clock_timestamp(), 1 FROM generate_series(1, 20);
SET LOCAL ROLE service_role;
SELECT is(public.media_quarantine_scheduler_begin('sweep') ->> 'reason', 'rate_limited', 'more than 20 runs a minute are refused');
RESET ROLE;
SELECT pg_temp.backdate();
UPDATE private.media_quarantine_scheduler_runs SET started_at = started_at - interval '40 days', finished_at = finished_at - interval '40 days'
 WHERE status = 'completed';
SELECT private.run_media_quarantine_sweep();
SELECT is((SELECT count(*)::int FROM private.media_quarantine_scheduler_runs WHERE started_at < now() - interval '30 days'), 0,
  'the sweep keeps 30 days of run records');

-- ── 9. Admin status ─────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000e7500011', 'sch-11@example.invalid', '{"username": "sch_11"}'),
  ('00000000-0000-4000-8000-0000e7500012', 'sch-12@example.invalid', '{"username": "sch_12"}');
INSERT INTO public.admin_users (user_id) VALUES ('00000000-0000-4000-8000-0000e7500011');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7500011');
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'status', public.admin_media_quarantine_scheduler_status()::text;
RESET ROLE;
SELECT is((SELECT (val::jsonb ->> 'enabled') || ':' || (val::jsonb ->> 'sweep_active') FROM v WHERE k = 'status'), 'true:false',
  'admins see the switch and the (inactive) sweep');
SELECT is((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys((SELECT val::jsonb FROM v WHERE v.k = 'status')) k),
  ARRAY['child_safety_claimable', 'claimable', 'dispatches_24h', 'enabled', 'last_completed_at', 'last_failed_at', 'running', 'runs_24h', 'sweep_active'],
  '…as counts, flags and times only');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7500012');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.admin_media_quarantine_scheduler_status()$$, '42501', NULL, 'collectors cannot read scheduler status');
SELECT throws_ok($$SELECT public.media_quarantine_scheduler_begin('kick')$$, '42501', NULL, 'collectors cannot open runs');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
