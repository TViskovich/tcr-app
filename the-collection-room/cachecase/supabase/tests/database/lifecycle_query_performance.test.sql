-- pgTAP test for 20261107130000_lifecycle_query_performance.sql
-- (Checkpoint 5): the missing read-path indexes exist, the lifecycle guards
-- no longer call a function per row, and they hide exactly what they hid
-- before (the behaviour itself is covered in depth by
-- account_lifecycle.test.sql and account_lifecycle_dm.test.sql, which run
-- against the rewritten policies).
-- Run against the LOCAL database only:  supabase test db

BEGIN;
SELECT plan(22);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated;

-- ── 1. Indexes ──────────────────────────────────────────────────────────
SELECT has_index('public', 'posts', 'posts_created_at_idx', 'feed: posts by date');
SELECT has_index('public', 'posts', 'posts_user_created_at_idx', 'profile: a collector’s posts by date');
SELECT has_index('public', 'likes', 'likes_post_id_idx', 'likes of a post');
SELECT has_index('public', 'comments', 'comments_post_id_created_at_idx', 'comments of a post');
SELECT has_index('public', 'messages', 'messages_conversation_created_at_idx', 'a conversation’s messages by date');
SELECT has_index('public', 'follows', 'follows_following_id_idx', 'a collector’s followers');
SELECT has_index('public', 'notifications', 'notifications_user_created_at_idx', 'a collector’s notifications by date');

-- ── 2. No per-row function calls left in the guards ─────────────────────
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'
             AND policyname IN ('account_lifecycle_read_guard', 'account_lifecycle_conversation_guard')
             AND (qual LIKE '%private.account_is_hidden(%' OR qual LIKE '%private.conversation_has_hidden_participant(%')), 0,
  'no lifecycle guard calls a function per row');
SELECT ok((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname = 'account_lifecycle_read_guard'
             AND qual LIKE '%hidden_account_ids%') = 22, 'all 22 owner-hiding guards use the per-query hidden set');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND policyname = 'account_lifecycle_conversation_guard'
             AND qual LIKE '%hidden_conversation_ids%'), 3, 'the three conversation guards use the per-query set');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'
             AND policyname IN ('account_lifecycle_read_guard', 'account_lifecycle_conversation_guard') AND permissive <> 'RESTRICTIVE'), 0,
  'every guard is still RESTRICTIVE');

-- ── 3. Same visibility ──────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000e1c00001', 'qp-a@example.invalid', '{"username":"qp_alpha"}'),
  ('00000000-0000-4000-8000-0000e1c00002', 'qp-b@example.invalid', '{"username":"qp_beta"}'),
  ('00000000-0000-4000-8000-0000e1c00003', 'qp-c@example.invalid', '{"username":"qp_gamma"}');
INSERT INTO public.posts (id, user_id, post_type, content) VALUES
  ('00000000-0000-4000-8000-0000e1d00001', '00000000-0000-4000-8000-0000e1c00001', 'text', 'A post'),
  ('00000000-0000-4000-8000-0000e1d00002', '00000000-0000-4000-8000-0000e1c00002', 'text', 'B post');
INSERT INTO public.comments (user_id, post_id, body) VALUES
  ('00000000-0000-4000-8000-0000e1c00001', '00000000-0000-4000-8000-0000e1d00002', 'A on B'),
  ('00000000-0000-4000-8000-0000e1c00003', '00000000-0000-4000-8000-0000e1d00002', 'C on B'),
  ('00000000-0000-4000-8000-0000e1c00003', '00000000-0000-4000-8000-0000e1d00001', 'C on A');
INSERT INTO public.likes (user_id, post_id) VALUES
  ('00000000-0000-4000-8000-0000e1c00001', '00000000-0000-4000-8000-0000e1d00002'),
  ('00000000-0000-4000-8000-0000e1c00003', '00000000-0000-4000-8000-0000e1d00002');
INSERT INTO public.conversations (id) VALUES ('00000000-0000-4000-8000-0000e1e000ab'), ('00000000-0000-4000-8000-0000e1e000bc');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000e1e000ab', '00000000-0000-4000-8000-0000e1c00001'),
  ('00000000-0000-4000-8000-0000e1e000ab', '00000000-0000-4000-8000-0000e1c00002'),
  ('00000000-0000-4000-8000-0000e1e000bc', '00000000-0000-4000-8000-0000e1c00002'),
  ('00000000-0000-4000-8000-0000e1e000bc', '00000000-0000-4000-8000-0000e1c00003');
INSERT INTO public.messages (conversation_id, sender_id, body) VALUES
  ('00000000-0000-4000-8000-0000e1e000ab', '00000000-0000-4000-8000-0000e1c00002', 'B to A'),
  ('00000000-0000-4000-8000-0000e1e000bc', '00000000-0000-4000-8000-0000e1c00002', 'B to C');
-- A is pending deletion.
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for)
VALUES ('00000000-0000-4000-8000-0000e1c00001', 'pending_deletion', 'scheduled', now() + interval '14 days');

SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e1c00002');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id::text LIKE '00000000-0000-4000-8000-0000e1c0000%'), 2, 'B sees B and C, not A');
SELECT is((SELECT array_agg(content ORDER BY content) FROM public.posts WHERE id::text LIKE '00000000-0000-4000-8000-0000e1d0000%'), ARRAY['B post'],
  'B sees B’s post, not A’s');
SELECT is((SELECT array_agg(body ORDER BY body) FROM public.comments WHERE post_id::text LIKE '00000000-0000-4000-8000-0000e1d0000%'), ARRAY['C on B'],
  'comments by A and on A’s post are hidden; C’s comment on B’s post shows');
SELECT is((SELECT count(*)::int FROM public.likes WHERE post_id = '00000000-0000-4000-8000-0000e1d00002'), 1, 'A’s like is hidden, C’s shows');
SELECT is((SELECT array_agg(body) FROM public.messages), ARRAY['B to C'], 'the conversation with A is hidden from B; B↔C shows');
SELECT is((SELECT count(*)::int FROM public.conversations WHERE id::text LIKE '00000000-0000-4000-8000-0000e1e000%'), 1, 'B sees one conversation');
SELECT is((SELECT count(*)::int FROM public.conversation_participants WHERE conversation_id = '00000000-0000-4000-8000-0000e1e000ab'), 0,
  'and none of the hidden conversation’s participants');
-- A row whose owner column is NULL is not hidden (as before), even while
-- someone is hidden.
SELECT ok(NOT COALESCE((NULL::uuid = ANY ((SELECT private.hidden_account_ids())::uuid[])), false), 'a NULL owner is not hidden');
RESET ROLE;
-- Cancelling restores everything at once.
DELETE FROM public.account_lifecycle WHERE user_id = '00000000-0000-4000-8000-0000e1c00001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e1c00002');
SELECT is((SELECT count(*)::int FROM public.comments WHERE post_id::text LIKE '00000000-0000-4000-8000-0000e1d0000%'), 3, 'after cancelling, A’s comments show again');
SELECT is((SELECT count(*)::int FROM public.messages), 2, 'and the conversation with A');
-- A collector pending deletion sees nothing but their own lifecycle row.
RESET ROLE;
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for)
VALUES ('00000000-0000-4000-8000-0000e1c00001', 'pending_deletion', 'scheduled', now() + interval '14 days');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e1c00001');
SELECT is((SELECT count(*)::int FROM public.posts) + (SELECT count(*)::int FROM public.profiles) + (SELECT count(*)::int FROM public.messages), 0,
  'the hidden collector themselves sees nothing');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
