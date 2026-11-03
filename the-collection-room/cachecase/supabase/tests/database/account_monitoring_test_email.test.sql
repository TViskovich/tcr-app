-- pgTAP test for 20261109120000_account_monitoring_test_email.sql: the
-- test-email rate limit is server-side, private, and touches nothing else.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(19);

DELETE FROM private.account_monitoring_test_sends;
CREATE TEMP TABLE te_before AS SELECT
  (SELECT count(*) FROM private.account_monitoring_alerts) AS alerts,
  (SELECT count(*) FROM private.account_maintenance_runs) AS runs,
  (SELECT count(*) FROM private.account_maintenance_dispatches) AS dispatches,
  (SELECT md5(t::text) FROM private.account_monitoring_state t) AS state,
  (SELECT count(*) FROM public.account_deletion_jobs) AS jobs;

-- ── Privileges ──────────────────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
  WHERE has_table_privilege(r, 'private.account_monitoring_test_sends', 'SELECT')
     OR has_table_privilege(r, 'private.account_monitoring_test_sends', 'INSERT')
     OR has_table_privilege(r, 'private.account_monitoring_test_sends', 'DELETE')), 0,
  'no client (or the service role) can touch the test log directly');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'private.account_monitoring_test_sends'::regclass), 'RLS is on');
SELECT ok(NOT has_function_privilege('anon', 'public.account_monitoring_take_test_slot()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.account_monitoring_take_test_slot()', 'EXECUTE'), 'clients cannot take a test slot');
SELECT ok(NOT has_function_privilege('anon', 'public.account_monitoring_record_test(bigint,text,text[])', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.account_monitoring_record_test(bigint,text,text[])', 'EXECUTE'), 'nor record one');
SELECT ok(has_function_privilege('service_role', 'public.account_monitoring_take_test_slot()', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.account_monitoring_record_test(bigint,text,text[])', 'EXECUTE'), 'the service role can');

-- ── Rate limit ──────────────────────────────────────────────────────────
SET LOCAL ROLE service_role;
CREATE TEMP TABLE te_slot AS SELECT public.account_monitoring_take_test_slot() AS s;
RESET ROLE;
SELECT is((SELECT (s ->> 'allowed')::boolean FROM te_slot), true, 'the first test is allowed');
SELECT ok((SELECT (s ->> 'slot') IS NOT NULL FROM te_slot), 'with a slot id');
SELECT is((public.account_monitoring_take_test_slot() ->> 'allowed')::boolean, false, 'a second one at once is refused');
SELECT is((public.account_monitoring_take_test_slot() ->> 'retry_after_seconds')::int, 600, 'retry after 10 minutes');
SELECT is((SELECT count(*)::int FROM private.account_monitoring_test_sends), 1, 'a refused request takes no slot');

UPDATE private.account_monitoring_test_sends SET requested_at = now() - interval '11 minutes';
SELECT is((public.account_monitoring_take_test_slot() ->> 'allowed')::boolean, true, 'allowed again after 10 minutes');

DELETE FROM private.account_monitoring_test_sends;
INSERT INTO private.account_monitoring_test_sends (requested_at, outcome)
SELECT now() - make_interval(hours => h), 'delivered' FROM generate_series(1, 5) h;
SELECT is((public.account_monitoring_take_test_slot() ->> 'allowed')::boolean, false, 'five in 24 hours: refused');
SELECT is((public.account_monitoring_take_test_slot() ->> 'retry_after_seconds')::int, 19 * 3600, 'until the oldest is 24 hours old');

DELETE FROM private.account_monitoring_test_sends;
INSERT INTO private.account_monitoring_test_sends (requested_at, outcome) VALUES (now() - interval '8 days', 'delivered');
SELECT public.account_monitoring_take_test_slot();
SELECT is((SELECT count(*)::int FROM private.account_monitoring_test_sends WHERE requested_at < now() - interval '7 days'), 0, 'entries older than 7 days are pruned');

-- ── Recording an outcome ────────────────────────────────────────────────
SELECT public.account_monitoring_record_test((SELECT max(id) FROM private.account_monitoring_test_sends), 'delivered', ARRAY['email']);
SELECT is((SELECT outcome || ':' || array_to_string(channels, ',') FROM private.account_monitoring_test_sends ORDER BY id DESC LIMIT 1), 'delivered:email',
  'the outcome and accepting channel are recorded');
SELECT public.account_monitoring_record_test((SELECT max(id) FROM private.account_monitoring_test_sends), 'resend_rejected', '{}');
SELECT is((SELECT outcome FROM private.account_monitoring_test_sends ORDER BY id DESC LIMIT 1), 'delivered', 'and only once');
SELECT throws_ok($$ SELECT public.account_monitoring_record_test(1, 'sent to ops@example.com', '{}') $$, '22023', 'invalid_test_report',
  'outcomes are controlled codes (nothing personal)');
SELECT throws_ok($$ SELECT public.account_monitoring_record_test(1, 'delivered', ARRAY['sms']) $$, '22023', 'invalid_test_report', 'channels are controlled');

-- ── Nothing else touched ────────────────────────────────────────────────
SELECT ok((SELECT alerts = (SELECT count(*) FROM private.account_monitoring_alerts)
              AND runs = (SELECT count(*) FROM private.account_maintenance_runs)
              AND dispatches = (SELECT count(*) FROM private.account_maintenance_dispatches)
              AND state = (SELECT md5(t::text) FROM private.account_monitoring_state t)
              AND jobs = (SELECT count(*) FROM public.account_deletion_jobs) FROM te_before),
  'monitoring alerts, runs, dispatches, state and deletion jobs are untouched');

SELECT * FROM finish();
ROLLBACK;
