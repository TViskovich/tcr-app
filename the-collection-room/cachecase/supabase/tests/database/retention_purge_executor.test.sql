-- pgTAP test for 20261125120000_retention_purge_executor.sql (Phase 2B M4 step 4B).
-- DESTRUCTIVE (synthetic fixtures only, inside one rolled-back transaction):
-- runs ONLY on an isolated disposable local stack, and only when the session
-- says so:  PGOPTIONS='-c cachecase.isolated_stack=on' (or SET it first).
-- Anywhere else it stops at the first statement.

BEGIN;
DO $$ BEGIN
  IF current_setting('cachecase.isolated_stack', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'refusing: destructive retention-purge tests run only on an isolated stack (cachecase.isolated_stack=on)';
  END IF;
END $$;
SELECT plan(110);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated, service_role;
CREATE TEMP TABLE v (k text PRIMARY KEY, val jsonb);
GRANT ALL ON v TO authenticated;
CREATE FUNCTION pg_temp.rid(k text) RETURNS uuid LANGUAGE sql AS $$ SELECT (val ->> 'id')::uuid FROM v WHERE v.k = $1 $$;
CREATE FUNCTION pg_temp.item(p_run uuid, p_subject uuid) RETURNS private.retention_purge_items LANGUAGE sql AS $$
  SELECT * FROM private.retention_purge_items WHERE run_id = p_run AND subject_id = p_subject $$;
GRANT EXECUTE ON FUNCTION pg_temp.rid(text) TO authenticated;
-- Item id lookup for calls made as an admin session (the items table itself is private).
CREATE FUNCTION pg_temp.iid(p_run uuid, p_subject uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id FROM private.retention_purge_items WHERE run_id = p_run AND subject_id = p_subject $$;
GRANT EXECUTE ON FUNCTION pg_temp.iid(uuid, uuid) TO authenticated;
CREATE FUNCTION pg_temp.r(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e71000' || lpad(n::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.q(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e73000' || lpad(n::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.qp(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'q/00000000-0000-4000-8000-0000e74000' || lpad(n::text, 2, '0') || '/original' $$;
GRANT EXECUTE ON FUNCTION pg_temp.r(int), pg_temp.q(int), pg_temp.qp(int) TO authenticated, service_role;
CREATE FUNCTION pg_temp.storage_delete(p_path text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN   -- what the Storage API does for a service-role remove()
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = p_path;
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.storage_delete(text) TO service_role;

-- ── 1. Shape and privileges ─────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r,
                  unnest(ARRAY['private.retention_purge_runs', 'private.retention_purge_items', 'private.retention_purge_tombstones',
                               'private.retention_purge_events']) t
           WHERE has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')), 0, 'no API role can touch runs, items, tombstones or events');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY[
             'public.admin_retention_purge_preview(text,integer)', 'public.admin_retention_prepare_run(text,uuid[])',
             'public.admin_retention_approve_run(uuid,text,integer)', 'public.admin_retention_cancel_run(uuid)',
             'public.admin_retention_execute_reports(uuid,integer)', 'public.admin_retention_claim_copy(uuid,uuid)',
             'public.admin_retention_confirm_copy(uuid,uuid,text)', 'public.admin_retention_reconcile_run(uuid)',
             'public.admin_retention_purge_run(uuid)', 'public.admin_list_retention_purge_runs(text,integer)']::regprocedure[]) f
           JOIN pg_proc p ON p.oid = f
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%'
             AND has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
             AND NOT has_function_privilege('service_role', f, 'EXECUTE')), 10,
  'executor RPCs: definer, pinned, require_admin, signed-in only (not even the service role)');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'private' AND p.proname LIKE 'retention_purge%'
              AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   OR has_function_privilege('service_role', p.oid, 'EXECUTE'))), 0, 'internal helpers: no API role');
SELECT is((SELECT provolatile::text FROM pg_proc WHERE oid = 'public.admin_retention_purge_preview(text,integer)'::regprocedure), 's',
  'preview is STABLE: it cannot write');
SELECT is((SELECT count(*)::int FROM cron.job WHERE command ILIKE '%retention%' OR command ILIKE '%purge%'), 0, 'no scheduled purge');
SELECT is((SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
            WHERE table_schema = 'private' AND table_name = 'retention_purge_tombstones'),
  ARRAY['id', 'item_id', 'run_id', 'subject_kind', 'subject_id', 'policy_key', 'policy_period', 'due_at', 'size_bytes',
        'category_detail', 'prepared_by', 'approved_by', 'executed_by', 'purged_at'],
  'tombstones hold operational metadata only (no content, hash, text, path or note)');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- C, D collectors; A1–A3 admins; A4 admin pending deletion; A5 not an admin.
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT ('00000000-0000-4000-8000-0000e70000' || x)::uuid, 'rp-' || x || '@example.invalid', jsonb_build_object('username', 'rp_' || x)
  FROM unnest(ARRAY['01', '02', '11', '12', '13', '14', '15']) x;
INSERT INTO public.admin_users (user_id) SELECT ('00000000-0000-4000-8000-0000e70000' || x)::uuid FROM unnest(ARRAY['11', '12', '13', '14']) x;
SET LOCAL session_replication_role = replica;
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for)
VALUES ('00000000-0000-4000-8000-0000e7000014', 'pending_deletion', 'scheduled', now() + interval '10 days');
-- Reports: 1–8 ordinary, resolved, due (C); 9 child safety; 10 not due; 11 open; 12–14 spare.
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, details, evidence, status,
                                    created_at, reviewed_at, evidence_purge_after, resolution, resolution_reason)
SELECT pg_temp.r(n), '00000000-0000-4000-8000-0000e7000002', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000e7000001',
       CASE WHEN n = 9 THEN 'child_safety' ELSE 'spam' END, 'reporter note ' || n, '{"text":"rp evidence"}',
       CASE WHEN n = 11 THEN 'open' ELSE 'dismissed' END, now() - interval '120 days',
       CASE WHEN n = 11 THEN NULL ELSE now() - interval '100 days' END,
       CASE WHEN n = 11 THEN NULL WHEN n = 10 THEN now() + interval '20 days' ELSE now() - interval '10 days' END,
       CASE WHEN n = 11 THEN NULL ELSE 'no_violation' END, CASE WHEN n = 11 THEN NULL ELSE 'within_guidelines' END
  FROM generate_series(1, 14) n;
-- Quarantine jobs: 1–8 restored/cancelled & due (C); 9 quarantined/retain; 10 child safety; 11 metadata mismatch.
INSERT INTO private.media_quarantine (id, source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id,
                                      size_bytes, source_sha256, quarantine_sha256, quarantine_path, state, desired, child_safety,
                                      legal_hold, retain_until, source_removed_at)
SELECT pg_temp.q(n), 'avatars', '00000000-0000-4000-8000-0000e7000001/src-' || n || '.jpg', '00000000-0000-4000-8000-0000e7000001',
       'avatar', 'profile', '00000000-0000-4000-8000-0000e7000001', 3, repeat('b', 64), repeat('b', 64), pg_temp.qp(n),
       CASE WHEN n = 9 THEN 'quarantined' WHEN n % 2 = 0 THEN 'cancelled' ELSE 'restored' END,
       CASE WHEN n = 9 THEN 'retain' ELSE 'restore' END, n = 10, n = 10,
       CASE WHEN n = 10 THEN NULL ELSE now() - interval '5 days' END, now() - interval '100 days'
  FROM generate_series(1, 11) n;
INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'moderation-quarantine', pg_temp.qp(n), jsonb_build_object('size', CASE WHEN n = 11 THEN 4 ELSE 3 END) FROM generate_series(1, 11) n;
-- The collector's own source files (restored originals) must never be touched.
INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
SELECT 'avatars', '00000000-0000-4000-8000-0000e7000001/src-' || n || '.jpg', '00000000-0000-4000-8000-0000e7000001', '{"size":3}'
  FROM generate_series(1, 11) n;
SET LOCAL session_replication_role = origin;
CREATE TEMP TABLE before_src AS SELECT count(*) AS n FROM storage.objects WHERE bucket_id = 'avatars' AND name LIKE '00000000-0000-4000-8000-0000e7000001/%';

-- ── 2. Preview, preparation ─────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000015');
SELECT throws_ok($$ SELECT public.admin_retention_purge_preview('report_evidence') $$, '42501', 'forbidden', 'a non-admin cannot preview');
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('report_evidence', ARRAY[pg_temp.r(1)]) $$, '42501', 'forbidden', '…or prepare');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000014');
SELECT throws_ok($$ SELECT public.admin_retention_purge_preview('report_evidence') $$, '42501', 'account_inactive', 'an inactive admin cannot preview');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000011');
INSERT INTO v VALUES ('preview', public.admin_retention_purge_preview('report_evidence', 200));
SELECT ok((SELECT val #>> '{policy,executable}' FROM v WHERE k = 'preview')::boolean, 'preview: the enforced, conforming policy is executable');
SELECT ok((SELECT val -> 'eligible' @> jsonb_build_array(jsonb_build_object('subject_id', pg_temp.r(1))) FROM v WHERE k = 'preview'),
  'preview: an ordinary due report is eligible');
SELECT ok((SELECT val -> 'excluded' @> jsonb_build_array(jsonb_build_object('subject_id', pg_temp.r(9), 'blockers', jsonb_build_array('child_safety')))
             FROM v WHERE k = 'preview'), 'preview: child-safety evidence is excluded with its reason');
SELECT ok((SELECT val -> 'excluded' @> jsonb_build_array(jsonb_build_object('subject_id', pg_temp.r(10), 'blockers', jsonb_build_array('not_due')))
             AND val -> 'excluded' @> jsonb_build_array(jsonb_build_object('subject_id', pg_temp.r(11)))
             FROM v WHERE k = 'preview'), 'preview: not-due and open reports are excluded');
SELECT ok((SELECT (val #>> '{totals,eligible_bytes}')::int > 0 FROM v WHERE k = 'preview'), 'preview: estimated sizes');
SELECT ok((SELECT val::text !~ 'rp evidence|reporter note' FROM v WHERE k = 'preview'), 'preview carries no evidence or reporter text');
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('report_evidence', ARRAY[pg_temp.r(9)]) $$,
  'PT409', 'candidate_not_eligible', 'child-safety evidence cannot be prepared');
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('report_evidence', ARRAY[pg_temp.r(1), pg_temp.r(10)]) $$,
  'PT409', 'candidate_not_eligible', 'one ineligible id refuses the whole selection');
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('report_evidence', ARRAY[pg_temp.r(1), pg_temp.r(1)]) $$,
  '22023', 'invalid_selection', 'duplicates refused');
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('report_evidence', ARRAY[]::uuid[]) $$, '22023', 'invalid_selection', 'empty refused');
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('report_evidence', (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 51))) $$,
  '22023', 'invalid_selection', 'more than 50 refused');
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('moderation_note', ARRAY[pg_temp.r(1)]) $$, '22023', 'invalid_argument',
  'notes are not a purge category');
INSERT INTO v VALUES ('run1', public.admin_retention_prepare_run('report_evidence', ARRAY[pg_temp.r(1), pg_temp.r(2), pg_temp.r(3), pg_temp.r(4), pg_temp.r(5)]));
SELECT ok((SELECT val ->> 'status' = 'prepared' AND (val ->> 'item_count')::int = 5 AND val ->> 'set_digest' ~ '^[0-9a-f]{32}$'
             AND (val ->> 'approval_expires_at')::timestamptz <= now() + interval '30 minutes 1 second' FROM v WHERE k = 'run1'),
  'A1 prepares a frozen, bounded run (digest, count, 30-minute approval window)');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000012');
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('report_evidence', ARRAY[pg_temp.r(1), pg_temp.r(6)]) $$,
  'PT409', 'candidate_not_eligible', 'evidence already in an open run cannot be prepared again');
SELECT ok(public.admin_retention_purge_preview('report_evidence', 200) -> 'excluded'
            @> jsonb_build_array(jsonb_build_object('subject_id', pg_temp.r(1), 'blockers', jsonb_build_array('in_open_run'))),
  'preview shows items already in an open run as excluded');

-- ── 3. Approval ─────────────────────────────────────────────────────────
SELECT throws_ok(format($$ SELECT public.admin_retention_execute_reports(%L) $$, pg_temp.rid('run1')), 'PT409', 'run_not_executable',
  'an unapproved run cannot be executed');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000011');
SELECT throws_ok(format($$ SELECT public.admin_retention_approve_run(%L, %L, 5) $$, pg_temp.rid('run1'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'run1')),
  '42501', 'self_approval_refused', 'the preparer cannot approve');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000014');
SELECT throws_ok(format($$ SELECT public.admin_retention_approve_run(%L, %L, 5) $$, pg_temp.rid('run1'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'run1')),
  '42501', 'account_inactive', 'an inactive admin cannot approve');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000015');
SELECT throws_ok(format($$ SELECT public.admin_retention_approve_run(%L, %L, 5) $$, pg_temp.rid('run1'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'run1')),
  '42501', 'forbidden', 'a non-admin cannot approve');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000012');
SELECT throws_ok(format($$ SELECT public.admin_retention_approve_run(%L, %L, 5) $$, pg_temp.rid('run1'), md5('other')),
  'PT409', 'run_set_mismatch', 'approval must name the exact frozen set (digest)');
SELECT throws_ok(format($$ SELECT public.admin_retention_approve_run(%L, %L, 4) $$, pg_temp.rid('run1'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'run1')),
  'PT409', 'run_set_mismatch', '…and count');
SELECT is((public.admin_retention_approve_run(pg_temp.rid('run1'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'run1'), 5)) ->> 'status',
  'approved', 'A2 approves the exact run');
SELECT throws_ok(format($$ SELECT public.admin_retention_approve_run(%L, %L, 5) $$, pg_temp.rid('run1'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'run1')),
  'PT409', 'run_not_pending', 'a duplicate approval is refused');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000011');
SELECT throws_ok(format($$ SELECT public.admin_retention_execute_reports(%L) $$, pg_temp.rid('run1')), '42501', 'self_execution_refused',
  'the preparer cannot execute');
RESET ROLE;

-- ── 4. Eligibility changes after approval; forced audit failure ─────────
-- 2: new legal hold. 3: new live restriction. 4: new suspension citing it.
-- 5: owner erased by account deletion while an account hold names a
--    deleted account (G6). 1: its audit insert is made to fail.
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000013');
SELECT lives_ok($$ SELECT public.admin_place_legal_hold('report', pg_temp.r(2), 'litigation', 'late hold', now() + interval '30 days') $$, 'hold on 2 after approval');
RESET ROLE;
INSERT INTO public.moderated_content (target_type, target_id, owner_id, state, reason_code, report_id)
VALUES ('post', gen_random_uuid(), '00000000-0000-4000-8000-0000e7000001', 'hidden', 'spam', pg_temp.r(3));
SET LOCAL session_replication_role = replica;
INSERT INTO public.account_suspensions (user_id, reason_code, report_id, created_by)
VALUES ('00000000-0000-4000-8000-0000e7000002', 'spam', pg_temp.r(4), '00000000-0000-4000-8000-0000e7000011');
INSERT INTO private.moderation_legal_holds (subject_kind, subject_id, hold_type, basis_code, basis_note, expires_at)
VALUES ('account', gen_random_uuid(), 'ordinary', 'litigation', 'deleted account', now() + interval '30 days');
SET LOCAL session_replication_role = origin;
UPDATE public.content_reports SET target_owner_id = NULL WHERE id = pg_temp.r(5);
CREATE FUNCTION pg_temp.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action = 'purge_report_evidence' AND NEW.report_id = '00000000-0000-4000-8000-0000e7100001' THEN
    RAISE EXCEPTION 'forced_audit_failure';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zz_fail_audit BEFORE INSERT ON public.moderation_actions FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_audit();

SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000013');
INSERT INTO v VALUES ('exec1', public.admin_retention_execute_reports(pg_temp.rid('run1')));
RESET ROLE;
SELECT is((SELECT val #>> '{processed,skipped}' FROM v WHERE k = 'exec1')::int, 4, 'four changed items are skipped, not forced');
SELECT is((pg_temp.item(pg_temp.rid('run1'), pg_temp.r(2))).skip_reasons, ARRAY['legal_hold'], 'item 2 skipped: new legal hold');
SELECT is((pg_temp.item(pg_temp.rid('run1'), pg_temp.r(3))).skip_reasons, ARRAY['live_restriction'], 'item 3 skipped: new live restriction');
SELECT is((pg_temp.item(pg_temp.rid('run1'), pg_temp.r(4))).skip_reasons, ARRAY['live_suspension'], 'item 4 skipped: new suspension');
SELECT is((pg_temp.item(pg_temp.rid('run1'), pg_temp.r(5))).skip_reasons, ARRAY['deleted_owner_hold_ambiguous'],
  'item 5 skipped: deleted owner with an unmatched account hold (G6, fail closed)');
SELECT ok((SELECT state = 'failed' AND attempts = 1 AND last_error = 'forced_audit_failure' FROM private.retention_purge_items
            WHERE run_id = pg_temp.rid('run1') AND subject_id = pg_temp.r(1)), 'item 1: the forced audit failure is recorded as a retryable failure');
SELECT ok((SELECT evidence IS NOT NULL AND evidence_purged_at IS NULL FROM public.content_reports WHERE id = pg_temp.r(1)),
  '…and the evidence change was rolled back with it');
SELECT is((SELECT count(*)::int FROM private.retention_purge_tombstones WHERE subject_id = pg_temp.r(1)), 0, '…no tombstone');
SELECT is((SELECT count(*)::int FROM private.retention_purge_claims WHERE subject_id = pg_temp.r(1)), 0, '…no claim left behind');
SELECT is((SELECT count(*)::int FROM public.content_reports WHERE id IN (pg_temp.r(2), pg_temp.r(3), pg_temp.r(4), pg_temp.r(5)) AND evidence IS NOT NULL), 4,
  'skipped evidence is untouched');
DROP TRIGGER zz_fail_audit ON public.moderation_actions;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000012');
SELECT is((public.admin_retention_execute_reports(pg_temp.rid('run1')) #>> '{processed,completed}')::int, 1, 'retry: the approver (≠ preparer) executes item 1');
RESET ROLE;
SELECT ok((SELECT evidence IS NULL AND evidence_purged_at IS NOT NULL AND details = 'reporter note 1' AND status = 'dismissed'
             AND resolution = 'no_violation' AND reason = 'spam' FROM public.content_reports WHERE id = pg_temp.r(1)),
  'only evidence is cleared; reporter details, status, resolution and reason stay');
SELECT ok((SELECT t.category_detail = 'spam:dismissed' AND t.prepared_by = '00000000-0000-4000-8000-0000e7000011'
             AND t.approved_by = '00000000-0000-4000-8000-0000e7000012' AND t.executed_by = '00000000-0000-4000-8000-0000e7000012'
             AND t.policy_key = 'report_evidence_after_resolution' AND t.policy_period = interval '90 days' AND t.size_bytes > 0
             FROM private.retention_purge_tombstones t WHERE t.subject_id = pg_temp.r(1)), 'the tombstone records both admins, the executor, policy and size');
SELECT ok((SELECT to_jsonb(t)::text !~ 'rp evidence|reporter note|moderation-quarantine|q/' FROM private.retention_purge_tombstones t
            WHERE t.subject_id = pg_temp.r(1)), 'the tombstone holds no content or text');
SELECT ok((SELECT count(*) = 1 FROM public.moderation_actions a WHERE a.action = 'purge_report_evidence' AND a.report_id = pg_temp.r(1)
             AND a.admin_id = '00000000-0000-4000-8000-0000e7000012' AND a.note IS NULL
             AND a.metadata ->> 'prepared_by' = '00000000-0000-4000-8000-0000e7000011' AND a.metadata ->> 'approved_by' = '00000000-0000-4000-8000-0000e7000012'),
  'one audit row, with both admins, no note');
SELECT is((SELECT close_reason FROM private.retention_purge_claims WHERE subject_id = pg_temp.r(1)), 'consumed', 'the two-admin claim was consumed');
SELECT is((SELECT status FROM private.retention_purge_runs WHERE id = pg_temp.rid('run1')), 'completed', 'the run completes when no item is open');
SELECT throws_ok($$ DELETE FROM public.moderation_actions WHERE action = 'purge_report_evidence' $$, '42501', 'moderation_actions_append_only',
  'the purge audit row is append-only like all moderation history');

-- ── 5. Expiry and cancellation ──────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000012');
INSERT INTO v VALUES ('run2', public.admin_retention_prepare_run('report_evidence', ARRAY[pg_temp.r(6)]));
RESET ROLE;
SET LOCAL session_replication_role = replica;
UPDATE private.retention_purge_runs SET prepared_at = now() - interval '40 minutes', approval_expires_at = now() - interval '10 minutes'
 WHERE id = pg_temp.rid('run2');
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000011');
SELECT throws_ok(format($$ SELECT public.admin_retention_approve_run(%L, %L, 1) $$, pg_temp.rid('run2'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'run2')),
  'PT409', 'run_expired', 'an expired run cannot be approved');
INSERT INTO v VALUES ('run3', public.admin_retention_prepare_run('report_evidence', ARRAY[pg_temp.r(6), pg_temp.r(7)]));
RESET ROLE;
SELECT ok((SELECT status = 'expired' FROM private.retention_purge_runs WHERE id = pg_temp.rid('run2'))
      AND (pg_temp.item(pg_temp.rid('run2'), pg_temp.r(6))).skip_reasons = ARRAY['run_expired'],
  'the expired run is closed and its item released (so it can be prepared again)');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000013');
SELECT lives_ok(format($$ SELECT public.admin_retention_approve_run(%L, %L, 2) $$, pg_temp.rid('run3'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'run3')),
  'run 3 approved');
RESET ROLE;
SET LOCAL session_replication_role = replica;
UPDATE private.retention_purge_runs SET approved_at = now() - interval '40 minutes', execution_expires_at = now() - interval '10 minutes'
 WHERE id = pg_temp.rid('run3');
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000012');
SELECT throws_ok(format($$ SELECT public.admin_retention_execute_reports(%L) $$, pg_temp.rid('run3')), 'PT409', 'run_not_executable',
  'an expired approval cannot be executed');
INSERT INTO v VALUES ('run4', public.admin_retention_prepare_run('report_evidence', ARRAY[pg_temp.r(12)]));
SELECT is(public.admin_retention_cancel_run(pg_temp.rid('run4')) ->> 'status', 'cancelled', 'a run can be cancelled before execution');
RESET ROLE;
SELECT ok((SELECT evidence IS NOT NULL FROM public.content_reports WHERE id = pg_temp.r(6))
      AND (SELECT evidence IS NOT NULL FROM public.content_reports WHERE id = pg_temp.r(7))
      AND (SELECT evidence IS NOT NULL FROM public.content_reports WHERE id = pg_temp.r(12)), 'expired and cancelled runs purged nothing');

-- ── 6. History is append-only ───────────────────────────────────────────
SELECT throws_ok($$ UPDATE private.retention_purge_tombstones SET size_bytes = 0 $$, '42501', 'retention_purge_append_only', 'tombstones cannot be edited');
SELECT throws_ok($$ DELETE FROM private.retention_purge_tombstones $$, '42501', 'retention_purge_append_only', '…or deleted');
SELECT throws_ok($$ DELETE FROM private.retention_purge_events $$, '42501', 'retention_purge_append_only', 'events cannot be deleted');
SELECT throws_ok($$ TRUNCATE private.retention_purge_events $$, '42501', 'retention_purge_append_only', '…or truncated');
SELECT throws_ok(format($$ UPDATE private.retention_purge_items SET subject_id = gen_random_uuid() WHERE run_id = %L $$, pg_temp.rid('run1')),
  '42501', 'retention_purge_append_only', 'an item cannot be redirected');
SELECT throws_ok(format($$ UPDATE private.retention_purge_items SET state = 'pending' WHERE run_id = %L AND state = 'completed' $$, pg_temp.rid('run1')),
  '42501', 'retention_purge_append_only', 'a completed item cannot be reopened');
SELECT throws_ok(format($$ UPDATE private.retention_purge_runs SET set_digest = md5('x') WHERE id = %L $$, pg_temp.rid('run1')),
  '42501', 'retention_purge_append_only', 'a run''s frozen set cannot change');
SELECT throws_ok(format($$ UPDATE private.retention_purge_runs SET approved_by = prepared_by WHERE id = %L $$, pg_temp.rid('run3')),
  '42501', 'retention_purge_append_only', 'the approver cannot be swapped');
SELECT throws_ok(format($$ DELETE FROM private.retention_purge_runs WHERE id = %L $$, pg_temp.rid('run1')), '42501', 'retention_purge_append_only', 'runs cannot be deleted');

-- ── 7. Quarantine copies ────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000011');
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('quarantine_copy', ARRAY[pg_temp.q(9)]) $$, 'PT409', 'candidate_not_eligible',
  'a non-terminal (retained quarantined) job cannot be prepared');
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('quarantine_copy', ARRAY[pg_temp.q(10)]) $$, 'PT409', 'candidate_not_eligible',
  'a child-safety copy cannot be prepared');
SELECT throws_ok($$ SELECT public.admin_retention_prepare_run('quarantine_copy', ARRAY[pg_temp.q(11)]) $$, 'PT409', 'candidate_not_eligible',
  'a copy whose object metadata does not match its job cannot be prepared');
INSERT INTO v VALUES ('qrun', public.admin_retention_prepare_run('quarantine_copy', ARRAY[pg_temp.q(1), pg_temp.q(2), pg_temp.q(3), pg_temp.q(4), pg_temp.q(5), pg_temp.q(6)]));
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000012');
SELECT lives_ok(format($$ SELECT public.admin_retention_approve_run(%L, %L, 6) $$, pg_temp.rid('qrun'), (SELECT val ->> 'set_digest' FROM v WHERE k = 'qrun')),
  'A2 approves the copy run');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000011');
SELECT throws_ok(format($$ SELECT public.admin_retention_claim_copy(%L) $$, pg_temp.rid('qrun')), '42501', 'self_execution_refused',
  'the preparer cannot claim copies for deletion');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000013');
-- (a) Normal path: claim → Storage delete → confirm.
INSERT INTO v VALUES ('c1', public.admin_retention_claim_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(1))));
SELECT ok((SELECT val ->> 'outcome' = 'claimed' AND val ->> 'bucket' = 'moderation-quarantine' AND val ->> 'path' = pg_temp.qp(1) FROM v WHERE k = 'c1'),
  'claim returns the exact private object from the job record');
SELECT is(public.admin_retention_claim_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(1))) ->> 'outcome', 'item_busy',
  'a duplicate claim on an item in flight is refused (item_busy)');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(2)), '42501', 'quarantine_object_protected',
  'the claim for copy 1 does not unlock copy 2');
SELECT lives_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(1)), 'the Storage delete of exactly that object succeeds');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT is(public.admin_retention_confirm_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(1))) ->> 'outcome', 'completed',
  'confirmed: object gone AND claim consumed');
SELECT is(public.admin_retention_confirm_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(1))) ->> 'outcome', 'completed',
  'confirming again is idempotent');
RESET ROLE;
SELECT ok((SELECT t.category_detail = 'avatar:restored' AND t.executed_by = '00000000-0000-4000-8000-0000e7000013' AND to_jsonb(t)::text !~ 'q/'
             FROM private.retention_purge_tombstones t WHERE t.subject_id = pg_temp.q(1)), 'copy tombstone: category only, no path');
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE action = 'purge_quarantine_copy' AND metadata ->> 'quarantine_id' = pg_temp.q(1)::text), 1,
  'one audit row for the copy');
-- (b) Object vanished WITHOUT an authorised delete.
SET LOCAL ROLE authenticated;
SELECT is(public.admin_retention_claim_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(2))) ->> 'outcome', 'claimed', 'claim copy 2');
RESET ROLE;
SET LOCAL storage.allow_delete_query = 'true';
DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = pg_temp.qp(2);   -- out-of-band (operator), not via the claim
SET LOCAL ROLE authenticated;
SELECT is(public.admin_retention_confirm_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(2))) ->> 'outcome', 'needs_attention',
  'a missing object is NOT counted as purged without an authorised delete');
RESET ROLE;
SELECT ok((SELECT last_error = 'object_missing_unverified' FROM private.retention_purge_items WHERE subject_id = pg_temp.q(2))
      AND NOT EXISTS (SELECT 1 FROM private.retention_purge_tombstones WHERE subject_id = pg_temp.q(2)), '…it is flagged, with no tombstone');
SELECT is((SELECT close_reason FROM private.retention_purge_claims WHERE subject_id = pg_temp.q(2)), 'withdrawn',
  '…and its unused claim is withdrawn at once (it can authorise nothing else)');
-- (c) Crash after the Storage delete, before confirmation → reconciliation.
SET LOCAL ROLE authenticated;
SELECT is(public.admin_retention_claim_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(3))) ->> 'outcome', 'claimed', 'claim copy 3');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT lives_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(3)), 'copy 3 deleted, then the executor "crashes"');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT ok(public.admin_retention_reconcile_run(pg_temp.rid('qrun')) -> 'results' @> jsonb_build_array(jsonb_build_object(
            'item_id', pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(3)), 'outcome', 'completed')), 'reconciliation completes it from the database evidence');
-- (d) Storage failure: object still there; retried after the lease, bounded.
SELECT is(public.admin_retention_claim_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(4))) ->> 'outcome', 'claimed', 'claim copy 4');
SELECT is(public.admin_retention_confirm_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(4)), 'storage_unavailable') ->> 'outcome',
  'in_flight', 'a failed Storage call leaves the item in flight until its claim lease ends');
RESET ROLE;
CREATE FUNCTION pg_temp.expire_claim(p_subject uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN   -- called with session_replication_role = replica (time travel for fixtures)
  UPDATE private.retention_purge_claims SET claimed_at = clock_timestamp() - interval '10 minutes', lease_expires_at = clock_timestamp() - interval '6 minutes'
   WHERE subject_id = p_subject AND closed_at IS NULL;
  UPDATE private.retention_purge_items SET lease_expires_at = clock_timestamp() - interval '6 minutes' WHERE subject_id = p_subject AND state = 'deleting';
END;
$$;
SET LOCAL session_replication_role = replica;
SELECT pg_temp.expire_claim(pg_temp.q(4));
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE authenticated;
SELECT is((public.admin_retention_reconcile_run(pg_temp.rid('qrun')) -> 'results' -> 0 ->> 'outcome'), 'failed', 'after the lease: failed (retryable)');
SELECT is(public.admin_retention_claim_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(4))) ->> 'outcome', 'claimed', 'retry 2 claims anew');
RESET ROLE;
SET LOCAL session_replication_role = replica;
SELECT pg_temp.expire_claim(pg_temp.q(4));
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE authenticated;
SELECT is(public.admin_retention_claim_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(4))) ->> 'outcome', 'claimed', 'retry 3 claims anew');
RESET ROLE;
SET LOCAL session_replication_role = replica;
SELECT pg_temp.expire_claim(pg_temp.q(4));
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE authenticated;
SELECT is(public.admin_retention_claim_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(4))) ->> 'outcome', 'needs_attention',
  'after three attempts the item is flagged for manual investigation (bounded retries)');
RESET ROLE;
SELECT ok((SELECT count(*) = 1 FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = pg_temp.qp(4)), 'copy 4 was never deleted');
-- (e) Legal hold placed while the copy is claimed.
SET LOCAL ROLE authenticated;
SELECT is(public.admin_retention_claim_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(5))) ->> 'outcome', 'claimed', 'claim copy 5');
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000011');
SELECT lives_ok($$ SELECT public.admin_place_legal_hold('quarantine_copy', pg_temp.q(5), 'litigation', 'mid-purge hold', now() + interval '30 days') $$,
  'a hold is placed on copy 5 mid-purge');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(5)), '42501', 'quarantine_copy_not_eligible',
  'the Storage guard refuses the delete: the hold wins');
RESET ROLE;
SET LOCAL session_replication_role = replica;
SELECT pg_temp.expire_claim(pg_temp.q(5));
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e7000013');
SELECT is(public.admin_retention_claim_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(5))) ->> 'outcome', 'skipped',
  'the retry re-checks and skips the held copy');
-- (f) The rest of the run, then completion.
SELECT is(public.admin_retention_claim_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(6))) ->> 'outcome', 'claimed', 'claim copy 6');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT lives_ok(format($$ SELECT pg_temp.storage_delete(%L) $$, pg_temp.qp(6)), 'copy 6 deleted');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT is(public.admin_retention_confirm_copy(pg_temp.rid('qrun'), pg_temp.iid(pg_temp.rid('qrun'), pg_temp.q(6))) ->> 'outcome', 'completed', 'copy 6 confirmed');
SELECT is(public.admin_retention_claim_copy(pg_temp.rid('qrun')) ->> 'done', 'true', 'nothing left to claim');
RESET ROLE;
SELECT is((SELECT status FROM private.retention_purge_runs WHERE id = pg_temp.rid('qrun')), 'completed', 'the copy run completes');
SELECT is((SELECT string_agg(i.state, ',' ORDER BY i.subject_id) FROM private.retention_purge_items i WHERE i.run_id = pg_temp.rid('qrun')),
  'completed,needs_attention,completed,needs_attention,skipped,completed', 'final item states (1–6)');
SELECT is((SELECT count(*) FROM storage.objects WHERE bucket_id = 'avatars' AND name LIKE '00000000-0000-4000-8000-0000e7000001/%'),
  (SELECT n FROM before_src), 'no original (source) file was touched');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name IN (pg_temp.qp(7), pg_temp.qp(8), pg_temp.qp(9), pg_temp.qp(10), pg_temp.qp(11))), 5,
  'copies outside the run are untouched');
SELECT is((SELECT count(*)::int FROM private.retention_purge_tombstones), 4, 'exactly four tombstones (1 report, 3 copies)');

-- ── 8. Reads ────────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT ok(jsonb_array_length(public.admin_retention_purge_run(pg_temp.rid('qrun')) -> 'events') > 0
      AND public.admin_retention_purge_run(pg_temp.rid('qrun'))::text !~ 'q/0', 'run detail lists events and tombstones without paths');
SELECT ok((SELECT (x ->> 'needs_attention')::int = 2 FROM jsonb_array_elements(public.admin_list_retention_purge_runs('completed')) x
            WHERE x ->> 'id' = pg_temp.rid('qrun')::text), 'run list surfaces items needing attention');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM private.retention_purge_claims WHERE closed_at IS NULL AND lease_expires_at > clock_timestamp()), 0,
  'no live claim is left open');

SELECT * FROM finish();
ROLLBACK;
