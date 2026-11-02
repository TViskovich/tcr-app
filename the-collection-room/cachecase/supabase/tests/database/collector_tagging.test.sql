-- pgTAP test for 20261102120000_add_collector_tagging.sql (collector
-- tagging, Checkpoint 1).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(72);

-- ── Helpers ─────────────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated;

-- ── Shape and privileges ────────────────────────────────────────────────
SELECT has_table('public', 'collection_item_tags', 'collection_item_tags exists');
SELECT has_table('public', 'folder_tags', 'folder_tags exists');
SELECT is((SELECT count(*)::int FROM pg_class WHERE oid IN ('public.collection_item_tags'::regclass, 'public.folder_tags'::regclass) AND relrowsecurity),
  2, 'RLS is on for both tag tables');
SELECT ok(NOT has_table_privilege('anon', 'public.collection_item_tags', 'SELECT')
       AND NOT has_table_privilege('anon', 'public.folder_tags', 'SELECT'), 'anon cannot read tags');
SELECT ok(NOT has_table_privilege('anon', 'public.collection_item_tags', 'INSERT')
       AND NOT has_table_privilege('anon', 'public.folder_tags', 'INSERT'), 'anon cannot add tags');
SELECT ok(NOT has_table_privilege('authenticated', 'public.collection_item_tags', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.folder_tags', 'UPDATE'), 'tags can never be updated by clients');
SELECT ok(has_table_privilege('authenticated', 'public.collection_item_tags', 'SELECT,INSERT,DELETE')
       AND has_table_privilege('authenticated', 'public.folder_tags', 'SELECT,INSERT,DELETE'), 'signed-in users can read, add and remove (subject to RLS)');

CREATE TEMP TABLE tag_fns AS
  SELECT unnest(ARRAY[
    'public.validate_content_tag()', 'public.create_content_tag_notification()',
    'public.delete_content_tag_notification()', 'public._folder_visible_to(uuid,uuid)'
  ])::regprocedure AS fn;
SELECT is((SELECT count(*)::int FROM tag_fns t JOIN pg_proc p ON p.oid = t.fn
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""']), 4,
  'every tagging function is SECURITY DEFINER with a pinned search_path');
SELECT is((SELECT count(*)::int FROM tag_fns WHERE has_function_privilege('authenticated', fn, 'EXECUTE')
                                               OR has_function_privilege('anon', fn, 'EXECUTE')), 0,
  'no tagging function is callable by clients');
SELECT ok(NOT has_function_privilege('authenticated', 'public._item_visible_to(uuid,uuid)', 'EXECUTE'),
  'the reused item visibility helper stays server-only');
SELECT ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'notifications_type_check') ~ 'item_tag.*folder_tag'
      AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'notifications_type_check') ~ 'ownership_transfer_cancelled',
  'notification types gain item_tag / folder_tag and keep the existing ones');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'notifications_item_tag_unique')
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'notifications_folder_tag_unique'),
  'one tag notification per collector per item/collection (unique indexes)');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- A owns everything; B, C, D are collectors; X an outsider; 21 extra
-- collectors for the cap.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-000000c0a001', 'ct-a@example.invalid', '{"username":"ct_a"}'),
  ('00000000-0000-4000-8000-000000c0a002', 'ct-b@example.invalid', '{"username":"ct_b"}'),
  ('00000000-0000-4000-8000-000000c0a003', 'ct-c@example.invalid', '{"username":"ct_c"}'),
  ('00000000-0000-4000-8000-000000c0a004', 'ct-d@example.invalid', '{"username":"ct_d"}'),
  ('00000000-0000-4000-8000-000000c0a009', 'ct-x@example.invalid', '{"username":"ct_x"}');
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT ('00000000-0000-4000-8000-000000c1' || lpad(g::text, 4, '0'))::uuid,
       'ct-cap' || g || '@example.invalid',
       json_build_object('username', 'ct_cap_' || g)::jsonb
FROM generate_series(1, 21) g;

-- Collections: F1 public; F2 private; F3 public but nested under private F2;
-- F4 private but showcased as a Grail; F5 public and empty.
INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-000000c0f001', '00000000-0000-4000-8000-000000c0a001', 'ct public', true, NULL),
  ('00000000-0000-4000-8000-000000c0f002', '00000000-0000-4000-8000-000000c0a001', 'ct private', false, NULL),
  ('00000000-0000-4000-8000-000000c0f004', '00000000-0000-4000-8000-000000c0a001', 'ct grail coll', false, NULL),
  ('00000000-0000-4000-8000-000000c0f005', '00000000-0000-4000-8000-000000c0a001', 'ct empty', true, NULL);
INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-000000c0f003', '00000000-0000-4000-8000-000000c0a001', 'ct nested', true, '00000000-0000-4000-8000-000000c0f002');
-- Items: I1 public in F1; I2 private in F1; I3 public in nested F3; I4
-- private in F2 but showcased as a Grail.
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status) VALUES
  ('00000000-0000-4000-8000-000000c0c001', '00000000-0000-4000-8000-000000c0f001', '00000000-0000-4000-8000-000000c0a001', 'ct public card', true, 'active'),
  ('00000000-0000-4000-8000-000000c0c002', '00000000-0000-4000-8000-000000c0f001', '00000000-0000-4000-8000-000000c0a001', 'ct private card', false, 'active'),
  ('00000000-0000-4000-8000-000000c0c003', '00000000-0000-4000-8000-000000c0f003', '00000000-0000-4000-8000-000000c0a001', 'ct nested card', true, 'active'),
  ('00000000-0000-4000-8000-000000c0c004', '00000000-0000-4000-8000-000000c0f002', '00000000-0000-4000-8000-000000c0a001', 'ct grail card', false, 'active');
INSERT INTO public.profile_grail_slots (user_id, slot_index, entry_type, item_id, collection_id) VALUES
  ('00000000-0000-4000-8000-000000c0a001', 0, 'item', '00000000-0000-4000-8000-000000c0c004', NULL),
  ('00000000-0000-4000-8000-000000c0a001', 1, 'collection', NULL, '00000000-0000-4000-8000-000000c0f004');

SET LOCAL ROLE authenticated;

-- ── Adding tags (A, the owner) ──────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a001');
SELECT lives_ok($$INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by, created_at)
  VALUES ('00000000-0000-4000-8000-000000c0c001', '00000000-0000-4000-8000-000000c0a002', '00000000-0000-4000-8000-000000c0a003', '2000-01-01')$$,
  'the owner tags B in a public item');
SELECT is((SELECT tagged_by FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c001' AND tagged_user_id = '00000000-0000-4000-8000-000000c0a002'),
  '00000000-0000-4000-8000-000000c0a001'::uuid, 'tagged_by is always the caller (a forged value is replaced)');
SELECT ok((SELECT created_at FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c001' AND tagged_user_id = '00000000-0000-4000-8000-000000c0a002') > '2001-01-01',
  'created_at is the server''s time (a forged value is replaced)');
SELECT throws_ok($$INSERT INTO public.collection_item_tags (item_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-000000c0c001', '00000000-0000-4000-8000-000000c0a002')$$,
  '23505', NULL, 'the same collector cannot be tagged twice');
SELECT throws_ok($$INSERT INTO public.collection_item_tags (item_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-000000c0c001', '00000000-0000-4000-8000-000000c0a001')$$,
  '22023', 'tag_self', 'the owner cannot tag themselves (item)');
SELECT throws_ok($$INSERT INTO public.folder_tags (folder_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-000000c0f001', '00000000-0000-4000-8000-000000c0a001')$$,
  '22023', 'tag_self', 'the owner cannot tag themselves (collection)');
SELECT throws_ok($$INSERT INTO public.collection_item_tags (item_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-000000c0c001', '00000000-0000-4000-8000-0000000000ff')$$,
  '22023', 'tag_user_not_found', 'a nonexistent collector cannot be tagged');
SELECT lives_ok($$INSERT INTO public.folder_tags (folder_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-000000c0f001', '00000000-0000-4000-8000-000000c0a003')$$,
  'the owner tags C in a public collection');

-- ── Non-owners cannot tag (B) ───────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a002');
SELECT throws_ok($$INSERT INTO public.collection_item_tags (item_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-000000c0c001', '00000000-0000-4000-8000-000000c0a003')$$,
  '42501', 'tag_not_owner', 'a non-owner cannot tag in someone else''s item');
SELECT throws_ok($$INSERT INTO public.folder_tags (folder_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-000000c0f001', '00000000-0000-4000-8000-000000c0a004')$$,
  '42501', 'tag_not_owner', 'a non-owner cannot tag in someone else''s collection');
SELECT throws_ok($$INSERT INTO public.collection_item_tags (item_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-0000000000ee', '00000000-0000-4000-8000-000000c0a003')$$,
  '42501', 'tag_not_owner', 'a nonexistent item gives the same answer as a not-owned one');
SELECT throws_ok($$UPDATE public.collection_item_tags SET created_at = now()$$,
  '42501', NULL, 'tags cannot be updated');
SELECT throws_ok($$INSERT INTO public.notifications (user_id, actor_id, type, item_id) VALUES ('00000000-0000-4000-8000-000000c0a003', '00000000-0000-4000-8000-000000c0a002', 'item_tag', '00000000-0000-4000-8000-000000c0c001')$$,
  '42501', NULL, 'clients cannot create tag notifications themselves');

-- ── Notifications for visible content ───────────────────────────────────
SELECT is((SELECT count(*)::int FROM public.notifications
           WHERE type = 'item_tag' AND item_id = '00000000-0000-4000-8000-000000c0c001' AND actor_id = '00000000-0000-4000-8000-000000c0a001'),
  1, 'B is notified once, by A, about the item');
SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a003');
SELECT is((SELECT count(*)::int FROM public.notifications
           WHERE type = 'folder_tag' AND folder_id = '00000000-0000-4000-8000-000000c0f001' AND actor_id = '00000000-0000-4000-8000-000000c0a001'),
  1, 'C is notified once, by A, about the collection');

-- ── The 20-collector cap ────────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a001');
SELECT lives_ok($$INSERT INTO public.collection_item_tags (item_id, tagged_user_id)
  SELECT '00000000-0000-4000-8000-000000c0c001', ('00000000-0000-4000-8000-000000c1' || lpad(g::text, 4, '0'))::uuid FROM generate_series(1, 19) g$$,
  '19 more collectors can be tagged in the item');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c001'), 20, 'the item has 20 tags');
SELECT throws_ok($$INSERT INTO public.collection_item_tags (item_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-000000c0c001', '00000000-0000-4000-8000-000000c10020')$$,
  '22023', 'tag_limit_reached', 'a 21st collector is rejected');
SELECT throws_ok($$INSERT INTO public.collection_item_tags (item_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-000000c0c001', '00000000-0000-4000-8000-000000c0a002')$$,
  '23505', NULL, 'at the cap, re-adding someone already tagged is a duplicate, not a limit error');
SELECT lives_ok($$INSERT INTO public.folder_tags (folder_id, tagged_user_id)
  SELECT '00000000-0000-4000-8000-000000c0f001', ('00000000-0000-4000-8000-000000c1' || lpad(g::text, 4, '0'))::uuid FROM generate_series(1, 19) g$$,
  'the collection takes 19 more (20 with C)');
SELECT throws_ok($$INSERT INTO public.folder_tags (folder_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-000000c0f001', '00000000-0000-4000-8000-000000c10020')$$,
  '22023', 'tag_limit_reached', 'a 21st collector is rejected on a collection too');

-- ── Private content: tags never grant access ────────────────────────────
SELECT lives_ok($$
  INSERT INTO public.collection_item_tags (item_id, tagged_user_id) VALUES
    ('00000000-0000-4000-8000-000000c0c002', '00000000-0000-4000-8000-000000c0a003'),
    ('00000000-0000-4000-8000-000000c0c003', '00000000-0000-4000-8000-000000c0a003'),
    ('00000000-0000-4000-8000-000000c0c004', '00000000-0000-4000-8000-000000c0a003');
  INSERT INTO public.folder_tags (folder_id, tagged_user_id) VALUES
    ('00000000-0000-4000-8000-000000c0f002', '00000000-0000-4000-8000-000000c0a003'),
    ('00000000-0000-4000-8000-000000c0f003', '00000000-0000-4000-8000-000000c0a003'),
    ('00000000-0000-4000-8000-000000c0f004', '00000000-0000-4000-8000-000000c0a003')$$,
  'the owner can tag C in private, nested-private and Grail-showcased content');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE tagged_user_id = '00000000-0000-4000-8000-000000c0a003'), 3,
  'the owner sees every tag on their own content');

SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a003');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c002'), 0, 'C cannot see their tag on a private item');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c003'), 0, 'C cannot see their tag on an item nested in a private collection');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c004'), 1, 'C sees their tag on a Grail-showcased item (the item is visible)');
SELECT is((SELECT count(*)::int FROM public.folder_tags WHERE folder_id = '00000000-0000-4000-8000-000000c0f002'), 0, 'C cannot see their tag on a private collection');
SELECT is((SELECT count(*)::int FROM public.folder_tags WHERE folder_id = '00000000-0000-4000-8000-000000c0f003'), 0, 'C cannot see their tag on a collection nested in a private one');
SELECT is((SELECT count(*)::int FROM public.folder_tags WHERE folder_id = '00000000-0000-4000-8000-000000c0f004'), 1, 'C sees their tag on a Grail-showcased collection');
SELECT is((SELECT count(*)::int FROM public.collection_items WHERE id IN ('00000000-0000-4000-8000-000000c0c002', '00000000-0000-4000-8000-000000c0c003')), 0,
  'being tagged does not let C read the private items');
SELECT is((SELECT count(*)::int FROM public.folders WHERE id IN ('00000000-0000-4000-8000-000000c0f002', '00000000-0000-4000-8000-000000c0f003')), 0,
  'being tagged does not let C read the private collections');
SELECT set_eq($$SELECT item_id FROM public.collection_item_tags WHERE tagged_user_id = auth.uid()$$,
              $$SELECT id FROM public.collection_items WHERE id IN ('00000000-0000-4000-8000-000000c0c002', '00000000-0000-4000-8000-000000c0c003', '00000000-0000-4000-8000-000000c0c004')$$,
  'C''s visible item tags are exactly the tagged items C can read');
SELECT set_eq($$SELECT item_id FROM public.notifications WHERE type = 'item_tag'$$,
              ARRAY['00000000-0000-4000-8000-000000c0c004'::uuid],
  'C is notified only about the item they can see');
SELECT set_eq($$SELECT folder_id FROM public.notifications WHERE type = 'folder_tag'$$,
              ARRAY['00000000-0000-4000-8000-000000c0f001'::uuid, '00000000-0000-4000-8000-000000c0f004'::uuid],
  'C is notified only about the collections they can see');

-- ── Others with access see the tags (X, an outsider) ────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a009');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c001'), 20, 'anyone signed in sees the tags on a public item');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id IN ('00000000-0000-4000-8000-000000c0c002', '00000000-0000-4000-8000-000000c0c003')), 0,
  'an outsider sees no tags on private content');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE tagged_user_id = '00000000-0000-4000-8000-000000c0a003'), 1,
  'an outsider sees only C''s tags on content they can read (the Grail item)');
SELECT is((SELECT count(*)::int FROM public.folder_tags WHERE folder_id = '00000000-0000-4000-8000-000000c0f001'), 20, 'anyone signed in sees the tags on a public collection');
DELETE FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c001';
DELETE FROM public.folder_tags WHERE folder_id = '00000000-0000-4000-8000-000000c0f001';
SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a001');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c001')
        + (SELECT count(*)::int FROM public.folder_tags WHERE folder_id = '00000000-0000-4000-8000-000000c0f001'), 40,
  'an outsider cannot remove anyone''s tags');

-- ── Removing tags ───────────────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a002');
DELETE FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c001';
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c001' AND tagged_user_id = auth.uid()), 0,
  'B removes themselves from the item');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE type = 'item_tag' AND item_id = '00000000-0000-4000-8000-000000c0c001'), 0,
  'B''s tag notification goes with the tag');
SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a001');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c001'), 19,
  'B''s delete removed only B''s own tag, not the other 19');

SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a003');
DELETE FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c002';
DELETE FROM public.folder_tags WHERE folder_id = '00000000-0000-4000-8000-000000c0f004';
SELECT is((SELECT count(*)::int FROM public.folder_tags WHERE folder_id = '00000000-0000-4000-8000-000000c0f004'), 0,
  'C removes themselves from a collection they can see');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE type = 'folder_tag' AND folder_id = '00000000-0000-4000-8000-000000c0f004'), 0,
  'C''s notification for it is removed');
SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a001');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c002'), 1,
  'a tag on content C cannot see is not removable by C (the owner can remove it)');

DELETE FROM public.collection_item_tags
WHERE item_id = '00000000-0000-4000-8000-000000c0c001' AND tagged_user_id = '00000000-0000-4000-8000-000000c10001';
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c001'), 18,
  'the owner removes another collector''s tag');
SELECT lives_ok($$INSERT INTO public.collection_item_tags (item_id, tagged_user_id) VALUES ('00000000-0000-4000-8000-000000c0c001', '00000000-0000-4000-8000-000000c0a002')$$,
  'the owner can tag B again after B removed themselves');
SELECT pg_temp.login('00000000-0000-4000-8000-000000c0a002');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE type = 'item_tag' AND item_id = '00000000-0000-4000-8000-000000c0c001'), 1,
  'B has exactly one notification for the item again (never two)');

-- ── Notifications: structural dedupe and visibility at tag time ─────────
RESET ROLE;
-- From here on: a trusted server-side session (no signed-in user).
SELECT set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true);
SELECT throws_ok($$INSERT INTO public.notifications (user_id, actor_id, type, item_id) VALUES ('00000000-0000-4000-8000-000000c0a002', '00000000-0000-4000-8000-000000c0a001', 'item_tag', '00000000-0000-4000-8000-000000c0c001')$$,
  '23505', NULL, 'a second notification for the same collector and item is impossible');
SELECT throws_ok($$INSERT INTO public.notifications (user_id, actor_id, type) VALUES ('00000000-0000-4000-8000-000000c0a002', '00000000-0000-4000-8000-000000c0a001', 'item_tag')$$,
  '23514', NULL, 'an item_tag notification must name its item');
SELECT throws_ok($$INSERT INTO public.notifications (user_id, actor_id, type) VALUES ('00000000-0000-4000-8000-000000c0a002', '00000000-0000-4000-8000-000000c0a001', 'folder_tag')$$,
  '23514', NULL, 'a folder_tag notification must name its collection');
SELECT ok(public._folder_visible_to('00000000-0000-4000-8000-000000c0f001', '00000000-0000-4000-8000-000000c0a009')
      AND public._folder_visible_to('00000000-0000-4000-8000-000000c0f004', '00000000-0000-4000-8000-000000c0a009')
      AND NOT public._folder_visible_to('00000000-0000-4000-8000-000000c0f002', '00000000-0000-4000-8000-000000c0a009')
      AND NOT public._folder_visible_to('00000000-0000-4000-8000-000000c0f003', '00000000-0000-4000-8000-000000c0a009')
      AND public._folder_visible_to('00000000-0000-4000-8000-000000c0f002', '00000000-0000-4000-8000-000000c0a001'),
  '_folder_visible_to matches folders_select_public (public, Grail, private, nested-private, owner)');

-- ── Deleted accounts and deleted content ────────────────────────────────
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-000000c10002';
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE tagged_user_id = '00000000-0000-4000-8000-000000c10002')
        + (SELECT count(*)::int FROM public.folder_tags WHERE tagged_user_id = '00000000-0000-4000-8000-000000c10002'), 0,
  'a deleted account''s tags are removed');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE user_id = '00000000-0000-4000-8000-000000c10002'), 0,
  'and its notifications');
SELECT throws_ok($$INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by) VALUES ('00000000-0000-4000-8000-000000c0c001', '00000000-0000-4000-8000-000000c10002', '00000000-0000-4000-8000-000000c0a001')$$,
  '22023', 'tag_user_not_found', 'a deleted account cannot be tagged');

DELETE FROM public.collection_items WHERE id = '00000000-0000-4000-8000-000000c0c001';
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE item_id = '00000000-0000-4000-8000-000000c0c001'), 0, 'deleting an item removes its tags');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE item_id = '00000000-0000-4000-8000-000000c0c001'), 0, 'and its tag notifications');

INSERT INTO public.folder_tags (folder_id, tagged_user_id, tagged_by) VALUES
  ('00000000-0000-4000-8000-000000c0f005', '00000000-0000-4000-8000-000000c0a002', '00000000-0000-4000-8000-000000c0a001');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE type = 'folder_tag' AND folder_id = '00000000-0000-4000-8000-000000c0f005'), 1,
  'a trusted server-side insert naming the owner works and notifies');
DELETE FROM public.folders WHERE id = '00000000-0000-4000-8000-000000c0f005';
SELECT is((SELECT count(*)::int FROM public.folder_tags WHERE folder_id = '00000000-0000-4000-8000-000000c0f005')
        + (SELECT count(*)::int FROM public.notifications WHERE folder_id = '00000000-0000-4000-8000-000000c0f005'), 0,
  'deleting a collection removes its tags and notifications');
SELECT throws_ok($$INSERT INTO public.folder_tags (folder_id, tagged_user_id, tagged_by) VALUES ('00000000-0000-4000-8000-000000c0f001', '00000000-0000-4000-8000-000000c0a002', '00000000-0000-4000-8000-000000c0a002')$$,
  '42501', 'tag_not_owner', 'a server-side insert must still name the real owner');

SELECT * FROM finish();
ROLLBACK;
