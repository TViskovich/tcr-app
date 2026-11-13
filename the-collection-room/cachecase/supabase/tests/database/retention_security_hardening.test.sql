-- pgTAP test for 20261124120000_retention_security_hardening.sql (Phase 2B M4 step 4A).
-- Run against a LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.
-- "Executor" steps (inserting purge claims) are performed as the database
-- owner, standing in for the future approved executor: no API role can.

BEGIN;
SELECT plan(84);

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
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid), pg_temp.logout() TO authenticated, service_role;
CREATE FUNCTION pg_temp.claim(p_kind text, p_id uuid, p_path text DEFAULT NULL,
                              p_prep uuid DEFAULT '00000000-0000-4000-8000-0000e5000011',
                              p_appr uuid DEFAULT '00000000-0000-4000-8000-0000e5000012',
                              p_lease interval DEFAULT interval '2 minutes') RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO private.retention_purge_claims (subject_kind, subject_id, object_bucket, object_path, prepared_by, approved_by, lease_expires_at)
  VALUES (p_kind, p_id, CASE WHEN p_path IS NOT NULL THEN 'moderation-quarantine' END, p_path, p_prep, p_appr, clock_timestamp() + p_lease)
  RETURNING id $$;
CREATE FUNCTION pg_temp.st(p uuid) RETURNS text LANGUAGE sql AS $$
  SELECT c.status || ':' || array_to_string(c.blockers, '+') FROM private.retention_candidates() c WHERE c.record_id = p $$;

-- ── 1. Privilege boundaries ─────────────────────────────────────────────
SELECT is((SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
            WHERE has_table_privilege('service_role', 'public.content_reports', p)), 'SELECT',
  'G2: the service role can only read reports');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
            WHERE has_table_privilege(r, 'public.content_reports', 'INSERT,UPDATE,DELETE,TRUNCATE')), 0, 'no API role can write reports directly');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
            WHERE has_table_privilege(r, 'private.retention_purge_claims', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')), 0,
  'no API role can read or write purge claims');
-- 20261125120000: exactly the two two-admin executor entry points create
-- claims, each behind require_admin, pinned, and closed to the service role.
SELECT is((SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prosrc ILIKE '%retention_purge_claims%'
              AND p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%'
              AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')),
  (SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prosrc ILIKE '%retention_purge_claims%'),
  'only admin-gated, pinned executor RPCs (no service role) touch claims');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'private'
             AND p.proname IN ('orphaned_account_hold_exists', 'report_evidence_purge_blockers', 'quarantine_copy_purge_blockers',
                               'retention_purge_claims_guard', 'content_reports_guard_update', 'storage_held_write_guard')
             AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('service_role', p.oid, 'EXECUTE'))), 0, 'new and changed helpers: no API role');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.content_reports'::regclass AND tgname = 'content_reports_no_truncate')
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'private.retention_purge_claims'::regclass AND tgname = 'retention_purge_claims_history')
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'retention_purge_claims_one_open'), 'truncate, claim history and one-open-claim guards exist');
SELECT is((SELECT count(*)::int FROM private.retention_policy_conformance() WHERE NOT conforms), 0, 'policy conformance still holds');
SELECT is((SELECT count(*)::int FROM cron.job WHERE active), 0, 'no scheduled job is active');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- C, D collectors; A1, A2, A3 admins; X a plain collector.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000e5000001', 'rs-c@example.invalid', '{"username":"rs_c"}'),
  ('00000000-0000-4000-8000-0000e5000002', 'rs-d@example.invalid', '{"username":"rs_d"}'),
  ('00000000-0000-4000-8000-0000e5000003', 'rs-x@example.invalid', '{"username":"rs_x"}'),
  ('00000000-0000-4000-8000-0000e5000011', 'rs-a1@example.invalid', '{"username":"rs_a1"}'),
  ('00000000-0000-4000-8000-0000e5000012', 'rs-a2@example.invalid', '{"username":"rs_a2"}'),
  ('00000000-0000-4000-8000-0000e5000013', 'rs-a3@example.invalid', '{"username":"rs_a3"}');
INSERT INTO public.admin_users (user_id) VALUES
  ('00000000-0000-4000-8000-0000e5000011'), ('00000000-0000-4000-8000-0000e5000012'), ('00000000-0000-4000-8000-0000e5000013');
-- 20261129120000: purge privileges are granted by an operator, each by a different admin.
SELECT private.grant_admin_privilege(g.id, p, ('00000000-0000-4000-8000-0000e50000' || CASE g.x WHEN '11' THEN '12' ELSE '11' END)::uuid, 'test fixture')
  FROM (SELECT ('00000000-0000-4000-8000-0000e50000' || x)::uuid AS id, x FROM unnest(ARRAY['11', '12', '13']) x) g, unnest(ARRAY['retention_purge_preparer', 'retention_purge_approver']) p;
SET LOCAL session_replication_role = replica;
-- Reports: 01–05 resolved & due about C; 06 child safety; 07 open; 08 not due;
-- 09, 10 owner erased by an account deletion (target_owner_id NULL); 11 about D.
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence, status,
                                    created_at, reviewed_at, evidence_purge_after, resolution, resolution_reason)
SELECT ('00000000-0000-4000-8000-0000e51000' || lpad(n::text, 2, '0'))::uuid, '00000000-0000-4000-8000-0000e5000003', 'post', gen_random_uuid(),
       CASE WHEN n IN (9, 10) THEN NULL WHEN n = 11 THEN '00000000-0000-4000-8000-0000e5000002'::uuid ELSE '00000000-0000-4000-8000-0000e5000001'::uuid END,
       CASE WHEN n = 6 THEN 'child_safety' ELSE 'spam' END, '{"text":"rs evidence"}',
       CASE WHEN n = 7 THEN 'open' ELSE 'dismissed' END, now() - interval '120 days',
       CASE WHEN n = 7 THEN NULL ELSE now() - interval '100 days' END,
       CASE WHEN n = 7 THEN NULL WHEN n = 8 THEN now() + interval '30 days' ELSE now() - interval '10 days' END,
       CASE WHEN n = 7 THEN NULL ELSE 'no_violation' END, CASE WHEN n = 7 THEN NULL ELSE 'within_guidelines' END
  FROM generate_series(1, 11) n;
-- Quarantine jobs (all past retain_until unless noted), each with its object:
--   01, 02, 03 restored, C   04 child safety, C   05 restored, D (held below)
--   06 quarantined/retain, C   07 copied (worker may still overwrite)
INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id,
                                      source_sha256, quarantine_sha256, quarantine_path, state, desired, child_safety, legal_hold,
                                      retain_until, source_removed_at)
SELECT ('00000000-0000-4000-8000-0000e53000' || lpad(n::text, 2, '0'))::uuid, 'avatars', 'rs/src' || n || '.jpg',
       CASE WHEN n = 5 THEN '00000000-0000-4000-8000-0000e5000002'::uuid ELSE '00000000-0000-4000-8000-0000e5000001'::uuid END,
       'avatar', 'profile', '00000000-0000-4000-8000-0000e5000001',
       CASE WHEN n = 7 THEN NULL ELSE repeat('a', 64) END, CASE WHEN n = 7 THEN NULL ELSE repeat('a', 64) END,
       'q/00000000-0000-4000-8000-0000e54000' || lpad(n::text, 2, '0') || '/original',
       CASE WHEN n = 6 THEN 'quarantined' WHEN n = 7 THEN 'copied' ELSE 'restored' END,
       CASE WHEN n = 6 THEN 'retain' WHEN n = 7 THEN 'quarantine' ELSE 'restore' END,
       n = 4, n = 4, CASE WHEN n IN (4, 7) THEN NULL ELSE now() - interval '5 days' END,
       CASE WHEN n = 7 THEN NULL ELSE now() - interval '100 days' END
  FROM generate_series(1, 7) n;
INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'moderation-quarantine', 'q/00000000-0000-4000-8000-0000e54000' || lpad(n::text, 2, '0') || '/original', '{"size":1}'::jsonb
  FROM generate_series(1, 7) n;
INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES
  ('avatars', '00000000-0000-4000-8000-0000e5000002/d.jpg', '00000000-0000-4000-8000-0000e5000002'),
  ('moderation-quarantine', 'q/00000000-0000-4000-8000-0000e54000ff/original', NULL);   -- an object no job owns
SET LOCAL session_replication_role = origin;

-- ── 2. G1/G2: report evidence and report records ────────────────────────
SET LOCAL ROLE service_role;
SELECT throws_ok($$ UPDATE public.content_reports SET evidence = NULL WHERE id = '00000000-0000-4000-8000-0000e5100001' $$,
  '42501', NULL, 'G1 before claim: the service role cannot clear due evidence');
SELECT throws_ok($$ DELETE FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000e5100001' $$,
  '42501', NULL, 'G2: the service role cannot delete a report');
SELECT throws_ok($$ TRUNCATE public.content_reports CASCADE $$, '42501', NULL, 'G2: the service role cannot truncate reports');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e5000011');
SELECT throws_ok($$ UPDATE public.content_reports SET evidence = NULL WHERE id = '00000000-0000-4000-8000-0000e5100001' $$,
  '42501', NULL, 'an admin session cannot clear evidence directly');
SELECT throws_ok($$ INSERT INTO private.retention_purge_claims (subject_kind, subject_id, prepared_by, approved_by, lease_expires_at)
                    VALUES ('report_evidence', '00000000-0000-4000-8000-0000e5100001', '00000000-0000-4000-8000-0000e5000011',
                            '00000000-0000-4000-8000-0000e5000012', now() + interval '1 minute') $$,
  '42501', NULL, 'an admin session cannot forge a claim');
RESET ROLE;
SELECT pg_temp.logout();
-- Even the database owner needs a claim (no operator exemption for evidence).
SELECT throws_ok($$ UPDATE public.content_reports SET evidence = NULL WHERE id = '00000000-0000-4000-8000-0000e5100001' $$,
  '42501', 'evidence_purge_claim_required', 'G1: without a claim, nobody clears evidence — not even the owner role');
SELECT throws_ok($$ SET LOCAL ROLE service_role; DELETE FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000e5100008' $$,
  '42501', NULL, 'G2: a SET ROLE session is not the operator exemption');
RESET ROLE;
SELECT lives_ok($$ DELETE FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000e5100011' $$,
  'the existing narrow operator exemption is unchanged (logged in as postgres, no SET ROLE)');
SELECT throws_ok($$ UPDATE public.content_reports SET evidence = '{"x":1}' WHERE id = '00000000-0000-4000-8000-0000e5100001' $$,
  '42501', 'content_report_evidence_immutable', 'evidence can never be rewritten');

-- ── 3. Claim validation ─────────────────────────────────────────────────
SELECT throws_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100001', NULL,
                    '00000000-0000-4000-8000-0000e5000011', '00000000-0000-4000-8000-0000e5000011') $$,
  '42501', 'second_admin_required', 'a claim needs two different admins');
SELECT throws_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100001', NULL,
                    '00000000-0000-4000-8000-0000e5000011', '00000000-0000-4000-8000-0000e5000003') $$,
  '42501', 'claim_admins_invalid', 'both must be admins');
SELECT throws_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100001', NULL,
                    p_lease => interval '10 minutes') $$, '22023', 'invalid_lease', 'leases last at most 5 minutes');
SELECT throws_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100006') $$,
  'PT409', 'claim_subject_not_eligible', 'child-safety evidence cannot be claimed');
SELECT throws_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100007') $$,
  'PT409', 'claim_subject_not_eligible', 'an open report cannot be claimed');
SELECT throws_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100008') $$,
  'PT409', 'claim_subject_not_eligible', 'evidence before its date cannot be claimed');
SELECT throws_ok($$ SELECT pg_temp.claim('report_evidence', gen_random_uuid()) $$,
  'PT409', 'claim_subject_unavailable', 'an unknown report cannot be claimed');

-- ── 4. A valid claim, then a hold or child-safety flag arrives ──────────
SELECT lives_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100002') $$, 'claim on report 02');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e5000013');
SELECT lives_ok($$ SELECT public.admin_place_legal_hold('report', '00000000-0000-4000-8000-0000e5100002', 'litigation', 'late hold', now() + interval '30 days') $$,
  'a hold is placed after the claim');
RESET ROLE;
SELECT pg_temp.logout();
SELECT throws_ok($$ UPDATE public.content_reports SET evidence = NULL WHERE id = '00000000-0000-4000-8000-0000e5100002' $$,
  '42501', 'evidence_not_eligible', 'a hold placed after the claim still wins: the guard re-checks');
SELECT lives_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100003') $$, 'claim on report 03');
INSERT INTO public.moderated_content (target_type, target_id, owner_id, state, reason_code, child_safety, report_id, lifted_at, lift_reason)
  VALUES ('post', gen_random_uuid(), '00000000-0000-4000-8000-0000e5000001', 'hidden', 'child_safety', true,
          '00000000-0000-4000-8000-0000e5100003', now(), 'resolved_in_error');
SELECT throws_ok($$ UPDATE public.content_reports SET evidence = NULL WHERE id = '00000000-0000-4000-8000-0000e5100003' $$,
  '42501', 'evidence_child_safety', 'evidence that became child-safety after the claim is refused');

-- ── 5. Claim scope: subject, transaction, lease, single use ─────────────
SELECT lives_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100004') $$, 'claim on report 04');
SELECT throws_ok($$ UPDATE public.content_reports SET evidence = NULL WHERE id = '00000000-0000-4000-8000-0000e5100005' $$,
  '42501', 'evidence_purge_claim_required', 'a claim for one report does not unlock another');
SELECT throws_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100004') $$,
  '23505', NULL, 'one open claim per subject');
SELECT lives_ok($$ UPDATE public.content_reports SET evidence = NULL WHERE id = '00000000-0000-4000-8000-0000e5100004' $$,
  'with a valid claim, eligible evidence is cleared');
SELECT ok((SELECT evidence IS NULL AND evidence_purged_at IS NOT NULL AND status = 'dismissed' AND details IS NOT DISTINCT FROM details
             AND reason = 'spam' FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000e5100004'),
  'only evidence is cleared; the report record and its metadata remain');
SELECT is((SELECT close_reason FROM private.retention_purge_claims WHERE subject_id = '00000000-0000-4000-8000-0000e5100004'),
  'consumed', 'the claim is consumed');
SELECT ok((SELECT prepared_by = '00000000-0000-4000-8000-0000e5000011' AND approved_by = '00000000-0000-4000-8000-0000e5000012'
             FROM private.retention_purge_claims WHERE subject_id = '00000000-0000-4000-8000-0000e5100004'), 'the claim records both admins');
-- A claim from another (simulated) transaction.
SET LOCAL session_replication_role = replica;
INSERT INTO private.retention_purge_claims (subject_kind, subject_id, prepared_by, approved_by, claimed_xact, claimed_at, lease_expires_at)
VALUES ('report_evidence', '00000000-0000-4000-8000-0000e5100005', '00000000-0000-4000-8000-0000e5000011', '00000000-0000-4000-8000-0000e5000012',
        '1'::xid8, clock_timestamp(), clock_timestamp() + interval '2 minutes');
SET LOCAL session_replication_role = origin;
SELECT throws_ok($$ UPDATE public.content_reports SET evidence = NULL WHERE id = '00000000-0000-4000-8000-0000e5100005' $$,
  '42501', 'evidence_purge_claim_required', 'a claim from another transaction cannot be used');
-- An expired claim.
SET LOCAL session_replication_role = replica;
UPDATE private.retention_purge_claims SET claimed_xact = pg_current_xact_id(), claimed_at = clock_timestamp() - interval '10 minutes',
       lease_expires_at = clock_timestamp() - interval '6 minutes' WHERE subject_id = '00000000-0000-4000-8000-0000e5100005';
SET LOCAL session_replication_role = origin;
SELECT throws_ok($$ UPDATE public.content_reports SET evidence = NULL WHERE id = '00000000-0000-4000-8000-0000e5100005' $$,
  '42501', 'evidence_purge_claim_required', 'an expired claim cannot be used');
SELECT lives_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100005') $$,
  'a new claim closes the expired one first');
SELECT is((SELECT string_agg(close_reason, ',' ORDER BY claimed_at) FROM private.retention_purge_claims WHERE subject_id = '00000000-0000-4000-8000-0000e5100005'),
  'expired', 'the expired claim was closed as expired');

-- Claim history.
SELECT throws_ok($$ UPDATE private.retention_purge_claims SET subject_id = gen_random_uuid() WHERE subject_id = '00000000-0000-4000-8000-0000e5100005' $$,
  '42501', 'retention_purge_claims_append_only', 'claims cannot be redirected');
SELECT throws_ok($$ UPDATE private.retention_purge_claims SET closed_at = NULL, close_reason = NULL WHERE subject_id = '00000000-0000-4000-8000-0000e5100004' $$,
  '42501', 'retention_purge_claims_append_only', 'a consumed claim cannot be reopened');
SELECT throws_ok($$ DELETE FROM private.retention_purge_claims $$, '42501', 'retention_purge_claims_append_only', 'claims cannot be deleted');
SELECT throws_ok($$ TRUNCATE private.retention_purge_claims $$, '42501', 'retention_purge_claims_append_only', 'or truncated');

-- ── 6. G3: the quarantine bucket ────────────────────────────────────────
-- The Storage API deletes as the request's role with this setting on.
SET LOCAL storage.allow_delete_query = 'true';
SET LOCAL ROLE service_role;
SELECT throws_ok($$ DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400001/original' $$,
  '42501', 'quarantine_object_protected', 'G3: no claim → the service role cannot delete a quarantine copy');
SELECT throws_ok($$ DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400004/original' $$,
  '42501', 'quarantine_object_protected', 'G3: child-safety copy cannot be deleted');
SELECT throws_ok($$ DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e54000ff/original' $$,
  '42501', 'quarantine_object_protected', 'G3: an object no job owns cannot be deleted either (fail closed)');
SELECT throws_ok($$ DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' $$,
  '42501', 'quarantine_object_protected', 'G3: a bulk delete of the bucket is refused');
SELECT throws_ok($$ UPDATE storage.objects SET name = 'q/elsewhere/original' WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400001/original' $$,
  '42501', 'quarantine_object_protected', 'a verified copy cannot be moved');
SELECT throws_ok($$ UPDATE storage.objects SET metadata = '{"size":2}' WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400001/original' $$,
  '42501', 'quarantine_object_protected', 'a verified copy cannot be overwritten');
SELECT throws_ok($$ UPDATE storage.objects SET is_delete_marker = true WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400001/original' $$,
  '42501', 'quarantine_object_protected', 'a verified copy cannot be soft-deleted');
SELECT lives_ok($$ UPDATE storage.objects SET last_accessed_at = now() WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400001/original' $$,
  'read bookkeeping still works');
SELECT lives_ok($$ UPDATE storage.objects SET metadata = '{"size":3}' WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400007/original' $$,
  'the worker can still overwrite an unverified (copied) copy');
RESET ROLE;

SELECT throws_ok($$ SELECT pg_temp.claim('quarantine_copy', '00000000-0000-4000-8000-0000e5300004', 'q/00000000-0000-4000-8000-0000e5400004/original') $$,
  'PT409', 'claim_subject_not_eligible', 'child-safety copies cannot be claimed');
SELECT throws_ok($$ SELECT pg_temp.claim('quarantine_copy', '00000000-0000-4000-8000-0000e5300006', 'q/00000000-0000-4000-8000-0000e5400006/original') $$,
  'PT409', 'claim_subject_not_eligible', 'a retained (non-terminal) quarantined job cannot be claimed');
SELECT throws_ok($$ SELECT pg_temp.claim('quarantine_copy', '00000000-0000-4000-8000-0000e5300001', 'q/00000000-0000-4000-8000-0000e5400002/original') $$,
  'PT409', 'claim_subject_unavailable', 'a claim must name the job''s own object');
SELECT throws_ok($$ SELECT pg_temp.claim('quarantine_copy', '00000000-0000-4000-8000-0000e5300001', 'q/../avatars/x') $$,
  'PT409', 'claim_subject_unavailable', 'a traversal path is refused');
SELECT throws_ok($$ SET LOCAL session_replication_role = replica;
                    INSERT INTO private.retention_purge_claims (subject_kind, subject_id, object_bucket, object_path, prepared_by, approved_by, lease_expires_at)
                    VALUES ('quarantine_copy', gen_random_uuid(), 'moderation-quarantine', 'q/../avatars/x',
                            '00000000-0000-4000-8000-0000e5000011', '00000000-0000-4000-8000-0000e5000012', now() + interval '1 minute') $$,
  '23514', NULL, 'claim paths are shape-checked by a constraint even with triggers off');
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e5000013');
SELECT lives_ok($$ SELECT public.admin_place_legal_hold('account', '00000000-0000-4000-8000-0000e5000002', 'law_enforcement_request', 'D', now() + interval '60 days') $$,
  'an account hold on D');
RESET ROLE;
SELECT pg_temp.logout();
SELECT throws_ok($$ SELECT pg_temp.claim('quarantine_copy', '00000000-0000-4000-8000-0000e5300005', 'q/00000000-0000-4000-8000-0000e5400005/original') $$,
  'PT409', 'claim_subject_not_eligible', 'a copy under an account hold cannot be claimed');

-- Valid claim on 01: unrelated paths stay protected, then a late hold wins.
SELECT lives_ok($$ SELECT pg_temp.claim('quarantine_copy', '00000000-0000-4000-8000-0000e5300001', 'q/00000000-0000-4000-8000-0000e5400001/original') $$, 'claim on copy 01');
SET LOCAL ROLE service_role;
SELECT throws_ok($$ DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400002/original' $$,
  '42501', 'quarantine_object_protected', 'the claim does not unlock a different copy');
SELECT throws_ok($$ DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine'
                     AND name IN ('q/00000000-0000-4000-8000-0000e5400001/original', 'q/00000000-0000-4000-8000-0000e5400002/original') $$,
  '42501', 'quarantine_object_protected', 'a multi-object delete including an unclaimed copy fails as a whole');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name LIKE 'q/00000000-0000-4000-8000-0000e54000%'), 8,
  'nothing was deleted by the refused attempts');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e5000013');
SELECT lives_ok($$ SELECT public.admin_place_legal_hold('quarantine_copy', '00000000-0000-4000-8000-0000e5300001', 'litigation', 'late', now() + interval '30 days') $$,
  'a hold on copy 01 after its claim');
RESET ROLE;
SELECT pg_temp.logout();
SET LOCAL ROLE service_role;
SELECT throws_ok($$ DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400001/original' $$,
  '42501', 'quarantine_copy_not_eligible', 'the late hold wins at deletion time');
RESET ROLE;

-- Valid claim on 02: deleted once, then the claim is spent.
SELECT lives_ok($$ SELECT pg_temp.claim('quarantine_copy', '00000000-0000-4000-8000-0000e5300002', 'q/00000000-0000-4000-8000-0000e5400002/original') $$, 'claim on copy 02');
SET LOCAL ROLE service_role;
SELECT lives_ok($$ DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400002/original' $$,
  'with a valid claim, the eligible copy is deleted');
SELECT lives_ok($$ INSERT INTO storage.objects (bucket_id, name) VALUES ('moderation-quarantine', 'q/00000000-0000-4000-8000-0000e5400002/original') $$,
  '(an object reappears at the same path)');
SELECT throws_ok($$ DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400002/original' $$,
  '42501', 'quarantine_object_protected', 'a consumed claim cannot be reused');
RESET ROLE;
SELECT is((SELECT close_reason FROM private.retention_purge_claims WHERE subject_id = '00000000-0000-4000-8000-0000e5300002'), 'consumed', 'claim 02 consumed');

-- Expired claim on 03.
SET LOCAL session_replication_role = replica;
INSERT INTO private.retention_purge_claims (subject_kind, subject_id, object_bucket, object_path, prepared_by, approved_by, claimed_at, lease_expires_at)
VALUES ('quarantine_copy', '00000000-0000-4000-8000-0000e5300003', 'moderation-quarantine', 'q/00000000-0000-4000-8000-0000e5400003/original',
        '00000000-0000-4000-8000-0000e5000011', '00000000-0000-4000-8000-0000e5000012', clock_timestamp() - interval '10 minutes', clock_timestamp() - interval '6 minutes');
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE service_role;
SELECT throws_ok($$ DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = 'q/00000000-0000-4000-8000-0000e5400003/original' $$,
  '42501', 'quarantine_object_protected', 'an expired claim cannot authorise a delete');
-- Unrelated media and source paths keep their existing rules.
SELECT lives_ok($$ DELETE FROM storage.objects WHERE bucket_id = 'avatars' AND name = '00000000-0000-4000-8000-0000e5000002/d.jpg' $$,
  'ordinary (unheld) media outside the quarantine bucket follows its existing rules');
RESET ROLE;
SELECT ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name LIKE 'q/00000000-0000-4000-8000-0000e54000%') = 8,
  'only the one claimed copy was ever removed (and the re-created one remains)');

-- ── 7. G6: owners erased by account deletion ────────────────────────────
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e5100009'), 'eligible:', 'no orphaned hold: a NULL-owner report is eligible');
SET LOCAL session_replication_role = replica;
INSERT INTO private.moderation_legal_holds (subject_kind, subject_id, hold_type, basis_code, basis_note, placed_at, expires_at)
VALUES ('account', gen_random_uuid(), 'ordinary', 'litigation', 'deleted account', now() - interval '1 day', now() + interval '60 days');
SET LOCAL session_replication_role = origin;
SELECT ok(private.orphaned_account_hold_exists(), 'an active hold names an account that no longer exists');
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e5100009'), 'blocked:deleted_owner_hold_ambiguous', 'G6: NULL-owner evidence is now blocked (fail closed)');
SELECT throws_ok($$ SELECT pg_temp.claim('report_evidence', '00000000-0000-4000-8000-0000e5100010') $$,
  'PT409', 'claim_subject_not_eligible', 'G6: and cannot be claimed');
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e5100001'), 'eligible:', 'G6: a report with a known, unheld owner stays eligible');
SET LOCAL session_replication_role = replica;
UPDATE private.moderation_legal_holds SET expires_at = now() - interval '1 second', placed_at = now() - interval '2 days'
 WHERE subject_kind = 'account' AND basis_note = 'deleted account';
SET LOCAL session_replication_role = origin;
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e5100009'), 'eligible:', 'G6: once that hold expires, the report is eligible again');

-- ── 8. Discovery and the guards agree ───────────────────────────────────
SELECT is(pg_temp.st('00000000-0000-4000-8000-0000e5300006'), 'blocked:quarantine_not_terminal', 'discovery: retained quarantined copy blocked');
SELECT ok(pg_temp.st('00000000-0000-4000-8000-0000e5300004') LIKE 'blocked:child_safety%', 'discovery: child-safety copy blocked');
SELECT ok(pg_temp.st('00000000-0000-4000-8000-0000e5100006') LIKE 'blocked:child_safety%', 'discovery: child-safety report blocked');
SELECT is((SELECT count(*)::int FROM private.retention_candidates() c WHERE c.status = 'eligible'
             AND ((c.category = 'report_evidence' AND cardinality(private.report_evidence_purge_blockers(c.record_id)) > 0)
               OR (c.category = 'quarantine_copy' AND cardinality(private.quarantine_copy_purge_blockers(c.record_id)) > 0))), 0,
  'every eligible candidate passes the same blocker check the guards use');

SELECT * FROM finish();
ROLLBACK;
