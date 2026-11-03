-- pgTAP test for 20261103120000_add_account_lifecycle.sql (account
-- lifecycle, Dashboard Milestone 2 Checkpoint 1).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.
--
-- Collectors: A goes pending, B is an ordinary collector who interacts with
-- A, C is a third collector, anonymous visitors are checked too.

BEGIN;
SELECT plan(160);

-- ── Helpers ─────────────────────────────────────────────────────────────
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

-- ── 1. Shape, privileges and catalog-wide coverage ───────────────────────
SELECT has_table('public', 'account_lifecycle', 'account_lifecycle exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.account_lifecycle'::regclass), 'RLS is on for account_lifecycle');
SELECT ok(NOT has_table_privilege('anon', 'public.account_lifecycle', 'SELECT'), 'anon cannot read lifecycle state');
SELECT ok(NOT has_table_privilege('authenticated', 'public.account_lifecycle', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.account_lifecycle', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.account_lifecycle', 'DELETE'),
  'clients can never write lifecycle state');

CREATE TEMP TABLE lc_server_fns AS SELECT unnest(ARRAY[
  'public.schedule_account_deletion(uuid,integer)', 'public.cancel_account_deletion(uuid)',
  'public.begin_account_deletion(uuid,text)', 'public.list_due_account_deletions(integer)'])::regprocedure AS fn;
SELECT is((SELECT count(*)::int FROM lc_server_fns WHERE has_function_privilege('anon', fn, 'EXECUTE')
                                                     OR has_function_privilege('authenticated', fn, 'EXECUTE')), 0,
  'no transition function is callable by clients');
SELECT is((SELECT count(*)::int FROM lc_server_fns WHERE has_function_privilege('service_role', fn, 'EXECUTE')), 4,
  'every transition function is callable by the service role');
SELECT is((SELECT count(*)::int FROM lc_server_fns t JOIN pg_proc p ON p.oid = t.fn WHERE NOT p.prosecdef), 4,
  'transition functions run with the caller''s rights (SECURITY INVOKER)');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'private' AND p.proname IN ('account_is_hidden', 'caller_is_hidden', 'guard_account_write', 'reject_hidden_interaction_target',
                                                         'enforce_account_lifecycle_transition')
             AND p.prosecdef AND p.proconfig = ARRAY['search_path=""']), 5,
  'private helpers are SECURITY DEFINER with a pinned search_path');
SELECT ok(NOT has_schema_privilege('public', 'private', 'CREATE') AND NOT has_schema_privilege('authenticated', 'private', 'CREATE'),
  'nobody but the owner can create objects in the private schema');

-- Catalog audits: these fail if a current or FUTURE public table lacks a guard.
SELECT is((SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity), 0,
  'every public table has RLS enabled');
SELECT is((SELECT string_agg(c.relname, ', ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'account_lifecycle'
             AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'account_lifecycle_read_guard'
                               AND NOT p.polpermissive AND p.polcmd = 'r')), NULL,
  'every public table has the restrictive account_lifecycle_read_guard select policy');
SELECT is((SELECT string_agg(c.relname, ', ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'account_lifecycle'
             AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'account_write_guard' AND t.tgenabled = 'O')), NULL,
  'every public table has the account_write_guard trigger (insert, update and delete)');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgname = 'account_write_guard'
             AND (t.tgtype & 1) = 0 AND (t.tgtype & 2) = 2 AND (t.tgtype & 28) = 28), (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'account_write_guard'),
  'every write guard is BEFORE, statement-level and covers INSERT, UPDATE and DELETE');
SELECT is((SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = 'storage.objects'::regclass AND NOT p.polpermissive
             AND p.polname IN ('account_lifecycle_read_guard', 'account_lifecycle_insert_guard',
                               'account_lifecycle_update_guard', 'account_lifecycle_delete_guard')), 4,
  'storage.objects has restrictive guards for select, insert, update and delete');
SELECT is((SELECT string_agg(t, ', ') FROM unnest(ARRAY['follows','likes','comments','grail_ratings','item_likes','item_comments',
             'folder_likes','folder_comments','gallery_comments','saved_cards','saved_folders','saved_grails','collection_item_tags',
             'folder_tags','conversation_participants','messages','card_share_items','folder_share_items','rate_my_grail_cards',
             'post_images','ownership_transfers']) t
           WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = ('public.' || t)::regclass AND g.tgname = 'interaction_target_guard')), NULL,
  'every interaction table rejects hidden targets');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.posts'::regclass
             AND tgname IN ('interaction_target_guard_repost', 'interaction_target_guard_quote')), 2,
  'reposts and quotes of a hidden collector''s post are rejected');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public._folder_is_effectively_visible_for(uuid,uuid)', 'public._item_visible_to(uuid,uuid)',
             'public.item_is_grail_showcased(uuid)', 'public.folder_is_grail_showcased(uuid)',
             'public.resolve_item_images_for_signing(uuid[])']::regprocedure[]) f JOIN pg_proc p ON p.oid = f
           WHERE p.prosrc LIKE '%private.account_is_hidden%'), 5,
  'every SECURITY DEFINER visibility helper checks hidden accounts');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.folder_is_effectively_visible(uuid)', 'public._folder_visible_to(uuid,uuid)',
             'public.folder_effective_visibility_batch(uuid[],uuid)']::regprocedure[]) f JOIN pg_proc p ON p.oid = f
           WHERE p.prosrc LIKE '%_folder_is_effectively_visible_for%'), 3,
  'the remaining definer visibility helpers delegate to the patched folder check');
SELECT ok(has_function_privilege('authenticated', 'public.item_is_grail_showcased(uuid)', 'EXECUTE')
      AND has_function_privilege('anon', 'public.folder_is_effectively_visible(uuid)', 'EXECUTE'),
  'existing helper grants are unchanged by CREATE OR REPLACE');

-- ── Fixtures ────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000a1c00001', 'lc-a@example.invalid', '{"username":"lc_a"}'),
  ('00000000-0000-4000-8000-0000a1c00002', 'lc-b@example.invalid', '{"username":"lc_b"}'),
  ('00000000-0000-4000-8000-0000a1c00003', 'lc-c@example.invalid', '{"username":"lc_c"}');
UPDATE public.profiles SET bio = 'collector A bio' WHERE id = '00000000-0000-4000-8000-0000a1c00001';

-- A: FA1 public root, FA2 public nested in FA1, FA3 private.
INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000a1cf0001', '00000000-0000-4000-8000-0000a1c00001', 'lc alpha binder', true, NULL),
  ('00000000-0000-4000-8000-0000a1cf0003', '00000000-0000-4000-8000-0000a1c00001', 'lc alpha vault', false, NULL);
INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000a1cf0002', '00000000-0000-4000-8000-0000a1c00001', 'lc alpha nested', true, '00000000-0000-4000-8000-0000a1cf0001');
-- B: FB1 public.
INSERT INTO public.folders (id, user_id, name, is_public) VALUES
  ('00000000-0000-4000-8000-0000a1cf00b1', '00000000-0000-4000-8000-0000a1c00002', 'lc beta binder', true);
-- A: IA1 public in FA1, IA2 public in nested FA2, IA3 private in FA3 (a Grail).
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status, item_type) VALUES
  ('00000000-0000-4000-8000-0000a1ce0001', '00000000-0000-4000-8000-0000a1cf0001', '00000000-0000-4000-8000-0000a1c00001', 'lcalpha rookie', true, 'active', 'sports_card'),
  ('00000000-0000-4000-8000-0000a1ce0002', '00000000-0000-4000-8000-0000a1cf0002', '00000000-0000-4000-8000-0000a1c00001', 'lcalpha auto', true, 'active', 'sports_card'),
  ('00000000-0000-4000-8000-0000a1ce0003', '00000000-0000-4000-8000-0000a1cf0003', '00000000-0000-4000-8000-0000a1c00001', 'lcalpha grail', false, 'active', 'sports_card'),
  ('00000000-0000-4000-8000-0000a1ce00b1', '00000000-0000-4000-8000-0000a1cf00b1', '00000000-0000-4000-8000-0000a1c00002', 'lcbeta card', true, 'active', 'sports_card');
INSERT INTO public.collection_item_images (id, item_id, user_id, image_url, storage_path) VALUES
  ('00000000-0000-4000-8000-0000a1c10001', '00000000-0000-4000-8000-0000a1ce0001', '00000000-0000-4000-8000-0000a1c00001',
   'https://example.invalid/a1.jpg', '00000000-0000-4000-8000-0000a1c00001/lc/a1.jpg');
INSERT INTO public.profile_grail_slots (user_id, slot_index, entry_type, item_id, collection_id) VALUES
  ('00000000-0000-4000-8000-0000a1c00001', 0, 'item', '00000000-0000-4000-8000-0000a1ce0003', NULL),
  ('00000000-0000-4000-8000-0000a1c00001', 1, 'collection', NULL, '00000000-0000-4000-8000-0000a1cf0003');
INSERT INTO public.collection_item_view_counts (item_id, view_count) VALUES ('00000000-0000-4000-8000-0000a1ce0001', 7);
INSERT INTO public.posts (id, user_id, content, post_type) VALUES
  ('00000000-0000-4000-8000-0000a1cd0001', '00000000-0000-4000-8000-0000a1c00001', 'lc post by A', 'text'),
  ('00000000-0000-4000-8000-0000a1cd00b1', '00000000-0000-4000-8000-0000a1c00002', 'lc post by B', 'text');
INSERT INTO public.likes (user_id, post_id) VALUES
  ('00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1cd00b1'),
  ('00000000-0000-4000-8000-0000a1c00002', '00000000-0000-4000-8000-0000a1cd0001');
INSERT INTO public.comments (user_id, post_id, body) VALUES
  ('00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1cd00b1', 'A on B'),
  ('00000000-0000-4000-8000-0000a1c00002', '00000000-0000-4000-8000-0000a1cd0001', 'B on A');
INSERT INTO public.follows (follower_id, following_id) VALUES
  ('00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1c00002'),
  ('00000000-0000-4000-8000-0000a1c00002', '00000000-0000-4000-8000-0000a1c00001'),
  ('00000000-0000-4000-8000-0000a1c00003', '00000000-0000-4000-8000-0000a1c00002');
INSERT INTO public.item_likes (user_id, item_id) VALUES
  ('00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1ce00b1'),
  ('00000000-0000-4000-8000-0000a1c00002', '00000000-0000-4000-8000-0000a1ce0001');
INSERT INTO public.item_comments (user_id, item_id, body) VALUES
  ('00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1ce00b1', 'A on B card');
INSERT INTO public.folder_likes (user_id, folder_id) VALUES
  ('00000000-0000-4000-8000-0000a1c00002', '00000000-0000-4000-8000-0000a1cf0001');
-- Tags: B tags A in B's card; A tags C in A's card.
INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by) VALUES
  ('00000000-0000-4000-8000-0000a1ce00b1', '00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1c00002'),
  ('00000000-0000-4000-8000-0000a1ce0001', '00000000-0000-4000-8000-0000a1c00003', '00000000-0000-4000-8000-0000a1c00001');
INSERT INTO public.saved_grails (user_id, owner_id) VALUES
  ('00000000-0000-4000-8000-0000a1c00002', '00000000-0000-4000-8000-0000a1c00001');
-- Fixture inserts above created notifications (follows, likes, comments,
-- tags) through the existing triggers; they are what B's feed shows.
INSERT INTO public.registered_cards (id, current_owner_id, created_by, visibility) VALUES
  ('00000000-0000-4000-8000-0000a1cc0001', '00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1c00001', 'public');
INSERT INTO public.conversations (id) VALUES ('00000000-0000-4000-8000-0000a1cb0001');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000a1cb0001', '00000000-0000-4000-8000-0000a1c00001'),
  ('00000000-0000-4000-8000-0000a1cb0001', '00000000-0000-4000-8000-0000a1c00002');
INSERT INTO public.messages (conversation_id, sender_id, body) VALUES
  ('00000000-0000-4000-8000-0000a1cb0001', '00000000-0000-4000-8000-0000a1c00001', 'hello from A');

-- Exact fingerprint of A's data (as the table owner, bypassing RLS) to prove
-- cancellation restores the very same rows rather than copies.
CREATE TEMP TABLE lc_fingerprint (label text PRIMARY KEY, digest text);
CREATE FUNCTION pg_temp.fingerprint() RETURNS TABLE (label text, digest text) LANGUAGE sql AS $$
  SELECT 'profile', md5(string_agg(row_to_json(p)::text, '|')) FROM public.profiles p WHERE p.id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'folders', md5(string_agg(row_to_json(f)::text, '|' ORDER BY f.id)) FROM public.folders f WHERE f.user_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'items', md5(string_agg(row_to_json(i)::text, '|' ORDER BY i.id)) FROM public.collection_items i WHERE i.user_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'images', md5(string_agg(row_to_json(m)::text, '|' ORDER BY m.id)) FROM public.collection_item_images m WHERE m.user_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'grails', md5(string_agg(row_to_json(g)::text, '|' ORDER BY g.slot_index)) FROM public.profile_grail_slots g WHERE g.user_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'posts', md5(string_agg(row_to_json(p)::text, '|' ORDER BY p.id)) FROM public.posts p WHERE p.user_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'follows', md5(string_agg(row_to_json(f)::text, '|' ORDER BY f.follower_id, f.following_id)) FROM public.follows f
              WHERE '00000000-0000-4000-8000-0000a1c00001' IN (f.follower_id, f.following_id)
  UNION ALL SELECT 'tags', md5(string_agg(row_to_json(t)::text, '|' ORDER BY t.item_id, t.tagged_user_id)) FROM public.collection_item_tags t
              WHERE '00000000-0000-4000-8000-0000a1c00001' IN (t.tagged_by, t.tagged_user_id)
  UNION ALL SELECT 'messages', md5(string_agg(row_to_json(m)::text, '|' ORDER BY m.id)) FROM public.messages m WHERE m.sender_id = '00000000-0000-4000-8000-0000a1c00001';
$$;
INSERT INTO lc_fingerprint SELECT * FROM pg_temp.fingerprint();

-- What B sees of A while A is active (the same queries are repeated later).
CREATE FUNCTION pg_temp.b_view() RETURNS TABLE (label text, n int) LANGUAGE sql AS $$
  SELECT 'profile', count(*)::int FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'folders', count(*)::int FROM public.folders WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'items', count(*)::int FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'images', count(*)::int FROM public.collection_item_images WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'grails', count(*)::int FROM public.profile_grail_slots WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'posts', count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'likes', count(*)::int FROM public.likes WHERE user_id = '00000000-0000-4000-8000-0000a1c00001' OR post_id = '00000000-0000-4000-8000-0000a1cd0001'
  UNION ALL SELECT 'comments', count(*)::int FROM public.comments WHERE user_id = '00000000-0000-4000-8000-0000a1c00001' OR post_id = '00000000-0000-4000-8000-0000a1cd0001'
  UNION ALL SELECT 'follows', count(*)::int FROM public.follows WHERE '00000000-0000-4000-8000-0000a1c00001' IN (follower_id, following_id)
  UNION ALL SELECT 'item_likes', count(*)::int FROM public.item_likes WHERE user_id = '00000000-0000-4000-8000-0000a1c00001' OR item_id = '00000000-0000-4000-8000-0000a1ce0001'
  UNION ALL SELECT 'item_comments', count(*)::int FROM public.item_comments WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'folder_likes', count(*)::int FROM public.folder_likes WHERE folder_id = '00000000-0000-4000-8000-0000a1cf0001'
  UNION ALL SELECT 'tags', count(*)::int FROM public.collection_item_tags WHERE '00000000-0000-4000-8000-0000a1c00001' IN (tagged_by, tagged_user_id)
  UNION ALL SELECT 'notifications', count(*)::int FROM public.notifications WHERE actor_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'saved_grails', count(*)::int FROM public.saved_grails WHERE owner_id = '00000000-0000-4000-8000-0000a1c00001'
  UNION ALL SELECT 'view_counts', count(*)::int FROM public.collection_item_view_counts WHERE item_id = '00000000-0000-4000-8000-0000a1ce0001'
  UNION ALL SELECT 'registered_cards', count(*)::int FROM public.registered_cards WHERE current_owner_id = '00000000-0000-4000-8000-0000a1c00001';
$$;
GRANT EXECUTE ON FUNCTION pg_temp.b_view() TO authenticated, anon;

-- ── 2. Baseline: B sees A normally ───────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00002');
CREATE TEMP TABLE lc_baseline AS SELECT * FROM pg_temp.b_view()
  UNION ALL SELECT 'search_items', count(*)::int FROM public.search_profile_items('00000000-0000-4000-8000-0000a1c00001', 'lcalpha');
RESET ROLE;
SELECT pg_temp.logout();
SELECT is((SELECT n FROM lc_baseline WHERE label = 'profile'), 1, 'baseline: B sees A''s profile');
SELECT is((SELECT n FROM lc_baseline WHERE label = 'folders'), 3, 'baseline: B sees A''s two public collections and the Grail collection');
SELECT is((SELECT n FROM lc_baseline WHERE label = 'items'), 3, 'baseline: B sees A''s two public items and the Grail item');
SELECT is((SELECT n FROM lc_baseline WHERE label = 'grails'), 2, 'baseline: B sees A''s two Grails');
SELECT is((SELECT n FROM lc_baseline WHERE label = 'follows'), 2, 'baseline: B sees both follows involving A');
SELECT is((SELECT n FROM lc_baseline WHERE label = 'tags'), 2, 'baseline: B sees both tags involving A');
SELECT ok((SELECT n FROM lc_baseline WHERE label = 'notifications') >= 1, 'baseline: B has notifications caused by A');
SELECT ok((SELECT n FROM lc_baseline WHERE label = 'search_items') >= 2, 'baseline: Search Items finds A''s public items');
SELECT is((SELECT n FROM lc_baseline WHERE label = 'registered_cards'), 1, 'baseline: B sees A''s public registry card');

-- ── 3. Transitions ──────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00001');
SELECT throws_ok($$ SELECT public.schedule_account_deletion('00000000-0000-4000-8000-0000a1c00001') $$, '42501', NULL,
  'a collector cannot call the schedule function themselves');
SELECT throws_ok($$ INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for)
                    VALUES ('00000000-0000-4000-8000-0000a1c00001', 'pending_deletion', 'scheduled', now()) $$, '42501', NULL,
  'a collector cannot insert lifecycle state directly');
RESET ROLE;
SELECT pg_temp.logout();

SET LOCAL ROLE service_role;
SELECT throws_ok($$ SELECT public.schedule_account_deletion('00000000-0000-4000-8000-0000a1c00001', 0) $$, '22023', NULL,
  'the recovery window must be at least one day');
SELECT throws_ok($$ SELECT public.begin_account_deletion('00000000-0000-4000-8000-0000a1c00001', 'scheduled') $$,
  'P0001', 'account_lifecycle_not_scheduled', 'a scheduled deletion cannot begin for an account that was never scheduled');
SELECT is((SELECT state FROM public.schedule_account_deletion('00000000-0000-4000-8000-0000a1c00001')), 'pending_deletion',
  'the service role schedules deletion: active → pending_deletion');
SELECT ok((SELECT scheduled_for BETWEEN now() + interval '13 days 23 hours' AND now() + interval '14 days 1 hour'
           FROM public.account_lifecycle WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'),
  'the default recovery window is 14 days');
SELECT throws_ok($$ SELECT public.schedule_account_deletion('00000000-0000-4000-8000-0000a1c00001') $$,
  'P0001', 'account_lifecycle_already_pending_deletion', 'scheduling twice is rejected');
SELECT throws_ok($$ SELECT public.begin_account_deletion('00000000-0000-4000-8000-0000a1c00001', 'scheduled') $$,
  'P0001', 'account_lifecycle_not_due', 'the scheduler cannot start a deletion before the window ends');
SELECT is((SELECT count(*)::int FROM public.list_due_account_deletions()), 0, 'nothing is due during the recovery window');
SELECT throws_ok($$ UPDATE public.account_lifecycle SET scheduled_for = now() + interval '30 days'
                    WHERE user_id = '00000000-0000-4000-8000-0000a1c00001' $$, 'P0001', 'account_lifecycle_invalid_transition',
  'even the service role cannot edit a pending row except to begin deletion');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00001');
SELECT is((SELECT state FROM public.account_lifecycle), 'pending_deletion', 'A can read their own lifecycle state');
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00002');
SELECT is((SELECT count(*)::int FROM public.account_lifecycle), 0, 'B cannot see that A is pending deletion');
RESET ROLE;
SELECT pg_temp.logout();

-- ── 4. Hidden from other signed-in collectors ───────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00002');
CREATE TEMP TABLE lc_hidden AS SELECT * FROM pg_temp.b_view();
SELECT is((SELECT n FROM lc_hidden WHERE label = 'profile'), 0, 'B: A''s profile is hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'folders'), 0, 'B: A''s collections are hidden (incl. nested and Grail)');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'items'), 0, 'B: A''s items are hidden (incl. the Grail exception)');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'images'), 0, 'B: A''s image rows are hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'grails'), 0, 'B: A''s Grails are hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'posts'), 0, 'B: A''s posts are hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'likes'), 0, 'B: A''s likes, and likes on A''s posts, are hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'comments'), 0, 'B: A''s comments, and comments on A''s posts, are hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'follows'), 0, 'B: follows involving A are hidden (counts exclude A)');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'item_likes'), 0, 'B: item likes by or on A are hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'item_comments'), 0, 'B: A''s item comments are hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'folder_likes'), 0, 'B: likes on A''s collections are hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'tags'), 0, 'B: tags by or of A are hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'notifications'), 0, 'B: notifications caused by A are hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'saved_grails'), 0, 'B: B''s saved copy of A''s Grails is hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'view_counts'), 0, 'B: view counts of A''s items are hidden');
SELECT is((SELECT n FROM lc_hidden WHERE label = 'registered_cards'), 0, 'B: A''s registry card is hidden');
SELECT is((SELECT count(*)::int FROM public.follows WHERE following_id = '00000000-0000-4000-8000-0000a1c00002'), 1,
  'B''s follower count drops A but keeps C');
SELECT ok(NOT public.folder_is_effectively_visible('00000000-0000-4000-8000-0000a1cf0001'), 'B: folder visibility helper says no');
SELECT ok(NOT public.item_is_grail_showcased('00000000-0000-4000-8000-0000a1ce0003'), 'B: Grail-showcase exception no longer applies to A''s item');
SELECT ok(NOT public.folder_is_grail_showcased('00000000-0000-4000-8000-0000a1cf0003'), 'B: Grail-showcase exception no longer applies to A''s collection');
SELECT is((SELECT count(*)::int FROM public.search_profile_items('00000000-0000-4000-8000-0000a1c00001', 'lcalpha')), 0,
  'B: Search Items on A''s profile finds nothing');
SELECT is((SELECT count(*)::int FROM public.search_profile_collections('00000000-0000-4000-8000-0000a1c00001', 'lc alpha')), 0,
  'B: collection search on A''s profile finds nothing');
SELECT is((SELECT count(*)::int FROM public.search_collection_items('00000000-0000-4000-8000-0000a1cf0001', 'lcalpha')), 0,
  'B: searching inside A''s collection finds nothing');
SELECT is((SELECT count(*)::int FROM public.profile_item_view_counts('00000000-0000-4000-8000-0000a1c00001')), 0,
  'B: A''s Most Viewed counts are hidden');
SELECT is((SELECT total_items FROM public.folder_tally('00000000-0000-4000-8000-0000a1cf0001')), 0::bigint,
  'B: collection tally of A''s collection counts nothing');
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000a1c00002'), 1,
  'B still sees B''s own post');
SELECT is((SELECT count(*)::int FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000a1c00002'), 1,
  'B still sees B''s own card');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000a1cb0001'), 0,
  'B cannot read the DM history with A while A is pending (20261104120000)');
RESET ROLE;
SELECT pg_temp.logout();

-- ── 5. Hidden from anonymous visitors ───────────────────────────────────
SET LOCAL ROLE anon;
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000a1c00001'), 0, 'anon: A''s profile is hidden');
SELECT is((SELECT count(*)::int FROM public.folders WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'), 0, 'anon: A''s collections are hidden');
SELECT is((SELECT count(*)::int FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'), 0, 'anon: A''s items are hidden');
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'), 0, 'anon: A''s posts are hidden');
SELECT is((SELECT count(*)::int FROM public.profile_grail_slots WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'), 0, 'anon: A''s Grails are hidden');
SELECT is((SELECT count(*)::int FROM public.follows WHERE '00000000-0000-4000-8000-0000a1c00001' IN (follower_id, following_id)), 0, 'anon: follows involving A are hidden');
SELECT is((SELECT count(*)::int FROM public.comments WHERE post_id = '00000000-0000-4000-8000-0000a1cd0001'), 0, 'anon: comments on A''s posts are hidden');
SELECT is((SELECT count(*)::int FROM public.registered_cards WHERE current_owner_id = '00000000-0000-4000-8000-0000a1c00001'), 0, 'anon: A''s public registry card is hidden');
SELECT ok(NOT public.folder_is_effectively_visible('00000000-0000-4000-8000-0000a1cf0001'), 'anon: folder visibility helper says no');
SELECT ok(NOT public.item_is_grail_showcased('00000000-0000-4000-8000-0000a1ce0003'), 'anon: Grail-showcase helper says no');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000a1c00002'), 1, 'anon still sees B''s profile');
SELECT is((SELECT count(*)::int FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000a1c00002'), 1, 'anon still sees B''s public card');
RESET ROLE;

-- ── 6. Server-side (definer / service) paths ────────────────────────────
SELECT is((SELECT count(*)::int FROM public.resolve_item_images_for_signing(ARRAY['00000000-0000-4000-8000-0000a1c10001']::uuid[])), 0,
  'image signing resolves none of A''s images (no signed URL for anyone)');
SELECT ok(NOT (SELECT visible FROM public.folder_effective_visibility_batch(ARRAY['00000000-0000-4000-8000-0000a1cf0001']::uuid[], NULL)),
  'folder-cover signing: A''s collection is not visible anonymously');
SELECT ok(NOT (SELECT visible FROM public.folder_effective_visibility_batch(ARRAY['00000000-0000-4000-8000-0000a1cf0001']::uuid[], '00000000-0000-4000-8000-0000a1c00001')),
  'folder-cover signing: not even for A as owner');
SELECT ok(NOT public._item_visible_to('00000000-0000-4000-8000-0000a1ce0001', '00000000-0000-4000-8000-0000a1c00002'),
  'item visibility helper (tagging, views): A''s public item is not visible to B');
SELECT ok(NOT public._item_visible_to('00000000-0000-4000-8000-0000a1ce00b1', '00000000-0000-4000-8000-0000a1c00001'),
  'item visibility helper: a hidden viewer sees nothing either');
SELECT ok(NOT public._folder_visible_to('00000000-0000-4000-8000-0000a1cf0003', '00000000-0000-4000-8000-0000a1c00002'),
  'collection visibility helper (tagging): A''s Grail collection is not visible');
SELECT is((SELECT count(*)::int FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'), 3,
  'internal (no end-user identity) reads still see A''s data for export and cleanup');

-- ── 7. The pending collector: own lifecycle row only ────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00001');
SELECT is((SELECT count(*)::int FROM public.account_lifecycle), 1, 'A: own lifecycle row is readable');
SELECT is((SELECT count(*)::int FROM public.profiles), 0, 'A: no profiles at all (own or others)');
SELECT is((SELECT count(*)::int FROM public.collection_items), 0, 'A: no items, not even B''s public card');
SELECT is((SELECT count(*)::int FROM public.posts), 0, 'A: no posts');
SELECT is((SELECT count(*)::int FROM public.notifications), 0, 'A: no notifications');
SELECT is((SELECT count(*)::int FROM public.messages), 0, 'A: no messages');
SELECT ok(NOT public.folder_is_effectively_visible('00000000-0000-4000-8000-0000a1cf00b1'), 'A: folder visibility helper says no for B''s public folder');

-- ── 8. The pending collector cannot write ───────────────────────────────
SELECT throws_ok($$ INSERT INTO public.posts (user_id, content, post_type) VALUES ('00000000-0000-4000-8000-0000a1c00001', 'x', 'text') $$,
  '42501', 'account_inactive', 'A cannot post');
SELECT throws_ok($$ SELECT public.create_text_post('x', '[]'::jsonb) $$, '42501', 'account_inactive', 'A cannot post through create_text_post');
SELECT throws_ok($$ UPDATE public.profiles SET bio = 'changed' WHERE id = '00000000-0000-4000-8000-0000a1c00001' $$,
  '42501', 'account_inactive', 'A cannot edit the profile');
SELECT throws_ok($$ DELETE FROM public.collection_items WHERE id = '00000000-0000-4000-8000-0000a1ce0001' $$,
  '42501', 'account_inactive', 'A cannot delete an item (nothing changes while pending)');
SELECT throws_ok($$ INSERT INTO public.folders (user_id, name) VALUES ('00000000-0000-4000-8000-0000a1c00001', 'new') $$,
  '42501', 'account_inactive', 'A cannot create a collection');
SELECT throws_ok($$ INSERT INTO public.follows (follower_id, following_id) VALUES ('00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1c00003') $$,
  '42501', 'account_inactive', 'A cannot follow');
SELECT throws_ok($$ DELETE FROM public.follows WHERE follower_id = '00000000-0000-4000-8000-0000a1c00001' $$,
  '42501', 'account_inactive', 'A cannot unfollow');
SELECT throws_ok($$ INSERT INTO public.likes (user_id, post_id) VALUES ('00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1cd00b1') $$,
  '42501', 'account_inactive', 'A cannot like');
SELECT throws_ok($$ INSERT INTO public.comments (user_id, post_id, body) VALUES ('00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1cd00b1', 'x') $$,
  '42501', 'account_inactive', 'A cannot comment');
SELECT throws_ok($$ INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by) VALUES
                    ('00000000-0000-4000-8000-0000a1ce0002', '00000000-0000-4000-8000-0000a1c00003', '00000000-0000-4000-8000-0000a1c00001') $$,
  '42501', 'account_inactive', 'A cannot tag');
SELECT throws_ok($$ INSERT INTO public.messages (conversation_id, sender_id, body) VALUES
                    ('00000000-0000-4000-8000-0000a1cb0001', '00000000-0000-4000-8000-0000a1c00001', 'x') $$,
  '42501', 'account_inactive', 'A cannot send a message');
SELECT throws_ok($$ SELECT public.get_or_create_conversation('00000000-0000-4000-8000-0000a1c00003') $$,
  '42501', 'account_inactive', 'A cannot start a conversation (SECURITY DEFINER path)');
SELECT ok(NOT public.record_item_view('00000000-0000-4000-8000-0000a1ce00b1'), 'A''s views are not recorded (SECURITY DEFINER path)');
SELECT throws_ok($$ SELECT public.reorder_folders(NULL, ARRAY['00000000-0000-4000-8000-0000a1cf0003', '00000000-0000-4000-8000-0000a1cf0001']::uuid[]) $$,
  '42501', 'account_inactive', 'A cannot reorder collections (SECURITY DEFINER path)');
SELECT throws_ok($$ UPDATE public.conversation_participants SET last_read_at = now() WHERE user_id = '00000000-0000-4000-8000-0000a1c00001' $$,
  '42501', 'account_inactive', 'A cannot mark conversations read');
SELECT throws_ok($$ INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('avatars', '00000000-0000-4000-8000-0000a1c00001/new.jpg', '00000000-0000-4000-8000-0000a1c00001') $$,
  '42501', NULL, 'A cannot upload to Storage');
RESET ROLE;
SELECT pg_temp.logout();

-- ── 9. Nobody can interact with the pending collector ───────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00002');
SELECT throws_ok($$ INSERT INTO public.follows (follower_id, following_id) VALUES ('00000000-0000-4000-8000-0000a1c00002', '00000000-0000-4000-8000-0000a1c00001') $$,
  '42501', 'account_unavailable', 'B cannot re-follow A (rejected before the duplicate check)');
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00003');
SELECT throws_ok($$ INSERT INTO public.follows (follower_id, following_id) VALUES ('00000000-0000-4000-8000-0000a1c00003', '00000000-0000-4000-8000-0000a1c00001') $$,
  '42501', 'account_unavailable', 'C cannot follow A');
SELECT throws_ok($$ INSERT INTO public.likes (user_id, post_id) VALUES ('00000000-0000-4000-8000-0000a1c00003', '00000000-0000-4000-8000-0000a1cd0001') $$,
  '42501', 'account_unavailable', 'C cannot like A''s post');
SELECT throws_ok($$ INSERT INTO public.comments (user_id, post_id, body) VALUES ('00000000-0000-4000-8000-0000a1c00003', '00000000-0000-4000-8000-0000a1cd0001', 'x') $$,
  '42501', 'account_unavailable', 'C cannot comment on A''s post');
SELECT throws_ok($$ INSERT INTO public.posts (user_id, post_type, repost_of_post_id) VALUES ('00000000-0000-4000-8000-0000a1c00003', 'repost', '00000000-0000-4000-8000-0000a1cd0001') $$,
  '42501', 'account_unavailable', 'C cannot repost A''s post');
SELECT throws_ok($$ INSERT INTO public.item_likes (user_id, item_id) VALUES ('00000000-0000-4000-8000-0000a1c00003', '00000000-0000-4000-8000-0000a1ce0001') $$,
  '42501', NULL, 'C cannot like A''s item');
SELECT throws_ok($$ INSERT INTO public.saved_cards (user_id, item_id) VALUES ('00000000-0000-4000-8000-0000a1c00003', '00000000-0000-4000-8000-0000a1ce0001') $$,
  '42501', 'account_unavailable', 'C cannot save A''s item');
SELECT throws_ok($$ INSERT INTO public.saved_folders (user_id, folder_id) VALUES ('00000000-0000-4000-8000-0000a1c00003', '00000000-0000-4000-8000-0000a1cf0001') $$,
  '42501', 'account_unavailable', 'C cannot save A''s collection');
SELECT throws_ok($$ INSERT INTO public.saved_grails (user_id, owner_id) VALUES ('00000000-0000-4000-8000-0000a1c00003', '00000000-0000-4000-8000-0000a1c00001') $$,
  '42501', 'account_unavailable', 'C cannot save A''s Grails');
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00002');
SELECT throws_ok($$ INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by) VALUES
                    ('00000000-0000-4000-8000-0000a1ce00b1', '00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1c00002') $$,
  '42501', 'tag_user_not_found', 'B cannot re-tag A (rejected before the duplicate check)');
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status, item_type) VALUES
  ('00000000-0000-4000-8000-0000a1ce00b2', '00000000-0000-4000-8000-0000a1cf00b1', '00000000-0000-4000-8000-0000a1c00002', 'lcbeta second', true, 'active', 'sports_card');
SELECT throws_ok($$ INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by) VALUES
                    ('00000000-0000-4000-8000-0000a1ce00b2', '00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1c00002') $$,
  '42501', 'tag_user_not_found', 'B cannot tag A (same error as an unknown collector)');
SELECT throws_ok($$ INSERT INTO public.folder_tags (folder_id, tagged_user_id, tagged_by) VALUES
                    ('00000000-0000-4000-8000-0000a1cf00b1', '00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1c00002') $$,
  '42501', 'tag_user_not_found', 'B cannot tag A in a collection');
SELECT throws_ok($$ INSERT INTO public.messages (conversation_id, sender_id, body) VALUES
                    ('00000000-0000-4000-8000-0000a1cb0001', '00000000-0000-4000-8000-0000a1c00002', 'hi') $$,
  '42501', 'account_unavailable', 'B cannot message A in their existing conversation');
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00003');
SELECT throws_ok($$ SELECT public.get_or_create_conversation('00000000-0000-4000-8000-0000a1c00001') $$,
  '42501', 'account_unavailable', 'C cannot start a conversation with A');
SELECT ok(NOT public.record_item_view('00000000-0000-4000-8000-0000a1ce0001'), 'a view of A''s item is not counted');
SELECT is((SELECT count(*)::int FROM public.conversations), 0, 'no conversation was created for C');
RESET ROLE;
SELECT pg_temp.logout();
SELECT throws_ok($$ INSERT INTO public.ownership_transfers (registered_card_id, from_owner_id, to_owner_id) VALUES
                    ('00000000-0000-4000-8000-0000a1cc0001', '00000000-0000-4000-8000-0000a1c00002', '00000000-0000-4000-8000-0000a1c00001') $$,
  '42501', 'account_unavailable', 'no transfer can be created to A, even internally (registry kept dormant)');
SELECT is((SELECT view_count FROM public.collection_item_view_counts WHERE item_id = '00000000-0000-4000-8000-0000a1ce0001'), 7::bigint,
  'A''s view count is unchanged');

-- ── 10. Restore: cancelling brings back the exact same data ──────────────
SET LOCAL ROLE service_role;
SELECT ok(public.cancel_account_deletion('00000000-0000-4000-8000-0000a1c00001'), 'the service role cancels: pending_deletion → active');
SELECT ok(NOT public.cancel_account_deletion('00000000-0000-4000-8000-0000a1c00001'), 'cancelling again is a harmless no-op');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.account_lifecycle WHERE user_id = '00000000-0000-4000-8000-0000a1c00001'), 0, 'A has no lifecycle row (active)');
SELECT is((SELECT count(*)::int FROM pg_temp.fingerprint() f JOIN lc_fingerprint s USING (label) WHERE f.digest IS DISTINCT FROM s.digest), 0,
  'every row of A''s profile, collections (incl. hierarchy), items, images, Grails, posts, follows, tags and messages is byte-for-byte unchanged');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00002');
CREATE TEMP TABLE lc_restored AS SELECT * FROM pg_temp.b_view();
SELECT is((SELECT count(*)::int FROM lc_restored r JOIN lc_baseline b USING (label) WHERE r.n <> b.n), 0,
  'B sees exactly what B saw before A was scheduled');
SELECT is((SELECT parent_folder_id FROM public.folders WHERE id = '00000000-0000-4000-8000-0000a1cf0002'),
  '00000000-0000-4000-8000-0000a1cf0001'::uuid, 'the nested collection is still nested under its parent');
SELECT ok(public.item_is_grail_showcased('00000000-0000-4000-8000-0000a1ce0003'), 'A''s Grail item is showcased again');
SELECT is((SELECT count(*)::int FROM public.search_profile_items('00000000-0000-4000-8000-0000a1c00001', 'lcalpha')),
  (SELECT n FROM lc_baseline WHERE label = 'search_items'), 'Search Items finds the same items on A''s profile again');
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00003');
SELECT lives_ok($$ INSERT INTO public.likes (user_id, post_id) VALUES ('00000000-0000-4000-8000-0000a1c00003', '00000000-0000-4000-8000-0000a1cd0001') $$,
  'interactions with A work again');
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00001');
SELECT lives_ok($$ UPDATE public.profiles SET bio = 'back' WHERE id = '00000000-0000-4000-8000-0000a1c00001' $$, 'A can write again');
RESET ROLE;
SELECT pg_temp.logout();
SELECT is((SELECT count(*)::int FROM public.resolve_item_images_for_signing(ARRAY['00000000-0000-4000-8000-0000a1c10001']::uuid[])), 1,
  'A''s image resolves for signing again (same storage path, nothing moved)');

-- ── 11. Delete Now and the point of no return ───────────────────────────
SET LOCAL ROLE service_role;
SELECT is((SELECT state FROM public.begin_account_deletion('00000000-0000-4000-8000-0000a1c00003', 'immediate')), 'deleting',
  'Delete Now from active: active → deleting (no recovery window forced)');
SELECT is((SELECT mode FROM public.begin_account_deletion('00000000-0000-4000-8000-0000a1c00003', 'immediate')), 'immediate',
  'beginning again is idempotent');
SELECT throws_ok($$ SELECT public.cancel_account_deletion('00000000-0000-4000-8000-0000a1c00003') $$,
  'P0001', 'account_lifecycle_deleting_is_final', 'a deletion in progress cannot be cancelled');
SELECT throws_ok($$ DELETE FROM public.account_lifecycle WHERE user_id = '00000000-0000-4000-8000-0000a1c00003' $$,
  'P0001', 'account_lifecycle_deleting_is_final', 'a deleting row cannot be removed directly, even by the service role');
SELECT throws_ok($$ UPDATE public.account_lifecycle SET state = 'pending_deletion', mode = 'scheduled', scheduled_for = now(), deleting_started_at = NULL
                    WHERE user_id = '00000000-0000-4000-8000-0000a1c00003' $$,
  'P0001', 'account_lifecycle_invalid_transition', 'deleting cannot go back to pending');
SELECT throws_ok($$ SELECT public.schedule_account_deletion('00000000-0000-4000-8000-0000a1c00003') $$,
  'P0001', 'account_lifecycle_already_deleting', 'a deleting account cannot be rescheduled');
-- Pending → Delete Now during the window.
SELECT is((SELECT state FROM public.schedule_account_deletion('00000000-0000-4000-8000-0000a1c00001')), 'pending_deletion', 'A scheduled again');
SELECT is((SELECT mode FROM public.begin_account_deletion('00000000-0000-4000-8000-0000a1c00001', 'immediate')), 'immediate',
  'Delete Now during the recovery window: pending_deletion → deleting');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00002');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id IN ('00000000-0000-4000-8000-0000a1c00001', '00000000-0000-4000-8000-0000a1c00003')), 0,
  'deleting accounts stay hidden');
RESET ROLE;
SELECT pg_temp.logout();

-- The scheduler's view: a due pending account (window simulated as ended).
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000a1c00004', 'lc-d@example.invalid', '{"username":"lc_d"}');
ALTER TABLE public.account_lifecycle DISABLE TRIGGER account_lifecycle_transition;
INSERT INTO public.account_lifecycle (user_id, state, mode, requested_at, scheduled_for)
VALUES ('00000000-0000-4000-8000-0000a1c00004', 'pending_deletion', 'scheduled', now() - interval '15 days', now() - interval '1 day');
ALTER TABLE public.account_lifecycle ENABLE TRIGGER account_lifecycle_transition;
SET LOCAL ROLE service_role;
SELECT is((SELECT array_agg(id) FROM public.list_due_account_deletions() id), ARRAY['00000000-0000-4000-8000-0000a1c00004']::uuid[],
  'only the account whose window has ended is due');
SELECT is((SELECT mode FROM public.begin_account_deletion('00000000-0000-4000-8000-0000a1c00004', 'scheduled')), 'scheduled',
  'the scheduler begins a due deletion: pending_deletion → deleting');
RESET ROLE;

-- Permanent deletion (Checkpoint 4) removes the auth user; the lifecycle row
-- must go with it. Verified here on a disposable fixture, rolled back.
-- (A lifecycle deletion reserves the username, which needs the HMAC key.)
SELECT vault.create_secret(repeat('k', 48), 'username_reservation_key');
SELECT lives_ok($$ DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000a1c00004' $$,
  'deleting the auth user of a deleting account succeeds');
SELECT is((SELECT count(*)::int FROM public.account_lifecycle WHERE user_id = '00000000-0000-4000-8000-0000a1c00004'), 0,
  'its lifecycle row cascades away with it');

-- ── 12. Regressions: unaffected collectors, tagging, Group Messaging ─────
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000a1c00005', 'lc-e@example.invalid', '{"username":"lc_e"}');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000a1c00002');
SELECT lives_ok($$ INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by) VALUES
                   ('00000000-0000-4000-8000-0000a1ce00b2', '00000000-0000-4000-8000-0000a1c00005', '00000000-0000-4000-8000-0000a1c00002') $$,
  'tagging an active collector still works');
SELECT throws_ok($$ INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by) VALUES
                    ('00000000-0000-4000-8000-0000a1ce00b2', '00000000-0000-4000-8000-0000a1c00002', '00000000-0000-4000-8000-0000a1c00002') $$,
  '22023', 'tag_self', 'self-tagging is still rejected');
SELECT lives_ok($$ INSERT INTO public.follows (follower_id, following_id) VALUES ('00000000-0000-4000-8000-0000a1c00002', '00000000-0000-4000-8000-0000a1c00005') $$,
  'following an active collector still works');
SELECT lives_ok($$ SELECT public.create_text_post('still posting', '[]'::jsonb) $$, 'posting still works');
SELECT isnt((SELECT public.get_or_create_conversation('00000000-0000-4000-8000-0000a1c00005')), NULL,
  'starting a DM with an active collector still works');
RESET ROLE;
SELECT pg_temp.logout();
SELECT ok(to_regclass('public.conversation_group_departures') IS NULL
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'kind'),
  'Group Messaging stays inactive (no group schema)');
SELECT is((SELECT count(*)::int FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000a1cc0001'), 1,
  'registry rows are kept (dormant infrastructure untouched)');

SELECT * FROM finish();
ROLLBACK;
