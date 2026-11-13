-- pgTAP test for 20261129120000_purge_privileges_and_erasure_evidence.sql (Phase 2B M4 step 5D).
-- DESTRUCTIVE (synthetic fixtures only, inside one rolled-back transaction):
-- runs ONLY on an isolated disposable local stack, and only when the session
-- says so:  PGOPTIONS='-c cachecase.isolated_stack=on' (or SET it first).

BEGIN;
DO $$ BEGIN
  IF current_setting('cachecase.isolated_stack', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'refusing: destructive purge-privilege tests run only on an isolated stack (cachecase.isolated_stack=on)';
  END IF;
END $$;
SELECT plan(74);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated, service_role;
-- 01 owner, 02 collector, 11 A1, 12 A2, 13 A3, 14 inactive admin, 16 A4 (admin without purge privileges).
CREATE FUNCTION pg_temp.u(x text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e80000' || x)::uuid $$;
CREATE FUNCTION pg_temp.r(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e81000' || lpad(n::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.q(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e83000' || lpad(n::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.qp(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'q/00000000-0000-4000-8000-0000e84000' || lpad(n::text, 2, '0') || '/original' $$;
GRANT EXECUTE ON FUNCTION pg_temp.u(text), pg_temp.r(int), pg_temp.q(int), pg_temp.qp(int) TO authenticated, service_role;
CREATE FUNCTION pg_temp.storage_delete(p_path text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN   -- what the Storage API does for a service-role delete of one object
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = p_path;
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.storage_delete(text) TO service_role;
CREATE FUNCTION pg_temp.grant(p_user text, p_priv text, p_by text) RETURNS uuid LANGUAGE sql AS $$
  SELECT private.grant_admin_privilege(pg_temp.u(p_user), 'retention_purge_' || p_priv, pg_temp.u(p_by), 'pgTAP fixture grant') $$;
CREATE FUNCTION pg_temp.revoke(p_user text, p_priv text, p_by text) RETURNS boolean LANGUAGE sql AS $$
  SELECT private.revoke_admin_privilege(pg_temp.u(p_user), 'retention_purge_' || p_priv, pg_temp.u(p_by), 'pgTAP fixture revoke') $$;
-- Item and run lookups for admin sessions (the tables are private).
CREATE FUNCTION pg_temp.iid(p_subject uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id FROM private.retention_purge_items WHERE subject_id = p_subject ORDER BY updated_at DESC LIMIT 1 $$;
CREATE FUNCTION pg_temp.state(p_subject uuid) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT state FROM private.retention_purge_items WHERE subject_id = p_subject ORDER BY updated_at DESC LIMIT 1 $$;
CREATE FUNCTION pg_temp.evidence(p_subject uuid) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT e.classification || ':' || e.api_outcome || ':' || e.unavailable_check || ':' || (e.tombstone_id IS NOT NULL)::text
    FROM private.retention_purge_erasure_records e WHERE e.item_id = pg_temp.iid(p_subject) ORDER BY e.id DESC LIMIT 1 $$;
GRANT EXECUTE ON FUNCTION pg_temp.iid(uuid), pg_temp.state(uuid), pg_temp.evidence(uuid) TO authenticated, service_role;
CREATE TEMP TABLE v (k text PRIMARY KEY, val jsonb);
GRANT ALL ON v TO authenticated, service_role;
CREATE FUNCTION pg_temp.run(k text) RETURNS uuid LANGUAGE sql AS $$ SELECT (val ->> 'id')::uuid FROM v WHERE v.k = $1 $$;
GRANT EXECUTE ON FUNCTION pg_temp.run(text) TO authenticated, service_role;
-- Prepare (as p) and approve (as a); stores the run as k.
CREATE FUNCTION pg_temp.prep(k text, p text, cat text, ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.login(pg_temp.u(p));
  SET LOCAL ROLE authenticated;
  INSERT INTO v VALUES (k, public.admin_retention_prepare_run(cat, ids));
  RESET ROLE;
END;
$$;
CREATE FUNCTION pg_temp.appr(k text, a text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE x jsonb;
BEGIN
  SELECT val INTO x FROM v WHERE v.k = appr.k;
  PERFORM pg_temp.login(pg_temp.u(a));
  SET LOCAL ROLE authenticated;
  PERFORM public.admin_retention_approve_run((x ->> 'id')::uuid, x ->> 'set_digest', (x ->> 'item_count')::int);
  RESET ROLE;
END;
$$;

-- ── 1. Shape and privileges ─────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM private.admin_privileges), 0, 'nobody holds a purge privilege after the migration (no automatic grants)');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r,
                  unnest(ARRAY['private.admin_privileges', 'private.admin_privilege_events', 'private.retention_purge_erasure_records']) t
           WHERE has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')), 0, 'no API role can read or change privileges or erasure records');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['private.grant_admin_privilege(uuid,text,uuid,text)', 'private.revoke_admin_privilege(uuid,text,uuid,text)',
             'private.has_purge_privilege(uuid,text)', 'private.lock_purge_privilege(uuid,text)', 'private.require_privilege_operator()',
             'private.retention_purge_attempt_record(uuid)']::regprocedure[]) f
           WHERE has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
              OR has_function_privilege('service_role', f, 'EXECUTE')), 0, 'grant, revoke and privilege checks: no API role');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.admin_retention_confirm_copy(uuid,uuid,text,jsonb)', 'public.admin_retention_purge_reconciliation(uuid,integer)']::regprocedure[]) f
           JOIN pg_proc p ON p.oid = f
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%'
             AND has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
             AND NOT has_function_privilege('service_role', f, 'EXECUTE')), 2, 'new RPCs: definer, pinned, require_admin, signed-in only');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.admin_retention_prepare_run(text,uuid[])', 'public.admin_retention_approve_run(uuid,text,integer)',
             'private.retention_purge_authorize_execution(uuid,uuid,text)', 'public.admin_retention_confirm_copy(uuid,uuid,text)',
             'public.admin_retention_reconcile_run(uuid)', 'private.retention_purge_claims_guard()']::regprocedure[]) f
           JOIN pg_proc p ON p.oid = f WHERE p.prosrc LIKE '%lock_purge_privilege%'), 6,
  'prepare, approve, execution, confirm, reconcile and the claim guard all check privileges');
SELECT is((SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
            WHERE table_schema = 'private' AND table_name = 'retention_purge_tombstones'),
  ARRAY['id', 'item_id', 'run_id', 'subject_kind', 'subject_id', 'policy_key', 'policy_period', 'due_at', 'size_bytes',
        'category_detail', 'prepared_by', 'approved_by', 'executed_by', 'purged_at'], 'tombstones unchanged (minimal metadata)');
SELECT throws_ok($$ INSERT INTO private.retention_purge_erasure_records (item_id, run_id, classification, api_outcome, unavailable_check)
                    VALUES (gen_random_uuid(), gen_random_uuid(), 'physically_erased', 'accepted', 'not_found') $$, '23514', NULL,
  'there is no "physically erased" classification');

-- ── Fixtures ────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT pg_temp.u(x), 'pp-' || x || '@example.invalid', jsonb_build_object('username', 'pp_' || x) FROM unnest(ARRAY['01', '02', '11', '12', '13', '14', '16']) x;
INSERT INTO public.admin_users (user_id) SELECT pg_temp.u(x) FROM unnest(ARRAY['11', '12', '13', '14', '16']) x;
SET LOCAL session_replication_role = replica;
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for) VALUES (pg_temp.u('14'), 'pending_deletion', 'scheduled', now() + interval '10 days');
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, details, evidence, status,
                                    created_at, reviewed_at, evidence_purge_after, resolution, resolution_reason)
SELECT pg_temp.r(n), pg_temp.u('02'), 'post', gen_random_uuid(), pg_temp.u('01'), 'spam', 'pp note ' || n, '{"text":"pp evidence"}', 'dismissed',
       now() - interval '120 days', now() - interval '100 days', now() - interval '10 days', 'no_violation', 'within_guidelines'
  FROM generate_series(1, 6) n;
INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id,
                                      size_bytes, source_sha256, quarantine_sha256, quarantine_path, state, desired, child_safety,
                                      legal_hold, retain_until, source_removed_at)
SELECT pg_temp.q(n), 'avatars', pg_temp.u('01') || '/pp-src-' || n || '.jpg', pg_temp.u('01'), 'avatar', 'profile', pg_temp.u('01'), 3,
       repeat('d', 64), repeat('d', 64), pg_temp.qp(n), 'restored', 'restore', n = 9, n = 9,
       CASE WHEN n = 9 THEN NULL ELSE now() - interval '5 days' END, now() - interval '100 days'
  FROM generate_series(1, 9) n;
INSERT INTO storage.objects (bucket_id, name, metadata) SELECT 'moderation-quarantine', pg_temp.qp(n), '{"size": 3}' FROM generate_series(1, 9) n;
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('moderation-quarantine', 'q/00000000-0000-4000-8000-0000e8409999/original', '{"size": 3}');
SET LOCAL session_replication_role = origin;

-- ── 2. Grants and revocations (operator only) ───────────────────────────
SELECT throws_ok($$ SELECT pg_temp.grant('11', 'preparer', '11') $$, '42501', 'self_grant_refused', 'self-granting is refused');
SELECT throws_ok($$ SELECT pg_temp.grant('11', 'preparer', '02') $$, '42501', 'grantor_not_authorized', 'the grantor must be an active admin');
SELECT throws_ok($$ SELECT pg_temp.grant('11', 'preparer', '14') $$, '42501', 'grantor_not_authorized', '…not an inactive one');
SELECT throws_ok($$ SELECT pg_temp.grant('02', 'preparer', '11') $$, '42501', 'grantee_not_active_admin', 'a collector cannot be granted a purge privilege');
SELECT throws_ok($$ SELECT pg_temp.grant('14', 'approver', '11') $$, '42501', 'grantee_not_active_admin', '…nor an inactive admin');
SELECT throws_ok($$ SELECT private.grant_admin_privilege(pg_temp.u('11'), 'retention_purge_preparer', pg_temp.u('12'), '  ') $$, '22023', NULL, 'a reason is required');
SELECT throws_ok($$ SELECT private.grant_admin_privilege(pg_temp.u('11'), 'retention_purge_owner', pg_temp.u('12'), 'nope') $$, '22023', 'invalid_privilege',
  'only the two purge privileges exist');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT pg_temp.grant('11', 'preparer', '12') $$, '42501', NULL, 'signed-in users cannot grant');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok($$ SELECT pg_temp.grant('11', 'preparer', '12') $$, '42501', NULL, 'the service role cannot grant');
RESET ROLE;
SET LOCAL ROLE postgres;
SELECT throws_ok($$ SELECT pg_temp.grant('11', 'preparer', '12') $$, '42501', 'operator_only', 'only an operator session (no SET ROLE) can grant');
RESET ROLE;
SELECT isnt(pg_temp.grant('11', 'preparer', '12'), NULL, 'an operator grants A1 the preparer privilege on behalf of A2');
SELECT is((SELECT event || ':' || (actor_id = pg_temp.u('12'))::text || ':' || reason || ':' || via FROM private.admin_privilege_events ORDER BY id DESC LIMIT 1),
  'granted:true:pgTAP fixture grant:postgres', 'the grant is recorded: grantor, reason, database role');
SELECT throws_ok($$ SELECT pg_temp.grant('11', 'preparer', '13') $$, 'PT409', 'privilege_already_granted', 'a duplicate grant is refused');

-- ── 3. Preparation ──────────────────────────────────────────────────────
SELECT pg_temp.login(pg_temp.u('11'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('report_evidence', ARRAY[pg_temp.r(1)]) $$, 'PT409', 'insufficient_purge_administrators',
  'with no other active approver, preparation fails closed');
RESET ROLE;
SELECT pg_temp.grant('12', 'approver', '11');
SELECT pg_temp.grant('13', 'approver', '11');
SELECT pg_temp.grant('13', 'preparer', '12');
SELECT pg_temp.login(pg_temp.u('16'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('report_evidence', ARRAY[pg_temp.r(1)]) $$, '42501', 'purge_preparer_privilege_required',
  'an admin without the preparer privilege cannot prepare');
RESET ROLE;
SELECT pg_temp.prep('run1', '11', 'report_evidence', ARRAY[pg_temp.r(1), pg_temp.r(2)]);
SELECT is((SELECT val ->> 'status' FROM v WHERE k = 'run1'), 'prepared', 'a preparer prepares when an approver exists');

-- ── 4. Approval ─────────────────────────────────────────────────────────
SELECT pg_temp.login(pg_temp.u('16'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_approve_run(pg_temp.run('run1'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'run1'), 2) $$, '42501',
  'purge_approver_privilege_required', 'an admin without the approver privilege cannot approve');
RESET ROLE;
SELECT pg_temp.login(pg_temp.u('11'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_approve_run(pg_temp.run('run1'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'run1'), 2) $$, '42501',
  'self_approval_refused', 'self-approval is still refused');
RESET ROLE;
SELECT pg_temp.prep('run2', '13', 'report_evidence', ARRAY[pg_temp.r(3)]);
SELECT pg_temp.revoke('13', 'preparer', '12');
SELECT pg_temp.login(pg_temp.u('12'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_approve_run(pg_temp.run('run2'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'run2'), 1) $$, '42501',
  'preparer_not_authorized', 'a run whose preparer lost the privilege cannot be approved');
RESET ROLE;
SELECT is((SELECT event || ':' || (actor_id = pg_temp.u('12'))::text FROM private.admin_privilege_events ORDER BY id DESC LIMIT 1), 'revoked:true',
  'the revocation is recorded with who stood behind it');
SELECT is((SELECT count(*)::int FROM private.admin_privileges WHERE user_id = pg_temp.u('13') AND privilege = 'retention_purge_preparer' AND revoked_at IS NOT NULL), 1,
  '…and the grant row is kept, marked revoked');
SELECT throws_ok($$ UPDATE private.admin_privileges SET grant_reason = 'rewritten' WHERE user_id = pg_temp.u('11') $$, '42501', 'admin_privileges_immutable',
  'a grant cannot be rewritten');
SELECT throws_ok($$ UPDATE private.admin_privileges SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL, revoked_via = NULL
                    WHERE user_id = pg_temp.u('13') AND privilege = 'retention_purge_preparer' $$, '42501', 'admin_privileges_immutable', 'a revocation cannot be undone');
SELECT throws_ok($$ DELETE FROM private.admin_privileges $$, '42501', 'admin_privileges_immutable', 'grants cannot be deleted');
SELECT throws_ok($$ DELETE FROM private.admin_privilege_events $$, '42501', NULL, 'privilege history cannot be deleted');
SELECT pg_temp.appr('run1', '12');
SELECT is((SELECT status FROM private.retention_purge_runs WHERE id = pg_temp.run('run1')), 'approved', 'a different approver approves');

-- ── 5. Execution ────────────────────────────────────────────────────────
SELECT pg_temp.login(pg_temp.u('16'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_execute_reports(pg_temp.run('run1')) $$, '42501', 'purge_executor_privilege_required',
  'an admin without a purge privilege cannot execute');
RESET ROLE;
SELECT pg_temp.login(pg_temp.u('11'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_execute_reports(pg_temp.run('run1')) $$, '42501', 'self_execution_refused', 'the preparer cannot execute');
RESET ROLE;
SELECT pg_temp.revoke('12', 'approver', '11');
SELECT pg_temp.login(pg_temp.u('13'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_execute_reports(pg_temp.run('run1')) $$, '42501', 'run_admins_not_authorized',
  'a revocation between approval and execution stops the run');
RESET ROLE;
SELECT is((SELECT evidence IS NOT NULL FROM public.content_reports WHERE id = pg_temp.r(1)), true, '…nothing was purged');
SELECT pg_temp.grant('12', 'approver', '13');
SELECT pg_temp.login(pg_temp.u('13'));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'exec1', public.admin_retention_execute_reports(pg_temp.run('run1'));
RESET ROLE;
SELECT is((SELECT val -> 'processed' ->> 'completed' FROM v WHERE k = 'exec1'), '2', 'after a fresh grant an approver executes');
SELECT is(pg_temp.evidence(pg_temp.r(1)), 'database_cleared:not_applicable:not_applicable:true', 'report evidence: classified database_cleared, with its tombstone');
SELECT is((SELECT count(*)::int FROM private.retention_purge_tombstones t WHERE t.subject_id IN (pg_temp.r(1), pg_temp.r(2))
            AND t.prepared_by = pg_temp.u('11') AND t.approved_by = pg_temp.u('12') AND t.executed_by = pg_temp.u('13')), 2, 'tombstones name all three admins');

-- ── 6. Suspended and removed administrators ─────────────────────────────
SET LOCAL session_replication_role = replica;
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for) VALUES (pg_temp.u('12'), 'pending_deletion', 'scheduled', now() + interval '10 days');
SET LOCAL session_replication_role = origin;
SELECT is(private.has_purge_privilege(pg_temp.u('12'), 'retention_purge_approver'), false, 'an inactive (pending deletion / suspended) admin holds no privilege');
SET LOCAL session_replication_role = replica;
DELETE FROM public.account_lifecycle WHERE user_id = pg_temp.u('12');
SET LOCAL session_replication_role = origin;
SELECT is(private.has_purge_privilege(pg_temp.u('12'), 'retention_purge_approver'), true, '…and holds it again once active');
SELECT pg_temp.grant('16', 'approver', '11');
DELETE FROM public.admin_users WHERE user_id = pg_temp.u('16');
SELECT is(private.has_purge_privilege(pg_temp.u('16'), 'retention_purge_approver'), false, 'a removed admin holds no privilege, whatever the grant table says');
SELECT pg_temp.revoke('16', 'approver', '11');

-- ── 7. Claims ───────────────────────────────────────────────────────────
SELECT throws_ok(format($$ INSERT INTO private.retention_purge_claims (subject_kind, subject_id, object_bucket, object_path, prepared_by, approved_by, lease_expires_at)
                    VALUES ('quarantine_copy', %L, 'moderation-quarantine', %L, %L, %L, clock_timestamp() + interval '1 minute') $$,
                    pg_temp.q(8), pg_temp.qp(8), pg_temp.u('13'), pg_temp.u('11')), '42501', 'claim_admins_not_authorized',
  'a claim needs a privileged preparer and approver (13 has no preparer privilege now)');
SELECT pg_temp.prep('crun', '11', 'quarantine_copy', ARRAY[pg_temp.q(1), pg_temp.q(2), pg_temp.q(3), pg_temp.q(4), pg_temp.q(5), pg_temp.q(6), pg_temp.q(7)]);
SELECT pg_temp.appr('crun', '12');
SELECT pg_temp.login(pg_temp.u('13'));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'c1', public.admin_retention_claim_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(1)));
RESET ROLE;
SELECT is((SELECT val ->> 'outcome' FROM v WHERE k = 'c1'), 'claimed', 'copy 1 claimed for deletion');
SELECT pg_temp.revoke('12', 'approver', '11');
SELECT is((SELECT close_reason FROM private.retention_purge_claims WHERE subject_id = pg_temp.q(1)), 'withdrawn', 'revoking the approver withdraws the live claim');
SET LOCAL ROLE service_role;
SELECT throws_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(1)), '42501', 'quarantine_object_protected',
  '…so the Storage guard refuses the delete');
RESET ROLE;
SELECT pg_temp.grant('12', 'approver', '13');

-- ── 8. Erasure evidence ─────────────────────────────────────────────────
-- (a) accepted single-object delete, then the object is unavailable → strongest classification
SELECT pg_temp.login(pg_temp.u('13'));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'c2', public.admin_retention_claim_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(2)));
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT pg_temp.storage_delete(pg_temp.qp(2));
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_confirm_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(2)), 'storage_timeout', '{"api":"accepted","unavailable":"not_found"}'::jsonb) $$,
  '22023', NULL, 'an "accepted" outcome cannot also carry an error');
SELECT throws_ok($$ SELECT public.admin_retention_confirm_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(2)), NULL, '{"api":"accepted","path":"q/x"}'::jsonb) $$,
  '22023', NULL, 'unknown fields are refused');
INSERT INTO v SELECT 'f2', public.admin_retention_confirm_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(2)), NULL, '{"api":"accepted","unavailable":"not_found"}'::jsonb);
RESET ROLE;
SELECT is((SELECT val ->> 'outcome' FROM v WHERE k = 'f2'), 'completed', 'completed only because the guard consumed the claim and the metadata is gone');
SELECT is(pg_temp.evidence(pg_temp.q(2)), 'unavailable_via_api:accepted:not_found:true', 'classified unavailable_via_api (the strongest possible)');
-- (b) the API response was lost (timeout), but the database proves the authorised delete
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'c3', public.admin_retention_claim_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(3)));
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT pg_temp.storage_delete(pg_temp.qp(3));
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT public.admin_retention_confirm_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(3)), 'storage_timeout', '{"api":"timeout","unavailable":"not_checked"}'::jsonb);
RESET ROLE;
SELECT is(pg_temp.state(pg_temp.q(3)) || ':' || pg_temp.evidence(pg_temp.q(3)), 'completed:metadata_removed:timeout:not_checked:true',
  'a timeout after an authorised delete: completed as metadata_removed (the API outcome kept)');
-- (c) the API "accepted" but nothing was deleted
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'c4', public.admin_retention_claim_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(4)));
INSERT INTO v SELECT 'f4', public.admin_retention_confirm_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(4)), NULL, '{"api":"accepted","unavailable":"not_checked"}'::jsonb);
RESET ROLE;
SELECT is((SELECT val ->> 'outcome' FROM v WHERE k = 'f4') || ':' || pg_temp.evidence(pg_temp.q(4)), 'in_flight:api_accepted:accepted:not_checked:false',
  'an accepted response alone completes nothing (still in flight, no tombstone)');
SELECT is((SELECT count(*)::int FROM private.retention_purge_tombstones WHERE subject_id = pg_temp.q(4)), 0, '…and no tombstone');
-- (d) the object disappears without the authorised delete
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'c5', public.admin_retention_claim_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(5)));
RESET ROLE;
SET LOCAL session_replication_role = replica;
DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = pg_temp.qp(5);
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE authenticated;
SELECT public.admin_retention_confirm_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(5)), NULL, '{"api":"accepted","unavailable":"not_found"}'::jsonb);
RESET ROLE;
SELECT is(pg_temp.state(pg_temp.q(5)) || ':' || pg_temp.evidence(pg_temp.q(5)), 'needs_attention:ambiguous_missing_unverified:accepted:not_found:false',
  'missing without an authorised delete: needs_attention, ambiguous, never purged');
-- (e) an object is back at the path after the authorised delete
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'c6', public.admin_retention_claim_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(6)));
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT pg_temp.storage_delete(pg_temp.qp(6));
RESET ROLE;
SET LOCAL session_replication_role = replica;
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('moderation-quarantine', pg_temp.qp(6), '{"size": 3}');
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE authenticated;
SELECT public.admin_retention_confirm_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(6)), NULL, '{"api":"accepted","unavailable":"still_readable"}'::jsonb);
RESET ROLE;
SELECT is(pg_temp.state(pg_temp.q(6)) || ':' || pg_temp.evidence(pg_temp.q(6)), 'needs_attention:ambiguous_reappeared:accepted:still_readable:false',
  'an object back at the path: needs_attention, ambiguous_reappeared');
-- (f) the legacy 3-argument confirm records no API evidence
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'c7', public.admin_retention_claim_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(7)));
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT pg_temp.storage_delete(pg_temp.qp(7));
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT public.admin_retention_confirm_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(7)));
RESET ROLE;
SELECT is(pg_temp.evidence(pg_temp.q(7)), 'metadata_removed:unknown:not_checked:true', 'without an API report: metadata_removed, outcome unknown');
SELECT throws_ok($$ UPDATE private.retention_purge_erasure_records SET classification = 'unavailable_via_api' $$, '42501', NULL, 'erasure records are append-only');
SELECT throws_ok($$ UPDATE private.retention_purge_items SET state = 'completed' WHERE id = pg_temp.iid(pg_temp.q(5)) $$, '42501', NULL,
  'needs_attention cannot be cleared');
SELECT is((SELECT count(*)::int FROM private.retention_purge_erasure_records e, LATERAL (SELECT to_jsonb(e)::text AS t) j
            WHERE j.t LIKE '%q/%' OR j.t LIKE '%dddd%' OR j.t LIKE '%pp evidence%'), 0, 'erasure records hold no paths, hashes or content');

-- ── 9. Unrelated objects, child safety, settlement privilege ────────────
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'moderation-quarantine'
            AND name IN (pg_temp.qp(8), pg_temp.qp(9), 'q/00000000-0000-4000-8000-0000e8409999/original')), 3, 'unrelated objects untouched');
SELECT pg_temp.login(pg_temp.u('11'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('quarantine_copy', ARRAY[pg_temp.q(9)]) $$, 'PT409', 'candidate_not_eligible',
  'child-safety copies stay excluded');
RESET ROLE;
SELECT pg_temp.revoke('13', 'approver', '11');
SELECT pg_temp.login(pg_temp.u('13'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_reconcile_run(pg_temp.run('crun')) $$, '42501', 'purge_executor_privilege_required',
  'settling needs the approver privilege too');
SELECT throws_ok($$ SELECT public.admin_retention_confirm_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(4)), NULL, '{"api":"accepted"}'::jsonb) $$, '42501',
  'purge_executor_privilege_required', '…as does confirming');
RESET ROLE;

-- ── 10. Reconciliation and dashboard (read-only) ────────────────────────
SELECT pg_temp.login(pg_temp.u('16'));
INSERT INTO public.admin_users (user_id) VALUES (pg_temp.u('16'));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'rec', public.admin_retention_purge_reconciliation(pg_temp.run('crun'));
INSERT INTO v SELECT 'dash', public.admin_retention_purge_dashboard();
RESET ROLE;
SELECT is((SELECT string_agg((x ->> 'recommended_action'), ',' ORDER BY x ->> 'recommended_action') FROM v, jsonb_array_elements(v.val -> 'items') x WHERE v.k = 'rec'),
  'investigate_reappeared_object,investigate_unverified_disappearance,reconcile_then_retry,wait_for_lease', 'reconciliation: each unsettled item with a next step');
SELECT is((SELECT x -> 'evidence' ->> 'classification' FROM v, jsonb_array_elements(v.val -> 'items') x WHERE v.k = 'rec' AND x ->> 'claim_state' = 'live'), 'api_accepted',
  '…with the evidence held for it');
SELECT is((SELECT (x ->> 'storage_metadata_present') || ':' || (x ->> 'claim_state') FROM v, jsonb_array_elements(v.val -> 'items') x
            WHERE v.k = 'rec' AND x ->> 'last_error' = 'object_missing_unverified'), 'false:withdrawn', '…metadata presence and claim state, without paths');
SELECT is((SELECT (val ->> 'physical_erasure_verifiable') FROM v WHERE k = 'rec'), 'false', 'physical erasure is reported as not verifiable');
SELECT is((SELECT count(*)::int FROM v WHERE k = 'rec' AND (val::text LIKE '%q/%' OR val::text LIKE '%dddd%')), 0, 'no paths or hashes in reconciliation');
SELECT is((SELECT (val -> 'viewer_privileges')::text || '|' || (val -> 'authorized_admins')::text FROM v WHERE k = 'dash'),
  '{"approver": false, "preparer": false}|{"approvers": 1, "preparers": 1, "runs_possible": true}', 'the dashboard shows the viewer''s privileges and how many admins hold each');
SELECT is((SELECT count(*)::int FROM v, jsonb_array_elements(v.val -> 'items') x WHERE v.k = 'dash' AND (x ->> 'viewer_may_approve')::boolean), 0,
  'without the approver privilege nothing shows as approvable');
SELECT is((SELECT (x ->> 'ambiguous_items') FROM v, jsonb_array_elements(v.val -> 'items') x WHERE v.k = 'dash' AND x ->> 'id' = pg_temp.run('crun')::text), '4',
  'the run shows its unsettled items');
SELECT pg_temp.login(pg_temp.u('02'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_purge_reconciliation() $$, '42501', NULL, 'collectors cannot read reconciliation');
SELECT throws_ok($$ SELECT public.admin_retention_confirm_copy(pg_temp.run('crun'), pg_temp.iid(pg_temp.q(4)), NULL, '{"api":"accepted"}'::jsonb) $$, '42501', NULL,
  '…or confirm');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
