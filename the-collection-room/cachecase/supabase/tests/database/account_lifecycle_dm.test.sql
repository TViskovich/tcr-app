-- pgTAP test for 20261104120000_account_lifecycle_dm_privacy.sql (direct
-- messages while a participant is pending deletion).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.
--
-- A goes pending. B has a conversation with A (two messages and a photo)
-- and another with C, which must stay untouched.

BEGIN;
SELECT plan(39);

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
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.logout() TO authenticated, anon, service_role;

-- ── Shape ───────────────────────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polname = 'account_lifecycle_conversation_guard' AND NOT polpermissive AND polcmd = 'r'
             AND polrelid IN ('public.conversations'::regclass, 'public.conversation_participants'::regclass, 'public.messages'::regclass)), 3,
  'conversations, participants and messages each have the restrictive conversation guard');
SELECT ok(EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'storage.objects'::regclass AND polname = 'account_lifecycle_dm_attachment_guard'
             AND NOT polpermissive AND polcmd = 'r'), 'DM photo attachments have the same guard in Storage');
SELECT ok((SELECT prosecdef AND proconfig = ARRAY['search_path=""'] FROM pg_proc
           WHERE oid = 'private.conversation_has_hidden_participant(uuid)'::regprocedure),
  'the conversation helper is SECURITY DEFINER with a pinned search_path');
SELECT ok((SELECT prosrc LIKE '%account_inactive%' AND prosrc LIKE '%account_unavailable%' FROM pg_proc
           WHERE oid = 'public.get_or_create_conversation(uuid)'::regprocedure),
  'get_or_create_conversation checks both sides');
SELECT ok(has_function_privilege('authenticated', 'public.get_or_create_conversation(uuid)', 'EXECUTE'),
  'get_or_create_conversation keeps its existing grant');

-- ── Fixtures ────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000d1c00001', 'lcdm-a@example.invalid', '{"username":"lcdm_a"}'),
  ('00000000-0000-4000-8000-0000d1c00002', 'lcdm-b@example.invalid', '{"username":"lcdm_b"}'),
  ('00000000-0000-4000-8000-0000d1c00003', 'lcdm-c@example.invalid', '{"username":"lcdm_c"}');
INSERT INTO public.conversations (id) VALUES
  ('00000000-0000-4000-8000-0000d1cb00ab'),
  ('00000000-0000-4000-8000-0000d1cb00bc');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000d1cb00ab', '00000000-0000-4000-8000-0000d1c00001'),
  ('00000000-0000-4000-8000-0000d1cb00ab', '00000000-0000-4000-8000-0000d1c00002'),
  ('00000000-0000-4000-8000-0000d1cb00bc', '00000000-0000-4000-8000-0000d1c00002'),
  ('00000000-0000-4000-8000-0000d1cb00bc', '00000000-0000-4000-8000-0000d1c00003');
INSERT INTO public.messages (id, conversation_id, sender_id, body) VALUES
  ('00000000-0000-4000-8000-0000d1ca0001', '00000000-0000-4000-8000-0000d1cb00ab', '00000000-0000-4000-8000-0000d1c00001', 'from A'),
  ('00000000-0000-4000-8000-0000d1ca0002', '00000000-0000-4000-8000-0000d1cb00ab', '00000000-0000-4000-8000-0000d1c00002', 'from B'),
  ('00000000-0000-4000-8000-0000d1ca0004', '00000000-0000-4000-8000-0000d1cb00bc', '00000000-0000-4000-8000-0000d1c00003', 'from C');
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('dm-attachments', '00000000-0000-4000-8000-0000d1cb00ab/00000000-0000-4000-8000-0000d1ca0003/image.jpg',
   '00000000-0000-4000-8000-0000d1c00001', '00000000-0000-4000-8000-0000d1c00001'),
  ('dm-attachments', '00000000-0000-4000-8000-0000d1cb00bc/00000000-0000-4000-8000-0000d1ca0004/image.jpg',
   '00000000-0000-4000-8000-0000d1c00003', '00000000-0000-4000-8000-0000d1c00003');
INSERT INTO public.messages (id, conversation_id, sender_id, attachment_type, attachment_storage_path, attachment_width, attachment_height) VALUES
  ('00000000-0000-4000-8000-0000d1ca0003', '00000000-0000-4000-8000-0000d1cb00ab', '00000000-0000-4000-8000-0000d1c00001', 'image',
   '00000000-0000-4000-8000-0000d1cb00ab/00000000-0000-4000-8000-0000d1ca0003/image.jpg', 10, 10);

CREATE TEMP TABLE dm_fingerprint AS
  SELECT md5(string_agg(row_to_json(m)::text, '|' ORDER BY m.id)) AS messages,
         (SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY p.user_id)) FROM public.conversation_participants p
            WHERE p.conversation_id = '00000000-0000-4000-8000-0000d1cb00ab') AS participants
  FROM public.messages m WHERE m.conversation_id = '00000000-0000-4000-8000-0000d1cb00ab';

CREATE FUNCTION pg_temp.b_dm() RETURNS TABLE (label text, n int) LANGUAGE sql AS $$
  SELECT 'conv_ab', count(*)::int FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000d1cb00ab'
  UNION ALL SELECT 'parts_ab', count(*)::int FROM public.conversation_participants WHERE conversation_id = '00000000-0000-4000-8000-0000d1cb00ab'
  UNION ALL SELECT 'msgs_ab', count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000d1cb00ab'
  UNION ALL SELECT 'photo_ab', count(*)::int FROM storage.objects WHERE bucket_id = 'dm-attachments'
                                  AND name LIKE '00000000-0000-4000-8000-0000d1cb00ab/%'
  UNION ALL SELECT 'conv_bc', count(*)::int FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000d1cb00bc'
  UNION ALL SELECT 'msgs_bc', count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000d1cb00bc'
  UNION ALL SELECT 'photo_bc', count(*)::int FROM storage.objects WHERE bucket_id = 'dm-attachments'
                                  AND name LIKE '00000000-0000-4000-8000-0000d1cb00bc/%'
  UNION ALL SELECT 'my_rows', count(*)::int FROM public.conversation_participants WHERE user_id = '00000000-0000-4000-8000-0000d1c00002';
$$;
GRANT EXECUTE ON FUNCTION pg_temp.b_dm() TO authenticated;

-- ── Baseline ────────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1c00002');
CREATE TEMP TABLE dm_before AS SELECT * FROM pg_temp.b_dm();
RESET ROLE;
SELECT pg_temp.logout();
SELECT is((SELECT n FROM dm_before WHERE label = 'conv_ab'), 1, 'baseline: B sees the conversation with A');
SELECT is((SELECT n FROM dm_before WHERE label = 'parts_ab'), 2, 'baseline: B sees both participants');
SELECT is((SELECT n FROM dm_before WHERE label = 'msgs_ab'), 3, 'baseline: B sees all three messages (A, B, A''s photo)');
SELECT is((SELECT n FROM dm_before WHERE label = 'photo_ab'), 1, 'baseline: B can read A''s DM photo object');
SELECT is((SELECT n FROM dm_before WHERE label = 'my_rows'), 2, 'baseline: B has two conversations in the inbox');

-- ── A goes pending ──────────────────────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT is((SELECT state FROM public.schedule_account_deletion('00000000-0000-4000-8000-0000d1c00001')), 'pending_deletion', 'A is scheduled');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1c00002');
CREATE TEMP TABLE dm_during AS SELECT * FROM pg_temp.b_dm();
SELECT is((SELECT n FROM dm_during WHERE label = 'conv_ab'), 0, 'B: the conversation with A is unavailable');
SELECT is((SELECT n FROM dm_during WHERE label = 'parts_ab'), 0, 'B: its participant rows are unavailable (inbox drops it)');
SELECT is((SELECT n FROM dm_during WHERE label = 'msgs_ab'), 0, 'B: its messages are unavailable, B''s own included');
SELECT is((SELECT n FROM dm_during WHERE label = 'photo_ab'), 0, 'B: A''s DM photo cannot be read through Storage');
SELECT is((SELECT n FROM dm_during WHERE label = 'my_rows'), 1, 'B: only the conversation with C remains in the inbox');
SELECT is((SELECT n FROM dm_during WHERE label = 'conv_bc'), 1, 'B: the conversation with C is untouched');
SELECT is((SELECT n FROM dm_during WHERE label = 'msgs_bc'), 1, 'B: messages with C are untouched');
SELECT is((SELECT n FROM dm_during WHERE label = 'photo_bc'), 1, 'B: photos with C are untouched');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE actor_id = '00000000-0000-4000-8000-0000d1c00001'), 0,
  'B: message notifications from A are hidden');
SELECT throws_ok($$ SELECT public.get_or_create_conversation('00000000-0000-4000-8000-0000d1c00001') $$,
  '42501', 'account_unavailable', 'B cannot reopen the existing conversation with A');
SELECT throws_ok($$ INSERT INTO public.messages (conversation_id, sender_id, body) VALUES
                    ('00000000-0000-4000-8000-0000d1cb00ab', '00000000-0000-4000-8000-0000d1c00002', 'still there?') $$,
  '42501', 'account_unavailable', 'B cannot send into the conversation with A');
-- An UPDATE can't reach rows B can't see: it succeeds and changes nothing
-- (the participant fingerprint after cancellation proves it).
SELECT lives_ok($$ UPDATE public.conversation_participants SET last_read_at = now()
                   WHERE conversation_id = '00000000-0000-4000-8000-0000d1cb00ab' $$,
  'B''s attempt to mark the hidden conversation read reaches no rows');
SELECT lives_ok($$ INSERT INTO public.messages (conversation_id, sender_id, body) VALUES
                   ('00000000-0000-4000-8000-0000d1cb00bc', '00000000-0000-4000-8000-0000d1c00002', 'hi C') $$,
  'B can still message C');
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1c00001');
SELECT throws_ok($$ SELECT public.get_or_create_conversation('00000000-0000-4000-8000-0000d1c00003') $$,
  '42501', 'account_inactive', 'A cannot open conversations while pending');
SELECT is((SELECT count(*)::int FROM public.messages), 0, 'A cannot read any messages while pending');
RESET ROLE;
SELECT pg_temp.logout();

SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT count(*) FROM public.messages $$, '42501', NULL, 'anon cannot read messages at all (existing policy)');
RESET ROLE;

SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000d1cb00ab'), 3,
  'the messages themselves are untouched (internal read)');

-- ── Cancel restores the conversation exactly ────────────────────────────
SET LOCAL ROLE service_role;
SELECT ok(public.cancel_account_deletion('00000000-0000-4000-8000-0000d1c00001'), 'A cancels');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1c00002');
CREATE TEMP TABLE dm_after AS SELECT * FROM pg_temp.b_dm();
SELECT is((SELECT count(*)::int FROM dm_after a JOIN dm_before b USING (label) WHERE a.label NOT IN ('msgs_bc') AND a.n <> b.n), 0,
  'B sees the conversation with A, its participants, messages and photo exactly as before');
SELECT is((SELECT n FROM dm_after WHERE label = 'msgs_bc'), 2, 'B''s new message to C is still there');
SELECT is(public.get_or_create_conversation('00000000-0000-4000-8000-0000d1c00001'), '00000000-0000-4000-8000-0000d1cb00ab'::uuid,
  'B reopens the same conversation with A (not a new one)');
SELECT lives_ok($$ INSERT INTO public.messages (conversation_id, sender_id, body) VALUES
                   ('00000000-0000-4000-8000-0000d1cb00ab', '00000000-0000-4000-8000-0000d1c00002', 'welcome back') $$,
  'B can message A again');
RESET ROLE;
SELECT pg_temp.logout();
SELECT is((SELECT md5(string_agg(row_to_json(m)::text, '|' ORDER BY m.id)) FROM public.messages m
           WHERE m.conversation_id = '00000000-0000-4000-8000-0000d1cb00ab' AND m.id <> ALL (
             SELECT id FROM public.messages WHERE body = 'welcome back')),
  (SELECT messages FROM dm_fingerprint), 'the original messages are byte-for-byte unchanged');
SELECT is((SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY p.user_id)) FROM public.conversation_participants p
           WHERE p.conversation_id = '00000000-0000-4000-8000-0000d1cb00ab'),
  (SELECT participants FROM dm_fingerprint), 'participant rows (incl. read state) are unchanged');

-- ── Deleting state hides too; nothing else regresses ────────────────────
SET LOCAL ROLE service_role;
SELECT is((SELECT state FROM public.begin_account_deletion('00000000-0000-4000-8000-0000d1c00003', 'immediate')), 'deleting', 'C begins deletion');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1c00002');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000d1cb00bc'), 0,
  'a conversation with a deleting collector is unavailable too');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000d1cb00ab'), 4,
  'the conversation with A (active again) is unaffected');
RESET ROLE;
SELECT pg_temp.logout();
SELECT ok(to_regclass('public.conversation_group_departures') IS NULL, 'Group Messaging stays inactive');

SELECT * FROM finish();
ROLLBACK;
