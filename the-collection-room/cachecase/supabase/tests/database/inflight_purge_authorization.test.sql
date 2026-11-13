-- pgTAP test for 20261130120000_inflight_purge_authorization.sql (Phase 2B M4 step 5D.1).
-- DESTRUCTIVE (synthetic fixtures only, inside one rolled-back transaction):
-- runs ONLY on an isolated disposable local stack, and only when the session
-- says so:  PGOPTIONS='-c cachecase.isolated_stack=on' (or SET it first).
-- (Concurrency itself is exercised by scripts/integration/retention-purge-inflight.ts.)

BEGIN;
DO $$ BEGIN
  IF current_setting('cachecase.isolated_stack', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'refusing: destructive in-flight authorization tests run only on an isolated stack (cachecase.isolated_stack=on)';
  END IF;
END $$;
SELECT plan(35);

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
-- 01 owner; admins: 11 A1 prep · 12 A2 appr · 13 A3 executor (appr) · 14 A4 appr · 15 A5 prep · 16 A6 prep · 17 A7 appr · 18 A8 appr · 19 A9 appr.
CREATE FUNCTION pg_temp.u(x text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e90000' || x)::uuid $$;
CREATE FUNCTION pg_temp.q(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e93000' || lpad(n::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.qp(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'q/00000000-0000-4000-8000-0000e94000' || lpad(n::text, 2, '0') || '/original' $$;
GRANT EXECUTE ON FUNCTION pg_temp.u(text), pg_temp.q(int), pg_temp.qp(int) TO authenticated, service_role;
CREATE FUNCTION pg_temp.storage_delete(p_path text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN   -- what the Storage API does for a service-role delete of one object
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = p_path;
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.storage_delete(text) TO service_role;
CREATE FUNCTION pg_temp.present(n int) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = pg_temp.qp(n)) $$;
CREATE FUNCTION pg_temp.claim_state(n int) RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(close_reason, CASE WHEN lease_expires_at > clock_timestamp() THEN 'live' ELSE 'lease_over' END)
    FROM private.retention_purge_claims WHERE subject_id = pg_temp.q(n) ORDER BY claimed_at DESC LIMIT 1 $$;
CREATE FUNCTION pg_temp.iid(p_subject uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id FROM private.retention_purge_items WHERE subject_id = p_subject ORDER BY updated_at DESC LIMIT 1 $$;
GRANT EXECUTE ON FUNCTION pg_temp.iid(uuid) TO authenticated;
CREATE TEMP TABLE v (k text PRIMARY KEY, val jsonb);
GRANT ALL ON v TO authenticated, service_role;
CREATE FUNCTION pg_temp.run(k text) RETURNS uuid LANGUAGE sql AS $$ SELECT (val ->> 'id')::uuid FROM v WHERE v.k = $1 $$;
GRANT EXECUTE ON FUNCTION pg_temp.run(text) TO authenticated;
-- Prepare as p, approve as a, claim copy n as executor x (returns nothing; state is checked after).
CREATE FUNCTION pg_temp.ready(k text, p text, a text, x text, ns int[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.login(pg_temp.u(p));
  SET LOCAL ROLE authenticated;
  r := public.admin_retention_prepare_run('quarantine_copy', (SELECT array_agg(pg_temp.q(n)) FROM unnest(ns) n));
  RESET ROLE;
  INSERT INTO v VALUES (k, r);
  PERFORM pg_temp.login(pg_temp.u(a));
  SET LOCAL ROLE authenticated;
  PERFORM public.admin_retention_approve_run((r ->> 'id')::uuid, r ->> 'set_digest', (r ->> 'item_count')::int);
  PERFORM pg_temp.login(pg_temp.u(x));
  PERFORM public.admin_retention_claim_copy((r ->> 'id')::uuid, pg_temp.iid(pg_temp.q(ns[1])));
  RESET ROLE;
  PERFORM pg_temp.logout();
END;
$$;
CREATE FUNCTION pg_temp.suspend(x text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.account_suspensions (user_id, reason_code, created_by) VALUES (pg_temp.u(x), 'terms_violation', pg_temp.u('11')) $$;

-- ── 1. Shape ────────────────────────────────────────────────────────────
SELECT ok((SELECT position('FOR SHARE' IN prosrc) BETWEEN 1 AND position('retention_purge_admin_active' IN prosrc)
             FROM pg_proc WHERE oid = 'private.lock_purge_privilege(uuid,text)'::regprocedure),
  'the privilege check locks the grant first, then reads the administrator''s standing');
SELECT ok((SELECT position('lock_purge_privilege(v_appr' IN prosrc) BETWEEN 1 AND position('AND c.prepared_by = v_prep AND c.approved_by = v_appr' IN prosrc)
             FROM pg_proc WHERE oid = 'private.storage_held_write_guard()'::regprocedure),
  'the Storage guard re-authorises both claim administrators before locking the claim');
SELECT is((SELECT string_agg(tgrelid::regclass::text || ':' || tgname, ',' ORDER BY tgrelid::regclass::text) FROM pg_trigger
            WHERE tgname IN ('admin_users_purge_authority', 'account_suspensions_purge_authority', 'account_lifecycle_purge_authority')),
  'account_lifecycle:account_lifecycle_purge_authority,account_suspensions:account_suspensions_purge_authority,admin_users:admin_users_purge_authority',
  'removal, suspension and account deletion each withdraw purge authority');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['private.purge_authority_lost(uuid)', 'private.purge_authority_lost_trigger()']::regprocedure[]) f
           WHERE has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
              OR has_function_privilege('service_role', f, 'EXECUTE')), 0, 'the new helpers: no API role');

-- ── Fixtures ────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT pg_temp.u(x), 'ip-' || x || '@example.invalid', jsonb_build_object('username', 'ip_' || x)
  FROM unnest(ARRAY['01', '11', '12', '13', '14', '15', '16', '17', '18', '19']) x;
INSERT INTO public.admin_users (user_id) SELECT pg_temp.u(x) FROM unnest(ARRAY['11', '12', '13', '14', '15', '16', '17', '18', '19']) x;
SELECT private.grant_admin_privilege(pg_temp.u(x), 'retention_purge_preparer', pg_temp.u(CASE x WHEN '12' THEN '13' ELSE '12' END), 'pgTAP fixture')
  FROM unnest(ARRAY['11', '15', '16']) x;
SELECT private.grant_admin_privilege(pg_temp.u(x), 'retention_purge_approver', pg_temp.u('11'), 'pgTAP fixture')
  FROM unnest(ARRAY['12', '13', '14', '17', '18', '19']) x;
SET LOCAL session_replication_role = replica;
INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id,
                                      size_bytes, source_sha256, quarantine_sha256, quarantine_path, state, desired, child_safety,
                                      legal_hold, retain_until, source_removed_at)
SELECT pg_temp.q(n), 'avatars', pg_temp.u('01') || '/ip-src-' || n || '.jpg', pg_temp.u('01'), 'avatar', 'profile', pg_temp.u('01'), 3,
       repeat('f', 64), repeat('f', 64), pg_temp.qp(n), 'restored', 'restore', n = 12, n = 12,
       CASE WHEN n = 12 THEN NULL ELSE now() - interval '5 days' END, now() - interval '100 days'
  FROM generate_series(1, 12) n;
INSERT INTO storage.objects (bucket_id, name, metadata) SELECT 'moderation-quarantine', pg_temp.qp(n), '{"size": 3}' FROM generate_series(1, 12) n;
SET LOCAL session_replication_role = origin;

-- ── 2. Suspension immediately before the Storage delete ─────────────────
SELECT pg_temp.ready('s', '11', '12', '13', ARRAY[1]);
SELECT is(pg_temp.claim_state(1), 'live', 'copy 1 claimed (A1 prepared, A2 approved)');
SELECT pg_temp.suspend('12');
SELECT is(pg_temp.claim_state(1), 'withdrawn', 'suspending the approver withdraws the live claim');
SET LOCAL ROLE service_role;
SELECT throws_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(1)), '42501', 'quarantine_object_protected', '…so the Storage delete is refused');
RESET ROLE;
SELECT ok(pg_temp.present(1), '…and the object is still there');

-- ── 3. Removal immediately before the Storage delete ────────────────────
SELECT pg_temp.ready('r', '15', '14', '13', ARRAY[2]);
DELETE FROM public.admin_users WHERE user_id = pg_temp.u('15');
SELECT is(pg_temp.claim_state(2), 'withdrawn', 'removing the preparer from admin_users withdraws the live claim');
SET LOCAL ROLE service_role;
SELECT throws_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(2)), '42501', 'quarantine_object_protected', '…the delete is refused');
RESET ROLE;
SELECT ok(pg_temp.present(2), '…object intact');

-- ── 4. Account deletion begins while a claim is live ────────────────────
SELECT pg_temp.ready('d', '16', '14', '13', ARRAY[3]);
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for) VALUES (pg_temp.u('16'), 'pending_deletion', 'scheduled', now() + interval '30 days');
SELECT is(pg_temp.claim_state(3), 'withdrawn', 'the preparer starting account deletion withdraws the live claim');
SET LOCAL ROLE service_role;
SELECT throws_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(3)), '42501', 'quarantine_object_protected', '…the delete is refused');
RESET ROLE;
SELECT ok(pg_temp.present(3), '…object intact');

-- ── 5. The guard re-checks even if no withdrawal happened ───────────────
-- (the suspension is inserted with triggers off, as if the withdrawal were missed)
SELECT pg_temp.ready('g', '11', '17', '13', ARRAY[4]);
SET LOCAL session_replication_role = replica;
INSERT INTO public.account_suspensions (user_id, reason_code, created_by) VALUES (pg_temp.u('17'), 'terms_violation', pg_temp.u('11'));
SET LOCAL session_replication_role = origin;
SELECT is(pg_temp.claim_state(4), 'live', 'the claim is still open (no withdrawal ran)');
SET LOCAL ROLE service_role;
SELECT throws_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(4)), '42501', 'claim_admins_not_authorized',
  'the Storage guard itself refuses: the approver is suspended');
RESET ROLE;
SELECT ok(pg_temp.present(4) AND pg_temp.claim_state(4) = 'live', '…nothing deleted, claim not consumed');
SET LOCAL session_replication_role = replica;
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for) VALUES (pg_temp.u('11'), 'pending_deletion', 'scheduled', now() + interval '30 days');
SET LOCAL session_replication_role = origin;
SELECT is(private.lock_purge_privilege(pg_temp.u('11'), 'retention_purge_preparer'), false, 'a preparer pending deletion fails the privilege check');
SET LOCAL session_replication_role = replica;
DELETE FROM public.account_lifecycle WHERE user_id = pg_temp.u('11');
SET LOCAL session_replication_role = origin;
SELECT is(private.lock_purge_privilege(pg_temp.u('11'), 'retention_purge_preparer'), true, '…and passes again once active');

-- ── 6. Storage already deleted, then the executor loses standing ────────
SELECT pg_temp.ready('p', '11', '14', '13', ARRAY[5]);
SET LOCAL ROLE service_role;
SELECT lives_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(5)), 'the authorised delete of copy 5 succeeds');
RESET ROLE;
SELECT pg_temp.suspend('13');
SELECT is(pg_temp.claim_state(5), 'consumed', 'the consumed claim is not rewritten by the later suspension');
SELECT pg_temp.login(pg_temp.u('13'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_confirm_copy(pg_temp.run('p'), pg_temp.iid(pg_temp.q(5))) $$, '42501', NULL,
  'the suspended executor can no longer confirm');
RESET ROLE;
SELECT pg_temp.login(pg_temp.u('18'));
SET LOCAL ROLE authenticated;
INSERT INTO v SELECT 'rec', public.admin_retention_reconcile_run(pg_temp.run('p'));
RESET ROLE;
SELECT is((SELECT state FROM private.retention_purge_items WHERE id = pg_temp.iid(pg_temp.q(5))), 'completed',
  'another authorised approver settles the already-performed delete');
SELECT is((SELECT e.classification || ':' || e.api_outcome FROM private.retention_purge_erasure_records e WHERE e.item_id = pg_temp.iid(pg_temp.q(5)) ORDER BY e.id DESC LIMIT 1),
  'metadata_removed:unknown', '…classified from the database evidence, the API outcome honestly unknown');
SELECT is((SELECT (prepared_by = pg_temp.u('11'))::text || ':' || (approved_by = pg_temp.u('14'))::text || ':' || (executed_by = pg_temp.u('18'))::text
             FROM private.retention_purge_tombstones WHERE subject_id = pg_temp.q(5)), 'true:true:true', '…the tombstone keeps the original two admins and the settling one');

-- ── 7. No re-authorisation around the two-person approval ───────────────
SELECT pg_temp.ready('f', '11', '19', '14', ARRAY[6, 7]);
SET LOCAL ROLE service_role;
SELECT pg_temp.storage_delete(pg_temp.qp(6));
RESET ROLE;
SELECT pg_temp.suspend('19');
SELECT pg_temp.login(pg_temp.u('18'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_claim_copy(pg_temp.run('f')) $$, '42501', 'run_admins_inactive',
  'with its approver suspended, no other admin can continue the run');
INSERT INTO v SELECT 'rec2', public.admin_retention_reconcile_run(pg_temp.run('f'));
RESET ROLE;
SELECT is((SELECT string_agg(state, ',' ORDER BY subject_id) FROM private.retention_purge_items WHERE run_id = pg_temp.run('f')), 'completed,pending',
  '…the already-deleted copy is settled; the other stays undeleted');
SELECT ok(pg_temp.present(7), '…copy 7 is still there');
SELECT pg_temp.login(pg_temp.u('11'));
SET LOCAL ROLE authenticated;
SELECT public.admin_retention_cancel_run(pg_temp.run('f'));
RESET ROLE;
SELECT pg_temp.ready('f2', '11', '18', '14', ARRAY[7]);
SET LOCAL ROLE service_role;
SELECT lives_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(7)), 'only a fresh run, approved by a different valid admin, can delete copy 7');
RESET ROLE;

-- ── 8. Holds, child safety, expiry, unrelated objects ───────────────────
SELECT pg_temp.ready('h', '11', '18', '14', ARRAY[8]);
SELECT pg_temp.login(pg_temp.u('18'));
SET LOCAL ROLE authenticated;
SELECT public.admin_place_legal_hold('quarantine_copy', pg_temp.q(8), 'litigation', 'pgTAP hold', now() + interval '30 days');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(8)), '42501', 'quarantine_copy_not_eligible', 'a new legal hold still wins');
RESET ROLE;
SELECT pg_temp.login(pg_temp.u('11'));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('quarantine_copy', ARRAY[pg_temp.q(12)]) $$, 'PT409', 'candidate_not_eligible', 'child-safety copies stay excluded');
RESET ROLE;
SELECT pg_temp.ready('e', '11', '18', '14', ARRAY[9]);
SET LOCAL ROLE service_role;
SELECT throws_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(10)), '42501', 'quarantine_object_protected', 'a live claim unlocks no other object');
RESET ROLE;
SET LOCAL session_replication_role = replica;
UPDATE private.retention_purge_claims SET claimed_at = clock_timestamp() - interval '10 minutes', lease_expires_at = clock_timestamp() - interval '6 minutes'
 WHERE subject_id = pg_temp.q(9) AND closed_at IS NULL;
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE service_role;
SELECT throws_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(9)), '42501', 'quarantine_object_protected', 'an expired claim authorises nothing');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name IN (pg_temp.qp(9), pg_temp.qp(10), pg_temp.qp(11), pg_temp.qp(12))), 4,
  'unrelated and expired-claim objects untouched');
SELECT is((SELECT count(*)::int FROM private.retention_purge_claims WHERE closed_at IS NULL AND lease_expires_at > clock_timestamp()
             AND (prepared_by IN (pg_temp.u('12'), pg_temp.u('13'), pg_temp.u('15'), pg_temp.u('16'), pg_temp.u('19'))
                  OR approved_by IN (pg_temp.u('12'), pg_temp.u('13'), pg_temp.u('15'), pg_temp.u('16'), pg_temp.u('19')))), 0,
  'no live claim names an administrator who lost standing');

SELECT * FROM finish();
ROLLBACK;
