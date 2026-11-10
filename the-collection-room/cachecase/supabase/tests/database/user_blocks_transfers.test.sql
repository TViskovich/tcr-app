-- pgTAP test for 20261113120000_block_ownership_transfers.sql (collector
-- blocking × Registry ownership transfers, Phase 1B.1).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(38);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated;

-- ── Shape ───────────────────────────────────────────────────────────────
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ownership_transfers'::regclass AND tgname = 'user_block_guard'),
  'new transfer requests are block-guarded');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ownership_transfers'::regclass AND tgname = 'user_block_guard_accept'),
  'accepting a transfer is block-guarded');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ownership_transfers'::regclass AND tgname = 'interaction_target_guard')
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ownership_transfers'::regclass AND tgname = 'interaction_target_guard_accept'),
  'the lifecycle guards on transfers are still in place');
SELECT ok(prosrc LIKE '%ownership_transfer_requested%', 'transfer-request notifications between a blocked pair are suppressed')
  FROM pg_proc WHERE oid = 'private.suppress_blocked_notification()'::regprocedure;
SELECT ok(NOT has_table_privilege('authenticated', 'public.ownership_transfers', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.ownership_transfers', 'UPDATE'),
  'clients cannot write transfers directly (RPCs only)');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- A and B (the pair), C a bystander, D pending deletion.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000b1100001', 'ubt-a@example.invalid', '{"username":"ubt_a"}'),
  ('00000000-0000-4000-8000-0000b1100002', 'ubt-b@example.invalid', '{"username":"ubt_b"}'),
  ('00000000-0000-4000-8000-0000b1100003', 'ubt-c@example.invalid', '{"username":"ubt_c"}'),
  ('00000000-0000-4000-8000-0000b1100004', 'ubt-d@example.invalid', '{"username":"ubt_d"}');
-- Cards: K1 (B), K2 (A), K3 (C), K4 (B, pending to A), K5 (A, pending to B), K6 (A, for D).
INSERT INTO public.registered_cards (id, cc_id, current_owner_id, status) VALUES
  ('00000000-0000-4000-8000-0000b11c0001', 'CC-UBTA-AAA2', '00000000-0000-4000-8000-0000b1100002', 'active'),
  ('00000000-0000-4000-8000-0000b11c0002', 'CC-UBTA-AAA3', '00000000-0000-4000-8000-0000b1100001', 'active'),
  ('00000000-0000-4000-8000-0000b11c0003', 'CC-UBTA-AAA4', '00000000-0000-4000-8000-0000b1100003', 'active'),
  ('00000000-0000-4000-8000-0000b11c0004', 'CC-UBTA-AAA5', '00000000-0000-4000-8000-0000b1100002', 'active'),
  ('00000000-0000-4000-8000-0000b11c0005', 'CC-UBTA-AAA6', '00000000-0000-4000-8000-0000b1100001', 'active'),
  ('00000000-0000-4000-8000-0000b11c0006', 'CC-UBTA-AAA7', '00000000-0000-4000-8000-0000b1100001', 'active');

-- Two legitimate transfers already pending before any block.
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100002');
SELECT lives_ok($$ SELECT public.initiate_ownership_transfer('00000000-0000-4000-8000-0000b11c0004', 'ubt_a', 'gift') $$, 'before blocking: B sends K4 to A');
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100001');
SELECT lives_ok($$ SELECT public.initiate_ownership_transfer('00000000-0000-4000-8000-0000b11c0005', 'ubt_b', 'trade') $$, 'before blocking: A sends K5 to B');
RESET ROLE;
INSERT INTO public.account_lifecycle (user_id, state, mode, requested_at, scheduled_for)
  VALUES ('00000000-0000-4000-8000-0000b1100004', 'pending_deletion', 'scheduled', now(), now() + interval '30 days');

CREATE TEMP TABLE before_block AS SELECT
  (SELECT count(*) FROM public.ownership_transfers) AS transfers,
  (SELECT count(*) FROM public.notifications WHERE type = 'ownership_transfer_requested') AS requests,
  (SELECT count(*) FROM public.registry_events) AS events;
GRANT SELECT ON before_block TO authenticated;

-- ── A blocks B ──────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100001');
SELECT lives_ok($$ SELECT public.block_collector('00000000-0000-4000-8000-0000b1100002') $$, 'A blocks B');
SELECT throws_ok($$ SELECT public.initiate_ownership_transfer('00000000-0000-4000-8000-0000b11c0002', 'ubt_b', 'gift') $$,
  'P0001', 'Recipient not found', 'A (blocker) cannot send a new transfer to B');
SELECT throws_ok($$ SELECT public.initiate_ownership_transfer('00000000-0000-4000-8000-0000b11c0002', 'ubt_nobody_xyz', 'gift') $$,
  'P0001', 'Recipient not found', '…the same error (code and message) as an unknown username');
SELECT throws_ok($$ SELECT public.initiate_ownership_transfer('00000000-0000-4000-8000-0000b11c0006', 'ubt_d', 'gift') $$,
  '42501', 'account_unavailable', 'a pending-deletion recipient is still refused by the lifecycle guard (unchanged)');
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100002');
SELECT throws_ok($$ SELECT public.initiate_ownership_transfer('00000000-0000-4000-8000-0000b11c0001', 'ubt_a', 'sale') $$,
  'P0001', 'Recipient not found', 'B (blocked) cannot send a new transfer to A');
SELECT throws_ok($$ INSERT INTO public.ownership_transfers (registered_card_id, from_owner_id, to_owner_id)
                    VALUES ('00000000-0000-4000-8000-0000b11c0001', '00000000-0000-4000-8000-0000b1100002', '00000000-0000-4000-8000-0000b1100001') $$,
  '42501', NULL, 'B cannot bypass the RPC with a direct insert');
RESET ROLE;
SELECT is((SELECT count(*) FROM public.ownership_transfers), (SELECT transfers FROM before_block), 'no transfer was created');
SELECT is((SELECT count(*) FROM public.notifications WHERE type = 'ownership_transfer_requested'), (SELECT requests FROM before_block),
  'no transfer-request notification was created');

-- Defense in depth: a request notification between the pair is dropped.
INSERT INTO public.notifications (user_id, actor_id, type, registered_card_id)
  VALUES ('00000000-0000-4000-8000-0000b1100001', '00000000-0000-4000-8000-0000b1100002', 'ownership_transfer_requested', '00000000-0000-4000-8000-0000b11c0001');
SELECT is((SELECT count(*) FROM public.notifications WHERE type = 'ownership_transfer_requested'), (SELECT requests FROM before_block),
  'a transfer-request notification from B to A is suppressed');

-- ── Pre-existing transfers stay manageable, and are never completed ─────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100001');
SELECT is((SELECT count(*)::int FROM public.ownership_transfers WHERE status = 'pending'
             AND registered_card_id IN ('00000000-0000-4000-8000-0000b11c0004', '00000000-0000-4000-8000-0000b11c0005')), 2,
  'A still sees both pending transfers');
SELECT throws_ok($$ SELECT public.accept_ownership_transfer((SELECT id FROM public.ownership_transfers WHERE registered_card_id = '00000000-0000-4000-8000-0000b11c0004' AND status = 'pending')) $$,
  '42501', 'account_unavailable', 'A cannot accept B''s pending transfer while blocked');
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100002');
SELECT throws_ok($$ SELECT public.accept_ownership_transfer((SELECT id FROM public.ownership_transfers WHERE registered_card_id = '00000000-0000-4000-8000-0000b11c0005' AND status = 'pending')) $$,
  '42501', 'account_unavailable', 'B cannot accept A''s pending transfer while blocked');
RESET ROLE;
SELECT is((SELECT current_owner_id FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000b11c0004'), '00000000-0000-4000-8000-0000b1100002'::uuid,
  'K4 still belongs to B (no ownership change)');
SELECT is((SELECT current_owner_id FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000b11c0005'), '00000000-0000-4000-8000-0000b1100001'::uuid,
  'K5 still belongs to A');
SELECT is((SELECT count(*) FROM public.registry_events), (SELECT events FROM before_block), 'no registry history was written');
SELECT is((SELECT count(*)::int FROM public.ownership_transfers WHERE status = 'pending'
             AND registered_card_id IN ('00000000-0000-4000-8000-0000b11c0004', '00000000-0000-4000-8000-0000b11c0005')), 2,
  'both transfers are still pending (not completed, deleted or reassigned)');

SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100001');
SELECT lives_ok($$ SELECT public.decline_ownership_transfer((SELECT id FROM public.ownership_transfers WHERE registered_card_id = '00000000-0000-4000-8000-0000b11c0004' AND status = 'pending')) $$,
  'A can still decline B''s pending transfer');
SELECT lives_ok($$ SELECT public.cancel_ownership_transfer((SELECT id FROM public.ownership_transfers WHERE registered_card_id = '00000000-0000-4000-8000-0000b11c0005' AND status = 'pending')) $$,
  'A can still cancel its own pending transfer to B');
RESET ROLE;
SELECT is((SELECT status FROM public.ownership_transfers WHERE registered_card_id = '00000000-0000-4000-8000-0000b11c0004' ORDER BY created_at DESC LIMIT 1), 'declined',
  'the declined transfer is recorded as declined');
SELECT is((SELECT status FROM public.ownership_transfers WHERE registered_card_id = '00000000-0000-4000-8000-0000b11c0005' ORDER BY created_at DESC LIMIT 1), 'cancelled',
  'the cancelled transfer is recorded as cancelled');
SELECT is((SELECT count(*)::int FROM public.registered_cards WHERE id IN ('00000000-0000-4000-8000-0000b11c0004', '00000000-0000-4000-8000-0000b11c0005')
             AND custody_status::text = 'owned'), 2, 'custody status is unchanged on both cards');

-- ── Bystander C is unaffected ───────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100003');
SELECT lives_ok($$ SELECT public.initiate_ownership_transfer('00000000-0000-4000-8000-0000b11c0003', 'ubt_a', 'gift') $$, 'C can still send a transfer to A');
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100001');
SELECT lives_ok($$ SELECT public.accept_ownership_transfer((SELECT id FROM public.ownership_transfers WHERE registered_card_id = '00000000-0000-4000-8000-0000b11c0003' AND status = 'pending')) $$,
  'A can accept C''s transfer');
RESET ROLE;
SELECT is((SELECT current_owner_id FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000b11c0003'), '00000000-0000-4000-8000-0000b1100001'::uuid,
  'K3 moved to A normally');

-- ── Unblocking restores new transfers; the reverse block works too ──────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100001');
SELECT lives_ok($$ SELECT public.unblock_collector('00000000-0000-4000-8000-0000b1100002') $$, 'A unblocks B');
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100002');
SELECT lives_ok($$ SELECT public.initiate_ownership_transfer('00000000-0000-4000-8000-0000b11c0001', 'ubt_a', 'sale') $$, 'after unblocking, B can send A a transfer');
RESET ROLE;
SELECT ok(EXISTS (SELECT 1 FROM public.notifications WHERE type = 'ownership_transfer_requested' AND actor_id = '00000000-0000-4000-8000-0000b1100002'
             AND user_id = '00000000-0000-4000-8000-0000b1100001' AND NOT read AND registered_card_id = '00000000-0000-4000-8000-0000b11c0001'),
  '…and A gets the request notification');

SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100002');
SELECT lives_ok($$ SELECT public.cancel_ownership_transfer((SELECT id FROM public.ownership_transfers WHERE registered_card_id = '00000000-0000-4000-8000-0000b11c0001' AND status = 'pending')) $$,
  'B cancels that request (cleanup)');
SELECT lives_ok($$ SELECT public.block_collector('00000000-0000-4000-8000-0000b1100001') $$, 'B blocks A');
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100001');
SELECT throws_ok($$ SELECT public.initiate_ownership_transfer('00000000-0000-4000-8000-0000b11c0002', 'ubt_b', 'gift') $$,
  'P0001', 'Recipient not found', 'when B blocks A, A cannot send B a transfer');
SELECT pg_temp.login('00000000-0000-4000-8000-0000b1100002');
SELECT throws_ok($$ SELECT public.initiate_ownership_transfer('00000000-0000-4000-8000-0000b11c0001', 'ubt_a', 'gift') $$,
  'P0001', 'Recipient not found', '…and B (the blocker) cannot send A one either');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
