-- pgTAP test for 20261116120000_content_moderation.sql (content moderation
-- enforcement, App Store moderation Phase 2B M2.1).
-- Run against a LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(183);

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
-- Moderation ids, read back as the superuser for later restore calls.
CREATE TEMP TABLE mids (k text PRIMARY KEY, id uuid);
GRANT SELECT ON mids TO authenticated;

-- ── 1. Shape, privileges, exposure ──────────────────────────────────────
CREATE TEMP TABLE cm_fns (fn regprocedure);
INSERT INTO cm_fns VALUES ('public.admin_hide_content(uuid,text,text,integer)'), ('public.admin_remove_content(uuid,text,text,integer,boolean)'),
  ('public.admin_restore_content(uuid,text,text,text,boolean)');

SELECT has_table('public', 'moderated_content', 'moderated_content exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.moderated_content'::regclass)
      AND (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.moderated_content'::regclass AND polpermissive) = 0,
  'moderated_content: RLS on, no permissive policies');
SELECT ok(NOT has_table_privilege('anon', 'public.moderated_content', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_table_privilege('authenticated', 'public.moderated_content', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'moderated_content: clients have no table privileges');
SELECT ok(has_table_privilege('service_role', 'public.moderated_content', 'SELECT')
      AND NOT has_table_privilege('service_role', 'public.moderated_content', 'INSERT,UPDATE,DELETE,TRUNCATE'),
  'moderated_content: the service role may only read');
SELECT ok(EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.moderated_content'::regclass AND polname = 'account_lifecycle_read_guard' AND NOT polpermissive)
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.moderated_content'::regclass AND tgname = 'account_write_guard'),
  'moderated_content carries the account-lifecycle guards');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'moderated_content_one_active'), 'one active restriction per content (unique)');
SELECT is((SELECT count(*)::int FROM cm_fns t JOIN pg_proc p ON p.oid = t.fn
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%'), 3,
  'hide/remove/restore are SECURITY DEFINER, pinned, and check admin_users');
SELECT is((SELECT count(*)::int FROM cm_fns t WHERE has_function_privilege('anon', t.fn, 'EXECUTE') OR has_function_privilege('service_role', t.fn, 'EXECUTE')), 0,
  'admin moderation functions: not for signed-out callers or the service role');
SELECT ok(has_function_privilege('authenticated', 'public.my_moderation_status(text,uuid[])', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.my_moderation_status(text,uuid[])', 'EXECUTE'),
  'my_moderation_status: signed-in only');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'private'
             AND p.proname IN ('is_moderated', 'folder_tree_moderated', 'item_hidden', 'item_restricted', 'image_path_moderated',
                               'reject_moderated_reference', 'moderation_resolve_target', 'active_moderation_of', 'moderated_content_guard',
                               'moderation_state_view')
             AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))), 0,
  'internal moderation helpers are not executable by clients');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polname = 'moderation_read_guard' AND NOT polpermissive AND polcmd = 'r'), 19,
  '19 restrictive moderation read guards');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE policyname = 'moderation_read_guard'
             AND qual !~ 'moderated_(ids_for_caller|folder_tree_for_caller)\(' ), 0,
  'every read guard uses a per-query restriction set');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE policyname = 'moderation_read_guard'
             AND qual ~ '(is_moderated|item_hidden|item_restricted|folder_tree_moderated)\('), 0,
  'no read guard calls a per-row lookup');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgname = 'moderation_target_guard' AND tgenabled = 'O'), 23,
  '23 interaction and redistribution guards');
SELECT ok(EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'storage.objects'::regclass AND polname = 'moderation_dm_attachment_guard' AND NOT polpermissive),
  'restrictive Storage guard for moderated DM photos');
SELECT is((SELECT count(*)::int FROM cm_fns t JOIN pg_proc p ON p.oid = t.fn
           WHERE p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+public\.(?!content_reports|moderated_content|moderation_actions)'), 0,
  'admin moderation functions write no collector content');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- A owns everything moderated; O and V are other collectors (V commented
-- and liked); R is A's DM partner; K is blocked by A; M1, M2 are admins.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000bd000001', 'cm-a@example.invalid', '{"username":"cm_a"}'),
  ('00000000-0000-4000-8000-0000bd000002', 'cm-o@example.invalid', '{"username":"cm_o"}'),
  ('00000000-0000-4000-8000-0000bd000003', 'cm-v@example.invalid', '{"username":"cm_v"}'),
  ('00000000-0000-4000-8000-0000bd000004', 'cm-r@example.invalid', '{"username":"cm_r"}'),
  ('00000000-0000-4000-8000-0000bd000005', 'cm-m1@example.invalid', '{"username":"cm_m1"}'),
  ('00000000-0000-4000-8000-0000bd000006', 'cm-m2@example.invalid', '{"username":"cm_m2"}'),
  ('00000000-0000-4000-8000-0000bd000007', 'cm-k@example.invalid', '{"username":"cm_k"}');
INSERT INTO public.admin_users (user_id) VALUES ('00000000-0000-4000-8000-0000bd000005'), ('00000000-0000-4000-8000-0000bd000006');
INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000bdf00001', '00000000-0000-4000-8000-0000bd000001', 'cm f1', true, NULL),
  ('00000000-0000-4000-8000-0000bdf00003', '00000000-0000-4000-8000-0000bd000001', 'cm f3', true, NULL),
  ('00000000-0000-4000-8000-0000bdf00004', '00000000-0000-4000-8000-0000bd000001', 'cm f4', true, NULL);
INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000bdf00002', '00000000-0000-4000-8000-0000bd000001', 'cm f2', true, '00000000-0000-4000-8000-0000bdf00001'),
  ('00000000-0000-4000-8000-0000bdf00005', '00000000-0000-4000-8000-0000bd000001', 'cm f5', true, '00000000-0000-4000-8000-0000bdf00004');
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status, item_type) VALUES
  ('00000000-0000-4000-8000-0000bde00001', '00000000-0000-4000-8000-0000bdf00002', '00000000-0000-4000-8000-0000bd000001', 'cm item one', true, 'active', 'sports_card'),
  ('00000000-0000-4000-8000-0000bde00002', '00000000-0000-4000-8000-0000bdf00001', '00000000-0000-4000-8000-0000bd000001', 'cm item two', true, 'active', 'sports_card'),
  ('00000000-0000-4000-8000-0000bde00003', '00000000-0000-4000-8000-0000bdf00003', '00000000-0000-4000-8000-0000bd000001', 'cmthree card', true, 'active', 'sports_card'),
  ('00000000-0000-4000-8000-0000bde00004', '00000000-0000-4000-8000-0000bdf00003', '00000000-0000-4000-8000-0000bd000001', 'cm item four', true, 'active', 'sports_card');
INSERT INTO public.collection_item_images (id, item_id, user_id, image_url, storage_path, sort_order, is_primary) VALUES
  ('00000000-0000-4000-8000-0000bdb00001', '00000000-0000-4000-8000-0000bde00001', '00000000-0000-4000-8000-0000bd000001', 'https://x.invalid/1', '00000000-0000-4000-8000-0000bd000001/cm/1.jpg', 0, true),
  ('00000000-0000-4000-8000-0000bdb00002', '00000000-0000-4000-8000-0000bde00002', '00000000-0000-4000-8000-0000bd000001', 'https://x.invalid/2a', '00000000-0000-4000-8000-0000bd000001/cm/2a.jpg', 0, true),
  ('00000000-0000-4000-8000-0000bdb00003', '00000000-0000-4000-8000-0000bde00002', '00000000-0000-4000-8000-0000bd000001', 'https://x.invalid/2b', '00000000-0000-4000-8000-0000bd000001/cm/2b.jpg', 1, false),
  ('00000000-0000-4000-8000-0000bdb00004', '00000000-0000-4000-8000-0000bde00003', '00000000-0000-4000-8000-0000bd000001', 'https://x.invalid/3', '00000000-0000-4000-8000-0000bd000001/cm/3.jpg', 0, true);
INSERT INTO public.posts (id, user_id, content, post_type) VALUES
  ('00000000-0000-4000-8000-0000bdd00001', '00000000-0000-4000-8000-0000bd000001', 'cm post by A', 'text'),
  ('00000000-0000-4000-8000-0000bdd00002', '00000000-0000-4000-8000-0000bd000003', 'cm post by V', 'text');
INSERT INTO public.posts (id, user_id, post_type, repost_of_post_id) VALUES
  ('00000000-0000-4000-8000-0000bdd00003', '00000000-0000-4000-8000-0000bd000003', 'repost', '00000000-0000-4000-8000-0000bdd00001');
INSERT INTO public.posts (id, user_id, post_type, quote_of_post_id, content) VALUES
  ('00000000-0000-4000-8000-0000bdd00004', '00000000-0000-4000-8000-0000bd000003', 'quote', '00000000-0000-4000-8000-0000bdd00001', 'cm quote by V');
INSERT INTO public.posts (id, user_id, post_type, item_id, image_url) VALUES
  ('00000000-0000-4000-8000-0000bdd00005', '00000000-0000-4000-8000-0000bd000001', 'item', '00000000-0000-4000-8000-0000bde00003', 'https://x.invalid/snap3');
INSERT INTO public.posts (id, user_id, post_type, caption) VALUES
  ('00000000-0000-4000-8000-0000bdd00006', '00000000-0000-4000-8000-0000bd000001', 'card_share', 'cm share');
INSERT INTO public.card_share_items (post_id, item_id, snapshot_image_url, snapshot_title) VALUES
  ('00000000-0000-4000-8000-0000bdd00006', '00000000-0000-4000-8000-0000bde00003', 'https://x.invalid/snap3', 'cmthree card');
INSERT INTO public.comments (id, user_id, post_id, body) VALUES
  ('00000000-0000-4000-8000-0000bdc00001', '00000000-0000-4000-8000-0000bd000003', '00000000-0000-4000-8000-0000bdd00001', 'cm comment by V on A'),
  ('00000000-0000-4000-8000-0000bdc00003', '00000000-0000-4000-8000-0000bd000001', '00000000-0000-4000-8000-0000bdd00002', 'cm comment by A on V'),
  ('00000000-0000-4000-8000-0000bdc00009', '00000000-0000-4000-8000-0000bd000001', '00000000-0000-4000-8000-0000bdd00002', 'cm comment to delete');
INSERT INTO public.likes (user_id, post_id) VALUES ('00000000-0000-4000-8000-0000bd000003', '00000000-0000-4000-8000-0000bdd00001');
INSERT INTO public.item_comments (id, user_id, item_id, body) VALUES
  ('00000000-0000-4000-8000-0000bd1c0001', '00000000-0000-4000-8000-0000bd000001', '00000000-0000-4000-8000-0000bde00004', 'cm item comment');
INSERT INTO public.folder_comments (id, user_id, folder_id, body) VALUES
  ('00000000-0000-4000-8000-0000bd2c0001', '00000000-0000-4000-8000-0000bd000001', '00000000-0000-4000-8000-0000bdf00003', 'cm folder comment');
INSERT INTO public.gallery_comments (id, user_id, folder_id, body, player_key) VALUES
  ('00000000-0000-4000-8000-0000bd3c0001', '00000000-0000-4000-8000-0000bd000001', '00000000-0000-4000-8000-0000bdf00003', 'cm gallery comment', 'p');
INSERT INTO public.profile_grail_slots (user_id, slot_index, entry_type, item_id, collection_id) VALUES
  ('00000000-0000-4000-8000-0000bd000001', 0, 'item', '00000000-0000-4000-8000-0000bde00003', NULL),
  ('00000000-0000-4000-8000-0000bd000001', 2, 'collection', NULL, '00000000-0000-4000-8000-0000bdf00001');
INSERT INTO public.profile_showcase_items (user_id, item_id, display_order) VALUES
  ('00000000-0000-4000-8000-0000bd000001', '00000000-0000-4000-8000-0000bde00003', 0);
INSERT INTO public.conversations (id) VALUES ('00000000-0000-4000-8000-0000bda00001');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000bda00001', '00000000-0000-4000-8000-0000bd000001'),
  ('00000000-0000-4000-8000-0000bda00001', '00000000-0000-4000-8000-0000bd000004');
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('dm-attachments', '00000000-0000-4000-8000-0000bda00001/00000000-0000-4000-8000-0000bd500001/image.jpg',
   '00000000-0000-4000-8000-0000bd000001', '00000000-0000-4000-8000-0000bd000001');
INSERT INTO public.messages (id, conversation_id, sender_id, body, attachment_type, attachment_storage_path, attachment_width, attachment_height) VALUES
  ('00000000-0000-4000-8000-0000bd500001', '00000000-0000-4000-8000-0000bda00001', '00000000-0000-4000-8000-0000bd000001', NULL, 'image',
   '00000000-0000-4000-8000-0000bda00001/00000000-0000-4000-8000-0000bd500001/image.jpg', 1, 1);
INSERT INTO public.messages (id, conversation_id, sender_id, body) VALUES
  ('00000000-0000-4000-8000-0000bd500002', '00000000-0000-4000-8000-0000bda00001', '00000000-0000-4000-8000-0000bd000004', 'cm reply from R');
INSERT INTO public.notifications (user_id, actor_id, type, post_id, comment_id) VALUES
  ('00000000-0000-4000-8000-0000bd000001', '00000000-0000-4000-8000-0000bd000003', 'like', '00000000-0000-4000-8000-0000bdd00001', NULL),
  ('00000000-0000-4000-8000-0000bd000003', '00000000-0000-4000-8000-0000bd000001', 'comment', '00000000-0000-4000-8000-0000bdd00002', '00000000-0000-4000-8000-0000bdc00003');
INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES ('00000000-0000-4000-8000-0000bd000001', '00000000-0000-4000-8000-0000bd000007');

-- Reports (as the server files them).
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence) VALUES
  ('00000000-0000-4000-8000-0000bd100001', '00000000-0000-4000-8000-0000bd000003', 'post', '00000000-0000-4000-8000-0000bdd00001', '00000000-0000-4000-8000-0000bd000001', 'spam', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd100002', '00000000-0000-4000-8000-0000bd000002', 'post', '00000000-0000-4000-8000-0000bdd00001', '00000000-0000-4000-8000-0000bd000001', 'harassment', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd100003', '00000000-0000-4000-8000-0000bd000003', 'comment', '00000000-0000-4000-8000-0000bdc00003', '00000000-0000-4000-8000-0000bd000001', 'harassment', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd100004', '00000000-0000-4000-8000-0000bd000002', 'item_comment', '00000000-0000-4000-8000-0000bd1c0001', '00000000-0000-4000-8000-0000bd000001', 'child_safety', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd100005', '00000000-0000-4000-8000-0000bd000002', 'folder_comment', '00000000-0000-4000-8000-0000bd2c0001', '00000000-0000-4000-8000-0000bd000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd100006', '00000000-0000-4000-8000-0000bd000002', 'gallery_comment', '00000000-0000-4000-8000-0000bd3c0001', '00000000-0000-4000-8000-0000bd000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd100007', '00000000-0000-4000-8000-0000bd000004', 'message', '00000000-0000-4000-8000-0000bd500001', '00000000-0000-4000-8000-0000bd000001', 'sexual', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd100008', '00000000-0000-4000-8000-0000bd000002', 'collection_item', '00000000-0000-4000-8000-0000bde00003', '00000000-0000-4000-8000-0000bd000001', 'scam_fraud', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd100009', '00000000-0000-4000-8000-0000bd000002', 'collection_item', '00000000-0000-4000-8000-0000bde00002', '00000000-0000-4000-8000-0000bd000001', 'sexual',
   '{"v":1,"image_refs":[{"bucket":"item-images","path":"00000000-0000-4000-8000-0000bd000001/cm/2a.jpg"},{"bucket":"item-images","path":"00000000-0000-4000-8000-0000bd000001/cm/2b.jpg"}]}'),
  ('00000000-0000-4000-8000-0000bd10000a', '00000000-0000-4000-8000-0000bd000002', 'folder', '00000000-0000-4000-8000-0000bdf00001', '00000000-0000-4000-8000-0000bd000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd10000b', '00000000-0000-4000-8000-0000bd000002', 'folder', '00000000-0000-4000-8000-0000bdf00004', '00000000-0000-4000-8000-0000bd000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd10000c', '00000000-0000-4000-8000-0000bd000002', 'profile', '00000000-0000-4000-8000-0000bd000001', '00000000-0000-4000-8000-0000bd000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd10000d', '00000000-0000-4000-8000-0000bd000002', 'comment', '00000000-0000-4000-8000-0000bdc00009', '00000000-0000-4000-8000-0000bd000001', 'spam', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd10000e', '00000000-0000-4000-8000-0000bd000003', 'collection_item', '00000000-0000-4000-8000-0000bde00003', '00000000-0000-4000-8000-0000bd000001', 'spam', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd10000f', '00000000-0000-4000-8000-0000bd000002', 'post', '00000000-0000-4000-8000-0000bdd00002', '00000000-0000-4000-8000-0000bd000003', 'spam', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bd100010', '00000000-0000-4000-8000-0000bd000004', 'post', '00000000-0000-4000-8000-0000bdd00002', '00000000-0000-4000-8000-0000bd000003', 'spam', '{"v":1}');

-- ── 2. Authorization ────────────────────────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT public.admin_hide_content('00000000-0000-4000-8000-0000bd100001', 'pending_review') $$, '42501', NULL, 'signed-out: cannot hide');
SELECT throws_ok($$ SELECT public.my_moderation_status('post', ARRAY['00000000-0000-4000-8000-0000bdd00001']::uuid[]) $$, '42501', NULL, 'signed-out: no status function');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000002');
SELECT throws_ok($$ SELECT public.admin_hide_content('00000000-0000-4000-8000-0000bd100001', 'pending_review') $$, '42501', 'forbidden', 'collector: hide refused');
SELECT throws_ok($$ SELECT public.admin_remove_content('00000000-0000-4000-8000-0000bd100001', 'spam') $$, '42501', 'forbidden', 'collector: remove refused');
SELECT throws_ok($$ SELECT public.admin_restore_content(gen_random_uuid(), 'resolved_in_error', NULL, 'overturn') $$, '42501', 'forbidden', 'collector: restore refused');
SELECT throws_ok($$ SELECT count(*) FROM public.moderated_content $$, '42501', NULL, 'collector: no direct access to moderated_content');
SELECT throws_ok($$ SELECT private.is_moderated('post', gen_random_uuid()) $$, '42501', NULL, 'collector: internal lookups not callable');

-- ── 3. Visible before moderation ────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000bdd00001'), 1, 'before: O sees A''s post');
SELECT is((SELECT count(*)::int FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000bd000001'), 4, 'before: O sees A''s 4 items');
SELECT is((SELECT count(*)::int FROM public.folders WHERE user_id = '00000000-0000-4000-8000-0000bd000001'), 5, 'before: O sees A''s 5 folders');
SELECT is((SELECT count(*)::int FROM public.card_share_items WHERE item_id = '00000000-0000-4000-8000-0000bde00003'), 1, 'before: O sees the share row');

-- ── 4. Posts: hide → remove (with related) → overturn ──────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000005');
SELECT is((public.admin_hide_content('00000000-0000-4000-8000-0000bd100001', 'pending_review', 'checking') - 'moderation_id'),
  '{"report_id": "00000000-0000-4000-8000-0000bd100001", "state": "hidden", "report_status": "reviewing", "changed": true}'::jsonb,
  'M1 hides the post pending review');
SELECT is(public.admin_hide_content('00000000-0000-4000-8000-0000bd100001', 'pending_review') -> 'changed', 'false'::jsonb, 'hiding again is a no-op retry');
SELECT throws_ok($$ SELECT public.admin_resolve_report('00000000-0000-4000-8000-0000bd100001', 'no_violation', 'within_guidelines') $$,
  'PT409', 'content_moderated', 'a report over hidden content cannot simply be dismissed');

SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000002');
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000bdd00001'), 0, 'hidden post: invisible to another collector');
SELECT is((SELECT count(*)::int FROM public.comments WHERE post_id = '00000000-0000-4000-8000-0000bdd00001'), 0, 'hidden post: its comments are invisible to others');
SELECT is((SELECT count(*)::int FROM public.likes WHERE post_id = '00000000-0000-4000-8000-0000bdd00001'), 0, 'hidden post: its likes are invisible to others');
SELECT is((SELECT count(*)::int FROM public.posts WHERE id IN ('00000000-0000-4000-8000-0000bdd00003', '00000000-0000-4000-8000-0000bdd00004')), 2,
  'reposts and quotes of it remain (they reference it; the original no longer resolves)');
SELECT is((SELECT count(*)::int FROM public.posts p WHERE p.id = '00000000-0000-4000-8000-0000bdd00004'
             AND EXISTS (SELECT 1 FROM public.posts q WHERE q.id = p.quote_of_post_id)), 0, 'a quote''s target no longer resolves');
SELECT throws_ok($$ INSERT INTO public.likes (user_id, post_id) VALUES ('00000000-0000-4000-8000-0000bd000002', '00000000-0000-4000-8000-0000bdd00001') $$,
  '42501', 'content_unavailable', 'no new likes on a hidden post');
SELECT throws_ok($$ INSERT INTO public.comments (user_id, post_id, body) VALUES ('00000000-0000-4000-8000-0000bd000002', '00000000-0000-4000-8000-0000bdd00001', 'x') $$,
  '42501', 'content_unavailable', 'no new comments on a hidden post');
SELECT throws_ok($$ INSERT INTO public.posts (user_id, post_type, repost_of_post_id) VALUES ('00000000-0000-4000-8000-0000bd000002', 'repost', '00000000-0000-4000-8000-0000bdd00001') $$,
  '42501', 'content_unavailable', 'no reposts of a hidden post');
SELECT throws_ok($$ INSERT INTO public.posts (user_id, post_type, quote_of_post_id, content) VALUES ('00000000-0000-4000-8000-0000bd000002', 'quote', '00000000-0000-4000-8000-0000bdd00001', 'q') $$,
  '42501', 'content_unavailable', 'no quotes of a hidden post');
SELECT is(public.my_moderation_status('post', ARRAY['00000000-0000-4000-8000-0000bdd00001']::uuid[]), '[]'::jsonb,
  'status function: nothing about other collectors'' content');

SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000003');
-- Known limitation (release dependency): the existing account-lifecycle
-- guard on comments/likes requires the parent post to be readable, so a
-- third party's own comment/like on a hidden post is hidden from them too
-- until a restore (same mechanism as the tracked blocked-comment issue).
SELECT is((SELECT count(*)::int FROM public.comments WHERE id = '00000000-0000-4000-8000-0000bdc00001'), 0,
  'known limitation: a commenter''s own comment on a hidden post is hidden from them (lifecycle guard needs the post)');
SELECT is((SELECT count(*)::int FROM public.likes WHERE post_id = '00000000-0000-4000-8000-0000bdd00001'), 0,
  'known limitation: likewise a liker''s own like');

SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000001');
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000bdd00001'), 1, 'the owner still sees their hidden post');
SELECT is((SELECT count(*)::int FROM public.comments WHERE post_id = '00000000-0000-4000-8000-0000bdd00001'), 1, '… and its comments');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE post_id = '00000000-0000-4000-8000-0000bdd00001'), 1, '… and its notifications');
SELECT is((public.my_moderation_status('post', ARRAY['00000000-0000-4000-8000-0000bdd00001']::uuid[]) -> 0) - 'since',
  '{"state": "hidden", "target_id": "00000000-0000-4000-8000-0000bdd00001", "target_type": "post"}'::jsonb,
  'the owner learns the state — and nothing about the report or admin');
SELECT throws_ok($$ INSERT INTO public.comments (user_id, post_id, body) VALUES ('00000000-0000-4000-8000-0000bd000001', '00000000-0000-4000-8000-0000bdd00001', 'x') $$,
  '42501', 'content_unavailable', 'the owner cannot add new interactions either');
SELECT throws_ok($$ SELECT public.my_moderation_status('post', array_fill(gen_random_uuid(), ARRAY[201])) $$, '22023', 'invalid_argument', 'status lookups are bounded');

RESET ROLE; SELECT pg_temp.logout(); SET LOCAL ROLE anon;
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000bdd00001'), 0, 'hidden post: invisible signed out');
RESET ROLE; SET LOCAL ROLE authenticated;

SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000005');
SELECT is((public.admin_remove_content('00000000-0000-4000-8000-0000bd100001', 'spam', 'confirmed') - 'moderation_id'),
  '{"report_id": "00000000-0000-4000-8000-0000bd100001", "state": "removed", "report_status": "actioned", "changed": true, "related_resolved": 1}'::jsonb,
  'remove: the hidden post becomes removed; the other report on it is resolved too');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000bd100001', 'spam') -> 'changed', 'false'::jsonb, 'removing again is a no-op retry');
SELECT throws_ok($$ SELECT public.admin_remove_content('00000000-0000-4000-8000-0000bd100001', 'hate') $$, 'PT409', 'already_resolved', 'a different removal of a resolved report is refused');
SELECT throws_ok($$ SELECT public.admin_hide_content('00000000-0000-4000-8000-0000bd100001', 'pending_review') $$, 'PT409', 'already_resolved', 'a resolved report cannot be hidden again');
RESET ROLE;
INSERT INTO mids SELECT 'post', moderation_id FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000bd100001';
SELECT ok((SELECT bool_and(status = 'actioned' AND resolution = 'content_removed' AND moderation_id = (SELECT id FROM mids WHERE k = 'post'))
           FROM public.content_reports WHERE id IN ('00000000-0000-4000-8000-0000bd100001', '00000000-0000-4000-8000-0000bd100002')),
  'both reports: actioned / content_removed, linked to the same restriction');
SELECT is((SELECT array_agg(action ORDER BY created_at) FROM public.moderation_actions WHERE report_id = '00000000-0000-4000-8000-0000bd100001'),
  ARRAY['hide', 'remove'], 'audit: hide then remove (retries add nothing)');
SELECT ok((SELECT metadata ->> 'via_report' = '00000000-0000-4000-8000-0000bd100001' FROM public.moderation_actions WHERE report_id = '00000000-0000-4000-8000-0000bd100002'),
  'audit: the related report''s row points at the primary');
SELECT is((SELECT count(*)::int FROM public.moderated_content WHERE target_type = 'post' AND target_id = '00000000-0000-4000-8000-0000bdd00001'), 1,
  'one restriction row (hidden → removed in place)');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_restore_content((SELECT id FROM mids WHERE k = 'post'), 'resolved_in_error', NULL, 'keep_reviewing') $$,
  '22023', 'invalid_disposition', 'keep_reviewing is impossible once removed');
SELECT throws_ok($$ SELECT public.admin_restore_content((SELECT id FROM mids WHERE k = 'post'), 'resolved_in_error', NULL, NULL) $$,
  '22023', 'invalid_disposition', 'restore requires a disposition');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000006');
SELECT ok((SELECT (x ->> 'changed')::boolean AND jsonb_array_length(x -> 'reports') = 2
           FROM public.admin_restore_content((SELECT id FROM mids WHERE k = 'post'), 'appeal_granted', 'appeal ok', 'overturn') x),
  'M2 restores with overturn');
SELECT is(public.admin_restore_content((SELECT id FROM mids WHERE k = 'post'), 'appeal_granted', NULL, 'overturn') -> 'changed', 'false'::jsonb,
  'restoring again is a no-op retry');
RESET ROLE;
SELECT ok((SELECT bool_and(status = 'dismissed' AND resolution = 'no_violation' AND resolution_reason = 'decision_overturned')
           FROM public.content_reports WHERE moderation_id = (SELECT id FROM mids WHERE k = 'post')),
  'overturn: every linked report is dismissed / decision_overturned — none left actioned');
SELECT ok((SELECT lifted_at IS NOT NULL AND lift_reason = 'appeal_granted' AND lifted_by = '00000000-0000-4000-8000-0000bd000006'
           FROM public.moderated_content WHERE id = (SELECT id FROM mids WHERE k = 'post')), 'the restriction is lifted, with who and why');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000002');
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000bdd00001'), 1, 'restored: O sees the post again');
SELECT is((SELECT count(*)::int FROM public.comments WHERE post_id = '00000000-0000-4000-8000-0000bdd00001'), 1, 'restored: and its comments');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000007');
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000bdd00001'), 0, 'blocking still applies after a restore');

-- ── 5. Comments (all four kinds) ────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000005');
SELECT is(public.admin_hide_content('00000000-0000-4000-8000-0000bd100003', 'urgent_risk') ->> 'state', 'hidden', 'hide A''s comment on V''s post');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000003');
SELECT is((SELECT count(*)::int FROM public.comments WHERE id = '00000000-0000-4000-8000-0000bdc00003'), 0, 'hidden comment: invisible even to the post''s owner');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE comment_id = '00000000-0000-4000-8000-0000bdc00003'), 0, 'hidden comment: its notification is hidden');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000001');
SELECT is((SELECT count(*)::int FROM public.comments WHERE id = '00000000-0000-4000-8000-0000bdc00003'), 1, 'the comment''s author still sees it');
RESET ROLE;
INSERT INTO mids SELECT 'c3', moderation_id FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000bd100003';
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000005');
SELECT is((SELECT x -> 'reports' FROM public.admin_restore_content((SELECT id FROM mids WHERE k = 'c3'), 'new_information', NULL, 'keep_reviewing') x),
  '[{"id": "00000000-0000-4000-8000-0000bd100003", "status": "reviewing"}]'::jsonb, 'lift a hide but keep the report under review');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000003');
SELECT is((SELECT count(*)::int FROM public.comments WHERE id = '00000000-0000-4000-8000-0000bdc00003'), 1, 'the lifted comment is visible again');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000005');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000bd100003', 'harassment') ->> 'state', 'removed', 'the same report can later lead to a removal');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000bd100004', 'child_safety') ->> 'state', 'removed', 'remove an item comment (child safety)');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000bd100005', 'hate') ->> 'state', 'removed', 'remove a folder comment');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000bd100006', 'hate') ->> 'state', 'removed', 'remove a gallery comment');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000002');
SELECT is((SELECT count(*)::int FROM public.item_comments WHERE id = '00000000-0000-4000-8000-0000bd1c0001')
        + (SELECT count(*)::int FROM public.folder_comments WHERE id = '00000000-0000-4000-8000-0000bd2c0001')
        + (SELECT count(*)::int FROM public.gallery_comments WHERE id = '00000000-0000-4000-8000-0000bd3c0001'), 0,
  'removed item, folder and gallery comments are invisible to others');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000001');
SELECT is((SELECT count(*)::int FROM public.item_comments WHERE id = '00000000-0000-4000-8000-0000bd1c0001')
        + (SELECT count(*)::int FROM public.gallery_comments WHERE id = '00000000-0000-4000-8000-0000bd3c0001'), 2, 'the author still sees them');
DELETE FROM public.folder_comments WHERE id = '00000000-0000-4000-8000-0000bd2c0001';
SELECT is((SELECT count(*)::int FROM public.folder_comments WHERE id = '00000000-0000-4000-8000-0000bd2c0001'), 0, 'the author can delete their removed comment');
RESET ROLE;
SELECT ok((SELECT child_safety FROM public.moderated_content WHERE target_id = '00000000-0000-4000-8000-0000bd1c0001'), 'the child-safety restriction is flagged');
INSERT INTO mids SELECT 'ic', id FROM public.moderated_content WHERE target_id = '00000000-0000-4000-8000-0000bd1c0001';
INSERT INTO mids SELECT 'gc', id FROM public.moderated_content WHERE target_id = '00000000-0000-4000-8000-0000bd3c0001';
SET LOCAL ROLE authenticated;

-- ── 6. Direct messages ──────────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000004');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'dm-attachments' AND name LIKE '00000000-0000-4000-8000-0000bda00001/%'), 1,
  'before: the recipient can read (sign) the DM photo');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000006');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000bd100007', 'sexual') ->> 'state', 'removed', 'M2 removes the DM photo message');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000004');
SELECT is((SELECT array_agg(id ORDER BY id) FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000bda00001'),
  ARRAY['00000000-0000-4000-8000-0000bd500002']::uuid[], 'the recipient sees the rest of the conversation, not the removed message');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'dm-attachments' AND name LIKE '00000000-0000-4000-8000-0000bda00001/%'), 0,
  'the recipient can no longer read (sign) the photo');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000001');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000bda00001'), 2, 'the sender still sees both messages');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'dm-attachments' AND name LIKE '00000000-0000-4000-8000-0000bda00001/%'), 1,
  'the sender keeps access to their own photo');

-- ── 7. Collection items ─────────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000005');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000bd100008', 'scam_fraud') ->> 'related_resolved', '1', 'remove an item (the second report on it is resolved)');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000002');
SELECT is((SELECT count(*)::int FROM public.collection_items WHERE id = '00000000-0000-4000-8000-0000bde00003'), 0, 'removed item: invisible');
SELECT is((SELECT count(*)::int FROM public.collection_item_images WHERE item_id = '00000000-0000-4000-8000-0000bde00003'), 0, 'its images: invisible');
SELECT is((SELECT count(*)::int FROM public.profile_grail_slots WHERE item_id = '00000000-0000-4000-8000-0000bde00003'), 0, 'its Grail slot: invisible');
SELECT is((SELECT count(*)::int FROM public.profile_showcase_items WHERE item_id = '00000000-0000-4000-8000-0000bde00003'), 0, 'its showcase entry: invisible');
SELECT is((SELECT count(*)::int FROM public.card_share_items WHERE item_id = '00000000-0000-4000-8000-0000bde00003'), 0, 'its share row (snapshot) in a post: invisible');
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000bdd00005'), 0, 'a single-item post of it: invisible');
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000bdd00006'), 1, 'a multi-card share post stays (minus that card)');
SELECT is((SELECT count(*)::int FROM public.search_profile_items('00000000-0000-4000-8000-0000bd000001', 'cmthree', 50, 0)), 0, 'search no longer finds it');
SELECT throws_ok($$ INSERT INTO public.item_likes (user_id, item_id) VALUES ('00000000-0000-4000-8000-0000bd000002', '00000000-0000-4000-8000-0000bde00003') $$,
  '42501', 'content_unavailable', 'no likes on a removed item');
SELECT throws_ok($$ INSERT INTO public.saved_cards (user_id, item_id) VALUES ('00000000-0000-4000-8000-0000bd000002', '00000000-0000-4000-8000-0000bde00003') $$,
  '42501', 'content_unavailable', 'no saves of a removed item');
SELECT throws_ok($$ INSERT INTO public.item_comments (user_id, item_id, body) VALUES ('00000000-0000-4000-8000-0000bd000002', '00000000-0000-4000-8000-0000bde00003', 'x') $$,
  '42501', 'content_unavailable', 'no comments on a removed item');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000001');
SELECT is((SELECT count(*)::int FROM public.collection_items WHERE id = '00000000-0000-4000-8000-0000bde00003'), 1, 'the owner still sees the item');
SELECT is((SELECT count(*)::int FROM public.search_profile_items('00000000-0000-4000-8000-0000bd000001', 'cmthree', 50, 0)), 1, '… and finds it in their own search');
SELECT throws_ok($$ INSERT INTO public.card_share_items (post_id, item_id, snapshot_image_url) VALUES ('00000000-0000-4000-8000-0000bdd00006', '00000000-0000-4000-8000-0000bde00003', 'https://x.invalid/s') $$,
  '42501', 'content_unavailable', 'owner: cannot re-share it in a card share');
SELECT throws_ok($$ INSERT INTO public.posts (user_id, post_type, item_id, image_url) VALUES ('00000000-0000-4000-8000-0000bd000001', 'item', '00000000-0000-4000-8000-0000bde00003', 'https://x.invalid/s') $$,
  '42501', 'content_unavailable', 'owner: cannot post it as an item post');
SELECT throws_ok($$ INSERT INTO public.messages (conversation_id, sender_id, attachment_type, attachment_item_id) VALUES ('00000000-0000-4000-8000-0000bda00001', '00000000-0000-4000-8000-0000bd000001', 'item', '00000000-0000-4000-8000-0000bde00003') $$,
  '42501', NULL, 'owner: cannot send it as a DM item card (refused by item_not_shareable before the moderation guard)');
SELECT throws_ok($$ INSERT INTO public.profile_grail_slots (user_id, slot_index, entry_type, item_id) VALUES ('00000000-0000-4000-8000-0000bd000001', 1, 'item', '00000000-0000-4000-8000-0000bde00003') $$,
  '42501', 'content_unavailable', 'owner: cannot place it in a Grail slot');
SELECT throws_ok($$ UPDATE public.folders SET cover_item_id = '00000000-0000-4000-8000-0000bde00003' WHERE id = '00000000-0000-4000-8000-0000bdf00003' $$,
  '42501', 'content_unavailable', 'owner: cannot make it a folder cover');
SELECT throws_ok($$ INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by) VALUES ('00000000-0000-4000-8000-0000bde00003', '00000000-0000-4000-8000-0000bd000002', '00000000-0000-4000-8000-0000bd000001') $$,
  '42501', 'content_unavailable', 'owner: cannot tag collectors on it');
SELECT lives_ok($$ UPDATE public.collection_items SET title = 'cmthree card edited' WHERE id = '00000000-0000-4000-8000-0000bde00003' $$,
  'owner: may still edit the item (it stays restricted)');
RESET ROLE;
SELECT ok((SELECT NOT item_is_public AND NOT folder_effectively_visible AND NOT grail_showcased
           FROM public.resolve_item_images_for_signing(ARRAY['00000000-0000-4000-8000-0000bdb00004']::uuid[])),
  'signing resolver: the removed item''s image is signable for its owner only');
SELECT ok(NOT public._item_visible_to('00000000-0000-4000-8000-0000bde00003', '00000000-0000-4000-8000-0000bd000002')
      AND public._item_visible_to('00000000-0000-4000-8000-0000bde00003', '00000000-0000-4000-8000-0000bd000001'),
  '_item_visible_to (reporting, export): owner only');
SET LOCAL ROLE authenticated;

-- ── 8. A single item image ──────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000005');
SELECT throws_ok($$ SELECT public.admin_hide_content('00000000-0000-4000-8000-0000bd10000f', 'pending_review', NULL, 0) $$,
  '22023', 'invalid_argument', 'image scope only applies to item reports');
SELECT throws_ok($$ SELECT public.admin_hide_content('00000000-0000-4000-8000-0000bd100009', 'pending_review', NULL, 7) $$,
  '22023', 'invalid_argument', 'image index must exist in the evidence');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000bd100009', 'sexual', NULL, 0) ->> 'state', 'removed', 'remove one image of an item');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000002');
SELECT is((SELECT array_agg(id ORDER BY id) FROM public.collection_item_images WHERE item_id = '00000000-0000-4000-8000-0000bde00002'),
  ARRAY['00000000-0000-4000-8000-0000bdb00003']::uuid[], 'the item and its other image stay visible; the removed image does not');
SELECT lives_ok($$ INSERT INTO public.item_likes (user_id, item_id) VALUES ('00000000-0000-4000-8000-0000bd000002', '00000000-0000-4000-8000-0000bde00002') $$,
  'the item itself can still be liked');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000001');
SELECT throws_ok($$ INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order) VALUES ('00000000-0000-4000-8000-0000bde00004', '00000000-0000-4000-8000-0000bd000001', 'https://x.invalid/again', '00000000-0000-4000-8000-0000bd000001/cm/2a.jpg', 1) $$,
  '42501', 'content_unavailable', 'owner: cannot re-attach the removed image file to another item');
SELECT throws_ok($$ INSERT INTO public.card_share_items (post_id, item_id, snapshot_image_url) VALUES ('00000000-0000-4000-8000-0000bdd00006', '00000000-0000-4000-8000-0000bde00002', 'https://x.invalid/s') $$,
  '42501', 'content_unavailable', 'owner: cannot share an item whose image was removed (a snapshot would copy it)');
SELECT throws_ok($$ UPDATE public.folders SET cover_storage_path = '00000000-0000-4000-8000-0000bd000001/cm/2a.jpg' WHERE id = '00000000-0000-4000-8000-0000bdf00003' $$,
  '42501', 'content_unavailable', 'owner: cannot use the removed image as a cover');
RESET ROLE;
SELECT is((SELECT array_agg(image_id ORDER BY image_id) FROM public.resolve_item_images_for_signing(ARRAY['00000000-0000-4000-8000-0000bdb00002', '00000000-0000-4000-8000-0000bdb00003']::uuid[])
           WHERE item_is_public AND folder_effectively_visible), ARRAY['00000000-0000-4000-8000-0000bdb00003']::uuid[],
  'signing resolver: only the unrestricted image is publicly signable');
SET LOCAL ROLE authenticated;

-- ── 9. Folders and nested collections ───────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000006');
SELECT is(public.admin_hide_content('00000000-0000-4000-8000-0000bd10000a', 'pending_review') ->> 'state', 'hidden', 'hide a folder with a subfolder');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000002');
SELECT is((SELECT count(*)::int FROM public.folders WHERE id IN ('00000000-0000-4000-8000-0000bdf00001', '00000000-0000-4000-8000-0000bdf00002')), 0,
  'the folder and its subfolder are invisible');
SELECT is((SELECT count(*)::int FROM public.collection_items WHERE id IN ('00000000-0000-4000-8000-0000bde00001', '00000000-0000-4000-8000-0000bde00002')), 0,
  'items in the folder and its subfolder are invisible');
SELECT is((SELECT count(*)::int FROM public.collection_item_images WHERE item_id IN ('00000000-0000-4000-8000-0000bde00001', '00000000-0000-4000-8000-0000bde00002')), 0,
  'their images are invisible');
SELECT is((SELECT count(*)::int FROM public.profile_grail_slots WHERE collection_id = '00000000-0000-4000-8000-0000bdf00001'), 0, 'its Grail collection slot is invisible');
SELECT is((SELECT count(*)::int FROM public.search_profile_items('00000000-0000-4000-8000-0000bd000001', 'cm item', 50, 0)), 1, 'search finds only items outside it');
SELECT throws_ok($$ INSERT INTO public.saved_folders (user_id, folder_id) VALUES ('00000000-0000-4000-8000-0000bd000002', '00000000-0000-4000-8000-0000bdf00002') $$,
  '42501', 'content_unavailable', 'no saving a folder inside it');
SELECT throws_ok($$ INSERT INTO public.folder_comments (user_id, folder_id, body) VALUES ('00000000-0000-4000-8000-0000bd000002', '00000000-0000-4000-8000-0000bdf00002', 'x') $$,
  '42501', 'content_unavailable', 'no comments on a folder inside it');
SELECT throws_ok($$ INSERT INTO public.item_likes (user_id, item_id) VALUES ('00000000-0000-4000-8000-0000bd000002', '00000000-0000-4000-8000-0000bde00001') $$,
  '42501', 'content_unavailable', 'no likes on an item inside it');
RESET ROLE;
SELECT ok(NOT public._folder_visible_to('00000000-0000-4000-8000-0000bdf00002', '00000000-0000-4000-8000-0000bd000002')
      AND NOT public._folder_visible_to('00000000-0000-4000-8000-0000bdf00001', '00000000-0000-4000-8000-0000bd000002')
      AND public._folder_visible_to('00000000-0000-4000-8000-0000bdf00002', '00000000-0000-4000-8000-0000bd000001'),
  '_folder_visible_to: invisible to others even with the Grail exception; visible to the owner');
SELECT is((SELECT array_agg(visible) FROM public.folder_effective_visibility_batch(ARRAY['00000000-0000-4000-8000-0000bdf00001', '00000000-0000-4000-8000-0000bdf00002']::uuid[], NULL)),
  ARRAY[false, false], 'folder signing batch (service role): not visible');
SELECT is((SELECT count(*)::int FROM public.resolve_item_images_for_signing(ARRAY['00000000-0000-4000-8000-0000bdb00001']::uuid[]) WHERE item_is_public OR folder_effectively_visible OR grail_showcased), 0,
  'signing resolver: images inside it are owner-only');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000001');
SELECT is((SELECT count(*)::int FROM public.folders WHERE id IN ('00000000-0000-4000-8000-0000bdf00001', '00000000-0000-4000-8000-0000bdf00002')), 2, 'the owner still sees both folders');
SELECT throws_ok($$ UPDATE public.collection_items SET folder_id = '00000000-0000-4000-8000-0000bdf00003' WHERE id = '00000000-0000-4000-8000-0000bde00001' $$,
  '42501', 'content_unavailable', 'owner: cannot move an item out of it');
SELECT throws_ok($$ UPDATE public.folders SET parent_folder_id = NULL WHERE id = '00000000-0000-4000-8000-0000bdf00002' $$,
  '42501', 'content_unavailable', 'owner: cannot move the subfolder out of it');
SELECT throws_ok($$ INSERT INTO public.posts (user_id, post_type, folder_id, caption) VALUES ('00000000-0000-4000-8000-0000bd000001', 'folder_share', '00000000-0000-4000-8000-0000bdf00002', 'x') $$,
  '42501', 'content_unavailable', 'owner: cannot share it as a collection post');
SELECT throws_ok($$ INSERT INTO public.profile_grail_slots (user_id, slot_index, entry_type, collection_id) VALUES ('00000000-0000-4000-8000-0000bd000001', 3, 'collection', '00000000-0000-4000-8000-0000bdf00002') $$,
  '42501', 'content_unavailable', 'owner: cannot showcase it as a Grail collection');
SELECT lives_ok($$ UPDATE public.folders SET is_public = false WHERE id = '00000000-0000-4000-8000-0000bdf00002' $$, 'owner: may change its privacy (it stays restricted)');
SELECT lives_ok($$ UPDATE public.collection_items SET folder_id = '00000000-0000-4000-8000-0000bdf00002' WHERE id = '00000000-0000-4000-8000-0000bde00004' $$,
  'owner: may move other items into it (they become restricted)');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000002');
SELECT is((SELECT count(*)::int FROM public.collection_items WHERE id = '00000000-0000-4000-8000-0000bde00004'), 0, 'an item moved into it is hidden');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000006');
SELECT is(public.admin_hide_content('00000000-0000-4000-8000-0000bd10000b', 'pending_review') ->> 'state', 'hidden', 'hide another folder with a subfolder');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000001');
SELECT lives_ok($$ DELETE FROM public.folders WHERE id = '00000000-0000-4000-8000-0000bdf00004' $$, 'owner: may delete a restricted folder (subfolders detach)');
RESET ROLE;
SELECT is((SELECT parent_folder_id FROM public.folders WHERE id = '00000000-0000-4000-8000-0000bdf00005'), NULL, 'its subfolder was detached by ON DELETE SET NULL');
SET LOCAL ROLE authenticated;

-- ── 10. Report integration, concurrency, atomicity ──────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000005');
SELECT throws_ok($$ SELECT public.admin_hide_content('00000000-0000-4000-8000-0000bd10000c', 'pending_review') $$, '22023', 'unsupported_target', 'profiles are moderated in M2.2');
SELECT throws_ok($$ SELECT public.admin_hide_content('00000000-0000-4000-8000-0000bd10000f', 'spam') $$, '22023', 'invalid_reason_code', 'hide reasons are hide-only');
SELECT throws_ok($$ SELECT public.admin_remove_content('00000000-0000-4000-8000-0000bd10000f', 'pending_review') $$, '22023', 'invalid_reason_code', 'remove needs a violation reason');
SELECT throws_ok($$ SELECT public.admin_hide_content(gen_random_uuid(), 'pending_review') $$, 'PT404', 'not_found', 'unknown report');
SELECT throws_ok($$ SELECT public.admin_restore_content(gen_random_uuid(), 'resolved_in_error', NULL, 'overturn') $$, 'PT404', 'not_found', 'unknown restriction');
RESET ROLE;
DELETE FROM public.comments WHERE id = '00000000-0000-4000-8000-0000bdc00009';
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_hide_content('00000000-0000-4000-8000-0000bd10000d', 'pending_review') $$, 'PT409', 'target_not_found', 'deleted content cannot be hidden');
SELECT is(public.admin_resolve_report('00000000-0000-4000-8000-0000bd10000d', 'administrative_closure', 'target_deleted') ->> 'status', 'dismissed',
  '… it is closed as target_deleted instead');

-- Atomicity: if the audit row cannot be written, nothing is enforced.
RESET ROLE;
ALTER TABLE public.moderation_actions ADD CONSTRAINT cm_test_fail CHECK (action <> 'remove') NOT VALID;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_remove_content('00000000-0000-4000-8000-0000bd10000f', 'spam') $$, '23514', NULL, 'a failing audit insert fails the removal');
RESET ROLE;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.moderated_content WHERE target_id = '00000000-0000-4000-8000-0000bdd00002')
      AND (SELECT status = 'open' AND moderation_id IS NULL FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000bd10000f'),
  '… no restriction and no report change: enforcement, resolution and audit are one transaction');
ALTER TABLE public.moderation_actions DROP CONSTRAINT cm_test_fail;
SET LOCAL ROLE authenticated;

-- Two admins, two reports, one post.
SELECT is(public.admin_hide_content('00000000-0000-4000-8000-0000bd10000f', 'pending_review') ->> 'changed', 'true', 'M1 hides V''s post via one report');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000006');
SELECT throws_ok($$ SELECT public.admin_remove_content('00000000-0000-4000-8000-0000bd10000f', 'spam') $$, 'PT409', 'claimed_by_other', 'M2 cannot act on M1''s claimed report');
SELECT ok((SELECT (x ->> 'changed')::boolean AND (x ->> 'state') = 'hidden' FROM public.admin_hide_content('00000000-0000-4000-8000-0000bd100010', 'pending_review') x),
  'M2 hides the same post via the other report: linked to the existing restriction');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000bd100010', 'spam', NULL, NULL, false) ->> 'state', 'removed', 'M2 removes it');
RESET ROLE;
SELECT is((SELECT count(DISTINCT moderation_id)::int FROM public.content_reports WHERE id IN ('00000000-0000-4000-8000-0000bd10000f', '00000000-0000-4000-8000-0000bd100010')), 1,
  'both reports point at one restriction');
SELECT ok((SELECT metadata ->> 'linked_existing' = 'true' FROM public.moderation_actions WHERE report_id = '00000000-0000-4000-8000-0000bd100010' AND action = 'hide'),
  'the second hide is audited as linked');
SELECT is((SELECT status FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000bd10000f'), 'reviewing', 'M1''s report is still under M1''s review');
INSERT INTO mids SELECT 'pv', moderation_id FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000bd100010';
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000005');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000bd10000f', 'spam') ->> 'report_status', 'actioned', 'M1 resolves their report against the same removal');
SELECT is((SELECT x -> 'reports' FROM public.admin_restore_content((SELECT id FROM mids WHERE k = 'pv'), 'new_information', NULL, 'reopen') x),
  '[{"id": "00000000-0000-4000-8000-0000bd10000f", "status": "open"}, {"id": "00000000-0000-4000-8000-0000bd100010", "status": "open"}]'::jsonb,
  'restore with reopen sends both reports back to the queue');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.content_reports WHERE status = 'actioned' AND (SELECT lifted_at FROM public.moderated_content m WHERE m.id = moderation_id) IS NOT NULL), 0,
  'no actioned report anywhere points at a lifted restriction');
SET LOCAL ROLE authenticated;

-- ── 11. Child safety: separately authorized restore ─────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000005');
SELECT throws_ok($$ SELECT public.admin_restore_content((SELECT id FROM mids WHERE k = 'ic'), 'child_safety_review_cleared', 'reviewed', 'overturn', true) $$,
  '42501', 'child_safety_second_admin_required', 'the removing admin cannot restore child-safety content');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000006');
SELECT throws_ok($$ SELECT public.admin_restore_content((SELECT id FROM mids WHERE k = 'ic'), 'child_safety_review_cleared', 'reviewed', 'overturn') $$,
  '42501', 'child_safety_confirmation_required', 'a second admin must confirm explicitly');
SELECT throws_ok($$ SELECT public.admin_restore_content((SELECT id FROM mids WHERE k = 'ic'), 'resolved_in_error', 'reviewed', 'overturn', true) $$,
  '42501', 'child_safety_confirmation_required', '… with the dedicated reason');
SELECT throws_ok($$ SELECT public.admin_restore_content((SELECT id FROM mids WHERE k = 'ic'), 'child_safety_review_cleared', NULL, 'overturn', true) $$,
  '42501', 'child_safety_confirmation_required', '… and a note');
SELECT is(public.admin_restore_content((SELECT id FROM mids WHERE k = 'ic'), 'child_safety_review_cleared', 'escalated and cleared', 'overturn', true) ->> 'changed', 'true',
  'a second admin with confirmation, reason and note may restore');
SELECT throws_ok($$ SELECT public.admin_restore_content((SELECT id FROM mids WHERE k = 'gc'), 'child_safety_review_cleared', 'x', 'overturn', true) $$,
  '22023', 'invalid_reason_code', 'the child-safety reason is only for child-safety restrictions');
RESET ROLE;
SELECT ok((SELECT metadata ->> 'child_safety' = 'true' AND note = 'escalated and cleared' AND admin_id = '00000000-0000-4000-8000-0000bd000006'
           FROM public.moderation_actions WHERE action = 'restore' AND metadata ->> 'moderation_id' = (SELECT id FROM mids WHERE k = 'ic')::text),
  'the child-safety restore is audited with its second admin and note');

-- ── 12. History is tamper-resistant ─────────────────────────────────────
SELECT throws_ok($$ DELETE FROM public.moderated_content $$, '42501', 'moderated_content_immutable', 'elevated: restrictions cannot be deleted');
SELECT throws_ok($$ UPDATE public.moderated_content SET target_id = gen_random_uuid() WHERE id = (SELECT id FROM mids WHERE k = 'gc') $$,
  '42501', 'moderated_content_immutable', 'elevated: the target cannot be changed');
SELECT throws_ok($$ UPDATE public.moderated_content SET lifted_at = NULL, lift_reason = NULL WHERE id = (SELECT id FROM mids WHERE k = 'post') $$,
  '42501', 'moderated_content_immutable', 'elevated: a lifted restriction cannot be silently re-activated');
SELECT throws_ok($$ UPDATE public.moderated_content SET child_safety = false WHERE id = (SELECT id FROM mids WHERE k = 'ic') $$,
  '42501', 'moderated_content_immutable', 'elevated: the child-safety flag cannot be cleared');
SELECT throws_ok($$ TRUNCATE public.moderated_content $$, '0A000', NULL, 'elevated: cannot truncate (referenced by reports; the trigger is a second line)');
SET LOCAL ROLE service_role;
SELECT ok((SELECT count(*) FROM public.moderated_content) > 0, 'the service role can read restrictions');
SELECT throws_ok($$ UPDATE public.moderated_content SET state = 'hidden' $$, '42501', NULL, 'service role: cannot change restrictions');
SELECT throws_ok($$ SELECT public.admin_hide_content('00000000-0000-4000-8000-0000bd10000f', 'pending_review') $$, '42501', NULL, 'service role: cannot call admin moderation functions');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE action IN ('hide', 'remove', 'restore')),
          (SELECT count(*)::int FROM public.moderation_actions WHERE action IN ('hide', 'remove', 'restore') AND admin_id IS NOT NULL AND metadata ? 'moderation_id'),
  'every hide/remove/restore audit row names its admin and restriction');

-- ── 13. Admin detail view ───────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000005');
SELECT ok((SELECT g #>> '{moderation,state}' = 'removed' AND (g #>> '{moderation,active}')::boolean
           FROM public.admin_get_report('00000000-0000-4000-8000-0000bd100008') g), 'admin_get_report shows the active restriction');
SELECT ok((SELECT NOT (g #>> '{moderation,active}')::boolean AND g #>> '{moderation,lift_reason}' = 'appeal_granted'
           FROM public.admin_get_report('00000000-0000-4000-8000-0000bd100001') g), '… or the lifted one');

-- ── 14. Lifecycle and permanent deletion ────────────────────────────────
RESET ROLE;
SELECT pg_temp.logout();
INSERT INTO public.account_lifecycle (user_id, state, mode, requested_at, scheduled_for)
  VALUES ('00000000-0000-4000-8000-0000bd000003', 'pending_deletion', 'scheduled', now(), now() + interval '30 days');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bd000002');
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000bdd00002'), 0,
  'a restored post of an account pending deletion stays hidden (lifecycle still applies)');
RESET ROLE;
SELECT pg_temp.logout();
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000bd000001';
SELECT ok(NOT EXISTS (SELECT 1 FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000bd000001'),
  'permanently deleting a collector with restricted content works');
SELECT ok((SELECT bool_and(owner_id IS NULL) FROM public.moderated_content WHERE target_id IN
           ('00000000-0000-4000-8000-0000bde00003', '00000000-0000-4000-8000-0000bd500001')),
  'restriction history stays, owner anonymised');
SELECT ok((SELECT count(*) = 2 FROM public.content_reports WHERE target_id = '00000000-0000-4000-8000-0000bde00003' AND status = 'actioned'),
  'the reports stay too');
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000bd000005';
SELECT ok((SELECT bool_and(created_by IS NULL) FROM public.moderated_content WHERE id = (SELECT id FROM mids WHERE k = 'gc')),
  'deleting an admin anonymises the restrictions they created');

SELECT * FROM finish();
ROLLBACK;
