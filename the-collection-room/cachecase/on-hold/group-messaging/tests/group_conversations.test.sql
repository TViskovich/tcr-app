-- pgTAP test for 20261101130000_add_group_conversations.sql (group messaging,
-- M1 Checkpoint 1).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back. (Truly
-- concurrent membership changes need separate sessions; here the row lock
-- that serializes them is asserted structurally.)

BEGIN;
SELECT plan(110);

-- ── Helpers ─────────────────────────────────────────────────────────────
-- Act as a signed-in user (the role is set once below).
CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
-- Named ids created during the test (groups, messages).
CREATE TEMP TABLE ids (name text PRIMARY KEY, id uuid NOT NULL);
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM ids WHERE name = p_name $$;
GRANT ALL ON ids TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.id(text) TO authenticated;

-- ── Shape and privileges ────────────────────────────────────────────────
SELECT has_function('public', 'create_group_conversation', ARRAY['uuid[]', 'text'], 'create_group_conversation exists');
SELECT has_function('public', 'add_group_members', ARRAY['uuid', 'uuid[]'], 'add_group_members exists');
SELECT has_function('public', 'remove_group_member', ARRAY['uuid', 'uuid'], 'remove_group_member exists');
SELECT has_function('public', 'leave_group', ARRAY['uuid'], 'leave_group exists');
SELECT has_function('public', 'rename_group', ARRAY['uuid', 'text'], 'rename_group exists');
SELECT has_function('public', 'set_group_member_role', ARRAY['uuid', 'uuid', 'text'], 'set_group_member_role exists');

CREATE TEMP TABLE group_fns AS
  SELECT unnest(ARRAY[
    'public.create_group_conversation(uuid[],text)', 'public.add_group_members(uuid,uuid[])',
    'public.remove_group_member(uuid,uuid)', 'public.leave_group(uuid)',
    'public.rename_group(uuid,text)', 'public.set_group_member_role(uuid,uuid,text)'
  ])::regprocedure AS fn;
SELECT is((SELECT count(*)::int FROM group_fns g JOIN pg_proc p ON p.oid = g.fn
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""']), 6,
  'every group function is SECURITY DEFINER with a pinned search_path');
SELECT is((SELECT count(*)::int FROM group_fns WHERE has_function_privilege('anon', fn, 'EXECUTE')), 0, 'anon can run none of them');
SELECT is((SELECT count(*)::int FROM group_fns WHERE has_function_privilege('authenticated', fn, 'EXECUTE')), 6, 'signed-in users can run all of them');
SELECT ok(NOT has_function_privilege('authenticated', 'public.is_conversation_participant(uuid,uuid)', 'EXECUTE'),
  'SF-1: clients can no longer ask about another user''s membership');
SELECT ok(has_function_privilege('authenticated', 'public.is_my_conversation(uuid)', 'EXECUTE'), 'the caller-scoped check is available');
SELECT ok(NOT has_function_privilege('anon', 'public.is_my_conversation(uuid)', 'EXECUTE'), 'anon cannot use it');
SELECT ok(NOT has_column_privilege('authenticated', 'public.conversation_participants', 'role', 'UPDATE'), 'clients cannot update a role');
SELECT ok(NOT has_column_privilege('authenticated', 'public.conversation_participants', 'conversation_id', 'UPDATE'), 'clients cannot move a participant row');
SELECT ok(has_column_privilege('authenticated', 'public.conversation_participants', 'last_read_at', 'UPDATE'), 'clients can still update their read marker');
SELECT ok(has_column_privilege('authenticated', 'public.conversation_participants', 'hidden_at', 'UPDATE'), 'clients can still hide a conversation');
SELECT ok(NOT has_table_privilege('authenticated', 'public.conversations', 'UPDATE'), 'clients cannot update conversations');
SELECT ok(NOT has_table_privilege('authenticated', 'public.conversations', 'INSERT'), 'clients cannot insert conversations');
SELECT ok(NOT has_table_privilege('authenticated', 'public.conversation_participants', 'INSERT'), 'clients cannot insert participants');
SELECT ok(NOT has_table_privilege('authenticated', 'public.messages', 'UPDATE'), 'clients cannot update messages');
SELECT ok(NOT has_table_privilege('authenticated', 'public.messages', 'DELETE'), 'clients cannot delete messages');
SELECT ok(NOT has_table_privilege('authenticated', 'public.conversation_group_departures', 'SELECT'), 'departures are server-only');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- A–F collectors, X an outsider, plus 40 extra users for the cap / rate
-- limit. User ids sort A < B < C < D < E < F (succession tie-break).
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-00000000aa01', 'gm-a@example.invalid', '{"username":"gm_test_a"}'),
  ('00000000-0000-4000-8000-00000000aa02', 'gm-b@example.invalid', '{"username":"gm_test_b"}'),
  ('00000000-0000-4000-8000-00000000aa03', 'gm-c@example.invalid', '{"username":"gm_test_c"}'),
  ('00000000-0000-4000-8000-00000000aa04', 'gm-d@example.invalid', '{"username":"gm_test_d"}'),
  ('00000000-0000-4000-8000-00000000aa05', 'gm-e@example.invalid', '{"username":"gm_test_e"}'),
  ('00000000-0000-4000-8000-00000000aa06', 'gm-f@example.invalid', '{"username":"gm_test_f"}'),
  ('00000000-0000-4000-8000-00000000aa99', 'gm-x@example.invalid', '{"username":"gm_test_x"}');
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT ('00000000-0000-4000-8000-0000000ab' || lpad(g::text, 3, '0'))::uuid,
       'gm-cap' || g || '@example.invalid',
       json_build_object('username', 'gm_cap_' || g)::jsonb
FROM generate_series(1, 40) g;

-- A's public item and private item (both in a public collection).
INSERT INTO public.folders (id, user_id, name, is_public) VALUES
  ('00000000-0000-4000-8000-00000000af01', '00000000-0000-4000-8000-00000000aa01', 'gm pub', true);
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status) VALUES
  ('00000000-0000-4000-8000-00000000ac01', '00000000-0000-4000-8000-00000000af01', '00000000-0000-4000-8000-00000000aa01', 'public card', true, 'active'),
  ('00000000-0000-4000-8000-00000000ac02', '00000000-0000-4000-8000-00000000af01', '00000000-0000-4000-8000-00000000aa01', 'private card', false, 'active');

-- An existing A↔B direct message, created the old way (defaults only).
INSERT INTO public.conversations (id) VALUES ('00000000-0000-4000-8000-00000000ad01');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-00000000ad01', '00000000-0000-4000-8000-00000000aa01'),
  ('00000000-0000-4000-8000-00000000ad01', '00000000-0000-4000-8000-00000000aa02');
INSERT INTO public.messages (conversation_id, sender_id, body) VALUES
  ('00000000-0000-4000-8000-00000000ad01', '00000000-0000-4000-8000-00000000aa02', 'old dm');
SELECT is((SELECT kind FROM public.conversations WHERE id = '00000000-0000-4000-8000-00000000ad01'), 'direct',
  'an existing conversation is a direct one by default');

SET LOCAL ROLE authenticated;

-- ── Creating groups (as A) ──────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa01');
SELECT is(public.get_or_create_conversation('00000000-0000-4000-8000-00000000aa02'), '00000000-0000-4000-8000-00000000ad01'::uuid,
  'existing DM dedupe still returns the existing A↔B conversation');
SELECT throws_ok($$SELECT public.create_group_conversation(ARRAY['00000000-0000-4000-8000-00000000aa02']::uuid[])$$,
  '22023', 'group_invalid_member_count', 'a group needs at least 3 people in total');
SELECT throws_ok($$SELECT public.create_group_conversation(ARRAY['00000000-0000-4000-8000-00000000aa02','00000000-0000-4000-8000-00000000aa02','00000000-0000-4000-8000-00000000aa03']::uuid[])$$,
  '22023', 'group_duplicate_member', 'duplicate members are rejected');
SELECT throws_ok($$SELECT public.create_group_conversation(ARRAY['00000000-0000-4000-8000-00000000aa02','00000000-0000-4000-8000-00000000aa01']::uuid[])$$,
  '22023', 'group_duplicate_member', 'listing yourself is rejected');
SELECT throws_ok($$SELECT public.create_group_conversation(ARRAY['00000000-0000-4000-8000-00000000aa02','00000000-0000-4000-8000-0000000000ff']::uuid[])$$,
  '22023', 'group_member_not_found', 'nonexistent members are rejected');
SELECT throws_ok($$SELECT public.create_group_conversation(ARRAY(SELECT ('00000000-0000-4000-8000-0000000ab' || lpad(g::text, 3, '0'))::uuid FROM generate_series(1, 32) g))$$,
  '22023', 'group_invalid_member_count', 'more than 32 people in total is rejected');
SELECT throws_ok($$SELECT public.create_group_conversation(ARRAY['00000000-0000-4000-8000-00000000aa02','00000000-0000-4000-8000-00000000aa03']::uuid[], repeat('x', 51))$$,
  '22023', 'group_invalid_name', 'names over 50 characters are rejected');

INSERT INTO ids SELECT 'g1', public.create_group_conversation(
  ARRAY['00000000-0000-4000-8000-00000000aa02','00000000-0000-4000-8000-00000000aa03']::uuid[], '  Card Club  ');
SELECT is((SELECT kind || ':' || name FROM public.conversations WHERE id = pg_temp.id('g1')), 'group:Card Club',
  'a group is created with its trimmed name');
SELECT is((SELECT user_id FROM public.conversation_participants WHERE conversation_id = pg_temp.id('g1') AND role = 'admin'),
  '00000000-0000-4000-8000-00000000aa01'::uuid, 'the creator is its only admin');
SELECT is((SELECT count(*)::int FROM public.conversation_participants WHERE conversation_id = pg_temp.id('g1') AND role = 'member'), 2,
  'everyone else joins as a member');
SELECT is(public.get_or_create_conversation('00000000-0000-4000-8000-00000000aa02'), '00000000-0000-4000-8000-00000000ad01'::uuid,
  'opening the DM with B still returns the DM, never the shared group');
INSERT INTO ids SELECT 'dm_ac', public.get_or_create_conversation('00000000-0000-4000-8000-00000000aa03');
SELECT ok((SELECT c.kind = 'direct' AND c.id <> pg_temp.id('g1')
           FROM public.conversations c WHERE c.id = pg_temp.id('dm_ac')),
  'opening a DM with C (shares only the group) creates a direct conversation');

-- ── Messaging in a group ────────────────────────────────────────────────
SELECT lives_ok($$INSERT INTO public.messages (conversation_id, sender_id, body)
                  VALUES (pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa01', 'hello group')$$,
  'a member can send to the group');
RESET ROLE;
SELECT is((SELECT string_agg(right(user_id::text, 2), ',' ORDER BY user_id) FROM public.notifications
           WHERE conversation_id = (SELECT id FROM ids WHERE name = 'g1') AND type = 'message'),
  '02,03', 'a group message notifies every other member (never the sender or outsiders)');
SET LOCAL ROLE authenticated;

SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa02');
SELECT lives_ok($$INSERT INTO public.messages (conversation_id, sender_id, body, created_at)
                  VALUES (pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa02', 'from b', '2000-01-01')$$,
  'B (member) can send');
SELECT ok((SELECT created_at > now() - interval '1 minute' FROM public.messages WHERE body = 'from b'),
  'a forged created_at is replaced by the server time');
SELECT throws_ok($$INSERT INTO public.messages (conversation_id, sender_id, body)
                   VALUES (pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa01', 'pretending to be a')$$,
  '42501', NULL, 'B cannot send as A');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = pg_temp.id('g1')), 2, 'B reads the group''s messages');

-- Unauthorized column updates (B).
SELECT throws_ok($$UPDATE public.conversation_participants SET role = 'admin'
                   WHERE conversation_id = pg_temp.id('g1') AND user_id = '00000000-0000-4000-8000-00000000aa02'$$,
  '42501', NULL, 'B cannot promote themself');
SELECT throws_ok($$UPDATE public.conversations SET name = 'hijacked' WHERE id = pg_temp.id('g1')$$,
  '42501', NULL, 'B cannot rename the group directly');
SELECT throws_ok($$UPDATE public.conversation_participants SET conversation_id = '00000000-0000-4000-8000-00000000ad01'
                   WHERE conversation_id = pg_temp.id('g1') AND user_id = '00000000-0000-4000-8000-00000000aa02'$$,
  '42501', NULL, 'B cannot move their participant row');
SELECT lives_ok($$UPDATE public.conversation_participants SET last_read_at = now()
                  WHERE conversation_id = pg_temp.id('g1') AND user_id = '00000000-0000-4000-8000-00000000aa02'$$,
  'B can update their own read marker');
SELECT throws_ok($$INSERT INTO public.conversation_participants (conversation_id, user_id)
                   VALUES (pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa99')$$,
  '42501', NULL, 'B cannot insert a participant directly');
SELECT throws_ok($$SELECT public.add_group_members(pg_temp.id('g1'), ARRAY['00000000-0000-4000-8000-00000000aa04']::uuid[])$$,
  '42501', 'not_group_admin', 'a member cannot add people');
SELECT throws_ok($$SELECT public.rename_group(pg_temp.id('g1'), 'mine now')$$,
  '42501', 'not_group_admin', 'a member cannot rename');
SELECT throws_ok($$SELECT public.remove_group_member(pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa03')$$,
  '42501', 'not_group_admin', 'a member cannot remove people');
SELECT throws_ok($$SELECT public.set_group_member_role(pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa02', 'admin')$$,
  '42501', 'not_group_admin', 'a member cannot promote themself through the function either');

-- An outsider (X).
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa99');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = pg_temp.id('g1')), 0, 'X cannot read the group''s messages');
SELECT is((SELECT count(*)::int FROM public.conversation_participants WHERE conversation_id = pg_temp.id('g1')), 0, 'X cannot list its members');
SELECT is((SELECT count(*)::int FROM public.conversations WHERE id = pg_temp.id('g1')), 0, 'X cannot see the conversation');
SELECT throws_ok($$INSERT INTO public.messages (conversation_id, sender_id, body)
                   VALUES (pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa99', 'let me in')$$,
  '42501', NULL, 'X cannot send to the group');
SELECT is(public.is_my_conversation(pg_temp.id('g1')), false, 'is_my_conversation is false for X');
SELECT throws_ok($$SELECT public.is_conversation_participant(pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa01')$$,
  '42501', NULL, 'X cannot probe whether A is in the group (SF-1)');
SELECT throws_ok($$SELECT public.add_group_members(pg_temp.id('g1'), ARRAY['00000000-0000-4000-8000-00000000aa04']::uuid[])$$,
  '42501', 'not_group_member', 'X cannot add people');

-- ── Admin actions (A) ───────────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa01');
SELECT is(public.add_group_members(pg_temp.id('g1'), ARRAY['00000000-0000-4000-8000-00000000aa04']::uuid[]), 1, 'the admin adds D');
SELECT throws_ok($$SELECT public.add_group_members(pg_temp.id('g1'), ARRAY['00000000-0000-4000-8000-00000000aa04']::uuid[])$$,
  '22023', 'group_duplicate_member', 'adding an existing member is rejected');
SELECT throws_ok($$SELECT public.add_group_members(pg_temp.id('g1'), ARRAY['00000000-0000-4000-8000-0000000000ff']::uuid[])$$,
  '22023', 'group_member_not_found', 'adding a nonexistent user is rejected');
SELECT lives_ok($$SELECT public.rename_group(pg_temp.id('g1'), ' New Name ')$$, 'the admin renames');
SELECT is((SELECT name FROM public.conversations WHERE id = pg_temp.id('g1')), 'New Name', 'the name is trimmed');
SELECT lives_ok($$SELECT public.rename_group(pg_temp.id('g1'), '   ')$$, 'a blank name clears it');
SELECT is((SELECT name FROM public.conversations WHERE id = pg_temp.id('g1')), NULL, 'the name is cleared');
SELECT throws_ok($$SELECT public.remove_group_member(pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa01')$$,
  '22023', 'cannot_remove_self', 'the admin cannot remove themself (leave instead)');
SELECT throws_ok($$SELECT public.set_group_member_role(pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa02', 'owner')$$,
  '22023', 'group_invalid_role', 'unknown roles are rejected');
SELECT throws_ok($$SELECT public.set_group_member_role(pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa01', 'member')$$,
  '22023', 'last_group_admin', 'the last admin cannot step down without a successor');
SELECT lives_ok($$SELECT public.set_group_member_role(pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa02', 'admin')$$, 'A promotes B');
SELECT lives_ok($$SELECT public.set_group_member_role(pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa01', 'member')$$,
  'A can step down once B is an admin');
SELECT throws_ok($$SELECT public.add_group_members(pg_temp.id('g1'), ARRAY['00000000-0000-4000-8000-00000000aa05']::uuid[])$$,
  '42501', 'not_group_admin', 'A, now a member, cannot add people');
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa02');
SELECT lives_ok($$SELECT public.set_group_member_role(pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa01', 'admin')$$, 'B makes A an admin again');

-- ── Removal (A removes C) ───────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa01');
SELECT lives_ok($$SELECT public.remove_group_member(pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa03')$$, 'the admin removes C');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.notifications
           WHERE user_id = '00000000-0000-4000-8000-00000000aa03' AND conversation_id = (SELECT id FROM ids WHERE name = 'g1')), 0,
  'C''s notifications for the group are gone');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa03');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = pg_temp.id('g1')), 0, 'removed C cannot read old messages');
SELECT is(public.is_my_conversation(pg_temp.id('g1')), false, 'removed C is no longer a member');
SELECT throws_ok($$INSERT INTO public.messages (conversation_id, sender_id, body)
                   VALUES (pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa03', 'still here?')$$,
  '42501', NULL, 'removed C cannot send');
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa01');
SELECT is(public.add_group_members(pg_temp.id('g1'), ARRAY['00000000-0000-4000-8000-00000000aa03']::uuid[]), 1,
  'a removed (not departed) member can be added back');

-- ── Leaving, succession and anti-abuse ─────────────────────────────────
INSERT INTO ids SELECT 'g2', public.create_group_conversation(
  ARRAY['00000000-0000-4000-8000-00000000aa04','00000000-0000-4000-8000-00000000aa05']::uuid[]);
SELECT lives_ok($$SELECT public.leave_group(pg_temp.id('g2'))$$, 'the sole admin leaves');
SELECT is(public.is_my_conversation(pg_temp.id('g2')), false, 'A is no longer in the group');
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa04');
SELECT is((SELECT user_id FROM public.conversation_participants WHERE conversation_id = pg_temp.id('g2') AND role = 'admin'),
  '00000000-0000-4000-8000-00000000aa04'::uuid, 'admin passes to the longest-standing member (joined_at, then id)');
SELECT throws_ok($$SELECT public.add_group_members(pg_temp.id('g2'), ARRAY['00000000-0000-4000-8000-00000000aa01']::uuid[])$$,
  '42501', 'group_member_unavailable', 'a group cannot re-add someone who left it');

-- C (re-added to g1 by A) leaves g1: A can't put C in any group for 7 days.
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa03');
SELECT lives_ok($$SELECT public.leave_group(pg_temp.id('g1'))$$, 'C leaves g1');
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa01');
SELECT throws_ok($$SELECT public.create_group_conversation(ARRAY['00000000-0000-4000-8000-00000000aa03','00000000-0000-4000-8000-00000000aa04']::uuid[])$$,
  '42501', 'group_member_unavailable', 'whoever added C cannot put C in a new group within 7 days of C leaving');
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa04');
SELECT lives_ok($$SELECT public.create_group_conversation(ARRAY['00000000-0000-4000-8000-00000000aa03','00000000-0000-4000-8000-00000000aa05']::uuid[])$$,
  'someone else can still start a group with C');
RESET ROLE;
UPDATE public.conversation_group_departures SET left_at = now() - interval '8 days'
WHERE user_id = '00000000-0000-4000-8000-00000000aa03';
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa01');
SELECT lives_ok($$SELECT public.create_group_conversation(ARRAY['00000000-0000-4000-8000-00000000aa03','00000000-0000-4000-8000-00000000aa05']::uuid[])$$,
  'after 7 days the original adder can include C in a new group');
SELECT throws_ok($$SELECT public.add_group_members(pg_temp.id('g1'), ARRAY['00000000-0000-4000-8000-00000000aa03']::uuid[])$$,
  '42501', 'group_member_unavailable', 'but g1 itself can never re-add C');

-- The last member leaving deletes the group.
INSERT INTO ids SELECT 'g5', public.create_group_conversation(
  ARRAY['00000000-0000-4000-8000-00000000aa05','00000000-0000-4000-8000-00000000aa06']::uuid[]);
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa05');
SELECT lives_ok($$SELECT public.leave_group(pg_temp.id('g5'))$$, 'E leaves');
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa06');
SELECT lives_ok($$SELECT public.leave_group(pg_temp.id('g5'))$$, 'F leaves');
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa01');
SELECT lives_ok($$SELECT public.leave_group(pg_temp.id('g5'))$$, 'A, the last member, leaves');
SELECT throws_ok($$SELECT public.leave_group(pg_temp.id('g5'))$$, '42501', 'not_group_member', 'leaving twice is rejected');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.conversations WHERE id = (SELECT id FROM ids WHERE name = 'g5')), 0,
  'an empty group is deleted');
SET LOCAL ROLE authenticated;

-- ── The 32-member cap and the creation rate limit (A) ──────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa01');
INSERT INTO ids SELECT 'gcap', public.create_group_conversation(
  ARRAY(SELECT ('00000000-0000-4000-8000-0000000ab' || lpad(g::text, 3, '0'))::uuid FROM generate_series(1, 31) g));
SELECT is((SELECT count(*)::int FROM public.conversation_participants WHERE conversation_id = pg_temp.id('gcap')), 32,
  'a group of exactly 32 can be created');
SELECT throws_ok($$SELECT public.add_group_members(pg_temp.id('gcap'), ARRAY['00000000-0000-4000-8000-00000000aa06']::uuid[])$$,
  '54000', 'group_full', 'a 33rd member is rejected');
-- A has created g1, g2, gcap and the post-cooldown group in the last 24h
-- (g5 was deleted): 4. Six more reach the limit of 10.
SELECT lives_ok($q$DO $do$ BEGIN
  FOR i IN 1..6 LOOP
    PERFORM public.create_group_conversation(ARRAY[
      ('00000000-0000-4000-8000-0000000ab' || lpad((31 + i)::text, 3, '0'))::uuid,
      ('00000000-0000-4000-8000-0000000ab' || lpad((32 + i)::text, 3, '0'))::uuid]);
  END LOOP;
END $do$$q$, 'ten groups in 24 hours are allowed');
SELECT throws_ok($$SELECT public.create_group_conversation(ARRAY['00000000-0000-4000-8000-00000000aa05','00000000-0000-4000-8000-00000000aa06']::uuid[])$$,
  '54000', 'group_rate_limited', 'an eleventh group within 24 hours is rejected');

-- ── Attachments ─────────────────────────────────────────────────────────
-- g1 now: A, B, D.
SELECT lives_ok($$INSERT INTO public.messages (conversation_id, sender_id, attachment_type, attachment_item_id)
                  VALUES (pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa01', 'item', '00000000-0000-4000-8000-00000000ac01')$$,
  'an item every member can see can be shared into the group');
SELECT throws_ok($$INSERT INTO public.messages (conversation_id, sender_id, attachment_type, attachment_item_id)
                   VALUES (pg_temp.id('g1'), '00000000-0000-4000-8000-00000000aa01', 'item', '00000000-0000-4000-8000-00000000ac02')$$,
  '42501', 'item_not_shareable', 'a private item other members can''t see cannot be shared into the group');
RESET ROLE;
INSERT INTO ids VALUES ('img', gen_random_uuid());
INSERT INTO storage.objects (bucket_id, name, owner)
VALUES ('dm-attachments', (SELECT id FROM ids WHERE name = 'g1')::text || '/' || (SELECT id FROM ids WHERE name = 'img')::text || '/image.jpg',
        '00000000-0000-4000-8000-00000000aa01');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa02');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'dm-attachments' AND name LIKE pg_temp.id('g1')::text || '/%'), 1,
  'a member can read the group''s image attachments');
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa99');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'dm-attachments' AND name LIKE pg_temp.id('g1')::text || '/%'), 0,
  'an outsider cannot');
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa03');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'dm-attachments' AND name LIKE pg_temp.id('g1')::text || '/%'), 0,
  'a member who left cannot');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name, owner)
                   VALUES ('dm-attachments', pg_temp.id('g1')::text || '/' || gen_random_uuid()::text || '/image.jpg', '00000000-0000-4000-8000-00000000aa03')$$,
  '42501', NULL, 'a member who left cannot upload into the group');

-- ── Existing one-to-one DM (B) ──────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa02');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-00000000ad01'), 1,
  'B still reads the old DM');
SELECT lives_ok($$INSERT INTO public.messages (conversation_id, sender_id, body)
                  VALUES ('00000000-0000-4000-8000-00000000ad01', '00000000-0000-4000-8000-00000000aa02', 'still works')$$,
  'B can still send in the DM');
SELECT pg_temp.login('00000000-0000-4000-8000-00000000aa99');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-00000000ad01'), 0,
  'an outsider still cannot read the DM');
RESET ROLE;
SELECT is((SELECT string_agg(right(user_id::text, 2), ',') || ':' || count(*) FROM public.notifications
           WHERE conversation_id = '00000000-0000-4000-8000-00000000ad01' AND type = 'message'),
  '01,01:2', 'DM messages still notify only the other person (A, once per message from B; never B)');

-- ── Concurrency (structural) ────────────────────────────────────────────
SELECT ok((SELECT prosrc LIKE '%FOR UPDATE%' FROM pg_proc WHERE oid = 'public._lock_group_for_caller(uuid,uuid)'::regprocedure),
  'every membership change locks the group row first (serializes concurrent adds/leaves)');
SELECT ok((SELECT prosrc LIKE '%pg_advisory_xact_lock%' FROM pg_proc WHERE oid = 'public.create_group_conversation(uuid[],text)'::regprocedure),
  'group creation serializes per caller (rate limit can''t be raced)');

-- ── Anonymous ───────────────────────────────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.create_group_conversation(ARRAY['00000000-0000-4000-8000-00000000aa02','00000000-0000-4000-8000-00000000aa03']::uuid[])$$,
  '42501', NULL, 'anon cannot create groups');
SELECT throws_ok($$SELECT * FROM public.messages LIMIT 1$$, '42501', NULL, 'anon cannot read messages');
SELECT throws_ok($$SELECT * FROM public.conversation_participants LIMIT 1$$, '42501', NULL, 'anon cannot read participants');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
