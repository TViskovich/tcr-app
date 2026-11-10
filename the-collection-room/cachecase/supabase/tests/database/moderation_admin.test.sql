-- pgTAP test for 20261115120000_moderation_admin.sql (admin report queue and
-- audit trail, App Store moderation Phase 2B M1).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(136);

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
-- Every id on every page, in order.
CREATE FUNCTION pg_temp.walk(p_statuses text[], p_limit integer) RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE
  v_cursor jsonb := NULL;
  v_page   jsonb;
  v_ids    uuid[] := '{}';
  v_pages  integer := 0;
BEGIN
  LOOP
    v_page := public.admin_list_reports(p_statuses, NULL, NULL, p_limit, v_cursor);
    v_ids := v_ids || ARRAY(SELECT (x.e ->> 'id')::uuid FROM jsonb_array_elements(v_page -> 'items') WITH ORDINALITY x (e, n) ORDER BY x.n);
    v_cursor := v_page -> 'next_cursor';
    v_pages := v_pages + 1;
    EXIT WHEN v_cursor IS NULL OR v_cursor = 'null'::jsonb OR v_pages > 100;
  END LOOP;
  RETURN v_ids;
END;
$$;
CREATE FUNCTION pg_temp.ids(p_page jsonb) RETURNS uuid[] LANGUAGE sql AS $$
  SELECT ARRAY(SELECT (x.e ->> 'id')::uuid FROM jsonb_array_elements(p_page -> 'items') WITH ORDINALITY x (e, n) ORDER BY x.n);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid), pg_temp.logout(), pg_temp.walk(text[], integer), pg_temp.ids(jsonb)
  TO authenticated, anon, service_role;

-- ── 1. Shape, privileges, exposure ──────────────────────────────────────
CREATE TEMP TABLE md_fns (fn regprocedure);
INSERT INTO md_fns VALUES
  ('public.admin_list_reports(text[],text,text,integer,jsonb)'), ('public.admin_report_counts()'), ('public.admin_get_report(uuid)'),
  ('public.admin_claim_report(uuid)'), ('public.admin_release_report(uuid)'),
  ('public.admin_resolve_report(uuid,text,text,text,boolean)'), ('public.admin_reopen_report(uuid,text,text)');
GRANT SELECT ON md_fns TO authenticated;

SELECT has_table('public', 'moderation_actions', 'moderation_actions exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.moderation_actions'::regclass)
      AND (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.moderation_actions'::regclass AND polpermissive) = 0,
  'audit: RLS on, no permissive policies');
SELECT ok(NOT has_table_privilege('anon', 'public.moderation_actions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_table_privilege('authenticated', 'public.moderation_actions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'audit: clients have no table privileges');
SELECT ok(has_table_privilege('service_role', 'public.moderation_actions', 'SELECT')
      AND NOT has_table_privilege('service_role', 'public.moderation_actions', 'INSERT,UPDATE,DELETE,TRUNCATE'),
  'audit: the service role may only read');
SELECT ok(EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.moderation_actions'::regclass AND polname = 'account_lifecycle_read_guard' AND NOT polpermissive)
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.moderation_actions'::regclass AND tgname = 'account_write_guard'),
  'audit: carries the account-lifecycle read and write guards');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.moderation_actions'::regclass
             AND tgname IN ('moderation_actions_append_only', 'moderation_actions_no_truncate') AND tgenabled = 'O'), 2,
  'audit: append-only row trigger and TRUNCATE trigger are enabled');
SELECT is((SELECT count(*)::int FROM md_fns t JOIN pg_proc p ON p.oid = t.fn WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""']), 7,
  'all 7 admin functions are SECURITY DEFINER with an empty search_path');
SELECT is((SELECT count(*)::int FROM md_fns t JOIN pg_proc p ON p.oid = t.fn WHERE p.prosrc LIKE '%private.require_admin()%'), 7,
  'every admin function checks admin_users itself (private.require_admin)');
SELECT is((SELECT count(*)::int FROM md_fns t WHERE has_function_privilege('anon', t.fn, 'EXECUTE') OR has_function_privilege('service_role', t.fn, 'EXECUTE')), 0,
  'no admin function is executable by signed-out callers or the service role');
SELECT is((SELECT count(*)::int FROM md_fns t WHERE has_function_privilege('authenticated', t.fn, 'EXECUTE')), 7,
  'admin functions are executable by signed-in callers (each re-checks admin)');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'private' AND (p.proname LIKE 'moderation%' OR p.proname IN ('require_admin', 'log_moderation_action'))
             AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))), 0,
  'private moderation helpers are not executable by clients');
SELECT is((SELECT array_agg(confdeltype::text ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.moderation_actions'::regclass AND contype = 'f'),
  ARRAY['n', 'r', 'n'], 'audit: admin and owner ids are nulled on account deletion; a report with history cannot be deleted');
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conrelid = 'public.content_reports'::regclass AND contype = 'f'
             AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.content_reports'::regclass AND attname = 'claimed_by')]),
  'n', 'claimed_by is nulled when the claiming account is deleted');
SELECT ok(NOT has_table_privilege('anon', 'public.content_reports', 'SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('authenticated', 'public.content_reports', 'SELECT,INSERT,UPDATE,DELETE'),
  'content_reports still has no client privileges');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- M1, M2 admins; M3 admin pending deletion; N collector; A, A2 reporters;
-- B owner of reported content; P a reported collector pending deletion.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000ad000001', 'md-m1@example.invalid', '{"username":"md_m1"}'),
  ('00000000-0000-4000-8000-0000ad000002', 'md-m2@example.invalid', '{"username":"md_m2"}'),
  ('00000000-0000-4000-8000-0000ad000003', 'md-n@example.invalid', '{"username":"md_n"}'),
  ('00000000-0000-4000-8000-0000ad000004', 'md-a@example.invalid', '{"username":"md_reporter_a"}'),
  ('00000000-0000-4000-8000-0000ad000005', 'md-a2@example.invalid', '{"username":"md_reporter_b"}'),
  ('00000000-0000-4000-8000-0000ad000006', 'md-b@example.invalid', '{"username":"md_owner"}'),
  ('00000000-0000-4000-8000-0000ad000007', 'md-m3@example.invalid', '{"username":"md_m3"}'),
  ('00000000-0000-4000-8000-0000ad000008', 'md-p@example.invalid', '{"username":"md_pending"}');
INSERT INTO public.admin_users (user_id) VALUES
  ('00000000-0000-4000-8000-0000ad000001'), ('00000000-0000-4000-8000-0000ad000002'), ('00000000-0000-4000-8000-0000ad000007');
INSERT INTO public.account_lifecycle (user_id, state, mode, requested_at, scheduled_for) VALUES
  ('00000000-0000-4000-8000-0000ad000007', 'pending_deletion', 'scheduled', now(), now() + interval '30 days'),
  ('00000000-0000-4000-8000-0000ad000008', 'pending_deletion', 'scheduled', now(), now() + interval '30 days');
INSERT INTO public.posts (id, user_id, content, post_type) VALUES
  ('00000000-0000-4000-8000-0000ad200001', '00000000-0000-4000-8000-0000ad000006', 'md post by B', 'text');
INSERT INTO public.comments (id, user_id, post_id, body) VALUES
  ('00000000-0000-4000-8000-0000ad300001', '00000000-0000-4000-8000-0000ad000006', '00000000-0000-4000-8000-0000ad200001', 'md comment by B');
INSERT INTO public.conversations (id) VALUES ('00000000-0000-4000-8000-0000ad400001');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000ad400001', '00000000-0000-4000-8000-0000ad000004'),
  ('00000000-0000-4000-8000-0000ad400001', '00000000-0000-4000-8000-0000ad000006');
INSERT INTO public.messages (id, conversation_id, sender_id, body) VALUES
  ('00000000-0000-4000-8000-0000ad500001', '00000000-0000-4000-8000-0000ad400001', '00000000-0000-4000-8000-0000ad000006', 'md abusive DM'),
  ('00000000-0000-4000-8000-0000ad500002', '00000000-0000-4000-8000-0000ad400001', '00000000-0000-4000-8000-0000ad000004', 'md private reply from A');

INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, details, evidence, priority, created_at) VALUES
  ('00000000-0000-4000-8000-0000ad100001', '00000000-0000-4000-8000-0000ad000004', 'post', '00000000-0000-4000-8000-0000ad200001',
   '00000000-0000-4000-8000-0000ad000006', 'violence', 'md details from A', '{"v":1,"content":"md post by B"}', 'urgent', now() - interval '3 hours'),
  ('00000000-0000-4000-8000-0000ad100002', '00000000-0000-4000-8000-0000ad000005', 'post', '00000000-0000-4000-8000-0000ad200001',
   '00000000-0000-4000-8000-0000ad000006', 'spam', NULL, '{"v":1,"content":"md post by B"}', 'normal', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-0000ad100003', '00000000-0000-4000-8000-0000ad000004', 'message', '00000000-0000-4000-8000-0000ad500001',
   '00000000-0000-4000-8000-0000ad000006', 'harassment', NULL,
   '{"v":1,"body":"md abusive DM","attachment_ref":{"bucket":"dm-attachments","path":"00000000-0000-4000-8000-0000ad400001/00000000-0000-4000-8000-0000ad500001/image.jpg"}}',
   'normal', now() - interval '5 hours'),
  ('00000000-0000-4000-8000-0000ad100004', '00000000-0000-4000-8000-0000ad000004', 'comment', '00000000-0000-4000-8000-0000ad300001',
   '00000000-0000-4000-8000-0000ad000006', 'hate', NULL, '{"v":1,"body":"md comment by B"}', 'normal', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-0000ad100005', '00000000-0000-4000-8000-0000ad000005', 'profile', '00000000-0000-4000-8000-0000ad000006',
   '00000000-0000-4000-8000-0000ad000006', 'child_safety', NULL, '{"v":1,"username":"md_owner"}', 'urgent', now() - interval '30 minutes'),
  ('00000000-0000-4000-8000-0000ad100006', '00000000-0000-4000-8000-0000ad000004', 'profile', '00000000-0000-4000-8000-0000ad000008',
   '00000000-0000-4000-8000-0000ad000008', 'spam', NULL, '{"v":1,"username":"md_pending"}', 'normal', now() - interval '20 minutes');
-- 30 older normal reports (reporter gone) for pagination.
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence, priority, created_at)
SELECT ('00000000-0000-4000-8000-0000ad9000' || lpad(i::text, 2, '0'))::uuid, NULL, 'post', gen_random_uuid(),
       '00000000-0000-4000-8000-0000ad000006', 'spam', jsonb_build_object('v', 1, 'content', 'md bulk ' || i), 'normal',
       now() - interval '10 days' + i * interval '1 minute'
FROM generate_series(1, 30) i;

-- ── 2. Authorization ────────────────────────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT public.admin_list_reports() $$, '42501', NULL, 'signed-out: cannot list');
SELECT throws_ok($$ SELECT public.admin_get_report('00000000-0000-4000-8000-0000ad100001') $$, '42501', NULL, 'signed-out: cannot read a report');
SELECT throws_ok($$ SELECT count(*) FROM public.content_reports $$, '42501', NULL, 'signed-out: no direct report access');
SELECT throws_ok($$ SELECT count(*) FROM public.moderation_actions $$, '42501', NULL, 'signed-out: no direct audit access');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_list_reports() $$, '42501', 'not_authenticated', 'a token with no user is refused');

SELECT pg_temp.login('00000000-0000-4000-8000-0000ad000003');
SELECT throws_ok($$ SELECT public.admin_list_reports() $$, '42501', 'forbidden', 'collector: admin_list_reports refused');
SELECT throws_ok($$ SELECT public.admin_report_counts() $$, '42501', 'forbidden', 'collector: admin_report_counts refused');
SELECT throws_ok($$ SELECT public.admin_get_report('00000000-0000-4000-8000-0000ad100001') $$, '42501', 'forbidden', 'collector: admin_get_report refused');
SELECT throws_ok($$ SELECT public.admin_claim_report('00000000-0000-4000-8000-0000ad100001') $$, '42501', 'forbidden', 'collector: admin_claim_report refused');
SELECT throws_ok($$ SELECT public.admin_release_report('00000000-0000-4000-8000-0000ad100001') $$, '42501', 'forbidden', 'collector: admin_release_report refused');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'no_violation', 'within_guidelines') $$, '42501', 'forbidden', 'collector: admin_resolve_report refused');
SELECT throws_ok($$ SELECT public.admin_reopen_report('00000000-0000-4000-8000-0000ad100001', 'new_information') $$, '42501', 'forbidden', 'collector: admin_reopen_report refused');
SELECT throws_ok($$ SELECT count(*) FROM public.content_reports $$, '42501', NULL, 'collector: no direct report reads');
SELECT throws_ok($$ SELECT count(*) FROM public.moderation_actions $$, '42501', NULL, 'collector: no direct audit reads');
SELECT throws_ok($$ INSERT INTO public.moderation_actions (admin_id, action, target_type, target_id) VALUES ('00000000-0000-4000-8000-0000ad000003', 'claim', 'post', gen_random_uuid()) $$,
  '42501', NULL, 'collector: cannot write audit rows');
SELECT throws_ok($$ UPDATE public.content_reports SET status = 'dismissed' $$, '42501', NULL, 'collector: cannot change report status directly');

SELECT pg_temp.login('00000000-0000-4000-8000-0000ad000007');
SELECT throws_ok($$ SELECT public.admin_list_reports() $$, '42501', 'account_inactive', 'an admin pending deletion is refused');

SELECT pg_temp.login('00000000-0000-4000-8000-0000ad000001');
SELECT throws_ok($$ SELECT count(*) FROM public.content_reports $$, '42501', NULL, 'admin: no direct table access either (functions only)');
SELECT throws_ok($$ INSERT INTO public.moderation_actions (admin_id, action, target_type, target_id) VALUES ('00000000-0000-4000-8000-0000ad000001', 'claim', 'post', gen_random_uuid()) $$,
  '42501', NULL, 'admin: cannot write audit rows directly');

-- ── 3. Queue ────────────────────────────────────────────────────────────
SELECT is((pg_temp.ids(public.admin_list_reports()))[1:3],
  ARRAY['00000000-0000-4000-8000-0000ad100001', '00000000-0000-4000-8000-0000ad100005', '00000000-0000-4000-8000-0000ad900001']::uuid[],
  'pending queue: urgent first (oldest first), then the oldest normal report');
SELECT ok(jsonb_array_length(public.admin_list_reports() -> 'items') = 25 AND public.admin_list_reports() -> 'next_cursor' <> 'null'::jsonb,
  'default page is 25 with a next cursor');
SELECT is(pg_temp.walk(ARRAY['open', 'reviewing'], 7), pg_temp.ids(public.admin_list_reports(ARRAY['open', 'reviewing'], NULL, NULL, 50)),
  'walking 7-row pages returns all 36 pending reports once, in queue order');
SELECT is(cardinality(pg_temp.walk(ARRAY['open'], 7)), 36, '36 pending reports');
SELECT ok(public.admin_list_reports(ARRAY['open'], NULL, NULL, 50)::text NOT LIKE '%reporter%'
      AND public.admin_list_reports(ARRAY['open'], NULL, NULL, 50)::text NOT LIKE '%0000ad000004%'
      AND public.admin_list_reports(ARRAY['open'], NULL, NULL, 50)::text NOT LIKE '%0000ad000005%',
  'the queue carries no reporter id, username or field');
SELECT is(jsonb_array_length(public.admin_list_reports(ARRAY['open'], 'urgent') -> 'items'), 2, 'priority filter');
SELECT is(pg_temp.ids(public.admin_list_reports(ARRAY['open'], NULL, 'message')), ARRAY['00000000-0000-4000-8000-0000ad100003']::uuid[], 'type filter');
SELECT is((SELECT x.e -> 'owner' FROM jsonb_array_elements(public.admin_list_reports(ARRAY['open'], NULL, 'profile') -> 'items') x (e)
           WHERE x.e ->> 'id' = '00000000-0000-4000-8000-0000ad100006'),
  '{"present": true, "username": "md_pending", "account_state": "pending_deletion"}'::jsonb, 'queue shows the reported account''s lifecycle state');
SELECT ok((SELECT (x.e ->> 'other_pending_on_target')::int = 1 AND x.e ->> 'excerpt' = 'md post by B' AND (x.e ->> 'target_exists')::boolean
           FROM jsonb_array_elements(public.admin_list_reports() -> 'items') x (e) WHERE x.e ->> 'id' = '00000000-0000-4000-8000-0000ad100001'),
  'queue row: excerpt, target exists, one other pending report on the same post');
SELECT throws_ok($$ SELECT public.admin_list_reports(ARRAY['open'], NULL, NULL, 51) $$, '22023', 'invalid_limit', 'limit over 50 refused');
SELECT throws_ok($$ SELECT public.admin_list_reports(ARRAY['open'], NULL, NULL, 0) $$, '22023', 'invalid_limit', 'limit 0 refused');
SELECT throws_ok($$ SELECT public.admin_list_reports(ARRAY['open'], NULL, NULL, NULL) $$, '22023', 'invalid_limit', 'null limit refused');
SELECT throws_ok($$ SELECT public.admin_list_reports(ARRAY['open', 'dismissed']) $$, '22023', 'invalid_status', 'pending and resolved cannot be mixed');
SELECT throws_ok($$ SELECT public.admin_list_reports(ARRAY['hidden']) $$, '22023', 'invalid_status', 'unknown status refused');
SELECT throws_ok($$ SELECT public.admin_list_reports(ARRAY['open', NULL]) $$, '22023', 'invalid_status', 'null status refused');
SELECT throws_ok($$ SELECT public.admin_list_reports('{}'::text[]) $$, '22023', 'invalid_status', 'empty status list refused');
SELECT throws_ok($$ SELECT public.admin_list_reports(ARRAY['open'], NULL, NULL, 10, '{"r":0,"t":"yesterday-ish","id":"x"}') $$, '22023', 'invalid_cursor', 'malformed cursor refused');
SELECT throws_ok($$ SELECT public.admin_list_reports(ARRAY['open'], NULL, NULL, 10, jsonb_build_object('t', now(), 'id', gen_random_uuid())) $$,
  '22023', 'invalid_cursor', 'a resolved-queue cursor is refused for the pending queue');
SELECT throws_ok($$ SELECT public.admin_list_reports(ARRAY['open'], 'high') $$, '22023', 'invalid_priority', 'unknown priority refused');
SELECT throws_ok($$ SELECT public.admin_list_reports(ARRAY['open'], NULL, 'notification') $$, '22023', 'invalid_target_type', 'unknown type refused');
SELECT ok((SELECT (c ->> 'open')::int = 36 AND (c ->> 'reviewing')::int = 0 AND (c ->> 'urgent_pending')::int = 2
             AND (c ->> 'oldest_pending_at')::timestamptz = now() - interval '10 days' + interval '1 minute'
           FROM public.admin_report_counts() c), 'counts: open, reviewing, urgent and the oldest pending age');

-- ── 4. Detail ───────────────────────────────────────────────────────────
SELECT is(public.admin_get_report('00000000-0000-4000-8000-0000ad100003') #>> '{current,content,body}', 'md abusive DM',
  'message report: the reported message as it is now');
SELECT ok(public.admin_get_report('00000000-0000-4000-8000-0000ad100003')::text NOT LIKE '%md private reply%'
      AND public.admin_get_report('00000000-0000-4000-8000-0000ad100003')::text NOT LIKE '%0000ad400001%',
  'message report: no other message and no conversation id');
SELECT is(public.admin_get_report('00000000-0000-4000-8000-0000ad100003') #> '{evidence,attachment_ref}',
  '{"bucket": "dm-attachments", "available": false}'::jsonb, 'media evidence: bucket and availability only, never the storage path');
SELECT ok(public.admin_get_report('00000000-0000-4000-8000-0000ad100001') -> 'reporter' = '{"present": true}'::jsonb
      AND public.admin_get_report('00000000-0000-4000-8000-0000ad100001')::text NOT LIKE '%0000ad000004%'
      AND public.admin_get_report('00000000-0000-4000-8000-0000ad100001')::text NOT LIKE '%md_reporter%',
  'detail: only whether the reporter still exists — no id, no username');
SELECT ok((SELECT (g #>> '{prior,same_target,open}')::int = 1 AND (g #>> '{prior,same_owner,open}')::int = 34
             AND jsonb_array_length(g #> '{prior,recent_same_owner}') = 10 AND g #>> '{report,details}' = 'md details from A'
           FROM public.admin_get_report('00000000-0000-4000-8000-0000ad100001') g),
  'detail: prior reports on the same content and account (bounded), and the reporter''s details');
SELECT is(public.admin_get_report('00000000-0000-4000-8000-0000ad100001') -> 'owner',
  '{"present": true, "username": "md_owner", "account_state": "active"}'::jsonb, 'detail: the reported account');
SELECT throws_ok($$ SELECT public.admin_get_report(gen_random_uuid()) $$, 'PT404', 'not_found', 'unknown report');
SELECT throws_ok($$ SELECT public.admin_get_report(NULL) $$, 'PT404', 'not_found', 'null report id');

RESET ROLE;
DELETE FROM public.comments WHERE id = '00000000-0000-4000-8000-0000ad300001';
-- Snapshot of B's and the conversation's content: no admin function may change it.
CREATE TEMP TABLE ugc_before AS SELECT md5(
  COALESCE((SELECT string_agg(p::text, '|' ORDER BY p.id) FROM public.posts p WHERE p.user_id = '00000000-0000-4000-8000-0000ad000006'), '') ||
  COALESCE((SELECT string_agg(m::text, '|' ORDER BY m.id) FROM public.messages m WHERE m.conversation_id = '00000000-0000-4000-8000-0000ad400001'), '') ||
  COALESCE((SELECT string_agg(f::text, '|' ORDER BY f.id) FROM public.profiles f WHERE f.id IN ('00000000-0000-4000-8000-0000ad000006', '00000000-0000-4000-8000-0000ad000008')), '')) AS h;
SET LOCAL ROLE authenticated;
SELECT ok((SELECT NOT (g #>> '{current,exists}')::boolean AND g #>> '{evidence,body}' = 'md comment by B'
           FROM public.admin_get_report('00000000-0000-4000-8000-0000ad100004') g),
  'deleted content: current is gone, the stored evidence remains');

-- ── 5. Claim and release ────────────────────────────────────────────────
SELECT is(public.admin_claim_report('00000000-0000-4000-8000-0000ad100001'),
  '{"id": "00000000-0000-4000-8000-0000ad100001", "status": "reviewing", "changed": true}'::jsonb, 'M1 claims a report');
SELECT is(public.admin_claim_report('00000000-0000-4000-8000-0000ad100001') -> 'changed', 'false'::jsonb, 'claiming again is a no-op retry');
SELECT is(jsonb_array_length(public.admin_get_report('00000000-0000-4000-8000-0000ad100001') -> 'history'), 1, 'the retry wrote no second audit row');

SELECT pg_temp.login('00000000-0000-4000-8000-0000ad000002');
SELECT throws_ok($$ SELECT public.admin_claim_report('00000000-0000-4000-8000-0000ad100001') $$, 'PT409', 'claimed_by_other', 'M2 cannot claim M1''s report');
SELECT throws_ok($$ SELECT public.admin_release_report('00000000-0000-4000-8000-0000ad100001') $$, 'PT409', 'claimed_by_other', 'M2 cannot release M1''s claim');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'no_violation', 'within_guidelines') $$,
  'PT409', 'claimed_by_other', 'M2 cannot resolve M1''s claimed report');
SELECT ok((SELECT NOT (x.e ->> 'claimed_by_me')::boolean AND x.e ->> 'claimed_at' IS NOT NULL
           FROM jsonb_array_elements(public.admin_list_reports(ARRAY['reviewing']) -> 'items') x (e)),
  'M2 sees the report as claimed by someone else');
SELECT is(public.admin_get_report('00000000-0000-4000-8000-0000ad100001') #> '{report,claimed_by}',
  '{"username": "md_m1", "is_me": false}'::jsonb, 'M2 sees which admin claimed it');
SELECT is(public.admin_claim_report('00000000-0000-4000-8000-0000ad100006') -> 'changed', 'true'::jsonb, 'M2 claims another report');

RESET ROLE;
UPDATE public.content_reports SET claimed_at = now() - interval '25 hours' WHERE id = '00000000-0000-4000-8000-0000ad100001';
SET LOCAL ROLE authenticated;
SELECT is(public.admin_claim_report('00000000-0000-4000-8000-0000ad100001') -> 'changed', 'true'::jsonb, 'a claim over 24 hours old can be taken over');
SELECT is(public.admin_get_report('00000000-0000-4000-8000-0000ad100001') #> '{history,1,metadata}', '{"took_over_stale_claim": true}'::jsonb,
  '… and the takeover is audited as such');
SELECT is(public.admin_release_report('00000000-0000-4000-8000-0000ad100001') ->> 'status', 'open', 'M2 releases it back to the queue');
SELECT is(public.admin_release_report('00000000-0000-4000-8000-0000ad100001') -> 'changed', 'false'::jsonb, 'releasing again is a no-op retry');

-- ── 6. Resolve ──────────────────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000ad000001');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'content_hidden', 'within_guidelines') $$,
  '22023', 'invalid_outcome', 'content_hidden is not available without enforcement');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'content_removed', 'within_guidelines') $$,
  '22023', 'invalid_outcome', 'content_removed is not available without enforcement');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'account_suspended', 'within_guidelines') $$,
  '22023', 'invalid_outcome', 'account_suspended is not available without enforcement');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'no_violation', 'duplicate_report') $$,
  '22023', 'invalid_reason_code', 'a reason code must match the outcome');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'no_violation', NULL) $$,
  '22023', 'invalid_reason_code', 'a reason code is required');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'no_violation', 'within_guidelines', repeat('n', 1001)) $$,
  '22023', 'note_too_long', 'notes are at most 1,000 characters');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'administrative_closure', 'target_deleted') $$,
  'PT409', 'target_still_exists', 'target_deleted is refused while the content exists');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'administrative_closure', 'account_deleted') $$,
  'PT409', 'account_still_exists', 'account_deleted is refused while the account exists');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'no_violation', 'within_guidelines', NULL, NULL) $$,
  '22023', 'invalid_argument', 'include_related must be true or false');

-- Atomicity: if the audit row can't be written, the status change doesn't happen.
RESET ROLE;
ALTER TABLE public.moderation_actions ADD CONSTRAINT md_test_fail CHECK (action <> 'resolve') NOT VALID;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'no_violation', 'within_guidelines') $$,
  '23514', NULL, 'a failing audit insert fails the resolution');
RESET ROLE;
SELECT ok((SELECT status = 'open' AND reviewed_at IS NULL AND resolution IS NULL FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000ad100001'),
  '… and the report is unchanged (resolution and audit are one transaction)');
ALTER TABLE public.moderation_actions DROP CONSTRAINT md_test_fail;
SET LOCAL ROLE authenticated;

SELECT is(public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'no_violation', 'within_guidelines', '  looked fine  ', true),
  '{"id": "00000000-0000-4000-8000-0000ad100001", "status": "dismissed", "changed": true, "related_resolved": 1}'::jsonb,
  'resolve with related: the other pending report on the same post is resolved too');
RESET ROLE;
SELECT ok((SELECT status = 'dismissed' AND resolution = 'no_violation' AND resolution_reason = 'within_guidelines'
             AND reviewed_by = '00000000-0000-4000-8000-0000ad000001' AND reviewed_at = now() AND claimed_by IS NULL AND claimed_at IS NULL
             AND evidence_purge_after = now() + interval '90 days' AND evidence IS NOT NULL
           FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000ad100001'),
  'resolution sets reviewer, time and evidence_purge_after = resolution + 90 days; evidence kept');
SELECT ok((SELECT r.status = 'dismissed' AND a.metadata ->> 'via_report' = '00000000-0000-4000-8000-0000ad100001' AND a.note IS NULL
           FROM public.content_reports r JOIN public.moderation_actions a ON a.report_id = r.id AND a.action = 'resolve'
           WHERE r.id = '00000000-0000-4000-8000-0000ad100002'),
  'the related report has its own audit row pointing at the primary');
SELECT ok((SELECT a.note = 'looked fine' AND a.outcome = 'no_violation' AND a.reason_code = 'within_guidelines' AND a.from_status = 'open'
             AND a.to_status = 'dismissed' AND a.admin_id = '00000000-0000-4000-8000-0000ad000001' AND a.target_type = 'post'
             AND a.target_owner_id = '00000000-0000-4000-8000-0000ad000006'
           FROM public.moderation_actions a WHERE a.report_id = '00000000-0000-4000-8000-0000ad100001' AND a.action = 'resolve'),
  'the audit row: actor, transition, outcome, reason, trimmed note, target');
SET LOCAL ROLE authenticated;
SELECT is(public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'no_violation', 'within_guidelines') -> 'changed', 'false'::jsonb,
  'retrying the same resolution is a no-op');
SELECT is((SELECT array_agg(x.e ->> 'action' ORDER BY x.n) FROM jsonb_array_elements(public.admin_get_report('00000000-0000-4000-8000-0000ad100001') -> 'history') WITH ORDINALITY x (e, n)),
  ARRAY['claim', 'claim', 'release', 'resolve'], 'history: claim, takeover, release, resolve — the retry added nothing');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000ad100001', 'duplicate', 'duplicate_report') $$,
  'PT409', 'already_resolved', 'a different resolution of a resolved report is refused');
SELECT throws_ok($$ SELECT public.admin_claim_report('00000000-0000-4000-8000-0000ad100001') $$, 'PT409', 'already_resolved', 'a resolved report cannot be claimed');
SELECT throws_ok($$ SELECT public.admin_release_report('00000000-0000-4000-8000-0000ad100001') $$, 'PT409', 'already_resolved', 'a resolved report cannot be released');
SELECT is(public.admin_resolve_report('00000000-0000-4000-8000-0000ad100004', 'administrative_closure', 'target_deleted') ->> 'status', 'dismissed',
  'target_deleted closes a report whose content is gone');
SELECT is(pg_temp.ids(public.admin_list_reports(ARRAY['dismissed'])),
  ARRAY['00000000-0000-4000-8000-0000ad100004', '00000000-0000-4000-8000-0000ad100002', '00000000-0000-4000-8000-0000ad100001']::uuid[],
  'resolved queue: most recently resolved first');
SELECT is(pg_temp.walk(ARRAY['dismissed', 'actioned'], 1), pg_temp.ids(public.admin_list_reports(ARRAY['dismissed'])),
  'resolved queue paginates one row at a time without gaps or repeats');
RESET ROLE;
SELECT throws_ok($$ UPDATE public.content_reports SET status = 'actioned' WHERE id = '00000000-0000-4000-8000-0000ad100001' $$,
  '23514', NULL, 'actioned is unreachable in M1, even for elevated writes');
SELECT throws_ok($$ UPDATE public.content_reports SET resolution = 'content_hidden' WHERE id = '00000000-0000-4000-8000-0000ad100001' $$,
  '23514', NULL, 'enforcement outcomes cannot be recorded in M1');

-- ── 7. Reopen ───────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_reopen_report('00000000-0000-4000-8000-0000ad100005', 'new_information') $$, 'PT409', 'not_resolved', 'an open report cannot be reopened');
SELECT throws_ok($$ SELECT public.admin_reopen_report('00000000-0000-4000-8000-0000ad100004', 'because') $$, '22023', 'invalid_reason_code', 'reopen needs a valid reason');
SELECT is(public.admin_reopen_report('00000000-0000-4000-8000-0000ad100004', 'new_information', 'second look') ->> 'status', 'open', 'a dismissed report can be reopened');
RESET ROLE;
SELECT ok((SELECT status = 'open' AND resolution IS NULL AND resolution_reason IS NULL AND reviewed_at IS NULL AND reviewed_by IS NULL
             AND evidence_purge_after IS NULL AND evidence ->> 'body' = 'md comment by B'
           FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000ad100004'),
  'reopening clears the resolution and stops the retention clock; evidence intact');
SELECT ok((SELECT a.metadata ->> 'previous_outcome' = 'administrative_closure' AND a.metadata ->> 'previous_reason' = 'target_deleted'
             AND a.note = 'second look' AND a.from_status = 'dismissed' AND a.to_status = 'open'
           FROM public.moderation_actions a WHERE a.report_id = '00000000-0000-4000-8000-0000ad100004' AND a.action = 'reopen'),
  'the reopen is audited with the previous outcome');
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence) VALUES
  ('00000000-0000-4000-8000-0000ad100007', '00000000-0000-4000-8000-0000ad000005', 'post', '00000000-0000-4000-8000-0000ad200001',
   '00000000-0000-4000-8000-0000ad000006', 'spam', '{"v":1}');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_reopen_report('00000000-0000-4000-8000-0000ad100002', 'resolved_in_error') $$,
  'PT409', 'duplicate_open_report', 'reopen refused while the same reporter has a newer open report on it');
RESET ROLE;
SELECT ok((SELECT status = 'dismissed' FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000ad100002')
      AND NOT EXISTS (SELECT 1 FROM public.moderation_actions WHERE report_id = '00000000-0000-4000-8000-0000ad100002' AND action = 'reopen'),
  '… leaving it dismissed and unaudited');
SET LOCAL ROLE authenticated;
SELECT is(public.admin_resolve_report('00000000-0000-4000-8000-0000ad100003', 'no_violation', 'insufficient_evidence') ->> 'status', 'dismissed', 'resolve the message report');
RESET ROLE;
UPDATE public.content_reports SET evidence_purge_after = now() - interval '1 second' WHERE id = '00000000-0000-4000-8000-0000ad100003';
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_reopen_report('00000000-0000-4000-8000-0000ad100003', 'new_information') $$,
  'PT409', 'retention_expired', 'reopen refused once the retention date has passed');
RESET ROLE;
UPDATE public.content_reports SET evidence = NULL WHERE id = '00000000-0000-4000-8000-0000ad100003';
UPDATE public.content_reports SET evidence_purge_after = now() + interval '1 day' WHERE id = '00000000-0000-4000-8000-0000ad100003';
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_reopen_report('00000000-0000-4000-8000-0000ad100003', 'new_information') $$,
  'PT409', 'evidence_unavailable', 'reopen refused once the evidence is purged');
SELECT ok((SELECT g -> 'evidence' = 'null'::jsonb AND g #>> '{report,evidence_purged_at}' IS NOT NULL
           FROM public.admin_get_report('00000000-0000-4000-8000-0000ad100003') g), 'detail shows purged evidence as purged');

-- ── 8. Audit trail cannot be rewritten ──────────────────────────────────
RESET ROLE;
SELECT throws_ok($$ UPDATE public.moderation_actions SET note = 'rewritten' $$, '42501', 'moderation_actions_append_only', 'elevated: notes cannot be rewritten');
SELECT throws_ok($$ UPDATE public.moderation_actions SET created_at = now() - interval '1 year' $$, '42501', 'moderation_actions_append_only', 'elevated: times cannot be rewritten');
SELECT throws_ok($$ UPDATE public.moderation_actions SET admin_id = '00000000-0000-4000-8000-0000ad000002' WHERE admin_id = '00000000-0000-4000-8000-0000ad000001' $$,
  '42501', 'moderation_actions_append_only', 'elevated: the actor cannot be reassigned');
SELECT throws_ok($$ DELETE FROM public.moderation_actions $$, '42501', 'moderation_actions_append_only', 'elevated: history cannot be deleted');
SELECT throws_ok($$ TRUNCATE public.moderation_actions $$, '42501', 'moderation_actions_append_only', 'elevated: history cannot be truncated');
SELECT pg_temp.logout();
SELECT throws_ok($$ INSERT INTO public.moderation_actions (admin_id, action, target_type, target_id) VALUES ('00000000-0000-4000-8000-0000ad000001', 'claim', 'post', gen_random_uuid()) $$,
  '42501', 'moderation_action_forbidden', 'elevated: no rows without an admin session');
SELECT pg_temp.login('00000000-0000-4000-8000-0000ad000003');
SELECT throws_ok($$ INSERT INTO public.moderation_actions (admin_id, action, target_type, target_id) VALUES ('00000000-0000-4000-8000-0000ad000003', 'claim', 'post', gen_random_uuid()) $$,
  '42501', 'moderation_action_forbidden', 'elevated: no rows in a non-admin''s name');
SELECT pg_temp.login('00000000-0000-4000-8000-0000ad000001');
SELECT throws_ok($$ INSERT INTO public.moderation_actions (admin_id, action, target_type, target_id) VALUES ('00000000-0000-4000-8000-0000ad000002', 'claim', 'post', gen_random_uuid()) $$,
  '42501', 'moderation_action_forbidden', 'elevated: no rows in another admin''s name');
INSERT INTO public.moderation_actions (admin_id, action, target_type, target_id, created_at)
  VALUES ('00000000-0000-4000-8000-0000ad000001', 'claim', 'post', '00000000-0000-4000-8000-0000ad2fffff', '2000-01-01');
SELECT ok((SELECT created_at >= now() FROM public.moderation_actions WHERE target_id = '00000000-0000-4000-8000-0000ad2fffff'), 'audit times cannot be backdated');
SELECT pg_temp.logout();
SET LOCAL ROLE service_role;
SELECT ok((SELECT count(*) FROM public.moderation_actions) > 0, 'the service role can read the audit trail');
SELECT throws_ok($$ INSERT INTO public.moderation_actions (admin_id, action, target_type, target_id) VALUES ('00000000-0000-4000-8000-0000ad000001', 'claim', 'post', gen_random_uuid()) $$,
  '42501', NULL, 'service role: cannot insert audit rows');
SELECT throws_ok($$ UPDATE public.moderation_actions SET note = 'x' $$, '42501', NULL, 'service role: cannot update audit rows');
SELECT throws_ok($$ DELETE FROM public.moderation_actions $$, '42501', NULL, 'service role: cannot delete audit rows');
SELECT throws_ok($$ SELECT public.admin_list_reports() $$, '42501', NULL, 'service role: cannot call admin functions');
RESET ROLE;
SELECT throws_ok($$ DELETE FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000ad100001' $$, '23503', NULL,
  'a report with audit history cannot be deleted');

-- ── 9. No writes to collector content ───────────────────────────────────
SELECT is((SELECT md5(
  COALESCE((SELECT string_agg(p::text, '|' ORDER BY p.id) FROM public.posts p WHERE p.user_id = '00000000-0000-4000-8000-0000ad000006'), '') ||
  COALESCE((SELECT string_agg(m::text, '|' ORDER BY m.id) FROM public.messages m WHERE m.conversation_id = '00000000-0000-4000-8000-0000ad400001'), '') ||
  COALESCE((SELECT string_agg(f::text, '|' ORDER BY f.id) FROM public.profiles f WHERE f.id IN ('00000000-0000-4000-8000-0000ad000006', '00000000-0000-4000-8000-0000ad000008')), ''))),
  (SELECT h FROM ugc_before), 'claims, resolutions and reopens changed no posts, messages or profiles');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN md_fns t ON t.fn = p.oid
           WHERE p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+public\.(?!content_reports|moderation_actions)'), 0,
  'admin functions write only content_reports (and the audit trail via its helper)');

-- ── 10. Account deletion ────────────────────────────────────────────────
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000ad000002';
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE admin_id IS NULL AND report_id IN
           ('00000000-0000-4000-8000-0000ad100001', '00000000-0000-4000-8000-0000ad100006')), 3,
  'deleting an admin keeps their audit rows, with the actor anonymised');
SELECT ok((SELECT status = 'reviewing' AND claimed_by IS NULL AND claimed_at IS NOT NULL FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000ad100006'),
  'a deleted admin''s claim becomes an unowned claim');
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000ad000006';
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000ad000004';
SELECT ok((SELECT bool_and(target_owner_id IS NULL) FROM public.moderation_actions WHERE report_id IN
           ('00000000-0000-4000-8000-0000ad100001', '00000000-0000-4000-8000-0000ad100002', '00000000-0000-4000-8000-0000ad100003', '00000000-0000-4000-8000-0000ad100004'))
      AND (SELECT count(*) FROM public.moderation_actions WHERE report_id = '00000000-0000-4000-8000-0000ad100001') = 4,
  'deleting the reported account keeps the audit rows, owner anonymised');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ad000001');
SELECT ok((SELECT g -> 'owner' = '{"present": false, "account_state": "deleted"}'::jsonb AND g #>> '{evidence,username}' = 'md_owner'
             AND g -> 'reporter' = '{"present": true}'::jsonb
           FROM public.admin_get_report('00000000-0000-4000-8000-0000ad100005') g),
  'detail after the reported account is deleted: owner gone, evidence kept');
SELECT ok((SELECT g -> 'reporter' = '{"present": false}'::jsonb AND g #> '{history,1,admin}' = 'null'::jsonb
           FROM public.admin_get_report('00000000-0000-4000-8000-0000ad100001') g),
  'detail after reporter and admin deletion: reporter gone, deleted admin shown as null');
SELECT is(public.admin_resolve_report('00000000-0000-4000-8000-0000ad100005', 'administrative_closure', 'account_deleted') ->> 'status', 'dismissed',
  'account_deleted closes a report whose account is gone');
SELECT ok((public.admin_claim_report('00000000-0000-4000-8000-0000ad100006') ->> 'changed')::boolean,
  'another admin can take over the deleted admin''s claim');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
