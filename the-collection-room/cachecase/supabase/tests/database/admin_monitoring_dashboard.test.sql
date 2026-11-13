-- pgTAP test for 20261128120000_admin_monitoring_dashboard.sql (Phase 2B M4 step 5C).
-- Synthetic fixtures inside one rolled-back transaction; runs ONLY on an
-- isolated disposable local stack (like the other M4 monitoring tests):
--   PGOPTIONS='-c cachecase.isolated_stack=on' (or SET it first).

BEGIN;
DO $$ BEGIN
  IF current_setting('cachecase.isolated_stack', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'refusing: dashboard tests run only on an isolated stack (cachecase.isolated_stack=on)';
  END IF;
END $$;
SELECT plan(66);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated, service_role;
CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e78000' || lpad(n::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.q(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e79000' || lpad(n::text, 2, '0'))::uuid $$;
GRANT EXECUTE ON FUNCTION pg_temp.u(int), pg_temp.q(int) TO authenticated, service_role;
CREATE FUNCTION pg_temp.mq(n int, p_bucket text, p_cs boolean, p_age interval, p_attention boolean DEFAULT false, p_error text DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id, quarantine_path,
                                        child_safety, legal_hold, state, needs_attention, last_error, attempts, created_at, source_sha256, quarantine_sha256)
  VALUES (pg_temp.q(n), p_bucket, pg_temp.u(9) || '/dash-secret-path-' || n || '.jpg', pg_temp.u(9),
          CASE p_bucket WHEN 'avatars' THEN 'avatar' ELSE 'item_image' END, 'profile', pg_temp.u(9), 'q/' || pg_temp.q(n) || '/original',
          p_cs, p_cs, CASE WHEN p_attention THEN 'copied' ELSE 'pending' END, p_attention, p_error, CASE WHEN p_attention THEN 1 ELSE 0 END,
          now() - p_age, repeat('b', 64), repeat('b', 64))
  RETURNING id $$;
CREATE FUNCTION pg_temp.issue_id(p_code text) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id FROM private.moderation_monitoring_issues WHERE issue_key = p_code AND resolved_at IS NULL $$;
GRANT EXECUTE ON FUNCTION pg_temp.issue_id(text) TO authenticated;
CREATE TEMP TABLE v (k text PRIMARY KEY, val text);
GRANT ALL ON v TO authenticated, service_role;

-- ── 1. Privileges and shape ─────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.admin_moderation_issue_detail(uuid,integer,integer)',
             'public.admin_moderation_issue_history(text,integer,timestamptz)', 'public.admin_media_quarantine_scheduler_runs(integer,timestamptz)',
             'public.admin_moderation_delivery_history(integer,timestamptz)', 'public.admin_retention_purge_dashboard(text,integer,timestamptz)']::regprocedure[]) f
           JOIN pg_proc p ON p.oid = f
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%' AND p.provolatile = 's'
             AND has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
             AND NOT has_function_privilege('service_role', f, 'EXECUTE')), 5,
  'dashboard RPCs: definer, pinned, require_admin, read-only (STABLE), signed-in only — not anon, not the service role');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.oid = 'public.moderation_monitoring_record_delivery(uuid,text,text[],jsonb)'::regprocedure
            AND p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND has_function_privilege('service_role', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')), 1,
  'per-channel delivery recording: service role only');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['private.moderation_monitoring_affected()', 'private.moderation_issue_status(private.moderation_monitoring_issues)',
             'private.moderation_issue_json(private.moderation_monitoring_issues)', 'private.retention_purge_display_status(private.retention_purge_runs)']::regprocedure[]) f
           WHERE has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('service_role', f, 'EXECUTE')),
  0, 'internal helpers: no API role');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname LIKE 'admin\_%' AND p.prosecdef
              AND has_function_privilege('service_role', p.oid, 'EXECUTE')
              AND p.proname IN ('admin_moderation_issue_detail', 'admin_moderation_issue_history', 'admin_media_quarantine_scheduler_runs',
                                'admin_moderation_delivery_history', 'admin_retention_purge_dashboard', 'admin_moderation_monitoring_overview',
                                'admin_acknowledge_moderation_issue')), 0, 'no new service-role endpoint reachable through the dashboard');
SELECT is((SELECT string_agg(jobname || ':' || active::text, ',' ORDER BY jobname) FROM cron.job),
  'account-deletion-monitor:false,account-maintenance:false,media-quarantine-worker:false,moderation-monitor:false', 'every scheduled job stays inactive');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- 1, 2 admins; 3 collector; 9 owner; 8 reporter.
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT pg_temp.u(n), 'dash-' || n || '@example.invalid', jsonb_build_object('username', 'dash_' || n) FROM unnest(ARRAY[1, 2, 3, 8, 9]) n;
INSERT INTO public.admin_users (user_id) VALUES (pg_temp.u(1)), (pg_temp.u(2));
SELECT pg_temp.mq(1, 'item-images', true, interval '30 minutes');
SELECT pg_temp.mq(2, 'item-images', true, interval '20 minutes');
SELECT pg_temp.mq(3, 'item-images', true, interval '10 minutes');
SELECT pg_temp.mq(4, 'avatars', false, interval '40 minutes');
SELECT pg_temp.mq(5, 'item-images', false, interval '1 hour', true, 'hash_mismatch');
SET LOCAL session_replication_role = replica;
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, reason, details, evidence, priority, status, created_at, updated_at)
VALUES (pg_temp.q(50), pg_temp.u(8), 'profile', pg_temp.u(9), 'child_safety', 'SENSITIVE-REPORT-TEXT', '{"snapshot": "SENSITIVE-EVIDENCE"}',
        'urgent', 'open', now() - interval '3 hours', now());
INSERT INTO private.retention_purge_runs (id, category, policy_key, policy_period, item_count, set_digest, prepared_by, prepared_at,
                                          approval_expires_at, approved_by, approved_at, execution_expires_at, status, closed_at) VALUES
  (pg_temp.q(60), 'report_evidence', 'report_evidence_after_resolution', interval '90 days', 2, md5('p'), pg_temp.u(1),
   now() - interval '5 minutes', now() + interval '25 minutes', NULL, NULL, NULL, 'prepared', NULL),
  (pg_temp.q(61), 'report_evidence', 'report_evidence_after_resolution', interval '90 days', 1, md5('l'), pg_temp.u(1),
   now() - interval '40 minutes', now() - interval '10 minutes', NULL, NULL, NULL, 'prepared', NULL),
  (pg_temp.q(62), 'quarantine_copy', 'quarantine_copy_after_release', interval '90 days', 1, md5('n'), pg_temp.u(2),
   now() - interval '50 minutes', now() - interval '45 minutes', pg_temp.u(1), now() - interval '48 minutes', now() - interval '20 minutes', 'completed', now() - interval '30 minutes'),
  (pg_temp.q(63), 'report_evidence', 'report_evidence_after_resolution', interval '90 days', 1, md5('c'), pg_temp.u(2),
   now() - interval '3 hours', now() - interval '170 minutes', pg_temp.u(1), now() - interval '175 minutes', now() - interval '150 minutes', 'completed', now() - interval '160 minutes');
INSERT INTO private.retention_purge_items (id, run_id, subject_kind, subject_id, due_at, state, attempts, last_error, updated_at) VALUES
  (pg_temp.q(70), pg_temp.q(62), 'quarantine_copy', pg_temp.q(5), now() - interval '1 day', 'needs_attention', 1, 'object_reappeared', now() - interval '30 minutes');
SET LOCAL session_replication_role = origin;

-- ── 2. Affected records = the issue counts ──────────────────────────────
SELECT is((SELECT string_agg(code || '=' || item_count, ',' ORDER BY code) FROM private.moderation_monitoring_evaluate()),
  (SELECT string_agg(code || '=' || n, ',' ORDER BY code) FROM (SELECT code, count(*) n FROM private.moderation_monitoring_affected() GROUP BY code) x),
  'evaluate is exactly the aggregate of the affected records');
SELECT is((SELECT string_agg(code || '=' || item_count, ',' ORDER BY code) FROM private.moderation_monitoring_evaluate()),
  'child_safety_unquarantined=3,integrity_failure=2,public_removal_overdue=1,purge_approval_pending=1,urgent_reports_overdue=1',
  'fixtures detected as expected (integrity counts the job and the purge item)');
SELECT private.moderation_monitoring_check();

-- ── 3. Issue detail ─────────────────────────────────────────────────────
SELECT pg_temp.login(pg_temp.u(1));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'cs', public.admin_moderation_issue_detail(pg_temp.issue_id('child_safety_unquarantined'))::text;
INSERT INTO v SELECT 'cs_p1', public.admin_moderation_issue_detail(pg_temp.issue_id('child_safety_unquarantined'), 0, 2)::text;
INSERT INTO v SELECT 'cs_p2', public.admin_moderation_issue_detail(pg_temp.issue_id('child_safety_unquarantined'), 2, 2)::text;
INSERT INTO v SELECT 'urgent', public.admin_moderation_issue_detail(pg_temp.issue_id('urgent_reports_overdue'))::text;
INSERT INTO v SELECT 'integrity', public.admin_moderation_issue_detail(pg_temp.issue_id('integrity_failure'))::text;
RESET ROLE;
SELECT is((SELECT val::jsonb -> 'issue' ->> 'status' FROM v WHERE k = 'cs'), 'active', 'detail: status active');
SELECT is((SELECT (val::jsonb -> 'issue' ->> 'severity') || ':' || (val::jsonb -> 'issue' ->> 'count') FROM v WHERE k = 'cs'), 'critical:3', '…severity and count');
SELECT is((SELECT array_agg(fk ORDER BY fk COLLATE "C") FROM jsonb_object_keys((SELECT val::jsonb -> 'issue' FROM v WHERE k = 'cs')) fk),
  ARRAY['acknowledged_at', 'acknowledged_by', 'admin_ref', 'category', 'code', 'count', 'delivery_failures', 'description', 'detection', 'id',
        'last_attempt_at', 'last_delivery_error', 'last_seen_at', 'notified_at', 'oldest_at', 'opened_at', 'peak_count', 'resolve_notified_at',
        'resolved_at', 'severity', 'status'], '…issue fields: lifecycle and codes only');
SELECT is((SELECT (val::jsonb -> 'affected' ->> 'total') || ':' || jsonb_array_length(val::jsonb -> 'affected' -> 'items') FROM v WHERE k = 'cs'), '3:3',
  'detail lists every currently affected record');
SELECT is((SELECT val::jsonb -> 'affected' -> 'items' -> 0 ->> 'ref_id' FROM v WHERE k = 'cs'), pg_temp.q(1)::text,
  '…with the internal job reference, oldest first');
SELECT is((SELECT array_agg(DISTINCT fk COLLATE "C" ORDER BY fk COLLATE "C") FROM jsonb_array_elements((SELECT val::jsonb -> 'affected' -> 'items' FROM v WHERE k = 'cs')) x, jsonb_object_keys(x) fk),
  ARRAY['attempts', 'child_safety', 'detail_code', 'ref_id', 'ref_kind', 'since', 'state'], '…and only state, codes and age');
SELECT is((SELECT count(*)::int FROM v WHERE k IN ('cs', 'urgent', 'integrity')
            AND (val LIKE '%dash-secret-path%' OR val LIKE '%' || pg_temp.u(9) || '%' OR val LIKE '%' || pg_temp.u(8) || '%'
                 OR val LIKE '%SENSITIVE%' OR val LIKE '%example.invalid%' OR val LIKE '%bbbbbbbb%')), 0,
  'no paths, owner or reporter ids, report text, evidence, addresses or hashes in any detail');
SELECT is((SELECT jsonb_array_length(val::jsonb -> 'affected' -> 'items') FROM v WHERE k = 'cs_p1'), 2, 'affected records are paged (page 1)');
SELECT is((SELECT (val::jsonb -> 'affected' -> 'items' -> 0 ->> 'ref_id') FROM v WHERE k = 'cs_p2'), pg_temp.q(3)::text, '…(page 2)');
SELECT is((SELECT (val::jsonb -> 'affected' -> 'items' -> 0 ->> 'ref_kind') || ':' || (val::jsonb -> 'affected' -> 'items' -> 0 ->> 'detail_code') FROM v WHERE k = 'urgent'),
  'content_report:child_safety', 'a report is referenced by id and reason only');
SELECT is((SELECT string_agg(x ->> 'ref_kind', ',' ORDER BY x ->> 'ref_kind') FROM v, jsonb_array_elements(v.val::jsonb -> 'affected' -> 'items') x WHERE v.k = 'integrity'),
  'purge_item,quarantine_job', 'integrity lists both the job and the purge item');
SELECT is((SELECT jsonb_array_length(val::jsonb -> 'events') FROM v WHERE k = 'cs'), 1, 'the history shows the detection');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.admin_moderation_issue_detail(gen_random_uuid())$$, 'PT404', NULL, 'unknown issue → not found');
SELECT throws_ok($$SELECT public.admin_moderation_issue_detail(pg_temp.issue_id('child_safety_unquarantined'), -1, 10)$$, '22023', NULL, 'invalid paging refused');
SELECT throws_ok($$SELECT public.admin_moderation_issue_detail(pg_temp.issue_id('child_safety_unquarantined'), 0, 500)$$, '22023', NULL, '…page size capped');
RESET ROLE;

-- ── 4. Acknowledgement never resolves ───────────────────────────────────
SELECT pg_temp.login(pg_temp.u(2));
SET LOCAL ROLE authenticated;
SELECT public.admin_acknowledge_moderation_issue(pg_temp.issue_id('child_safety_unquarantined'));
INSERT INTO v SELECT 'acked', public.admin_moderation_issue_detail(pg_temp.issue_id('child_safety_unquarantined'))::text;
RESET ROLE;
SELECT is((SELECT (val::jsonb -> 'issue' ->> 'status') || ':' || COALESCE(val::jsonb -> 'issue' ->> 'resolved_at', 'null') || ':' || (val::jsonb -> 'affected' ->> 'total')
             FROM v WHERE k = 'acked'), 'acknowledged:null:3', 'acknowledged: still unresolved, still 3 affected');
SELECT is((SELECT val::jsonb -> 'issue' ->> 'acknowledged_by' FROM v WHERE k = 'acked'), pg_temp.u(2)::text, '…by the acknowledging admin');
SELECT is((SELECT val::jsonb -> 'events' -> 0 ->> 'event' FROM v WHERE k = 'acked'), 'acknowledged', '…recorded in its history');

-- ── 5. Resolution and history (duplicates) ──────────────────────────────
INSERT INTO v SELECT 'pub_id', pg_temp.issue_id('public_removal_overdue')::text;
SET LOCAL session_replication_role = replica;
DELETE FROM private.media_quarantine WHERE id = pg_temp.q(4);
SET LOCAL session_replication_role = origin;
SELECT private.moderation_monitoring_check();
SELECT pg_temp.mq(6, 'avatars', false, interval '40 minutes');
SELECT private.moderation_monitoring_check();
SELECT pg_temp.login(pg_temp.u(1));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'resolved_detail', public.admin_moderation_issue_detail((SELECT val::uuid FROM v WHERE k = 'pub_id'))::text;
INSERT INTO v SELECT 'h_resolved', public.admin_moderation_issue_history('resolved')::text;
INSERT INTO v SELECT 'h_active', public.admin_moderation_issue_history('active')::text;
INSERT INTO v SELECT 'h_ack', public.admin_moderation_issue_history('acknowledged')::text;
INSERT INTO v SELECT 'h_all', public.admin_moderation_issue_history('all')::text;
INSERT INTO v SELECT 'h_page', public.admin_moderation_issue_history('all', 2)::text;
INSERT INTO v SELECT 'ov', public.admin_moderation_monitoring_overview()::text;
RESET ROLE;
SELECT is((SELECT (val::jsonb -> 'issue' ->> 'status') || ':' || (val::jsonb -> 'affected' ->> 'live') || ':' || jsonb_array_length(val::jsonb -> 'affected' -> 'items')
             FROM v WHERE k = 'resolved_detail'), 'resolved:false:0', 'a resolved issue shows no live affected records');
SELECT is((SELECT count(*)::int FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x WHERE v.k = 'h_resolved' AND x ->> 'code' = 'public_removal_overdue'), 1,
  'history: the resolved occurrence');
SELECT is((SELECT count(*)::int FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x WHERE v.k = 'h_all' AND x ->> 'code' = 'public_removal_overdue'), 2,
  'a recurrence is a separate issue in history…');
SELECT is((SELECT count(*)::int FROM v, jsonb_array_elements(v.val::jsonb -> 'open') x WHERE v.k = 'ov' AND x ->> 'code' = 'public_removal_overdue'), 1,
  '…but only one open issue per condition');
SELECT is((SELECT count(*)::int FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x WHERE v.k = 'h_active' AND x ->> 'code' = 'child_safety_unquarantined'), 0,
  'acknowledged issues are not listed as active…');
SELECT is((SELECT count(*)::int FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x WHERE v.k = 'h_ack' AND x ->> 'code' = 'child_safety_unquarantined'), 1,
  '…but as acknowledged');
SELECT is((SELECT (jsonb_array_length(val::jsonb -> 'items'))::text || ':' || (val::jsonb ->> 'next_before' IS NOT NULL)::text FROM v WHERE k = 'h_page'), '2:true',
  'history pages (next cursor when the page is full)');

-- ── 6. Scheduler runs ───────────────────────────────────────────────────
INSERT INTO private.media_quarantine_scheduler_runs (trigger, status, started_at, finished_at, jobs, outcomes, error_code, duration_ms) VALUES
  ('kick', 'completed', now() - interval '3 minutes', now() - interval '3 minutes', 2, '{"quarantined": 2}', NULL, 900),
  ('sweep', 'failed', now() - interval '2 minutes', now() - interval '2 minutes', 1, '{"interrupted": 1}', 'worker_error', 400);
INSERT INTO private.media_quarantine_scheduler_runs (trigger, status, started_at) VALUES ('kick', 'running', now() - interval '10 minutes');
SELECT pg_temp.login(pg_temp.u(1));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'runs', public.admin_media_quarantine_scheduler_runs(25)::text;
INSERT INTO v SELECT 'runs_p', public.admin_media_quarantine_scheduler_runs(2)::text;
INSERT INTO v SELECT 'sched', public.admin_media_quarantine_scheduler_status()::text;
RESET ROLE;
SELECT is((SELECT string_agg(x ->> 'status', ',') FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x WHERE v.k = 'runs'), 'failed,completed,stale',
  'runs newest first; a dead running run shows as stale; failures visible');
SELECT is((SELECT val::jsonb -> 'items' -> 0 ->> 'error_code' FROM v WHERE k = 'runs'), 'worker_error', '…with the failure code');
SELECT is((SELECT (val::jsonb ->> 'next_before' IS NOT NULL)::text FROM v WHERE k = 'runs_p'), 'true', 'runs page');
SELECT is((SELECT (val::jsonb ->> 'enabled') || ':' || (val::jsonb ->> 'sweep_active') FROM v WHERE k = 'sched'), 'false:false',
  'the scheduler reports disabled and the sweep inactive (not "running" because the migration exists)');

-- ── 7. Delivery per channel ─────────────────────────────────────────────
INSERT INTO private.moderation_monitoring_deliveries (id, notice_count, claimed_at) VALUES
  (pg_temp.q(80), 2, now() - interval '20 minutes'), (pg_temp.q(81), 1, now() - interval '15 minutes'),
  (pg_temp.q(82), 1, now() - interval '10 minutes'), (pg_temp.q(83), 1, now() - interval '9 minutes');
SET LOCAL ROLE service_role;
SELECT is(public.moderation_monitoring_record_delivery(pg_temp.q(80), NULL, ARRAY['webhook'], '{"email": "resend_rejected"}'::jsonb), 0,
  'a delivery with one failing channel is recorded');
SELECT public.moderation_monitoring_record_delivery(pg_temp.q(81), 'webhook_unreachable', '{}', '{"email": "resend_unreachable", "webhook": "webhook_unreachable"}'::jsonb);
SELECT public.moderation_monitoring_record_delivery(pg_temp.q(82), NULL, ARRAY['email', 'webhook']);
SELECT throws_ok($$SELECT public.moderation_monitoring_record_delivery(pg_temp.q(83), NULL, ARRAY['email'], '{"email": "resend_rejected"}'::jsonb)$$, '22023', NULL,
  'a channel cannot be both delivered and failed');
SELECT throws_ok($$SELECT public.moderation_monitoring_record_delivery(pg_temp.q(83), NULL, ARRAY['email'], '{"sms": "x"}'::jsonb)$$, '22023', NULL, 'unknown channels refused');
SELECT throws_ok($$SELECT public.moderation_monitoring_record_delivery(pg_temp.q(83), NULL, ARRAY['email'], '{"webhook": "https://hook/x"}'::jsonb)$$, '22023', NULL,
  'free-text error values refused');
RESET ROLE;
UPDATE private.moderation_monitoring_issues SET delivery_failures = 2, last_delivery_error = 'webhook_rejected' WHERE issue_key = 'integrity_failure' AND resolved_at IS NULL;
SELECT pg_temp.login(pg_temp.u(1));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'dlv', public.admin_moderation_delivery_history(25)::text;
RESET ROLE;
SELECT is((SELECT (x ->> 'outcome') || ':' || (x ->> 'partial') || ':' || (x -> 'channel_errors' ->> 'email') FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x
            WHERE v.k = 'dlv' AND x ->> 'id' = pg_temp.q(80)::text), 'delivered:true:resend_rejected', 'a failing channel is visible even when the other delivered');
SELECT is((SELECT x ->> 'outcome' FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x WHERE v.k = 'dlv' AND x ->> 'id' = pg_temp.q(81)::text), 'failed',
  'a fully failed delivery is shown as failed');
SELECT is((SELECT x ->> 'outcome' FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x WHERE v.k = 'dlv' AND x ->> 'id' = pg_temp.q(83)::text), 'abandoned',
  'a claim never reported is shown as abandoned');
SELECT is((SELECT (val::jsonb -> 'channels_24h' -> 'email')::text || '|' || (val::jsonb -> 'channels_24h' -> 'webhook')::text FROM v WHERE k = 'dlv'),
  '{"failed": 2, "delivered": 1}|{"failed": 1, "delivered": 2}', 'delivery success and failure are counted per channel');
SELECT is((SELECT (x ->> 'code') || ':' || (x ->> 'failures') FROM v, jsonb_array_elements(v.val::jsonb -> 'retrying') x WHERE v.k = 'dlv'), 'integrity_failure:2',
  'repeatedly retried notices are listed');
SELECT is((SELECT count(*)::int FROM v WHERE k = 'dlv' AND (val LIKE '%@%' OR val LIKE '%http%')), 0, 'no recipients or URLs in delivery history');

-- ── 8. Purge runs (read-only) ───────────────────────────────────────────
SELECT pg_temp.login(pg_temp.u(1));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'purge_a1', public.admin_retention_purge_dashboard()::text;
INSERT INTO v SELECT 'purge_pending', public.admin_retention_purge_dashboard('prepared')::text;
INSERT INTO v SELECT 'purge_page', public.admin_retention_purge_dashboard(NULL, 2)::text;
SELECT throws_ok($$SELECT public.admin_retention_approve_run(pg_temp.q(60), md5('p'), 2)$$, '42501', 'self_approval_refused',
  'the preparer still cannot approve (server-side, unchanged)');
RESET ROLE;
SELECT pg_temp.login(pg_temp.u(2));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'purge_a2', public.admin_retention_purge_dashboard('prepared')::text;
SELECT throws_ok($$SELECT public.admin_retention_approve_run(pg_temp.q(61), md5('l'), 1)$$, 'PT409', 'run_expired', 'a lapsed approval window is refused');
RESET ROLE;
SELECT is((SELECT string_agg((x ->> 'id') || '=' || (x ->> 'status'), ',' ORDER BY x ->> 'id') FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x WHERE v.k = 'purge_a1'),
  pg_temp.q(60) || '=prepared,' || pg_temp.q(61) || '=expired,' || pg_temp.q(62) || '=needs_attention,' || pg_temp.q(63) || '=completed',
  'effective states: awaiting approval, expired (window lapsed), needs attention, completed');
SELECT is((SELECT x ->> 'stored_status' FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x WHERE v.k = 'purge_a1' AND x ->> 'id' = pg_temp.q(61)::text), 'prepared',
  '…the lapsed run is shown expired before anything closes it');
SELECT is((SELECT (x ->> 'prepared_by_viewer') || ':' || (x ->> 'viewer_may_approve') || ':' || (x ->> 'item_count') FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x
            WHERE v.k = 'purge_a1' AND x ->> 'id' = pg_temp.q(60)::text), 'true:false:2', 'the preparer sees it as theirs, not approvable by them; exact count');
SELECT is((SELECT (x ->> 'prepared_by_viewer') || ':' || (x ->> 'viewer_may_approve') FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x
            WHERE v.k = 'purge_a2' AND x ->> 'id' = pg_temp.q(60)::text), 'false:true', 'another admin sees it as approvable (a hint; the server decides)');
SELECT ok((SELECT (x ->> 'approval_expires_at')::timestamptz BETWEEN now() + interval '24 minutes' AND now() + interval '26 minutes'
             FROM v, jsonb_array_elements(v.val::jsonb -> 'items') x WHERE v.k = 'purge_a1' AND x ->> 'id' = pg_temp.q(60)::text),
  'the 30-minute approval expiry is shown');
SELECT is((SELECT (val::jsonb ->> 'pending_approval') || ':' || jsonb_array_length(val::jsonb -> 'items') FROM v WHERE k = 'purge_pending'), '1:1',
  'filter: only runs awaiting approval');
SELECT is((SELECT (val::jsonb ->> 'needs_attention') FROM v WHERE k = 'purge_a1'), '1', 'needs-attention runs are counted');
SELECT is((SELECT (val::jsonb ->> 'next_before' IS NOT NULL)::text FROM v WHERE k = 'purge_page'), 'true', 'purge runs page');
SELECT is((SELECT count(*)::int FROM v WHERE k LIKE 'purge%' AND (val LIKE '%' || pg_temp.u(1) || '%' OR val LIKE '%' || pg_temp.u(2) || '%' OR val LIKE '%set_digest%')), 0,
  'the dashboard shows no admin ids or digests — only whether the viewer prepared or approved');
SELECT is((SELECT string_agg(status, ',' ORDER BY id) FROM private.retention_purge_runs WHERE id IN (pg_temp.q(60), pg_temp.q(61))), 'prepared,prepared',
  'reading the dashboard changes no run');

-- ── 9. Collectors get nothing ───────────────────────────────────────────
SELECT pg_temp.login(pg_temp.u(3));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.admin_moderation_issue_detail(pg_temp.issue_id('integrity_failure'))$$, '42501', NULL, 'collector: issue detail refused');
SELECT throws_ok($$SELECT public.admin_moderation_issue_history('all')$$, '42501', NULL, 'collector: issue history refused');
SELECT throws_ok($$SELECT public.admin_media_quarantine_scheduler_runs(10)$$, '42501', NULL, 'collector: scheduler runs refused');
SELECT throws_ok($$SELECT public.admin_moderation_delivery_history(10)$$, '42501', NULL, 'collector: delivery history refused');
SELECT throws_ok($$SELECT public.admin_retention_purge_dashboard()$$, '42501', NULL, 'collector: purge dashboard refused');
SELECT throws_ok($$SELECT public.admin_media_quarantine_overview()$$, '42501', NULL, 'collector: quarantine overview refused');
SELECT throws_ok($$SELECT public.admin_media_quarantine_scheduler_status()$$, '42501', NULL, 'collector: scheduler status refused');
SELECT throws_ok($$SELECT public.moderation_monitoring_record_delivery(pg_temp.q(83), NULL, ARRAY['email'], '{}'::jsonb)$$, '42501', NULL,
  'collector: cannot record deliveries');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
