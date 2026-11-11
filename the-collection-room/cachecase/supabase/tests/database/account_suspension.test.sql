-- pgTAP test for 20261122120000_account_suspension.sql (Phase 2B M3).
-- Run against a LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(85);

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
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid), pg_temp.logout() TO authenticated, anon, service_role;

-- ── 1. Shape and privileges ─────────────────────────────────────────────
SELECT has_table('public', 'account_suspensions', 'account_suspensions exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.account_suspensions'::regclass)
      AND (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.account_suspensions'::regclass AND polpermissive) = 0,
  'RLS on, no permissive policies');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
           WHERE has_table_privilege(r, 'public.account_suspensions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')), 0,
  'no API role (not even the service role) can touch suspension records');
SELECT ok(EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.account_suspensions'::regclass AND polname = 'account_lifecycle_read_guard' AND NOT polpermissive)
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.account_suspensions'::regclass AND tgname = 'account_write_guard'),
  'carries the standard account-lifecycle guards');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'account_suspensions_one_open'), 'one open suspension per collector (unique)');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.admin_suspend_account(uuid,text,timestamptz,text,uuid)', 'public.admin_lift_suspension(uuid,text,text,boolean)',
             'public.admin_list_suspensions(text,integer,integer)', 'public.admin_account_suspensions(uuid)']::regprocedure[]) f
           JOIN pg_proc p ON p.oid = f
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%'
             AND has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
             AND NOT has_function_privilege('service_role', f, 'EXECUTE')), 4,
  'admin functions: definer, pinned, each calls require_admin, signed-in only');
SELECT ok(has_function_privilege('authenticated', 'public.my_account_suspension()', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.my_account_suspension()', 'EXECUTE'), 'my_account_suspension: signed-in only');
SELECT ok(has_function_privilege('service_role', 'public.account_hidden_ids(uuid[])', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.account_hidden_ids(uuid[])', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.account_hidden_ids(uuid[])', 'EXECUTE'), 'account_hidden_ids: service role only');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'private'
             AND p.proname IN ('account_is_suspended', 'suspension_view', 'close_expired_suspension', 'suspension_category')
             AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('service_role', p.oid, 'EXECUTE'))), 0, 'internal helpers: no API role');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- S is suspended; O is another collector; T temporary; C child safety;
-- P pending deletion + suspended; D deleted while suspended; A1, A2 admins.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000d1000001', 'su-s@example.invalid', '{"username":"su_s"}'),
  ('00000000-0000-4000-8000-0000d1000002', 'su-o@example.invalid', '{"username":"su_o"}'),
  ('00000000-0000-4000-8000-0000d1000003', 'su-t@example.invalid', '{"username":"su_t"}'),
  ('00000000-0000-4000-8000-0000d1000004', 'su-c@example.invalid', '{"username":"su_c"}'),
  ('00000000-0000-4000-8000-0000d1000005', 'su-p@example.invalid', '{"username":"su_p"}'),
  ('00000000-0000-4000-8000-0000d1000006', 'su-d@example.invalid', '{"username":"su_d"}'),
  ('00000000-0000-4000-8000-0000d1000007', 'su-a1@example.invalid', '{"username":"su_a1"}'),
  ('00000000-0000-4000-8000-0000d1000008', 'su-a2@example.invalid', '{"username":"su_a2"}');
INSERT INTO public.admin_users (user_id) VALUES ('00000000-0000-4000-8000-0000d1000007'), ('00000000-0000-4000-8000-0000d1000008');
INSERT INTO public.folders (id, user_id, name, is_public) VALUES
  ('00000000-0000-4000-8000-0000d1f00001', '00000000-0000-4000-8000-0000d1000001', 'su folder', true);
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status, item_type) VALUES
  ('00000000-0000-4000-8000-0000d1e00001', '00000000-0000-4000-8000-0000d1f00001', '00000000-0000-4000-8000-0000d1000001', 'su item', true, 'active', 'sports_card');
INSERT INTO public.collection_item_images (id, item_id, user_id, image_url, storage_path, sort_order, is_primary) VALUES
  ('00000000-0000-4000-8000-0000d1b00001', '00000000-0000-4000-8000-0000d1e00001', '00000000-0000-4000-8000-0000d1000001', 'https://x.invalid', '00000000-0000-4000-8000-0000d1000001/su.jpg', 0, true);
INSERT INTO public.posts (id, user_id, post_type, content) VALUES
  ('00000000-0000-4000-8000-0000d1d00001', '00000000-0000-4000-8000-0000d1000001', 'text', 'su post'),
  ('00000000-0000-4000-8000-0000d1d00002', '00000000-0000-4000-8000-0000d1000001', 'text', 'su moderated post');
INSERT INTO public.conversations (id) VALUES ('00000000-0000-4000-8000-0000d1a00001');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000d1a00001', '00000000-0000-4000-8000-0000d1000001'),
  ('00000000-0000-4000-8000-0000d1a00001', '00000000-0000-4000-8000-0000d1000002');
INSERT INTO public.messages (id, conversation_id, sender_id, body) VALUES
  ('00000000-0000-4000-8000-0000d1500001', '00000000-0000-4000-8000-0000d1a00001', '00000000-0000-4000-8000-0000d1000001', 'su hello');
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('avatars', '00000000-0000-4000-8000-0000d1000001/a.jpg', '00000000-0000-4000-8000-0000d1000001', '00000000-0000-4000-8000-0000d1000001');
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence) VALUES
  ('00000000-0000-4000-8000-0000d1100001', '00000000-0000-4000-8000-0000d1000002', 'post', '00000000-0000-4000-8000-0000d1d00002', '00000000-0000-4000-8000-0000d1000001', 'spam', '{"v":1}'),
  ('00000000-0000-4000-8000-0000d1100002', '00000000-0000-4000-8000-0000d1000002', 'profile', '00000000-0000-4000-8000-0000d1000004', '00000000-0000-4000-8000-0000d1000004', 'child_safety', '{"v":1}');
-- An independent M2.1 restriction on one of S's posts.
INSERT INTO public.moderated_content (target_type, target_id, owner_id, state, reason_code, report_id, created_by) VALUES
  ('post', '00000000-0000-4000-8000-0000d1d00002', '00000000-0000-4000-8000-0000d1000001', 'removed', 'spam', '00000000-0000-4000-8000-0000d1100001', '00000000-0000-4000-8000-0000d1000007');
CREATE TEMP TABLE before_lifecycle AS SELECT count(*) AS n FROM public.account_lifecycle;

-- ── 2. Authorization and validation ─────────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000001', 'spam') $$, '42501', NULL, 'signed out: refused');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000002');
SELECT throws_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000001', 'spam') $$, '42501', 'forbidden', 'a collector cannot suspend');
SELECT throws_ok($$ SELECT public.admin_lift_suspension('00000000-0000-4000-8000-0000d1000001', 'resolved_in_error') $$, '42501', 'forbidden', '…or lift');
SELECT throws_ok($$ SELECT public.admin_list_suspensions() $$, '42501', 'forbidden', '…or list');
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000007');
SELECT throws_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000007', 'spam') $$, '22023', 'cannot_suspend_self', 'an admin cannot suspend themselves');
SELECT throws_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000008', 'spam') $$, '22023', 'cannot_suspend_admin', 'admins are never suspended from the app');
SELECT throws_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000001', 'being_annoying') $$, '22023', 'invalid_reason_code', 'reasons come from a fixed list');
SELECT throws_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000001', 'spam', now() + interval '10 minutes') $$, '22023', 'invalid_expiry', 'expiry under an hour is refused');
SELECT throws_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000001', 'spam', now() + interval '400 days') $$, '22023', 'invalid_expiry', 'expiry beyond a year is refused');
SELECT throws_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000001', 'spam', NULL, repeat('x', 1001)) $$, '22023', 'note_too_long', 'notes are bounded');
SELECT throws_ok($$ SELECT public.admin_suspend_account(gen_random_uuid(), 'spam') $$, 'PT404', 'not_found', 'unknown account');
SELECT throws_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000001', 'spam', NULL, NULL, '00000000-0000-4000-8000-0000d1100002') $$,
  '22023', 'report_mismatch', 'a report about someone else cannot back the suspension');

-- ── 3. Indefinite suspension ────────────────────────────────────────────
SELECT is(public.admin_suspend_account('00000000-0000-4000-8000-0000d1000001', 'harassment', NULL, 'repeated harassment', '00000000-0000-4000-8000-0000d1100001') ->> 'state',
  'active', 'A1 suspends S indefinitely');
SELECT throws_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000001', 'spam') $$, 'PT409', 'already_suspended', 'no second active suspension');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE action = 'suspend' AND target_id = '00000000-0000-4000-8000-0000d1000001'
             AND admin_id = '00000000-0000-4000-8000-0000d1000007' AND report_id = '00000000-0000-4000-8000-0000d1100001'), 1,
  'the decision is audited, with admin and report');
SELECT is((SELECT count(*) FROM public.account_lifecycle), (SELECT n FROM before_lifecycle), 'suspension never creates an account_lifecycle row');
SELECT ok(private.account_is_hidden('00000000-0000-4000-8000-0000d1000001') AND '00000000-0000-4000-8000-0000d1000001' = ANY (private.hidden_account_ids()),
  'the lifecycle helpers recognise the suspension');
SELECT is(private.moderation_account_summary('00000000-0000-4000-8000-0000d1000001') ->> 'account_state', 'suspended', 'admin evidence views show it');

-- ── 4. The suspended collector, with their existing session ─────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000001');
SELECT is(public.my_account_suspension() - 'since',
  '{"suspended": true, "category": "community_guidelines", "expires_at": null, "indefinite": true}'::jsonb,
  'S sees only a category and dates — no reason code, note, report or admin');
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000d1000001'), 0, 'S can no longer read (even their own) content');
SELECT throws_ok($$ INSERT INTO public.posts (user_id, post_type, content) VALUES ('00000000-0000-4000-8000-0000d1000001', 'text', 'x') $$,
  '42501', 'account_suspended', 'S cannot post');
SELECT throws_ok($$ UPDATE public.profiles SET bio = 'x' WHERE id = '00000000-0000-4000-8000-0000d1000001' $$, '42501', 'account_suspended', 'S cannot edit their profile');
SELECT throws_ok($$ INSERT INTO public.messages (conversation_id, sender_id, body) VALUES ('00000000-0000-4000-8000-0000d1a00001', '00000000-0000-4000-8000-0000d1000001', 'x') $$,
  '42501', 'account_suspended', 'S cannot message');
SELECT throws_ok($$ INSERT INTO public.follows (follower_id, following_id) VALUES ('00000000-0000-4000-8000-0000d1000001', '00000000-0000-4000-8000-0000d1000002') $$,
  '42501', 'account_suspended', 'S cannot follow');
SELECT throws_ok($$ SELECT public.submit_report('post', '00000000-0000-4000-8000-0000d1d00001', 'spam', NULL) $$, NULL::char(5), NULL::text, 'S cannot file reports');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE name LIKE '00000000-0000-4000-8000-0000d1000001/%'), 0, 'S cannot read Storage');
SELECT throws_ok($$ INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('avatars', '00000000-0000-4000-8000-0000d1000001/b.jpg', '00000000-0000-4000-8000-0000d1000001') $$,
  '42501', NULL, 'S cannot upload');
SELECT throws_ok($$ SELECT public.admin_list_suspensions() $$, '42501', NULL, 'and gains nothing administrative');

-- ── 5. Everyone else ────────────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000002');
SELECT is(public.my_account_suspension(), '{"suspended": false}'::jsonb, 'O is not suspended');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000d1000001'), 0, 'O cannot see S''s profile');
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000d1000001'), 0, '…posts');
SELECT is((SELECT count(*)::int FROM public.folders WHERE user_id = '00000000-0000-4000-8000-0000d1000001')
          + (SELECT count(*)::int FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000d1000001'), 0, '…collections and items');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000d1a00001'), 0, '…or their conversation');
SELECT throws_ok($$ INSERT INTO public.follows (follower_id, following_id) VALUES ('00000000-0000-4000-8000-0000d1000002', '00000000-0000-4000-8000-0000d1000001') $$,
  '42501', NULL, 'O cannot follow S');
SELECT throws_ok($$ SELECT public.get_or_create_conversation('00000000-0000-4000-8000-0000d1000001') $$, '42501', NULL, 'O cannot start a conversation with S');
SELECT throws_ok($$ INSERT INTO public.messages (conversation_id, sender_id, body) VALUES ('00000000-0000-4000-8000-0000d1a00001', '00000000-0000-4000-8000-0000d1000002', 'x') $$,
  '42501', NULL, 'O cannot message into the conversation');
SELECT pg_temp.logout();
RESET ROLE;
SET LOCAL ROLE anon;
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000d1000001'), 0, 'signed-out visitors cannot see S either');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.resolve_item_images_for_signing(ARRAY['00000000-0000-4000-8000-0000d1b00001'::uuid])), 0,
  'the image signer resolves nothing of S''s');
SELECT is(ARRAY(SELECT public.account_hidden_ids(ARRAY['00000000-0000-4000-8000-0000d1000001', '00000000-0000-4000-8000-0000d1000002']::uuid[])),
  ARRAY['00000000-0000-4000-8000-0000d1000001']::uuid[], 'Edge Functions see S as hidden (and O as not)');
RESET ROLE;

-- ── 6. Lifting restores access, never independent restrictions ──────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000008');
SELECT throws_ok($$ SELECT public.admin_lift_suspension('00000000-0000-4000-8000-0000d1000001', 'child_safety_review_cleared', 'x') $$,
  '22023', 'invalid_reason_code', 'the child-safety reason is only for child-safety suspensions');
SELECT is(public.admin_lift_suspension('00000000-0000-4000-8000-0000d1000001', 'appeal_granted', 'appeal accepted') ->> 'state', 'lifted', 'A2 lifts S''s suspension');
SELECT throws_ok($$ SELECT public.admin_lift_suspension('00000000-0000-4000-8000-0000d1000001', 'appeal_granted') $$, 'PT409', 'not_suspended', 'lifting twice is refused');
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000001');
SELECT is(public.my_account_suspension(), '{"suspended": false}'::jsonb, 'S is no longer suspended');
SELECT lives_ok($$ INSERT INTO public.posts (user_id, post_type, content) VALUES ('00000000-0000-4000-8000-0000d1000001', 'text', 'back') $$, 'S can post again');
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000002');
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000d1d00001'), 1, 'O sees S''s content again');
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000d1d00002'), 0, 'the independent M2.1 removal still applies');
SELECT lives_ok($$ SELECT public.block_collector('00000000-0000-4000-8000-0000d1000001') $$, 'O blocks S');
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000d1000001'), 0, 'blocking still applies on its own');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE action = 'lift_suspension' AND target_id = '00000000-0000-4000-8000-0000d1000001'
             AND admin_id = '00000000-0000-4000-8000-0000d1000008'), 1, 'the lift is audited');

-- ── 7. Temporary suspension: expiry needs no scheduled task ─────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000007');
SELECT is(public.admin_suspend_account('00000000-0000-4000-8000-0000d1000003', 'spam', now() + interval '2 hours') ->> 'state', 'active', 'T suspended for two hours');
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000003');
SELECT is((public.my_account_suspension() ->> 'indefinite')::boolean, false, 'T sees a temporary suspension');
SELECT is(public.my_account_suspension() ->> 'category', 'spam_or_scams', '…with its category');
RESET ROLE;
-- Time passes (simulated: the row is moved into the past as an operator would).
SET LOCAL session_replication_role = replica;
UPDATE public.account_suspensions SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 second'
 WHERE user_id = '00000000-0000-4000-8000-0000d1000003';
SET LOCAL session_replication_role = origin;
SELECT ok(NOT private.account_is_hidden('00000000-0000-4000-8000-0000d1000003'), 'after its expiry the account is visible again — no job ran');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000003');
SELECT is(public.my_account_suspension(), '{"suspended": false}'::jsonb, 'T is no longer suspended');
SELECT lives_ok($$ INSERT INTO public.posts (user_id, post_type, content) VALUES ('00000000-0000-4000-8000-0000d1000003', 'text', 'free') $$, 'T can post');
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000007');
SELECT throws_ok($$ SELECT public.admin_lift_suspension('00000000-0000-4000-8000-0000d1000003', 'appeal_granted') $$, 'PT409', 'not_suspended',
  'an expired suspension cannot be lifted');
SELECT is(public.admin_suspend_account('00000000-0000-4000-8000-0000d1000003', 'repeat_violations') ->> 'state', 'active', 'a new suspension can follow an expired one');
RESET ROLE;
SELECT is((SELECT array_agg(coalesce(lift_reason, 'open') ORDER BY created_at) FROM public.account_suspensions WHERE user_id = '00000000-0000-4000-8000-0000d1000003'),
  ARRAY['expired', 'open'], '…the old one is closed as expired, history kept');

-- ── 8. Child-safety suspensions ─────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000007');
SELECT is((public.admin_suspend_account('00000000-0000-4000-8000-0000d1000004', 'urgent_risk', NULL, NULL, '00000000-0000-4000-8000-0000d1100002') ->> 'child_safety')::boolean,
  true, 'a suspension backed by a child-safety report is a child-safety suspension');
SELECT throws_ok($$ SELECT public.admin_lift_suspension('00000000-0000-4000-8000-0000d1000004', 'child_safety_review_cleared', 'reviewed', true) $$,
  '42501', 'second_admin_required', 'the admin who imposed it cannot lift it');
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000008');
SELECT throws_ok($$ SELECT public.admin_lift_suspension('00000000-0000-4000-8000-0000d1000004', 'child_safety_review_cleared', 'reviewed') $$,
  '22023', 'child_safety_confirmation_required', 'a second admin must confirm');
SELECT throws_ok($$ SELECT public.admin_lift_suspension('00000000-0000-4000-8000-0000d1000004', 'appeal_granted', 'reviewed', true) $$,
  '22023', 'child_safety_review_required', '…use the child-safety review reason');
SELECT throws_ok($$ SELECT public.admin_lift_suspension('00000000-0000-4000-8000-0000d1000004', 'child_safety_review_cleared', NULL, true) $$,
  '22023', 'child_safety_review_required', '…and leave a note');
SELECT is(public.admin_lift_suspension('00000000-0000-4000-8000-0000d1000004', 'child_safety_review_cleared', 'second review cleared', true) ->> 'state', 'lifted',
  'a second admin with confirmation, reason and note can lift it');
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000004');
SELECT is(public.my_account_suspension(), '{"suspended": false}'::jsonb, 'C is reinstated');
RESET ROLE;

-- ── 9. History is append-only ───────────────────────────────────────────
SELECT throws_ok($$ UPDATE public.account_suspensions SET reason_code = 'spam' WHERE user_id = '00000000-0000-4000-8000-0000d1000001' $$,
  '42501', 'account_suspensions_append_only', 'records cannot be rewritten');
SELECT throws_ok($$ DELETE FROM public.account_suspensions WHERE user_id = '00000000-0000-4000-8000-0000d1000001' $$,
  '42501', 'account_suspensions_append_only', 'records cannot be deleted');
SELECT throws_ok($$ UPDATE public.account_suspensions SET lifted_at = NULL, lift_reason = NULL WHERE user_id = '00000000-0000-4000-8000-0000d1000001' $$,
  '42501', 'account_suspensions_append_only', 'a lifted suspension cannot be re-opened');

-- ── 10. Deletion and export compatibility ───────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000007');
SELECT lives_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000005', 'spam') $$, 'P is suspended');
SELECT lives_ok($$ SELECT public.admin_suspend_account('00000000-0000-4000-8000-0000d1000006', 'spam') $$, 'D is suspended');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT lives_ok($$ SELECT public.schedule_account_deletion('00000000-0000-4000-8000-0000d1000005', 14) $$, 'a suspended collector can schedule deletion');
RESET ROLE;
SELECT is((SELECT state FROM public.account_lifecycle WHERE user_id = '00000000-0000-4000-8000-0000d1000005'), 'pending_deletion', '…with the normal grace period');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000d1000005');
SELECT throws_ok($$ UPDATE public.profiles SET bio = 'x' WHERE id = '00000000-0000-4000-8000-0000d1000005' $$, '42501', 'account_inactive',
  'pending deletion takes precedence in the error');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT lives_ok($$ SELECT public.cancel_account_deletion('00000000-0000-4000-8000-0000d1000005') $$, 'cancelling deletion…');
RESET ROLE;
SELECT ok(private.account_is_suspended('00000000-0000-4000-8000-0000d1000005') AND NOT EXISTS (SELECT 1 FROM public.account_lifecycle WHERE user_id = '00000000-0000-4000-8000-0000d1000005'),
  '…leaves the suspension in place, and no lifecycle row behind');
-- Permanent deletion runs as the server, with no collector session.
SELECT pg_temp.logout();
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000d1000006';
SELECT is((SELECT count(*)::int FROM public.account_suspensions WHERE user_id IS NULL AND reason_code = 'spam' AND created_by = '00000000-0000-4000-8000-0000d1000007'), 1,
  'deleting a suspended account keeps an anonymised suspension record');

SELECT * FROM finish();
ROLLBACK;
