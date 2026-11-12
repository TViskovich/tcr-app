-- pgTAP test for 20261123120000_moderation_retention_foundation.sql (Phase 2B M4, steps 1–3).
-- Run against a LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(119);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated, anon, service_role;
-- Candidate status / blockers for one record (read as the database owner).
CREATE FUNCTION pg_temp.st(p uuid) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(c.status, ',') FROM private.retention_candidates() c WHERE c.record_id = p $$;
CREATE FUNCTION pg_temp.bl(p uuid) RETURNS text[] LANGUAGE sql AS $$
  SELECT c.blockers FROM private.retention_candidates() c WHERE c.record_id = p LIMIT 1 $$;

-- ── 1. Shape and privileges ─────────────────────────────────────────────
SELECT has_table('private', 'retention_policy', 'retention_policy exists');
SELECT has_table('private', 'moderation_legal_holds', 'moderation_legal_holds exists');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r,
                  unnest(ARRAY['private.retention_policy', 'private.moderation_legal_holds']) t
           WHERE has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')), 0,
  'no API role (not even the service role) can touch the policy or the holds');
SELECT is((SELECT count(*)::int FROM private.retention_policy), 8, 'eight retention policies');
SELECT ok((SELECT status = 'unresolved' AND period IS NULL AND legal_review_required FROM private.retention_policy WHERE key = 'child_safety_evidence'),
  'child-safety retention is recorded as unresolved, with no period');
SELECT ok((SELECT status = 'proposed' AND period = interval '1 year' AND legal_review_required FROM private.retention_policy WHERE key = 'moderation_note'),
  'moderation notes: 1 year, proposed, pending legal review');
SELECT is(private.retention_period('report_evidence_after_resolution'), interval '90 days', 'report evidence period is 90 days');
SELECT throws_ok($$ SELECT private.retention_period('no_such_policy') $$, 'P0001', 'retention_policy_missing', 'unknown policy keys raise');
SELECT is((SELECT count(*)::int FROM private.retention_policy_conformance()), 8, 'eight deadline sites are checked');
SELECT is((SELECT count(*)::int FROM private.retention_policy_conformance() WHERE NOT conforms), 0,
  'every existing deadline literal matches the central policy (no behaviour change)');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE prosrc LIKE '%retention_period(%'
             AND proname IN ('admin_resolve_report', 'admin_remove_content', 'admin_restore_content', 'admin_clear_profile_fields',
                             'end_profile_field_restrictions', 'end_media_holds', 'media_quarantine_advance', 'finalize_account_deletion')), 0,
  'existing trigger and moderation function bodies were not replaced');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY[
             'public.admin_place_legal_hold(text,uuid,text,text,timestamptz,boolean)', 'public.admin_renew_legal_hold(uuid,timestamptz,text)',
             'public.admin_release_legal_hold(uuid,text,text)', 'public.admin_request_legal_hold_release(uuid,text,text)',
             'public.admin_approve_legal_hold_release(uuid,text,boolean)', 'public.admin_list_legal_holds(text,integer,integer)',
             'public.admin_subject_legal_holds(text,uuid)', 'public.admin_retention_candidates(text,text,integer,integer)',
             'public.admin_retention_summary()']::regprocedure[]) f
           JOIN pg_proc p ON p.oid = f
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%'
             AND has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
             AND NOT has_function_privilege('service_role', f, 'EXECUTE')), 9,
  'admin functions: definer, pinned search_path, each calls require_admin, signed-in only');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'private'
             AND p.proname IN ('retention_period', 'retention_policy_conformance', 'moderation_legal_holds_guard', 'report_is_child_safety',
                               'legal_hold_active', 'legal_hold_subject', 'legal_hold_lock', 'close_expired_legal_holds',
                               'legal_hold_view', 'log_legal_hold_action', 'retention_candidates')
             AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('service_role', p.oid, 'EXECUTE'))), 0, 'internal helpers: no API role');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['private.retention_candidates()', 'public.admin_retention_candidates(text,text,integer,integer)',
             'public.admin_retention_summary()', 'private.retention_policy_conformance()']::regprocedure[]) f
           JOIN pg_proc p ON p.oid = f WHERE p.provolatile = 's'), 4,
  'candidate discovery, summary and conformance are STABLE: they cannot write');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'moderation_legal_holds_one_open'), 'one open hold per subject and basis (unique)');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'private.moderation_legal_holds'::regclass
             AND tgname IN ('moderation_legal_holds_history', 'moderation_legal_holds_no_truncate')), 2, 'append-only triggers present');
SELECT is((SELECT count(*)::int FROM cron.job WHERE command ILIKE '%retention%' OR command ILIKE '%legal_hold%' OR command ILIKE '%purge%'), 0,
  'no scheduled purge job');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- C1 evidence owner; C2 reporter; C3 pending deletion; C4 suspended;
-- A1, A2, A3 admins (A3 is also the subject of a report).
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000e4000001', 'rt-c1@example.invalid', '{"username":"rt_c1"}'),
  ('00000000-0000-4000-8000-0000e4000002', 'rt-c2@example.invalid', '{"username":"rt_c2"}'),
  ('00000000-0000-4000-8000-0000e4000003', 'rt-c3@example.invalid', '{"username":"rt_c3"}'),
  ('00000000-0000-4000-8000-0000e4000004', 'rt-c4@example.invalid', '{"username":"rt_c4"}'),
  ('00000000-0000-4000-8000-0000e4000011', 'rt-a1@example.invalid', '{"username":"rt_a1"}'),
  ('00000000-0000-4000-8000-0000e4000012', 'rt-a2@example.invalid', '{"username":"rt_a2"}'),
  ('00000000-0000-4000-8000-0000e4000013', 'rt-a3@example.invalid', '{"username":"rt_a3"}');
INSERT INTO public.admin_users (user_id) VALUES
  ('00000000-0000-4000-8000-0000e4000011'), ('00000000-0000-4000-8000-0000e4000012'), ('00000000-0000-4000-8000-0000e4000013');

-- Historical rows with past dates: inserted with triggers off (fixtures only).
SET LOCAL session_replication_role = replica;
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for) VALUES
  ('00000000-0000-4000-8000-0000e4000003', 'pending_deletion', 'scheduled', now() + interval '10 days');
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence, status,
                                    created_at, reviewed_at, evidence_purge_after, resolution, resolution_reason, moderation_id) VALUES
  -- 01 open, 100 days old
  ('00000000-0000-4000-8000-0000e4100001', '00000000-0000-4000-8000-0000e4000002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e4000001',
   'spam', '{"text":"SECRET-EVIDENCE"}', 'open', now() - interval '100 days', NULL, NULL, NULL, NULL, NULL),
  -- 02 resolved, past its date → eligible
  ('00000000-0000-4000-8000-0000e4100002', '00000000-0000-4000-8000-0000e4000002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e4000001',
   'spam', '{"text":"SECRET-EVIDENCE"}', 'dismissed', now() - interval '120 days', now() - interval '100 days', now() - interval '10 days', 'no_violation', 'within_guidelines', NULL),
  -- 03 resolved, date in the future → not_due
  ('00000000-0000-4000-8000-0000e4100003', '00000000-0000-4000-8000-0000e4000002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e4000001',
   'spam', '{"text":"SECRET-EVIDENCE"}', 'dismissed', now() - interval '70 days', now() - interval '60 days', now() + interval '30 days', 'no_violation', 'within_guidelines', NULL),
  -- 04 child safety, past its date → blocked
  ('00000000-0000-4000-8000-0000e4100004', '00000000-0000-4000-8000-0000e4000002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e4000001',
   'child_safety', '{"text":"SECRET-EVIDENCE"}', 'dismissed', now() - interval '120 days', now() - interval '100 days', now() - interval '10 days', 'no_violation', 'insufficient_evidence', NULL),
  -- 05 actioned with a live restriction
  ('00000000-0000-4000-8000-0000e4100005', '00000000-0000-4000-8000-0000e4000002', 'post', '00000000-0000-4000-8000-0000e4500005', '00000000-0000-4000-8000-0000e4000001',
   'spam', '{"text":"SECRET-EVIDENCE"}', 'actioned', now() - interval '120 days', now() - interval '100 days', now() - interval '10 days', 'content_removed', 'spam', '00000000-0000-4000-8000-0000e4200001'),
  -- 06 resolved, due (holds are placed on it below)
  ('00000000-0000-4000-8000-0000e4100006', '00000000-0000-4000-8000-0000e4000002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e4000002',
   'spam', '{"text":"SECRET-EVIDENCE"}', 'dismissed', now() - interval '120 days', now() - interval '100 days', now() - interval '10 days', 'no_violation', 'within_guidelines', NULL),
  -- 07 evidence already purged
  ('00000000-0000-4000-8000-0000e4100007', '00000000-0000-4000-8000-0000e4000002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e4000001',
   'spam', NULL, 'dismissed', now() - interval '220 days', now() - interval '200 days', now() - interval '110 days', 'no_violation', 'within_guidelines', NULL),
  -- 08 resolved but no date (legacy)
  ('00000000-0000-4000-8000-0000e4100008', '00000000-0000-4000-8000-0000e4000002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e4000001',
   'spam', '{"text":"SECRET-EVIDENCE"}', 'dismissed', now() - interval '120 days', now() - interval '100 days', NULL, 'no_violation', 'within_guidelines', NULL),
  -- 09 about admin A3
  ('00000000-0000-4000-8000-0000e4100009', '00000000-0000-4000-8000-0000e4000002', 'profile', '00000000-0000-4000-8000-0000e4000013', '00000000-0000-4000-8000-0000e4000013',
   'spam', '{"text":"SECRET-EVIDENCE"}', 'dismissed', now() - interval '120 days', now() - interval '100 days', now() - interval '10 days', 'no_violation', 'within_guidelines', NULL),
  -- 10 cited by C4's active suspension
  ('00000000-0000-4000-8000-0000e4100010', '00000000-0000-4000-8000-0000e4000002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e4000004',
   'spam', '{"text":"SECRET-EVIDENCE"}', 'dismissed', now() - interval '120 days', now() - interval '100 days', now() - interval '10 days', 'no_violation', 'within_guidelines', NULL),
  -- 11 about C3 (pending deletion)
  ('00000000-0000-4000-8000-0000e4100011', '00000000-0000-4000-8000-0000e4000002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e4000003',
   'spam', '{"text":"SECRET-EVIDENCE"}', 'dismissed', now() - interval '120 days', now() - interval '100 days', now() - interval '10 days', 'no_violation', 'within_guidelines', NULL),
  -- 12 due, with an expired hold
  ('00000000-0000-4000-8000-0000e4100012', '00000000-0000-4000-8000-0000e4000002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e4000002',
   'spam', '{"text":"SECRET-EVIDENCE"}', 'dismissed', now() - interval '120 days', now() - interval '100 days', now() - interval '10 days', 'no_violation', 'within_guidelines', NULL);
INSERT INTO public.moderated_content (id, target_type, target_id, owner_id, state, reason_code, child_safety, report_id, created_by, lifted_at, lift_reason) VALUES
  ('00000000-0000-4000-8000-0000e4200001', 'post', '00000000-0000-4000-8000-0000e4500005', '00000000-0000-4000-8000-0000e4000001', 'removed', 'spam', false,
   '00000000-0000-4000-8000-0000e4100005', '00000000-0000-4000-8000-0000e4000011', NULL, NULL),
  ('00000000-0000-4000-8000-0000e4200002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e4000001', 'hidden', 'child_safety', true,
   '00000000-0000-4000-8000-0000e4100004', '00000000-0000-4000-8000-0000e4000011', now() - interval '100 days', 'resolved_in_error');
INSERT INTO public.account_suspensions (user_id, reason_code, note, report_id, created_by) VALUES
  ('00000000-0000-4000-8000-0000e4000004', 'spam', 'SECRET-NOTE', '00000000-0000-4000-8000-0000e4100010', '00000000-0000-4000-8000-0000e4000011');
INSERT INTO public.moderated_profile_fields (id, user_id, field, original_value, moderation_id, report_id, created_by, status, ended_at, end_reason) VALUES
  ('00000000-0000-4000-8000-0000e4400001', '00000000-0000-4000-8000-0000e4000001', 'bio', 'SECRET-ORIGINAL', '00000000-0000-4000-8000-0000e4200001',
   '00000000-0000-4000-8000-0000e4100005', '00000000-0000-4000-8000-0000e4000011', 'active', NULL, NULL),
  ('00000000-0000-4000-8000-0000e4400002', '00000000-0000-4000-8000-0000e4000001', 'tagline', 'SECRET-ORIGINAL', '00000000-0000-4000-8000-0000e4200001',
   '00000000-0000-4000-8000-0000e4100002', '00000000-0000-4000-8000-0000e4000011', 'released', now() - interval '100 days', 'owner_may_edit'),
  ('00000000-0000-4000-8000-0000e4400003', '00000000-0000-4000-8000-0000e4000001', 'location', 'SECRET-ORIGINAL', '00000000-0000-4000-8000-0000e4200001',
   '00000000-0000-4000-8000-0000e4100002', '00000000-0000-4000-8000-0000e4000011', 'restored', now() - interval '10 days', 'resolved_in_error'),
  ('00000000-0000-4000-8000-0000e4400004', '00000000-0000-4000-8000-0000e4000001', 'website', 'SECRET-ORIGINAL', '00000000-0000-4000-8000-0000e4200002',
   '00000000-0000-4000-8000-0000e4100004', '00000000-0000-4000-8000-0000e4000011', 'released', now() - interval '100 days', 'owner_may_edit');
INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id,
                                      source_sha256, quarantine_sha256, quarantine_path, state, desired, child_safety, legal_hold,
                                      retain_until, source_removed_at) VALUES
  ('00000000-0000-4000-8000-0000e4300001', 'avatars', 'rt/q1.jpg', '00000000-0000-4000-8000-0000e4000001', 'avatar', 'profile', '00000000-0000-4000-8000-0000e4000001',
   repeat('a', 64), repeat('a', 64), 'rt/q1', 'restored', 'restore', false, false, now() - interval '5 days', now() - interval '100 days'),
  ('00000000-0000-4000-8000-0000e4300002', 'avatars', 'rt/q2.jpg', '00000000-0000-4000-8000-0000e4000001', 'avatar', 'profile', '00000000-0000-4000-8000-0000e4000001',
   repeat('b', 64), repeat('b', 64), 'rt/q2', 'quarantined', 'quarantine', true, true, NULL, now() - interval '100 days'),
  ('00000000-0000-4000-8000-0000e4300003', 'avatars', 'rt/q3.jpg', '00000000-0000-4000-8000-0000e4000001', 'avatar', 'profile', '00000000-0000-4000-8000-0000e4000001',
   repeat('c', 64), repeat('c', 64), 'rt/q3', 'quarantined', 'quarantine', false, false, NULL, now() - interval '100 days'),
  ('00000000-0000-4000-8000-0000e4300004', 'avatars', 'rt/q4.jpg', '00000000-0000-4000-8000-0000e4000001', 'avatar', 'profile', '00000000-0000-4000-8000-0000e4000001',
   NULL, NULL, 'rt/q4', 'copied', 'retain', false, false, now() - interval '5 days', NULL),
  ('00000000-0000-4000-8000-0000e4300005', 'avatars', 'rt/q5.jpg', '00000000-0000-4000-8000-0000e4000001', 'avatar', 'profile', '00000000-0000-4000-8000-0000e4000001',
   NULL, NULL, 'rt/q5', 'cancelled', 'retain', false, false, now() + interval '30 days', NULL);
INSERT INTO private.media_quarantine_holds (quarantine_id, moderation_id) VALUES
  ('00000000-0000-4000-8000-0000e4300003', '00000000-0000-4000-8000-0000e4200001');
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('moderation-quarantine', 'rt/q1'), ('moderation-quarantine', 'rt/q2'), ('moderation-quarantine', 'rt/q3'),
  ('moderation-quarantine', 'rt/q4'), ('moderation-quarantine', 'rt/q5');
-- 12's hold: placed 200 days ago, expired yesterday.
INSERT INTO private.moderation_legal_holds (id, subject_kind, subject_id, subject_owner_id, hold_type, basis_code, basis_note, placed_by, placed_at, expires_at) VALUES
  ('00000000-0000-4000-8000-0000e4600001', 'report', '00000000-0000-4000-8000-0000e4100012', '00000000-0000-4000-8000-0000e4000002', 'ordinary',
   'litigation', 'SECRET-BASIS', '00000000-0000-4000-8000-0000e4000011', now() - interval '200 days', now() - interval '1 day');
SET LOCAL session_replication_role = origin;
CREATE TEMP TABLE counts_before AS SELECT
  (SELECT count(*) FROM public.content_reports WHERE evidence IS NOT NULL) AS ev,
  (SELECT count(*) FROM private.media_quarantine) AS q,
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'moderation-quarantine') AS o,
  (SELECT count(*) FROM public.moderated_profile_fields) AS f,
  (SELECT count(*) FROM public.moderation_actions WHERE note IS NOT NULL) AS n;
GRANT SELECT ON counts_before TO authenticated;

-- ── 2. Authorization and validation ─────────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT public.admin_retention_summary() $$, '42501', NULL, 'signed out: refused');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000001');
SELECT throws_ok($$ SELECT public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100006', 'litigation', 'x', now() + interval '30 days') $$,
  '42501', 'forbidden', 'a collector cannot place a hold');
SELECT throws_ok($$ SELECT public.admin_retention_candidates() $$, '42501', 'forbidden', '…or list candidates');
SELECT throws_ok($$ SELECT public.admin_retention_summary() $$, '42501', 'forbidden', '…or read the summary');
SELECT throws_ok($$ SELECT public.admin_list_legal_holds() $$, '42501', 'forbidden', '…or list holds');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000011');
SELECT throws_ok($$ SELECT public.admin_place_legal_hold('collection', '00000000-0000-4000-8000-0000e4100006', 'litigation', 'x', now() + interval '30 days') $$,
  '22023', 'invalid_subject', 'subject kinds come from a fixed list');
SELECT throws_ok($$ SELECT public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100006', 'felt_like_it', 'x', now() + interval '30 days') $$,
  '22023', 'invalid_basis_code', 'legal bases come from a fixed list');
SELECT throws_ok($$ SELECT public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100006', 'litigation', '  ', now() + interval '30 days') $$,
  '22023', 'basis_note_required', 'a basis note is required');
SELECT throws_ok($$ SELECT public.admin_place_legal_hold('report', gen_random_uuid(), 'litigation', 'x', now() + interval '30 days') $$,
  'PT404', 'not_found', 'unknown subject');
SELECT throws_ok($$ SELECT public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100007', 'litigation', 'x', now() + interval '30 days') $$,
  'PT409', 'evidence_unavailable', 'nothing left to preserve on a purged report');
SELECT throws_ok($$ SELECT public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100006', 'litigation', 'x') $$,
  '22023', 'invalid_expiry', 'an ordinary hold needs an end date');
SELECT throws_ok($$ SELECT public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100006', 'litigation', 'x', now() + interval '2 hours') $$,
  '22023', 'invalid_expiry', '…of at least a day');
SELECT throws_ok($$ SELECT public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100006', 'litigation', 'x', now() + interval '400 days') $$,
  '22023', 'invalid_expiry', '…and at most 1 year');
SELECT throws_ok($$ SELECT public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100004', 'litigation', 'x', now() + interval '30 days') $$,
  '22023', 'invalid_expiry', 'a hold on child-safety evidence cannot carry an end date');

-- ── 3. Ordinary hold: place, duplicate, release by another admin ────────
CREATE TEMP TABLE h (k text PRIMARY KEY, id uuid);
GRANT ALL ON h TO authenticated;
INSERT INTO h SELECT 'r6', (public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100006', 'litigation', 'SECRET-BASIS case 1',
                                                           now() + interval '30 days') ->> 'id')::uuid;
SELECT ok((public.admin_subject_legal_holds('report', '00000000-0000-4000-8000-0000e4100006') ->> 'held')::boolean, 'A1 places an ordinary hold');
SELECT throws_ok($$ SELECT public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100006', 'litigation', 'again', now() + interval '30 days') $$,
  'PT409', 'already_held', 'no duplicate open hold for the same basis');
SELECT is(public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100006', 'regulatory_inquiry', 'second basis', now() + interval '60 days') ->> 'hold_type',
  'ordinary', 'a second hold with a different basis is allowed');
SELECT throws_ok(format($$ SELECT public.admin_release_legal_hold(%L, 'no_longer_required', 'done') $$, (SELECT id FROM h WHERE k = 'r6')),
  '42501', 'second_admin_required', 'the placer cannot release their own hold');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000012');
SELECT throws_ok(format($$ SELECT public.admin_release_legal_hold(%L, 'bored', 'done') $$, (SELECT id FROM h WHERE k = 'r6')),
  '22023', 'invalid_reason_code', 'release reasons come from a fixed list');
SELECT throws_ok(format($$ SELECT public.admin_release_legal_hold(%L, 'no_longer_required', NULL) $$, (SELECT id FROM h WHERE k = 'r6')),
  '22023', 'note_required', 'a release note is required');
SELECT is(public.admin_release_legal_hold((SELECT id FROM h WHERE k = 'r6'), 'no_longer_required', 'case settled') ->> 'state',
  'released', 'another admin (A2) releases it');
SELECT throws_ok(format($$ SELECT public.admin_release_legal_hold(%L, 'no_longer_required', 'again') $$, (SELECT id FROM h WHERE k = 'r6')),
  'PT409', 'hold_not_active', 'a released hold cannot be released again');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE action = 'place_legal_hold'
             AND metadata ->> 'subject_id' = '00000000-0000-4000-8000-0000e4100006'
             AND report_id = '00000000-0000-4000-8000-0000e4100006' AND admin_id = '00000000-0000-4000-8000-0000e4000011'), 2,
  'each placement (two bases) is audited with admin and report');
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE action = 'release_legal_hold'
             AND metadata ->> 'hold_id' = (SELECT id FROM h WHERE k = 'r6')::text
             AND admin_id = '00000000-0000-4000-8000-0000e4000012' AND reason_code = 'no_longer_required'), 1,
  'release is audited with the releasing admin and reason');

-- ── 4. Conflict of interest ─────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000011');
INSERT INTO h SELECT 'r9', (public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100009', 'internal_investigation', 'about A3',
                                                           now() + interval '30 days') ->> 'id')::uuid;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000013');
SELECT throws_ok(format($$ SELECT public.admin_release_legal_hold(%L, 'no_longer_required', 'mine') $$, (SELECT id FROM h WHERE k = 'r9')),
  '42501', 'conflict_of_interest', 'an admin cannot release a hold on their own evidence');

-- ── 5. Renewal ──────────────────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000011');
SELECT throws_ok(format($$ SELECT public.admin_renew_legal_hold(%L, now() + interval '10 days', 'shorter') $$, (SELECT id FROM h WHERE k = 'r9')),
  '22023', 'invalid_expiry', 'renewal must extend the hold');
SELECT throws_ok(format($$ SELECT public.admin_renew_legal_hold(%L, now() + interval '400 days', 'too long') $$, (SELECT id FROM h WHERE k = 'r9')),
  '22023', 'invalid_expiry', 'renewal is capped at 1 year from now');
SELECT throws_ok(format($$ SELECT public.admin_renew_legal_hold(%L, now() + interval '90 days', NULL) $$, (SELECT id FROM h WHERE k = 'r9')),
  '22023', 'basis_note_required', 'renewal needs a note');
INSERT INTO h SELECT 'r9b', (public.admin_renew_legal_hold((SELECT id FROM h WHERE k = 'r9'), now() + interval '300 days', 'still needed') ->> 'id')::uuid;
SELECT is((SELECT x ->> 'renewed_from' FROM public.admin_renew_legal_hold((SELECT id FROM h WHERE k = 'r9b'), now() + interval '360 days', 'renew again') x),
  (SELECT id FROM h WHERE k = 'r9b')::text, 'renewal creates a new row linked to the previous one');
SELECT throws_ok(format($$ SELECT public.admin_renew_legal_hold(%L, now() + interval '100 days', 'old') $$, (SELECT id FROM h WHERE k = 'r9')),
  'PT409', 'hold_not_active', 'a renewed (closed) hold cannot be renewed again');
RESET ROLE;
SELECT is((SELECT release_reason || ':' || (released_by = '00000000-0000-4000-8000-0000e4000011')::text FROM private.moderation_legal_holds WHERE id = (SELECT id FROM h WHERE k = 'r9')),
  'renewed:true', 'the previous hold is closed as renewed');
SELECT is((SELECT count(*)::int FROM private.moderation_legal_holds WHERE subject_id = '00000000-0000-4000-8000-0000e4100009' AND released_at IS NULL), 1,
  'exactly one open hold remains after two renewals');
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE action = 'renew_legal_hold' AND metadata ->> 'subject_id' = '00000000-0000-4000-8000-0000e4100009'), 2,
  'each renewal is audited');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000011');
SELECT throws_ok(format($$ SELECT public.admin_release_legal_hold(id, 'no_longer_required', 'x') FROM private.moderation_legal_holds
                           WHERE subject_id = %L AND released_at IS NULL $$, '00000000-0000-4000-8000-0000e4100009'),
  '42501', NULL, 'collectors and admins cannot read the hold table directly');

-- ── 6. Child-safety holds ───────────────────────────────────────────────
INSERT INTO h SELECT 'cs4', (public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100004', 'law_enforcement_request', 'preserve') ->> 'id')::uuid;
SELECT is((SELECT x ->> 'hold_type' FROM public.admin_subject_legal_holds('report', '00000000-0000-4000-8000-0000e4100004') s,
             jsonb_array_elements(s -> 'holds') x LIMIT 1), 'child_safety', 'child-safety evidence always gets a child-safety hold');
SELECT is(public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100003', 'child_safety_preservation', 'cs basis') ->> 'hold_type',
  'child_safety', 'the child_safety_preservation basis makes a child-safety hold');
SELECT is(public.admin_place_legal_hold('account', '00000000-0000-4000-8000-0000e4000004', 'law_enforcement_request', 'flagged', NULL, true) ->> 'hold_type',
  'child_safety', 'an admin can mark a hold as child safety');
SELECT throws_ok(format($$ SELECT public.admin_release_legal_hold(%L, 'no_longer_required', 'x') $$, (SELECT id FROM h WHERE k = 'cs4')),
  '42501', 'child_safety_release_requires_review', 'a child-safety hold cannot be released directly');
SELECT throws_ok(format($$ SELECT public.admin_renew_legal_hold(%L, now() + interval '30 days', 'x') $$, (SELECT id FROM h WHERE k = 'cs4')),
  '22023', 'child_safety_hold_has_no_expiry', 'child-safety holds are not renewed');
SELECT throws_ok(format($$ SELECT public.admin_approve_legal_hold_release(%L, 'ok', true) $$, (SELECT id FROM h WHERE k = 'cs4')),
  'PT409', 'release_not_requested', 'approval needs a prior request');
SELECT throws_ok(format($$ SELECT public.admin_request_legal_hold_release(%L, 'LR-1', 'x') $$, (SELECT id FROM h WHERE k = 'r9b')),
  '22023', 'not_child_safety_hold', 'ordinary holds use the direct release path');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000012');
SELECT throws_ok(format($$ SELECT public.admin_request_legal_hold_release(%L, '', 'x') $$, (SELECT id FROM h WHERE k = 'cs4')),
  '22023', 'legal_review_reference_required', 'a legal-review reference is required');
SELECT is(public.admin_request_legal_hold_release((SELECT id FROM h WHERE k = 'cs4'), 'LR-2026-014', 'counsel cleared') ->> 'state',
  'release_requested', 'A2 requests release with a legal-review reference');
SELECT throws_ok(format($$ SELECT public.admin_request_legal_hold_release(%L, 'LR-2', 'again') $$, (SELECT id FROM h WHERE k = 'cs4')),
  'PT409', 'release_already_requested', 'one request per hold');
SELECT throws_ok(format($$ SELECT public.admin_approve_legal_hold_release(%L, 'ok', true) $$, (SELECT id FROM h WHERE k = 'cs4')),
  '42501', 'second_admin_required', 'the requester cannot approve');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000011');
SELECT throws_ok(format($$ SELECT public.admin_approve_legal_hold_release(%L, 'ok', true) $$, (SELECT id FROM h WHERE k = 'cs4')),
  '42501', 'second_admin_required', 'the placer cannot approve');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000013');
SELECT throws_ok(format($$ SELECT public.admin_approve_legal_hold_release(%L, 'ok') $$, (SELECT id FROM h WHERE k = 'cs4')),
  '22023', 'child_safety_confirmation_required', 'approval needs explicit confirmation');
SELECT is(public.admin_approve_legal_hold_release((SELECT id FROM h WHERE k = 'cs4'), 'approved after review', true) ->> 'release_reason',
  'legal_review_cleared', 'a third admin approves the release');
RESET ROLE;
SELECT ok(pg_temp.st('00000000-0000-4000-8000-0000e4100004') = 'blocked' AND 'child_safety' = ANY (pg_temp.bl('00000000-0000-4000-8000-0000e4100004')),
  'released child-safety evidence is still never eligible');
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE metadata ->> 'hold_id' = (SELECT id FROM h WHERE k = 'cs4')::text
             AND action IN ('place_legal_hold', 'request_legal_hold_release', 'release_legal_hold')), 3,
  'place, request and approval are each audited');

-- ── 7. Database-level protections (bypassing the functions) ─────────────
SELECT throws_ok(format($$ UPDATE private.moderation_legal_holds SET basis_note = 'rewritten' WHERE id = %L $$, (SELECT id FROM h WHERE k = 'r9b')),
  '42501', 'moderation_legal_holds_append_only', 'history cannot be rewritten');
SELECT throws_ok(format($$ UPDATE private.moderation_legal_holds SET expires_at = now() + interval '5 years' WHERE id = %L $$, (SELECT id FROM h WHERE k = 'r9b')),
  '42501', 'moderation_legal_holds_append_only', 'expiry cannot be edited in place');
SELECT throws_ok(format($$ DELETE FROM private.moderation_legal_holds WHERE id = %L $$, (SELECT id FROM h WHERE k = 'r9b')),
  '42501', 'moderation_legal_holds_append_only', 'holds cannot be deleted');
SELECT throws_ok($$ TRUNCATE private.moderation_legal_holds $$, '42501', 'moderation_legal_holds_append_only', 'or truncated');
SELECT throws_ok($$ INSERT INTO private.moderation_legal_holds (subject_kind, subject_id, hold_type, basis_code, basis_note, expires_at)
                    VALUES ('report', gen_random_uuid(), 'ordinary', 'litigation', 'x', now() + interval '2 years') $$,
  '23514', NULL, 'an ordinary hold over 1 year violates a constraint');
SELECT throws_ok($$ INSERT INTO private.moderation_legal_holds (subject_kind, subject_id, hold_type, basis_code, basis_note, expires_at)
                    VALUES ('report', gen_random_uuid(), 'child_safety', 'litigation', 'x', now() + interval '20 days') $$,
  '23514', NULL, 'a child-safety hold with an expiry violates a constraint');
SELECT throws_ok($$ INSERT INTO private.moderation_legal_holds (subject_kind, subject_id, hold_type, basis_code, basis_note, expires_at)
                    VALUES ('report', gen_random_uuid(), 'ordinary', 'child_safety_preservation', 'x', now() + interval '20 days') $$,
  '23514', NULL, 'child_safety_preservation cannot be an ordinary hold');
SELECT throws_ok($$ INSERT INTO private.moderation_legal_holds (subject_kind, subject_id, hold_type, basis_code, basis_note, expires_at, released_at, release_reason)
                    VALUES ('report', gen_random_uuid(), 'ordinary', 'litigation', 'x', now() + interval '20 days', now(), 'no_longer_required') $$,
  '42501', 'moderation_legal_holds_append_only', 'a hold cannot be inserted already released');
SELECT throws_ok(format($$ UPDATE private.moderation_legal_holds SET released_at = now(), released_by = placed_by, release_reason = 'no_longer_required'
                           WHERE subject_id = %L AND released_at IS NULL $$, '00000000-0000-4000-8000-0000e4100009'),
  '23514', NULL, 'self-release is refused by a constraint, not only by the function');
SELECT throws_ok(format($$ INSERT INTO private.moderation_legal_holds (subject_kind, subject_id, hold_type, basis_code, basis_note, expires_at)
                           VALUES ('report', %L, 'ordinary', 'internal_investigation', 'dup', now() + interval '20 days') $$, '00000000-0000-4000-8000-0000e4100009'),
  '23505', NULL, 'a duplicate open hold violates the unique index');
SELECT throws_ok($$ UPDATE private.moderation_legal_holds SET release_requested_at = now(), release_requested_by = placed_by,
                           release_review_ref = 'LR', release_request_note = 'x'
                    WHERE subject_id = '00000000-0000-4000-8000-0000e4100009' AND released_at IS NULL $$,
  '23514', NULL, 'release requests exist only for child-safety holds');

-- ── 8. Expired holds ────────────────────────────────────────────────────
SELECT ok(NOT private.legal_hold_active('report', '00000000-0000-4000-8000-0000e4100012'), 'an expired hold is not active (no scheduler needed)');
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e4100012'), 'eligible', 'an expired hold no longer blocks: normal retention applies');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000012');
SELECT is((public.admin_retention_summary() -> 'legal_holds' ->> 'expired_not_closed')::int, 1, 'the summary shows the lapsed hold');
SELECT throws_ok($$ SELECT public.admin_release_legal_hold('00000000-0000-4000-8000-0000e4600001', 'no_longer_required', 'x') $$,
  'PT409', 'hold_not_active', 'an expired hold cannot be released');
SELECT throws_ok($$ SELECT public.admin_renew_legal_hold('00000000-0000-4000-8000-0000e4600001', now() + interval '30 days', 'x') $$,
  'PT409', 'hold_not_active', 'an expired hold cannot be renewed (the lapse stays visible)');
SELECT is(public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100012', 'litigation', 'new hold', now() + interval '30 days') ->> 'state',
  'active', 'a new hold with the same basis can be placed');
RESET ROLE;
SELECT is((SELECT release_reason || ':' || (released_at = expires_at)::text FROM private.moderation_legal_holds WHERE id = '00000000-0000-4000-8000-0000e4600001'),
  'expired:true', 'the lapsed hold was closed as expired at its expiry time');
SELECT ok(pg_temp.st('00000000-0000-4000-8000-0000e4100012') = 'blocked' AND 'legal_hold' = ANY (pg_temp.bl('00000000-0000-4000-8000-0000e4100012')),
  'the new hold blocks it again');

-- ── 9. Candidate discovery ──────────────────────────────────────────────
SELECT ok(pg_temp.st('00000000-0000-4000-8000-0000e4100001') = 'blocked' AND 'open_report' = ANY (pg_temp.bl('00000000-0000-4000-8000-0000e4100001')),
  'report: open reports keep their evidence');
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e4100002'), 'eligible', 'report: resolved and past its date → eligible');
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e4100003'), 'blocked', 'report: a child-safety-preservation hold blocks an otherwise not-due report');
SELECT ok(pg_temp.st('00000000-0000-4000-8000-0000e4100005') = 'blocked' AND 'live_restriction' = ANY (pg_temp.bl('00000000-0000-4000-8000-0000e4100005')),
  'report: a live restriction blocks it');
SELECT ok(pg_temp.st('00000000-0000-4000-8000-0000e4100006') = 'blocked' AND pg_temp.bl('00000000-0000-4000-8000-0000e4100006') = ARRAY['legal_hold'],
  'report: the remaining open hold blocks it');
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e4100007'), NULL, 'report: purged evidence is not listed');
SELECT is(pg_temp.bl('00000000-0000-4000-8000-0000e4100008'), ARRAY['no_retention_date'], 'report: resolved without a date → blocked, never assumed');
SELECT ok('live_suspension' = ANY (pg_temp.bl('00000000-0000-4000-8000-0000e4100010')), 'report: an active suspension citing it blocks it');
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e4100011'), 'eligible', 'report: an owner pending deletion does not by itself block');
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e4300001'), 'eligible', 'quarantine: restored copy past retain_until → eligible');
SELECT ok(pg_temp.bl('00000000-0000-4000-8000-0000e4300002') @> ARRAY['child_safety', 'quarantine_legal_hold'], 'quarantine: child-safety legal-hold copy is blocked');
SELECT ok(pg_temp.bl('00000000-0000-4000-8000-0000e4300003') @> ARRAY['live_restriction', 'no_retention_date'], 'quarantine: a copy still held by a restriction is blocked');
SELECT ok(pg_temp.bl('00000000-0000-4000-8000-0000e4300004') @> ARRAY['in_progress'], 'quarantine: a job in progress is blocked');
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e4300005'), 'not_due', 'quarantine: retain_until in the future → not_due');
SELECT ok('live_restriction' = ANY (pg_temp.bl('00000000-0000-4000-8000-0000e4400001')), 'profile field: an active restriction is blocked');
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e4400002'), 'eligible', 'profile field: ended 100 days ago → eligible (provisional 90 days)');
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e4400003'), 'not_due', 'profile field: ended 10 days ago → not_due');
SELECT ok('child_safety' = ANY (pg_temp.bl('00000000-0000-4000-8000-0000e4400004')), 'profile field: child-safety original is blocked');
SELECT is((SELECT count(*)::int FROM private.retention_candidates() WHERE category = 'moderation_note' AND status <> 'blocked'), 0,
  'notes: none is eligible while the note policy is pending legal review');
SELECT is((SELECT count(*)::int FROM private.retention_candidates() WHERE category = 'moderation_note'
             AND NOT ('policy_pending_legal_review' = ANY (blockers))), 0, 'notes: every note carries the pending-review blocker');
SELECT is((SELECT count(*)::int FROM private.retention_candidates() WHERE child_safety AND status <> 'blocked'), 0,
  'no child-safety record of any category is ever eligible');

-- Account hold covers all of the owner's evidence.
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000012');
SELECT is(public.admin_place_legal_hold('account', '00000000-0000-4000-8000-0000e4000001', 'law_enforcement_request', 'subpoena', now() + interval '90 days') ->> 'hold_type',
  'ordinary', 'an account hold is placed');
SELECT is(public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e4100011', 'litigation', 'pending deletion', now() + interval '90 days') ->> 'owner_pending_deletion',
  'true', 'the hold view flags an owner who is pending deletion');
RESET ROLE;
SELECT ok('legal_hold' = ANY (pg_temp.bl('00000000-0000-4000-8000-0000e4100002')) AND 'legal_hold' = ANY (pg_temp.bl('00000000-0000-4000-8000-0000e4300001'))
      AND 'legal_hold' = ANY (pg_temp.bl('00000000-0000-4000-8000-0000e4400002')),
  'the account hold blocks the owner''s reports, quarantine copies and profile originals');

-- Admin RPC output and leakage.
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e4000011');
SELECT throws_ok($$ SELECT public.admin_retention_candidates('everything') $$, '22023', 'invalid_argument', 'unknown category refused');
SELECT throws_ok($$ SELECT public.admin_retention_candidates(NULL, NULL, 500) $$, '22023', 'invalid_argument', 'page size is bounded');
SELECT ok(public.admin_retention_candidates('quarantine_copy', 'blocked') @> jsonb_build_array(jsonb_build_object('record_id', '00000000-0000-4000-8000-0000e4300005')),
  'filters by category and status');
SELECT ok(public.admin_retention_candidates(NULL, NULL, 200)::text !~ 'SECRET-(EVIDENCE|ORIGINAL|NOTE|BASIS)'
      AND public.admin_retention_summary()::text !~ 'SECRET-(EVIDENCE|ORIGINAL|NOTE|BASIS)',
  'candidates and summary never contain evidence, originals, notes or hold bases');
SELECT ok((public.admin_retention_summary() -> 'open_reports' ->> 'older_than_90_days')::int >= 1, 'summary: open-report ageing (D3)');
SELECT ok((public.admin_retention_summary() -> 'legal_holds' ->> 'on_accounts_pending_deletion')::int >= 1, 'summary: holds on accounts pending deletion (D4)');
SELECT ok((public.admin_retention_summary() -> 'policy_conformance' ->> 'ok')::boolean, 'summary: policy conformance ok');
SELECT is((SELECT count(*)::int FROM jsonb_array_elements(public.admin_list_legal_holds('release_requested'))), 0, 'list: no pending release requests left');
RESET ROLE;
SELECT ok((SELECT ev = (SELECT count(*) FROM public.content_reports WHERE evidence IS NOT NULL)
              AND q = (SELECT count(*) FROM private.media_quarantine)
              AND o = (SELECT count(*) FROM storage.objects WHERE bucket_id = 'moderation-quarantine')
              AND f = (SELECT count(*) FROM public.moderated_profile_fields) FROM counts_before),
  'discovery purged nothing: evidence, quarantine rows, objects and originals are unchanged');

SELECT * FROM finish();
ROLLBACK;
