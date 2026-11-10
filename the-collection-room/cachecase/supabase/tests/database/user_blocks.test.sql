-- pgTAP test for 20261112120000_add_user_blocks.sql (collector blocking,
-- App Store moderation Phase 1B — database layer).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(80);

-- ── Helpers ─────────────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated;

-- ── 1. Shape, privileges, catalog coverage ──────────────────────────────
SELECT has_table('public', 'user_blocks', 'user_blocks exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_blocks'::regclass), 'RLS is on');
SELECT ok(NOT has_table_privilege('anon', 'public.user_blocks', 'SELECT,INSERT,UPDATE,DELETE'), 'anon has no access to block lists');
SELECT ok(has_table_privilege('authenticated', 'public.user_blocks', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.user_blocks', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.user_blocks', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.user_blocks', 'DELETE'),
  'signed-in clients can only read (their own rows, via RLS)');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.user_blocks'::regclass AND contype = 'p'), 'the pair is the primary key (unique)');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocks_not_self'), 'self-blocking is impossible by constraint');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'public.user_blocks'::regclass AND contype = 'f' AND confdeltype = 'c'), 2,
  'both sides cascade when an account is deleted');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'user_blocks_blocked_idx'), 'reverse lookup index exists');
SELECT ok(EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.user_blocks'::regclass AND polname = 'account_lifecycle_read_guard' AND NOT polpermissive),
  'user_blocks carries the lifecycle read guard');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.user_blocks'::regclass AND tgname = 'account_write_guard'),
  'user_blocks carries the lifecycle write guard');

CREATE TEMP TABLE ub_fns AS
  SELECT unnest(ARRAY[
    'private.blocked_by_me()', 'private.blocked_me()', 'private.block_related_ids()', 'private.users_blocked(uuid,uuid)',
    'private.reject_blocked_interaction()', 'private.suppress_blocked_notification()',
    'public.block_collector(uuid)', 'public.unblock_collector(uuid)', 'public.list_blocked_collectors(integer,timestamptz)'
  ])::regprocedure AS fn;
SELECT is((SELECT count(*)::int FROM ub_fns t JOIN pg_proc p ON p.oid = t.fn WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""']), 9,
  'every SECURITY DEFINER blocking function pins an empty search_path');
SELECT ok((SELECT NOT prosecdef FROM pg_proc WHERE oid = 'public.get_block_status(uuid)'::regprocedure), 'get_block_status runs as the caller');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.block_collector(uuid)', 'public.unblock_collector(uuid)',
             'public.list_blocked_collectors(integer,timestamptz)', 'public.get_block_status(uuid)']::regprocedure[]) f
           WHERE has_function_privilege('anon', f, 'EXECUTE')), 0, 'signed-out callers cannot use the blocking functions');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.block_collector(uuid)', 'public.unblock_collector(uuid)',
             'public.list_blocked_collectors(integer,timestamptz)', 'public.get_block_status(uuid)']::regprocedure[]) f
           WHERE has_function_privilege('authenticated', f, 'EXECUTE')), 4, 'signed-in collectors can');
SELECT ok(NOT has_function_privilege('authenticated', 'private.reject_blocked_interaction()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'private.suppress_blocked_notification()', 'EXECUTE'),
  'the trigger functions are not callable by clients');

SELECT is((SELECT string_agg(c.relname, ', ') FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           WHERE t.tgname = 'interaction_target_guard' AND c.relname <> 'ownership_transfers'
             AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = t.tgrelid AND g.tgname = 'user_block_guard')), NULL,
  'every lifecycle-guarded interaction table (except Transfers) also has user_block_guard');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ownership_transfers'::regclass AND tgname LIKE 'user_block%'),
  'Transfers is deliberately not guarded (release dependency)');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.posts'::regclass AND tgname IN ('user_block_guard_repost', 'user_block_guard_quote')), 2,
  'reposts and quotes are guarded');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.messages'::regclass AND tgname = 'user_block_guard_attachment'),
  'sharing a blocked collector''s item in a message is guarded');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.grail_ratings'::regclass
             AND tgname IN ('user_block_guard_repoint', 'interaction_target_guard_repoint')), 2,
  'grail ratings are guarded against re-pointing (blocking and lifecycle)');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.notifications'::regclass AND tgname = 'user_block_notification_guard'),
  'notifications between a blocked pair are suppressed');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND policyname = 'user_block_read_guard'), 20,
  '20 tables have the block read guard');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND policyname = 'user_block_read_guard'
             AND (permissive <> 'RESTRICTIVE' OR roles <> '{authenticated}' OR cmd <> 'SELECT')), 0,
  'every block read guard is RESTRICTIVE, SELECT-only and signed-in only (anon reads unchanged)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND policyname = 'user_block_read_guard'
             AND tablename IN ('messages', 'conversations', 'conversation_participants')), 0,
  'direct-message history is not hidden');
SELECT ok((SELECT bool_and(qual ~ '\(\s*SELECT private\.(block_related_ids|blocked_me)\(\)' AND qual !~ 'users_blocked\(') FROM pg_policies WHERE schemaname = 'public' AND policyname = 'user_block_read_guard'),
  'every read guard evaluates its set once per statement (no per-row function call)');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- A blocks B; C is a bystander; D is pending deletion; E/F test cascades.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000b10c0001', 'ub-a@example.invalid', '{"username":"ub_a"}'),
  ('00000000-0000-4000-8000-0000b10c0002', 'ub-b@example.invalid', '{"username":"ub_b"}'),
  ('00000000-0000-4000-8000-0000b10c0003', 'ub-c@example.invalid', '{"username":"ub_c"}'),
  ('00000000-0000-4000-8000-0000b10c0004', 'ub-d@example.invalid', '{"username":"ub_d"}'),
  ('00000000-0000-4000-8000-0000b10c0005', 'ub-e@example.invalid', '{"username":"ub_e"}'),
  ('00000000-0000-4000-8000-0000b10c0006', 'ub-f@example.invalid', '{"username":"ub_f"}');
INSERT INTO public.folders (id, user_id, name, is_public) VALUES
  ('00000000-0000-4000-8000-0000b10f0001', '00000000-0000-4000-8000-0000b10c0001', 'ub a binder', true),
  ('00000000-0000-4000-8000-0000b10f0002', '00000000-0000-4000-8000-0000b10c0002', 'ub b binder', true);
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status, item_type) VALUES
  ('00000000-0000-4000-8000-0000b10e0001', '00000000-0000-4000-8000-0000b10f0001', '00000000-0000-4000-8000-0000b10c0001', 'ub a card', true, 'active', 'sports_card'),
  ('00000000-0000-4000-8000-0000b10e0002', '00000000-0000-4000-8000-0000b10f0002', '00000000-0000-4000-8000-0000b10c0002', 'ub b card', true, 'active', 'sports_card');
INSERT INTO public.posts (id, user_id, content, post_type) VALUES
  ('00000000-0000-4000-8000-0000b10d0001', '00000000-0000-4000-8000-0000b10c0001', 'ub post by A', 'text'),
  ('00000000-0000-4000-8000-0000b10d0011', '00000000-0000-4000-8000-0000b10c0001', 'ub second post by A', 'text'),
  ('00000000-0000-4000-8000-0000b10d0002', '00000000-0000-4000-8000-0000b10c0002', 'ub post by B', 'text'),
  ('00000000-0000-4000-8000-0000b10d0003', '00000000-0000-4000-8000-0000b10c0003', 'ub post by C', 'text'),
  ('00000000-0000-4000-8000-0000b10d0004', '00000000-0000-4000-8000-0000b10c0004', 'ub post by D', 'text');
INSERT INTO public.follows (follower_id, following_id) VALUES
  ('00000000-0000-4000-8000-0000b10c0002', '00000000-0000-4000-8000-0000b10c0001'),
  ('00000000-0000-4000-8000-0000b10c0001', '00000000-0000-4000-8000-0000b10c0002'),
  ('00000000-0000-4000-8000-0000b10c0003', '00000000-0000-4000-8000-0000b10c0001');
INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by) VALUES
  ('00000000-0000-4000-8000-0000b10e0001', '00000000-0000-4000-8000-0000b10c0002', '00000000-0000-4000-8000-0000b10c0001'),
  ('00000000-0000-4000-8000-0000b10e0002', '00000000-0000-4000-8000-0000b10c0001', '00000000-0000-4000-8000-0000b10c0002');
INSERT INTO public.notifications (id, user_id, actor_id, type, post_id, read) VALUES
  ('00000000-0000-4000-8000-0000b1000001', '00000000-0000-4000-8000-0000b10c0001', '00000000-0000-4000-8000-0000b10c0002', 'like', '00000000-0000-4000-8000-0000b10d0001', false),
  ('00000000-0000-4000-8000-0000b1000003', '00000000-0000-4000-8000-0000b10c0001', '00000000-0000-4000-8000-0000b10c0003', 'like', '00000000-0000-4000-8000-0000b10d0001', false);
INSERT INTO public.conversations (id) VALUES ('00000000-0000-4000-8000-0000b10a0001');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000b10a0001', '00000000-0000-4000-8000-0000b10c0001'),
  ('00000000-0000-4000-8000-0000b10a0001', '00000000-0000-4000-8000-0000b10c0002');
INSERT INTO public.messages (id, conversation_id, sender_id, body) VALUES
  ('00000000-0000-4000-8000-0000b10b0001', '00000000-0000-4000-8000-0000b10a0001', '00000000-0000-4000-8000-0000b10c0002', 'hello from B before the block');
INSERT INTO public.grail_ratings (id, post_id, rater_user_id, score) VALUES
  ('00000000-0000-4000-8000-0000b1090002', '00000000-0000-4000-8000-0000b10d0002', '00000000-0000-4000-8000-0000b10c0003', 7),
  ('00000000-0000-4000-8000-0000b1090003', '00000000-0000-4000-8000-0000b10d0003', '00000000-0000-4000-8000-0000b10c0002', 6);
INSERT INTO public.account_lifecycle (user_id, state, mode, requested_at, scheduled_for)
  VALUES ('00000000-0000-4000-8000-0000b10c0004', 'pending_deletion', 'scheduled', now(), now() + interval '30 days');

-- ── 2. block_collector / unblock_collector ──────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b10c0001');
SELECT is(public.block_collector('00000000-0000-4000-8000-0000b10c0002'), '{"status": "blocked", "already_blocked": false}'::jsonb, 'A blocks B');
SELECT is(public.block_collector('00000000-0000-4000-8000-0000b10c0002'), '{"status": "blocked", "already_blocked": true}'::jsonb, 'blocking again is idempotent');
SELECT throws_ok($$ SELECT public.block_collector('00000000-0000-4000-8000-0000b10c0001') $$, '22023', 'cannot_block_self', 'a collector cannot block themselves');
SELECT throws_ok($$ SELECT public.block_collector(NULL) $$, '22023', 'account_unavailable', 'a missing target is refused');
SELECT throws_ok($$ SELECT public.block_collector('00000000-0000-4000-8000-0000b10cffff') $$, '42501', 'account_unavailable', 'an unknown collector gets the neutral token');
SELECT throws_ok($$ SELECT public.block_collector('00000000-0000-4000-8000-0000b10c0004') $$, '42501', 'account_unavailable', 'a pending-deletion collector gets the same neutral token');
SELECT is((SELECT count(*)::int FROM public.user_blocks), 1, 'A sees exactly their own block');
SELECT is(public.get_block_status('00000000-0000-4000-8000-0000b10c0002'), '{"blocked_by_me": true}'::jsonb, 'A''s status shows the block');
SELECT is((SELECT count(*)::int FROM public.list_blocked_collectors()), 1, 'A''s block list has B');
SELECT is((SELECT username FROM public.list_blocked_collectors()), 'ub_b', 'with B''s public username');
SELECT throws_ok($$ DELETE FROM public.user_blocks $$, '42501', NULL, 'A cannot change the table directly');

SELECT pg_temp.login('00000000-0000-4000-8000-0000b10c0002');
SELECT is((SELECT count(*)::int FROM public.user_blocks), 0, 'B cannot see that A blocked them');
SELECT is(public.get_block_status('00000000-0000-4000-8000-0000b10c0001'), '{"blocked_by_me": false}'::jsonb, 'B''s status reveals nothing about A''s block');
SELECT is((SELECT count(*)::int FROM public.list_blocked_collectors()), 0, 'B''s own block list is empty');
SELECT throws_ok($$ INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES ('00000000-0000-4000-8000-0000b10c0002', '00000000-0000-4000-8000-0000b10c0003') $$,
  '42501', NULL, 'B cannot insert a block directly');

SELECT pg_temp.login('00000000-0000-4000-8000-0000b10c0003');
SELECT is((SELECT count(*)::int FROM public.user_blocks), 0, 'C cannot read anyone else''s block list');
RESET ROLE;

SELECT is((SELECT count(*)::int FROM public.follows WHERE follower_id IN ('00000000-0000-4000-8000-0000b10c0001', '00000000-0000-4000-8000-0000b10c0002')
             AND following_id IN ('00000000-0000-4000-8000-0000b10c0001', '00000000-0000-4000-8000-0000b10c0002')), 0, 'follows in both directions are removed');
SELECT ok(EXISTS (SELECT 1 FROM public.follows WHERE follower_id = '00000000-0000-4000-8000-0000b10c0003'), 'C''s follow of A is untouched');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id IN ('00000000-0000-4000-8000-0000b10e0001', '00000000-0000-4000-8000-0000b10e0002')), 0,
  'tags in both directions are removed');
SELECT ok((SELECT read FROM public.notifications WHERE id = '00000000-0000-4000-8000-0000b1000001'), 'B''s unread notification to A was marked read (not deleted)');
SELECT ok(NOT (SELECT read FROM public.notifications WHERE id = '00000000-0000-4000-8000-0000b1000003'), 'C''s notification to A is untouched');

-- ── 3. Interactions refused in both directions ──────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b10c0002');
SELECT throws_ok($$ INSERT INTO public.follows (follower_id, following_id) VALUES ('00000000-0000-4000-8000-0000b10c0002', '00000000-0000-4000-8000-0000b10c0001') $$,
  '42501', 'account_unavailable', 'B cannot follow A');
SELECT throws_ok($$ INSERT INTO public.likes (user_id, post_id) VALUES ('00000000-0000-4000-8000-0000b10c0002', '00000000-0000-4000-8000-0000b10d0001') $$,
  '42501', 'account_unavailable', 'B cannot like A''s post (even knowing its id)');
SELECT throws_ok($$ INSERT INTO public.comments (user_id, post_id, body) VALUES ('00000000-0000-4000-8000-0000b10c0002', '00000000-0000-4000-8000-0000b10d0001', 'x') $$,
  '42501', 'account_unavailable', 'B cannot comment on A''s post');
SELECT throws_ok($$ INSERT INTO public.messages (conversation_id, sender_id, body) VALUES ('00000000-0000-4000-8000-0000b10a0001', '00000000-0000-4000-8000-0000b10c0002', 'x') $$,
  '42501', 'account_unavailable', 'B cannot message A in their existing conversation');
SELECT throws_ok($$ SELECT public.get_or_create_conversation('00000000-0000-4000-8000-0000b10c0001') $$,
  '42501', 'account_unavailable', 'B cannot open a conversation with A');
SELECT throws_ok($$ UPDATE public.grail_ratings SET post_id = '00000000-0000-4000-8000-0000b10d0001' WHERE id = '00000000-0000-4000-8000-0000b1090003' $$,
  '42501', 'account_unavailable', 'B cannot re-point an existing rating onto A''s post');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000b10a0001'), 1, 'B still reads the conversation history');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000b10c0001'), 0, 'B cannot see A''s profile');
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000b10c0001'), 0, 'B cannot see A''s posts');
SELECT is((SELECT count(*)::int FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000b10c0001'), 0, 'B cannot see A''s items');
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000b10c0003'), 1, 'B still sees C''s posts');

SELECT pg_temp.login('00000000-0000-4000-8000-0000b10c0001');
SELECT throws_ok($$ INSERT INTO public.follows (follower_id, following_id) VALUES ('00000000-0000-4000-8000-0000b10c0001', '00000000-0000-4000-8000-0000b10c0002') $$,
  '42501', 'account_unavailable', 'A cannot follow B either');
SELECT throws_ok($$ INSERT INTO public.messages (conversation_id, sender_id, body) VALUES ('00000000-0000-4000-8000-0000b10a0001', '00000000-0000-4000-8000-0000b10c0001', 'x') $$,
  '42501', 'account_unavailable', 'A cannot message B either');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000b10a0001'), 1, 'A still reads the conversation history');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000b10c0002'), 1, 'A can still open B''s profile (to unblock)');
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000b10c0002'), 0, 'A does not see B''s posts');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE actor_id = '00000000-0000-4000-8000-0000b10c0002'), 0, 'A does not see B''s notifications while blocked');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE actor_id = '00000000-0000-4000-8000-0000b10c0003'), 1, 'A still sees C''s notification');

SELECT pg_temp.login('00000000-0000-4000-8000-0000b10c0003');
SELECT lives_ok($$ INSERT INTO public.likes (user_id, post_id) VALUES ('00000000-0000-4000-8000-0000b10c0003', '00000000-0000-4000-8000-0000b10d0002') $$,
  'C can still like B''s post');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id IN ('00000000-0000-4000-8000-0000b10c0001', '00000000-0000-4000-8000-0000b10c0002')), 2, 'C sees both A and B');
RESET ROLE;

SET LOCAL ROLE anon;
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000b10c0001'), 2,
  'signed-out reads of public posts are unchanged (documented limitation)');
RESET ROLE;

-- Notifications: a new or refreshed social notification between the pair is suppressed.
INSERT INTO public.notifications (user_id, actor_id, type, post_id, read)
  VALUES ('00000000-0000-4000-8000-0000b10c0001', '00000000-0000-4000-8000-0000b10c0002', 'like', '00000000-0000-4000-8000-0000b10d0011', false);
SELECT is((SELECT count(*)::int FROM public.notifications WHERE actor_id = '00000000-0000-4000-8000-0000b10c0002' AND type = 'like'), 1,
  'a new notification from B to A is dropped (only the pre-block like remains)');
UPDATE public.notifications SET read = false, created_at = now() WHERE id = '00000000-0000-4000-8000-0000b1000001';
SELECT ok((SELECT read FROM public.notifications WHERE id = '00000000-0000-4000-8000-0000b1000001'), 'refreshing B''s old notification to unread is skipped');

-- ── 4. Unblock ──────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b10c0001');
SELECT is(public.unblock_collector('00000000-0000-4000-8000-0000b10c0002'), '{"status": "unblocked", "was_blocked": true}'::jsonb, 'A unblocks B');
SELECT is(public.unblock_collector('00000000-0000-4000-8000-0000b10c0002'), '{"status": "unblocked", "was_blocked": false}'::jsonb, 'unblocking again is idempotent');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE actor_id = '00000000-0000-4000-8000-0000b10c0002' AND NOT read), 0,
  'no old notification resurfaces as unread');
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000b10c0002'), 1, 'A sees B''s posts again');
SELECT is((SELECT count(*)::int FROM public.follows WHERE follower_id = '00000000-0000-4000-8000-0000b10c0001' AND following_id = '00000000-0000-4000-8000-0000b10c0002'), 0,
  'follows are not restored');
SELECT pg_temp.login('00000000-0000-4000-8000-0000b10c0002');
SELECT lives_ok($$ INSERT INTO public.follows (follower_id, following_id) VALUES ('00000000-0000-4000-8000-0000b10c0002', '00000000-0000-4000-8000-0000b10c0001') $$,
  'after unblocking, B can follow A again');
RESET ROLE;

-- ── 5. Lifecycle fix: no re-pointing a rating at a hidden account's post ─
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b10c0003');
SELECT throws_ok($$ UPDATE public.grail_ratings SET post_id = '00000000-0000-4000-8000-0000b10d0004' WHERE id = '00000000-0000-4000-8000-0000b1090002' $$,
  '42501', 'account_unavailable', 'a rating cannot be re-pointed at a pending-deletion collector''s post');
SELECT lives_ok($$ UPDATE public.grail_ratings SET score = 9 WHERE id = '00000000-0000-4000-8000-0000b1090002' $$,
  'changing the score still works');
SELECT lives_ok($$ UPDATE public.grail_ratings SET post_id = '00000000-0000-4000-8000-0000b10d0001' WHERE id = '00000000-0000-4000-8000-0000b1090002' $$,
  're-pointing between active collectors behaves as before');
RESET ROLE;

-- ── 6. Cascades with account deletion ───────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000b10c0005');
SELECT lives_ok($$ SELECT public.block_collector('00000000-0000-4000-8000-0000b10c0006') $$, 'E blocks F');
RESET ROLE;
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000b10c0006';
SELECT is((SELECT count(*)::int FROM public.user_blocks WHERE blocker_id = '00000000-0000-4000-8000-0000b10c0005'), 0,
  'deleting the blocked account removes the block');

SELECT * FROM finish();
ROLLBACK;
