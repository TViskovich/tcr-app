-- pgTAP test for 20261201120000_admin_report_review.sql (Phase 2B M5.1:
-- administrator report review). Synthetic fixtures inside one rolled-back
-- transaction; runs ONLY on an isolated disposable local stack:
--   PGOPTIONS='-c cachecase.isolated_stack=on' (or SET it first).

BEGIN;
DO $$ BEGIN
  IF current_setting('cachecase.isolated_stack', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'refusing: report review tests run only on an isolated stack (cachecase.isolated_stack=on)';
  END IF;
END $$;
SELECT plan(141);

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
CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e5100' || lpad(n::text, 3, '0'))::uuid $$;
CREATE FUNCTION pg_temp.r(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e5110' || lpad(n::text, 3, '0'))::uuid $$;
CREATE FUNCTION pg_temp.ids(p_page jsonb) RETURNS uuid[] LANGUAGE sql AS $$
  SELECT ARRAY(SELECT (x.e ->> 'id')::uuid FROM jsonb_array_elements(p_page -> 'items') WITH ORDINALITY x (e, n) ORDER BY x.n) $$;
CREATE FUNCTION pg_temp.q(p_view text, p_type text DEFAULT NULL, p_reason text DEFAULT NULL, p_priority text DEFAULT NULL,
                          p_age text DEFAULT NULL, p_sort text DEFAULT NULL) RETURNS uuid[] LANGUAGE sql AS $$
  SELECT pg_temp.ids(public.admin_report_queue(p_view, p_type, p_reason, p_priority, p_age, p_sort, 50, NULL)) $$;
-- Every id on every page, in order.
CREATE FUNCTION pg_temp.walk(p_view text, p_sort text, p_limit integer) RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE
  v_cursor jsonb := NULL;
  v_page   jsonb;
  v_ids    uuid[] := '{}';
  v_pages  integer := 0;
BEGIN
  LOOP
    v_page := public.admin_report_queue(p_view, NULL, NULL, NULL, NULL, p_sort, p_limit, v_cursor);
    v_ids := v_ids || pg_temp.ids(v_page);
    v_cursor := v_page -> 'next_cursor';
    v_pages := v_pages + 1;
    EXIT WHEN v_cursor IS NULL OR v_cursor = 'null'::jsonb OR v_pages > 100;
  END LOOP;
  RETURN v_ids;
END;
$$;
CREATE FUNCTION pg_temp.ver(n int) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT private.report_review_version(c) FROM public.content_reports c WHERE c.id = pg_temp.r(n) $$;
CREATE FUNCTION pg_temp.st(n int) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT status || ':' || COALESCE(claimed_by::text, '-') FROM public.content_reports WHERE id = pg_temp.r(n) $$;
CREATE FUNCTION pg_temp.audits(n int, p_action text) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*)::int FROM public.moderation_actions WHERE report_id = pg_temp.r(n) AND action = p_action $$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid), pg_temp.logout(), pg_temp.u(int), pg_temp.r(int), pg_temp.ids(jsonb),
  pg_temp.q(text, text, text, text, text, text), pg_temp.walk(text, text, integer), pg_temp.ver(int), pg_temp.st(int),
  pg_temp.audits(int, text) TO authenticated, anon, service_role;
CREATE TEMP TABLE v (k text PRIMARY KEY, val jsonb);
GRANT ALL ON v TO authenticated, anon, service_role;

-- ── 1. Shape and privileges ─────────────────────────────────────────────
CREATE TEMP TABLE rr_fns (fn regprocedure);
INSERT INTO rr_fns VALUES
  ('public.admin_report_queue(text,text,text,text,text,text,integer,jsonb)'), ('public.admin_report_case(uuid)'),
  ('public.admin_report_case_action(uuid,text,text,text,text,text)');
SELECT is((SELECT count(*)::int FROM rr_fns t JOIN pg_proc p ON p.oid = t.fn WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""']), 3,
  'all 3 review functions are SECURITY DEFINER with an empty search_path');
SELECT is((SELECT count(*)::int FROM rr_fns t JOIN pg_proc p ON p.oid = t.fn WHERE p.prosrc LIKE '%private.require_admin()%'), 3,
  'every review function checks the admin itself (private.require_admin)');
SELECT is((SELECT count(*)::int FROM rr_fns t WHERE has_function_privilege('anon', t.fn, 'EXECUTE') OR has_function_privilege('service_role', t.fn, 'EXECUTE')), 0,
  'no review function is executable by signed-out callers or the service role');
SELECT is((SELECT count(*)::int FROM rr_fns t WHERE has_function_privilege('authenticated', t.fn, 'EXECUTE')), 3,
  'review functions are executable by signed-in callers (each re-checks admin)');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'private' AND p.proname LIKE 'report_review%'
             AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))), 0,
  'private review helpers are not executable by clients');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.proname = 'admin_report_case_action'
             AND p.prosrc ~ 'FOR UPDATE' AND p.prosrc ~ 'report_changed'
             AND p.prosrc ~ 'public\.admin_claim_report' AND p.prosrc ~ 'public\.admin_release_report'
             AND p.prosrc ~ 'public\.admin_resolve_report' AND p.prosrc ~ 'public\.admin_reopen_report'
             AND p.prosrc !~ 'admin_(hide|remove|restore)_content|admin_suspend|UPDATE public\.content_reports'), 1,
  'case action locks, checks the version and delegates to the existing M1 functions only (no enforcement, no direct writes)');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- 1 admin A · 2 admin B · 3 collector N · 4 admin S (suspended) · 5 admin X
-- (removed later) · 6 admin P (pending deletion) · 7 reporter · 8 owner ·
-- 9 admin C (stale claim holder).
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT pg_temp.u(i), 'rr-' || i || '@example.invalid', jsonb_build_object('username', 'rr_user_' || i) FROM generate_series(1, 9) i;
INSERT INTO public.admin_users (user_id) SELECT pg_temp.u(i) FROM unnest(ARRAY[1, 2, 4, 5, 6, 9]) i;
INSERT INTO public.account_suspensions (user_id, reason_code, created_by) VALUES (pg_temp.u(4), 'spam', NULL);
INSERT INTO public.account_lifecycle (user_id, state, mode, requested_at, scheduled_for)
VALUES (pg_temp.u(6), 'pending_deletion', 'scheduled', now(), now() + interval '30 days');
INSERT INTO public.posts (id, user_id, content, post_type, image_url) VALUES
  ('00000000-0000-4000-8000-0000e5120001', pg_temp.u(8), 'RR-SECRET-POST-TEXT', 'text', 'https://example.invalid/rr-secret-image.jpg'),
  ('00000000-0000-4000-8000-0000e5120002', pg_temp.u(8), 'rr restricted post', 'text', NULL);

INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, details, evidence, priority, created_at) VALUES
  (pg_temp.r(1), pg_temp.u(7), 'post', '00000000-0000-4000-8000-0000e5120001', pg_temp.u(8), 'violence', 'RR-SECRET-DETAILS',
   '{"v":1,"content":"RR-SECRET-POST-TEXT","image_url":"https://example.invalid/rr-secret-image.jpg"}', 'urgent', now() - interval '3 hours'),
  (pg_temp.r(2), pg_temp.u(7), 'profile', pg_temp.u(8), pg_temp.u(8), 'child_safety', NULL, '{"v":1,"username":"rr_user_8"}', 'urgent', now() - interval '30 minutes'),
  (pg_temp.r(3), pg_temp.u(7), 'comment', gen_random_uuid(), pg_temp.u(8), 'spam', NULL, '{"v":1,"body":"rr comment"}', 'normal', now() - interval '2 days'),
  (pg_temp.r(4), pg_temp.u(7), 'message', gen_random_uuid(), pg_temp.u(8), 'harassment', NULL, '{"v":1,"body":"RR-SECRET-DM"}', 'normal', now() - interval '10 days'),
  (pg_temp.r(10), pg_temp.u(7), 'post', '00000000-0000-4000-8000-0000e5120002', pg_temp.u(8), 'hate', NULL, '{"v":1,"content":"rr restricted post"}', 'normal', now() - interval '6 hours'),
  (pg_temp.r(11), pg_temp.u(7), 'folder', gen_random_uuid(), pg_temp.u(8), 'spam', NULL, '{"v":1,"name":"rr folder"}', 'normal', now() - interval '3 days');
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence, priority, status, claimed_by, claimed_at, created_at) VALUES
  (pg_temp.r(5), pg_temp.u(7), 'post', gen_random_uuid(), pg_temp.u(8), 'hate', '{"v":1,"content":"rr 5"}', 'normal', 'reviewing', pg_temp.u(2), now() - interval '1 hour', now() - interval '5 hours'),
  (pg_temp.r(6), pg_temp.u(7), 'post', gen_random_uuid(), pg_temp.u(8), 'spam', '{"v":1,"content":"rr 6"}', 'normal', 'reviewing', pg_temp.u(9), now() - interval '25 hours', now() - interval '2 days');
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence, priority, status,
                                    resolution, resolution_reason, reviewed_at, reviewed_by, evidence_purge_after, evidence_purged_at, created_at) VALUES
  (pg_temp.r(7), pg_temp.u(7), 'post', gen_random_uuid(), pg_temp.u(8), 'spam', '{"v":1,"content":"rr 7"}', 'normal', 'dismissed',
   'no_violation', 'within_guidelines', now() - interval '1 hour', pg_temp.u(2), now() + interval '89 days', NULL, now() - interval '4 days'),
  (pg_temp.r(8), NULL, 'post', gen_random_uuid(), pg_temp.u(8), 'spam', NULL, 'normal', 'dismissed',
   'no_violation', 'within_guidelines', now() - interval '100 days', pg_temp.u(2), now() - interval '10 days', now() - interval '9 days', now() - interval '101 days'),
  (pg_temp.r(12), pg_temp.u(7), 'post', gen_random_uuid(), pg_temp.u(8), 'spam', '{"v":1,"content":"rr 12"}', 'normal', 'dismissed',
   'no_violation', 'within_guidelines', now() - interval '2 hours', pg_temp.u(2), now() + interval '89 days', NULL, now() - interval '3 days');
-- r9: actioned (content removed); r10: open on content that is currently restricted.
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence, priority, created_at)
VALUES (pg_temp.r(9), NULL, 'post', '00000000-0000-4000-8000-0000e5120002', pg_temp.u(8), 'hate', '{"v":1,"content":"rr restricted post"}', 'normal', now() - interval '8 hours');
INSERT INTO public.moderated_content (id, target_type, target_id, owner_id, state, reason_code, report_id, created_by)
VALUES ('00000000-0000-4000-8000-0000e5130001', 'post', '00000000-0000-4000-8000-0000e5120002', pg_temp.u(8), 'removed', 'hate', pg_temp.r(9), pg_temp.u(1));
UPDATE public.content_reports SET status = 'actioned', resolution = 'content_removed', resolution_reason = 'hate', reviewed_at = now() - interval '30 minutes',
       reviewed_by = pg_temp.u(1), evidence_purge_after = now() + interval '90 days', moderation_id = '00000000-0000-4000-8000-0000e5130001'
 WHERE id = pg_temp.r(9);
UPDATE public.content_reports SET moderation_id = '00000000-0000-4000-8000-0000e5130001' WHERE id = pg_temp.r(10);
-- 30 older normal reports (reporter gone) for pagination.
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence, priority, created_at)
SELECT ('00000000-0000-4000-8000-0000e5190' || lpad(i::text, 3, '0'))::uuid, NULL, 'post', gen_random_uuid(), pg_temp.u(8), 'spam',
       jsonb_build_object('v', 1, 'content', 'rr bulk ' || i), 'normal', now() - interval '20 days' + i * interval '1 minute'
FROM generate_series(1, 30) i;
INSERT INTO v SELECT 'mod_before', to_jsonb((SELECT count(*) FROM public.moderated_content));
INSERT INTO v SELECT 'susp_before', to_jsonb((SELECT count(*) FROM public.account_suspensions));
INSERT INTO v SELECT 'hold_before', to_jsonb((SELECT count(*) FROM private.moderation_legal_holds));

-- r11 dismissed then reopened through the existing M1 function (by A).
UPDATE public.content_reports SET status = 'dismissed', resolution = 'no_violation', resolution_reason = 'within_guidelines',
       reviewed_at = now() - interval '1 day', reviewed_by = pg_temp.u(2), evidence_purge_after = now() + interval '89 days'
 WHERE id = pg_temp.r(11);
SET LOCAL ROLE authenticated;
SELECT pg_temp.login(pg_temp.u(1));
SELECT lives_ok($$ SELECT public.admin_reopen_report(pg_temp.r(11), 'new_information') $$, 'fixture: r11 reopened through admin_reopen_report');

-- ── 2. Authorization ────────────────────────────────────────────────────
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT public.admin_report_queue() $$, '42501', NULL, 'signed-out: queue refused');
SELECT throws_ok($$ SELECT public.admin_report_case(pg_temp.r(1)) $$, '42501', NULL, 'signed-out: case refused');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'claim', 'x') $$, '42501', NULL, 'signed-out: actions refused');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.logout();
SELECT throws_ok($$ SELECT public.admin_report_queue() $$, '42501', 'not_authenticated', 'expired/absent session: queue refused');
SELECT throws_ok($$ SELECT public.admin_report_case(pg_temp.r(1)) $$, '42501', 'not_authenticated', 'expired/absent session: case refused');
SELECT pg_temp.login(pg_temp.u(3));
SELECT throws_ok($$ SELECT public.admin_report_queue() $$, '42501', 'forbidden', 'collector: queue refused');
SELECT throws_ok($$ SELECT public.admin_report_case(pg_temp.r(1)) $$, '42501', 'forbidden', 'collector: case refused');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'claim', pg_temp.ver(1)) $$, '42501', 'forbidden', 'collector: actions refused');
SELECT pg_temp.login(pg_temp.u(4));
SELECT throws_ok($$ SELECT public.admin_report_queue() $$, '42501', 'account_inactive', 'suspended admin: queue refused');
SELECT throws_ok($$ SELECT public.admin_report_case(pg_temp.r(1)) $$, '42501', 'account_inactive', 'suspended admin: case (evidence) refused');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'claim', pg_temp.ver(1)) $$, '42501', 'account_inactive', 'suspended admin: actions refused');
SELECT pg_temp.login(pg_temp.u(6));
SELECT throws_ok($$ SELECT public.admin_report_queue() $$, '42501', 'account_inactive', 'pending-deletion admin: queue refused');
SELECT throws_ok($$ SELECT public.admin_report_case(pg_temp.r(1)) $$, '42501', 'account_inactive', 'pending-deletion admin: case refused');
SELECT pg_temp.login(pg_temp.u(5));
SELECT lives_ok($$ SELECT public.admin_report_queue() $$, 'admin X: queue allowed while an admin');
RESET ROLE;
DELETE FROM public.admin_users WHERE user_id = pg_temp.u(5);
SET LOCAL ROLE authenticated;
SELECT pg_temp.login(pg_temp.u(5));
SELECT throws_ok($$ SELECT public.admin_report_queue() $$, '42501', 'forbidden', 'removed admin: queue refused at once');
SELECT throws_ok($$ SELECT public.admin_report_case(pg_temp.r(1)) $$, '42501', 'forbidden', 'removed admin: case refused');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'claim', pg_temp.ver(1)) $$, '42501', 'forbidden', 'removed admin: actions refused');
SELECT throws_ok($$ SELECT count(*) FROM public.content_reports $$, '42501', NULL, 'clients still have no direct report access');

-- ── 3. Queue ────────────────────────────────────────────────────────────
SELECT pg_temp.login(pg_temp.u(1));
SELECT is((pg_temp.q('open'))[1:2], ARRAY[pg_temp.r(1), pg_temp.r(2)], 'open: urgent reports first, oldest first');
SELECT is(cardinality(pg_temp.q('open')), 36, 'open: every unclaimed pending report (6 + 30 bulk)');
SELECT is((pg_temp.q('open'))[3], '00000000-0000-4000-8000-0000e5190001'::uuid, 'open: then normal reports, oldest first');
SELECT is((pg_temp.q('open'))[33:36], ARRAY[pg_temp.r(4), pg_temp.r(11), pg_temp.r(3), pg_temp.r(10)], 'open: normal tail in submission order');
SELECT is((pg_temp.q('open', p_sort => 'newest'))[1], pg_temp.r(2), 'sort newest: most recent submission first');
SELECT is((pg_temp.q('open', p_sort => 'oldest'))[1], '00000000-0000-4000-8000-0000e5190001'::uuid, 'sort oldest: earliest submission first, priority ignored');
SELECT is(pg_temp.walk('open', NULL, 7), pg_temp.q('open'), 'pagination (priority sort, 7 per page): same ids, same order, no gaps or repeats');
SELECT is(pg_temp.walk('open', 'newest', 4), pg_temp.q('open', p_sort => 'newest'), 'pagination (newest, 4 per page) matches a single page');
SELECT is(pg_temp.walk('open', 'oldest', 5), pg_temp.q('open', p_sort => 'oldest'), 'pagination (oldest, 5 per page) matches a single page');
SELECT is(pg_temp.q('open', p_reason => 'child_safety'), ARRAY[pg_temp.r(2)], 'filter: reason');
SELECT is(pg_temp.q('open', p_type => 'message'), ARRAY[pg_temp.r(4)], 'filter: content type');
SELECT is(pg_temp.q('open', p_priority => 'urgent'), ARRAY[pg_temp.r(1), pg_temp.r(2)], 'filter: priority');
SELECT is(pg_temp.q('open', p_age => 'under_24h'), ARRAY[pg_temp.r(1), pg_temp.r(2), pg_temp.r(10)], 'filter: age under 24 h');
SELECT is(pg_temp.q('open', p_age => '1_to_7d'), ARRAY[pg_temp.r(11), pg_temp.r(3)], 'filter: age 1–7 days');
SELECT is(cardinality(pg_temp.q('open', p_age => 'over_7d')), 31, 'filter: age over 7 days');
SELECT is(pg_temp.q('open', p_type => 'post', p_reason => 'spam', p_age => 'under_24h'), '{}'::uuid[], 'combined filters can match nothing (empty page)');
SELECT is(pg_temp.q('claimed'), ARRAY[pg_temp.r(6), pg_temp.r(5)], 'claimed: reviewing reports');
SELECT is(pg_temp.q('mine'), '{}'::uuid[], 'mine: A holds no claims');
SELECT is(pg_temp.q('reopened'), ARRAY[pg_temp.r(11)], 'reopened: pending reports reopened at least once');
SELECT is(pg_temp.q('actioned'), ARRAY[pg_temp.r(9)], 'actioned view');
SELECT is(pg_temp.q('dismissed'), ARRAY[pg_temp.r(7), pg_temp.r(12), pg_temp.r(8)], 'dismissed: most recently resolved first');
SELECT is(pg_temp.q('dismissed', p_sort => 'oldest'), ARRAY[pg_temp.r(8), pg_temp.r(12), pg_temp.r(7)], 'dismissed: oldest resolution first');
SELECT is(pg_temp.walk('dismissed', NULL, 1), ARRAY[pg_temp.r(7), pg_temp.r(12), pg_temp.r(8)], 'resolved pagination, 1 per page');

INSERT INTO v SELECT 'p1', public.admin_report_queue('open', NULL, NULL, NULL, NULL, NULL, 50, NULL);
SELECT is((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys((SELECT val -> 'items' -> 0 FROM v WHERE k = 'p1')) k),
  ARRAY['child_safety', 'claim', 'claimed_at', 'created_at', 'evidence', 'id', 'priority', 'reason', 'reopened', 'resolution', 'reviewed_at',
        'status', 'target_type', 'version'],
  'queue rows carry metadata only (no text, excerpt, owner or reporter)');
SELECT ok((SELECT val::text FROM v WHERE k = 'p1') !~ ('RR-SECRET|rr_user_|example\.invalid|' || pg_temp.u(7)::text || '|' || pg_temp.u(8)::text),
  'queue never returns report text, evidence, usernames, URLs, reporter or owner ids');
SELECT is((SELECT val -> 'counts' FROM v WHERE k = 'p1'),
  '{"open": 36, "claimed": 2, "mine": 0, "reopened": 1, "urgent": 2, "child_safety": 1}'::jsonb, 'first page carries pending counts');
SELECT ok((SELECT (e ->> 'child_safety')::boolean AND e ->> 'priority' = 'urgent' FROM jsonb_array_elements((SELECT val -> 'items' FROM v WHERE k = 'p1')) e
            WHERE e ->> 'id' = pg_temp.r(2)::text), 'child-safety report is flagged and urgent');
SELECT is((SELECT e ->> 'version' FROM jsonb_array_elements((SELECT val -> 'items' FROM v WHERE k = 'p1')) e WHERE e ->> 'id' = pg_temp.r(1)::text),
  pg_temp.ver(1), 'row carries the case version');
SELECT ok((SELECT (e ->> 'reopened')::boolean FROM jsonb_array_elements(public.admin_report_queue('reopened') -> 'items') e), 'reopened row is marked');
SELECT is((SELECT jsonb_agg(e ->> 'claim' ORDER BY e ->> 'id') FROM jsonb_array_elements(public.admin_report_queue('claimed') -> 'items') e),
  '["other", "stale"]'::jsonb, 'claim state per row: another admin''s live claim, and a stale one');
SELECT is((SELECT e ->> 'evidence' FROM jsonb_array_elements(public.admin_report_queue('dismissed') -> 'items') e WHERE e ->> 'id' = pg_temp.r(8)::text),
  'purged', 'purged evidence is reported as such');
INSERT INTO v SELECT 'p2', public.admin_report_queue('open', NULL, NULL, NULL, NULL, NULL, 5, NULL);
SELECT ok((SELECT val -> 'next_cursor' FROM v WHERE k = 'p2') <> 'null'::jsonb
      AND public.admin_report_queue('open', NULL, NULL, NULL, NULL, NULL, 5, (SELECT val -> 'next_cursor' FROM v WHERE k = 'p2')) -> 'counts' = 'null'::jsonb,
  'later pages omit counts');
SELECT throws_ok($$ SELECT public.admin_report_queue('claimed', NULL, NULL, NULL, NULL, NULL, 5, (SELECT val -> 'next_cursor' FROM v WHERE k = 'p2')) $$,
  '22023', 'invalid_cursor', 'a cursor from another view is refused');
SELECT throws_ok($$ SELECT public.admin_report_queue('open', NULL, NULL, NULL, NULL, 'newest', 5, (SELECT val -> 'next_cursor' FROM v WHERE k = 'p2')) $$,
  '22023', 'invalid_cursor', 'a cursor from another sort is refused');
SELECT throws_ok($$ SELECT public.admin_report_queue('open', NULL, NULL, NULL, NULL, NULL, 5, '{"v":"open","s":"priority","r":7,"t":"2026-01-01","id":"00000000-0000-4000-8000-000000000000"}') $$,
  '22023', 'invalid_cursor', 'a tampered cursor is refused');
SELECT throws_ok($$ SELECT public.admin_report_queue('everything') $$, '22023', 'invalid_view', 'unknown view refused');
SELECT throws_ok($$ SELECT public.admin_report_queue('open', p_reason => 'rude') $$, '22023', 'invalid_reason', 'unknown reason refused');
SELECT throws_ok($$ SELECT public.admin_report_queue('open', p_age => 'ancient') $$, '22023', 'invalid_age', 'unknown age refused');
SELECT throws_ok($$ SELECT public.admin_report_queue('dismissed', p_sort => 'priority') $$, '22023', 'invalid_sort', 'priority sort is for pending views only');
SELECT throws_ok($$ SELECT public.admin_report_queue('open', p_limit => 51) $$, '22023', 'invalid_limit', 'page size is bounded (1–50)');
SELECT throws_ok($$ SELECT public.admin_report_queue('open', p_target_type => 'transfer') $$, '22023', 'invalid_target_type', 'unknown content type refused (no Registry/Transfers)');

-- ── 4. Case detail ──────────────────────────────────────────────────────
INSERT INTO v SELECT 'c1', public.admin_report_case(pg_temp.r(1));
SELECT ok((SELECT val ? 'case' AND val ? 'evidence' AND val ? 'current' AND val ? 'history' AND val ? 'moderation' FROM v WHERE k = 'c1'),
  'case: report, evidence, current state, moderation and history');
SELECT ok(NOT (SELECT val -> 'report' ? 'target_id' FROM v WHERE k = 'c1'), 'case: target id is not returned');
SELECT is((SELECT val -> 'reporter' FROM v WHERE k = 'c1'), '{"present": true}'::jsonb, 'case: reporter reduced to "still exists"');
SELECT ok((SELECT val::text FROM v WHERE k = 'c1') !~ (pg_temp.u(7)::text || '|rr_user_7|rr-7@'), 'case: no reporter id, username or email anywhere');
SELECT ok((SELECT val::text FROM v WHERE k = 'c1') !~ 'https?://', 'case: no media URLs anywhere');
SELECT is((SELECT val -> 'evidence' -> 'withheld_media' FROM v WHERE k = 'c1'), '["image_url"]'::jsonb, 'case: withheld evidence media is named, not linked');
SELECT is((SELECT val -> 'current' -> 'content' -> 'withheld_media' FROM v WHERE k = 'c1'), '["image_url"]'::jsonb, 'case: current-content media withheld too');
SELECT is((SELECT val -> 'evidence' ->> 'content' FROM v WHERE k = 'c1'), 'RR-SECRET-POST-TEXT', 'case: the reported text itself is available to the admin');
SELECT is((SELECT val -> 'report' ->> 'details' FROM v WHERE k = 'c1'), 'RR-SECRET-DETAILS', 'case: the reporter''s permitted details');
SELECT is((SELECT val -> 'case' ->> 'version' FROM v WHERE k = 'c1'), pg_temp.ver(1), 'case: carries the version');
SELECT is((SELECT val -> 'case' -> 'can' FROM v WHERE k = 'c1'), '{"claim": true, "release": false, "dismiss": false, "reopen": false}'::jsonb,
  'case (open, unclaimed): only claim applies');
SELECT is((SELECT val -> 'case' -> 'blocked' FROM v WHERE k = 'c1'), '{"dismiss": "claim_first", "reopen": "not_resolved"}'::jsonb, 'case: blocked reasons explained');
SELECT ok(NOT (SELECT (val -> 'case' ->> 'child_safety')::boolean OR (val -> 'case' ->> 'legal_hold')::boolean FROM v WHERE k = 'c1'), 'case: no child safety, no hold');
SELECT ok((public.admin_report_case(pg_temp.r(2)) -> 'case' ->> 'child_safety')::boolean, 'case: child-safety report flagged');
SELECT lives_ok($$ SELECT public.admin_place_legal_hold('report', pg_temp.r(1), 'internal_investigation', 'rr hold', now() + interval '30 days') $$,
  'fixture: legal hold placed on r1 by A (existing function)');
SELECT ok((public.admin_report_case(pg_temp.r(1)) -> 'case' ->> 'legal_hold')::boolean, 'case: legal hold shown');
SELECT is(public.admin_report_case(pg_temp.r(5)) -> 'case' ->> 'claim', 'other', 'case: claimed by another admin');
SELECT is(public.admin_report_case(pg_temp.r(5)) -> 'case' -> 'blocked' ->> 'dismiss', 'claimed_by_other', 'case: can''t decide another admin''s claim');
SELECT is(public.admin_report_case(pg_temp.r(5)) -> 'report' -> 'claimed_by', '{"username": "rr_user_2", "is_me": false}'::jsonb, 'case: claim ownership shown');
SELECT is(public.admin_report_case(pg_temp.r(6)) -> 'case' -> 'can', '{"claim": true, "release": true, "dismiss": false, "reopen": false}'::jsonb,
  'case: a stale claim can be taken over or released');
SELECT is(public.admin_report_case(pg_temp.r(8)) -> 'case' ->> 'evidence', 'purged', 'case: purged evidence state');
SELECT is(public.admin_report_case(pg_temp.r(8)) -> 'evidence', 'null'::jsonb, 'case: purged evidence is not resurrected');
SELECT is(public.admin_report_case(pg_temp.r(8)) -> 'case' -> 'blocked' ->> 'reopen', 'evidence_unavailable', 'case: purged report can''t be reopened');
SELECT ok((public.admin_report_case(pg_temp.r(7)) -> 'case' -> 'can' ->> 'reopen')::boolean, 'case: dismissed report with evidence can be reopened');
SELECT is(public.admin_report_case(pg_temp.r(9)) -> 'case' -> 'blocked' ->> 'reopen', 'reopen_not_supported', 'case: actioned reports aren''t reopened here');
SELECT ok((public.admin_report_case(pg_temp.r(10)) -> 'case' ->> 'content_restricted')::boolean
      AND public.admin_report_case(pg_temp.r(10)) -> 'case' -> 'blocked' ->> 'dismiss' = 'content_moderated', 'case: restricted content can''t be dismissed');
SELECT is((public.admin_report_case(pg_temp.r(11)) -> 'case' ->> 'reopen_count')::int, 1, 'case: reopen count');
SELECT throws_ok($$ SELECT public.admin_report_case('00000000-0000-4000-8000-000000000bad') $$, 'PT404', 'not_found', 'case: unknown report → not_found');

-- ── 5. Case actions (versioned) ─────────────────────────────────────────
INSERT INTO v SELECT 'v1', to_jsonb(pg_temp.ver(1));
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'claim', pg_temp.ver(1) || '0') $$,
  'PT409', 'report_changed', 'claim with an out-of-date version is refused');
SELECT is(pg_temp.st(1), 'open:-', '…and nothing changed');
INSERT INTO v SELECT 'a1', public.admin_report_case_action(pg_temp.r(1), 'claim', pg_temp.ver(1));
SELECT is(pg_temp.st(1), 'reviewing:' || pg_temp.u(1), 'claim with the current version: claimed by A');
SELECT ok((SELECT (val ->> 'changed')::boolean AND val ->> 'version' = pg_temp.ver(1) AND val ->> 'version' <> (SELECT val #>> '{}' FROM v WHERE k = 'v1') FROM v WHERE k = 'a1'), 'claim returns the new version');
SELECT is(pg_temp.audits(1, 'claim'), 1, 'claim audited once (by the existing function)');
SELECT is(pg_temp.q('mine'), ARRAY[pg_temp.r(1)], 'mine view now lists it');
SELECT pg_temp.login(pg_temp.u(2));
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'claim', pg_temp.ver(1)) $$, 'PT409', 'claimed_by_other',
  'second admin, current version: claimed_by_other');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'claim', (SELECT val #>> '{}' FROM v WHERE k = 'v1')) $$,
  'PT409', 'report_changed', 'second admin with the view from before the claim: report_changed');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'release', pg_temp.ver(1)) $$, 'PT409', 'claimed_by_other',
  'another admin can''t release a live claim');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'dismiss', pg_temp.ver(1), 'no_violation', 'within_guidelines') $$,
  'PT409', 'claimed_by_other', 'another admin can''t dismiss a claimed report');
SELECT is(pg_temp.st(1), 'reviewing:' || pg_temp.u(1), 'A''s claim is intact');
SELECT pg_temp.login(pg_temp.u(1));
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'dismiss', pg_temp.ver(1), 'content_removed', 'hate') $$,
  '22023', 'invalid_outcome', 'dismiss can''t carry an enforcement outcome');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'dismiss', pg_temp.ver(1), 'no_violation', 'test_report') $$,
  '22023', 'invalid_reason_code', 'dismiss reason must match the outcome');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'dismiss', pg_temp.ver(1), 'administrative_closure', 'target_deleted') $$,
  'PT409', 'target_still_exists', 'closure facts are still checked (target still exists)');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'remove', pg_temp.ver(1)) $$, '22023', 'invalid_action', 'no enforcement action exists here');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'claim', NULL) $$, '22023', 'invalid_version', 'a version is required');
SELECT throws_ok($$ SELECT public.admin_report_case_action('00000000-0000-4000-8000-000000000bad', 'claim', 'x') $$, 'PT404', 'not_found', 'unknown report');
INSERT INTO v SELECT 'v2', to_jsonb(pg_temp.ver(1));
SELECT lives_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'dismiss', pg_temp.ver(1), 'no_violation', 'within_guidelines', 'rr internal note') $$,
  'claimant dismisses with the current version');
SELECT is(pg_temp.st(1), 'dismissed:-', 'dismissed');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'dismiss', (SELECT val #>> '{}' FROM v WHERE k = 'v2'), 'no_violation', 'within_guidelines') $$,
  'PT409', 'report_changed', 'a retried dismissal from the old view is refused, not repeated');
SELECT is(pg_temp.audits(1, 'resolve'), 1, 'exactly one resolve audit row');
SELECT is((SELECT jsonb_agg(h ->> 'action' ORDER BY n) FROM jsonb_array_elements(public.admin_report_case(pg_temp.r(1)) -> 'history') WITH ORDINALITY x (h, n)),
  '["place_legal_hold", "claim", "resolve"]'::jsonb, 'history shows the audited actions in order');
SELECT pg_temp.login(pg_temp.u(2));
SELECT lives_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'reopen', pg_temp.ver(1), NULL, 'new_information') $$, 'B reopens with the current version');
SELECT is(pg_temp.st(1), 'open:-', 'reopened to the open queue');
SELECT pg_temp.login(pg_temp.u(1));
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'dismiss', (SELECT val #>> '{}' FROM v WHERE k = 'v2'), 'duplicate', 'duplicate_report') $$,
  'PT409', 'report_changed', 'A, still looking at the pre-reopen state, can''t silently overwrite B''s reopen');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(1), 'reopen', pg_temp.ver(1), NULL, 'new_information') $$, 'PT409', 'not_resolved',
  'reopening an open report is refused');
-- Stale takeover by B (C's claim is 25 h old).
SELECT pg_temp.login(pg_temp.u(2));
SELECT lives_ok($$ SELECT public.admin_report_case_action(pg_temp.r(6), 'claim', pg_temp.ver(6)) $$, 'B takes over the stale claim');
SELECT is(pg_temp.st(6), 'reviewing:' || pg_temp.u(2), 'claimed by B');
SELECT is((public.admin_report_case(pg_temp.r(6)) -> 'history' -> -1 -> 'metadata'), '{"took_over_stale_claim": true}'::jsonb, 'takeover is recorded in the audit history');
-- Restricted content, actioned and purged reports.
SELECT lives_ok($$ SELECT public.admin_report_case_action(pg_temp.r(10), 'claim', pg_temp.ver(10)) $$, 'B claims the report on restricted content');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(10), 'dismiss', pg_temp.ver(10), 'no_violation', 'within_guidelines') $$,
  'PT409', 'content_moderated', 'restricted content can''t be dismissed');
SELECT lives_ok($$ SELECT public.admin_report_case_action(pg_temp.r(10), 'release', pg_temp.ver(10)) $$, 'B releases it');
SELECT is(pg_temp.st(10), 'open:-', 'back to open');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(9), 'reopen', pg_temp.ver(9), NULL, 'new_information') $$, 'PT409', 'reopen_not_supported',
  'actioned report can''t be reopened');
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(8), 'reopen', pg_temp.ver(8), NULL, 'new_information') $$, 'PT409', 'evidence_unavailable',
  'purged report can''t be reopened (evidence is never restored)');
SELECT lives_ok($$ SELECT public.admin_report_case_action(pg_temp.r(2), 'claim', pg_temp.ver(2)) $$, 'B claims the child-safety report');
SELECT lives_ok($$ SELECT public.admin_report_case_action(pg_temp.r(2), 'release', pg_temp.ver(2)) $$, 'B releases it');
SELECT ok((public.admin_report_case(pg_temp.r(2)) -> 'case' ->> 'child_safety')::boolean AND pg_temp.st(2) = 'open:-', 'child-safety flag survives claim and release');

-- Lost standing mid-case: A claims, then is suspended → every call refused.
SELECT pg_temp.login(pg_temp.u(1));
SELECT lives_ok($$ SELECT public.admin_report_case_action(pg_temp.r(3), 'claim', pg_temp.ver(3)) $$, 'A claims r3');
RESET ROLE;
INSERT INTO public.account_suspensions (user_id, reason_code) VALUES (pg_temp.u(1), 'spam');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login(pg_temp.u(1));
SELECT throws_ok($$ SELECT public.admin_report_case_action(pg_temp.r(3), 'dismiss', pg_temp.ver(3), 'no_violation', 'within_guidelines') $$,
  '42501', 'account_inactive', 'suspended mid-case: A can''t decide the report it claimed');
SELECT throws_ok($$ SELECT public.admin_report_case(pg_temp.r(3)) $$, '42501', 'account_inactive', 'suspended mid-case: A can''t read it either');
SELECT pg_temp.login(pg_temp.u(2));
SELECT is(public.admin_report_case(pg_temp.r(3)) -> 'case' ->> 'claim', 'stale', 'suspended admin''s claim is stale for others');
SELECT lives_ok($$ SELECT public.admin_report_case_action(pg_temp.r(3), 'claim', pg_temp.ver(3)) $$, 'B can take it over');

-- ── 6. No enforcement happened ──────────────────────────────────────────
RESET ROLE;
SELECT is((SELECT count(*) FROM public.moderated_content), (SELECT (val #>> '{}')::bigint FROM v WHERE k = 'mod_before'), 'no content was hidden, removed or restored');
SELECT is((SELECT count(*) FROM public.account_suspensions), (SELECT (val #>> '{}')::bigint FROM v WHERE k = 'susp_before') + 1,
  'no suspension was created by the review functions (only the test''s own)');
SELECT is((SELECT count(*) FROM private.moderation_legal_holds), (SELECT (val #>> '{}')::bigint FROM v WHERE k = 'hold_before') + 1,
  'legal holds unchanged except the test''s own');
SELECT ok((SELECT evidence IS NULL AND evidence_purged_at IS NOT NULL FROM public.content_reports WHERE id = pg_temp.r(8)), 'purged evidence stays purged');

SELECT * FROM finish();
ROLLBACK;
