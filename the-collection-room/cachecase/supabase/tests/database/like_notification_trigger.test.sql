-- pgTAP test for 20261020120000_delete_like_notification_on_unlike.sql.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(15);

-- ── Function and trigger shape ─────────────────────────────────────────
SELECT has_function('public', 'delete_like_notification_on_unlike', ARRAY[]::text[], 'trigger function exists');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.delete_like_notification_on_unlike()'::regprocedure), true, 'function is SECURITY DEFINER');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.delete_like_notification_on_unlike()'::regprocedure), ARRAY['search_path=""'], 'search_path is pinned to empty');
SELECT has_trigger('public', 'likes', 'likes_delete_like_notification', 'AFTER DELETE trigger exists on likes');
SELECT ok(NOT has_function_privilege('authenticated', 'public.delete_like_notification_on_unlike()', 'EXECUTE'), 'authenticated cannot execute it directly');
SELECT ok(NOT has_function_privilege('anon', 'public.delete_like_notification_on_unlike()', 'EXECUTE'), 'anon cannot execute it directly');

-- ── Fixtures: A likes/comments/follows/messages B; C also likes B's post ─
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-00000000000a', 'trg-a@example.invalid', '{"username":"trg_test_a"}'),
  ('00000000-0000-4000-8000-00000000000b', 'trg-b@example.invalid', '{"username":"trg_test_b"}'),
  ('00000000-0000-4000-8000-00000000000c', 'trg-c@example.invalid', '{"username":"trg_test_c"}');
INSERT INTO public.posts (id, user_id, post_type, content) VALUES
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-00000000000b', 'text', 'trigger test post');
INSERT INTO public.likes (user_id, post_id) VALUES
  ('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000f1'),
  ('00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-0000000000f1');
INSERT INTO public.conversations (id) VALUES ('00000000-0000-4000-8000-0000000000c1');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000000b');
INSERT INTO public.notifications (id, user_id, actor_id, type, post_id, conversation_id) VALUES
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 'like', '00000000-0000-4000-8000-0000000000f1', NULL),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 'comment', '00000000-0000-4000-8000-0000000000f1', NULL),
  ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 'follow', NULL, NULL),
  ('00000000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 'message', NULL, '00000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c', 'like', '00000000-0000-4000-8000-0000000000f1', NULL);

-- ── As user A, through RLS, exactly like the app ───────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', true);

-- The bug the trigger fixes: the app's client-side cleanup matches nothing.
WITH d AS (
  DELETE FROM public.notifications
  WHERE actor_id = '00000000-0000-4000-8000-00000000000a' AND post_id = '00000000-0000-4000-8000-0000000000f1' AND type = 'like'
  RETURNING 1
)
SELECT is((SELECT count(*) FROM d)::int, 0, 'client-side notification delete as the actor matches 0 rows (RLS)');

-- The unlike itself.
DELETE FROM public.likes WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND post_id = '00000000-0000-4000-8000-0000000000f1';
RESET ROLE;

SELECT is((SELECT count(*) FROM public.likes WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND post_id = '00000000-0000-4000-8000-0000000000f1')::int, 0, 'A''s like is deleted');
SELECT is((SELECT count(*) FROM public.notifications WHERE id = '00000000-0000-4000-8000-0000000000a1')::int, 0, 'A''s like notification is removed by the trigger');
SELECT is((SELECT count(*) FROM public.notifications WHERE id = '00000000-0000-4000-8000-0000000000c2')::int, 1, 'C''s like notification on the same post is untouched');
SELECT is((SELECT count(*) FROM public.notifications WHERE id = '00000000-0000-4000-8000-0000000000a2')::int, 1, 'A''s comment notification is untouched');
SELECT is((SELECT count(*) FROM public.notifications WHERE id = '00000000-0000-4000-8000-0000000000a3')::int, 1, 'A''s follow notification is untouched');
SELECT is((SELECT count(*) FROM public.notifications WHERE id = '00000000-0000-4000-8000-0000000000a4')::int, 1, 'A''s message notification is untouched');

-- A like with no notification deletes cleanly.
DELETE FROM public.notifications WHERE id = '00000000-0000-4000-8000-0000000000c2';
SELECT lives_ok(
  $$DELETE FROM public.likes WHERE user_id = '00000000-0000-4000-8000-00000000000c' AND post_id = '00000000-0000-4000-8000-0000000000f1'$$,
  'unliking when no notification exists does not fail'
);
SELECT is((SELECT count(*) FROM public.likes WHERE post_id = '00000000-0000-4000-8000-0000000000f1')::int, 0, 'that like is deleted too');

SELECT * FROM finish();
ROLLBACK;
