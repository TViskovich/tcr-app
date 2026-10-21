-- pgTAP test for 20261026120000_add_profile_ordering.sql.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.
-- (The backfill itself is covered separately, before/after the migration:
-- scripts/db/profile-ordering-backfill/run.sh.)

BEGIN;
SELECT plan(62);

-- ── Shape and grants ─────────────────────────────────────────────────────
SELECT has_column('public', 'folders', 'sort_order', 'folders.sort_order exists');
SELECT has_column('public', 'collection_items', 'profile_sort_order', 'collection_items.profile_sort_order exists');
SELECT has_column('public', 'collection_items', 'sort_order', 'per-collection collection_items.sort_order still exists');
SELECT has_function('public', 'reorder_folders', ARRAY['uuid', 'uuid[]'], 'reorder_folders exists');
SELECT has_function('public', 'move_profile_item', ARRAY['uuid', 'uuid', 'uuid'], 'move_profile_item exists');
SELECT hasnt_function('public', 'reorder_profile_items', ARRAY['uuid[]'], 'no whole-set item reorder (it couldn''t scale past one page)');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.reorder_folders(uuid,uuid[])'::regprocedure), true,
  'reorder_folders is SECURITY DEFINER (it does its own ownership checks)');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.move_profile_item(uuid,uuid,uuid)'::regprocedure), true,
  'move_profile_item is SECURITY DEFINER (it does its own ownership checks)');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.reorder_folders(uuid,uuid[])'::regprocedure), ARRAY['search_path=""'],
  'reorder_folders pins search_path');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.move_profile_item(uuid,uuid,uuid)'::regprocedure), ARRAY['search_path=""'],
  'move_profile_item pins search_path');
SELECT ok(has_function_privilege('authenticated', 'public.reorder_folders(uuid,uuid[])', 'EXECUTE'), 'authenticated can execute reorder_folders');
SELECT ok(NOT has_function_privilege('anon', 'public.reorder_folders(uuid,uuid[])', 'EXECUTE'), 'anon cannot execute reorder_folders');
SELECT ok(has_function_privilege('authenticated', 'public.move_profile_item(uuid,uuid,uuid)', 'EXECUTE'), 'authenticated can execute move_profile_item');
SELECT ok(NOT has_function_privilege('anon', 'public.move_profile_item(uuid,uuid,uuid)', 'EXECUTE'), 'anon cannot execute move_profile_item');
SELECT ok(NOT has_column_privilege('authenticated', 'public.collection_items', 'profile_sort_order', 'UPDATE'),
  'clients cannot update profile_sort_order directly');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- Owner O:
--   a, b, c        top level (created in that order → c is newest)
--   a ── a1, a2    nested under a
--   b ── b1        nested under b
--   items i1, i2 in a; i3 in b
-- Other user X: x (top level), with one item.
-- Inserted as each owner, so the insert triggers run exactly as in the app.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'order-o@example.invalid', '{"username":"order_test_o"}'),
  ('00000000-0000-4000-8000-0000000000c2', 'order-x@example.invalid', '{"username":"order_test_x"}');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c2","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c2', true);
INSERT INTO public.folders (id, user_id, name, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000000002e0', '00000000-0000-4000-8000-0000000000c2', 'x', NULL);
INSERT INTO public.collection_items (id, folder_id, user_id, title) VALUES
  ('00000000-0000-4000-8000-0000000003e0', '00000000-0000-4000-8000-0000000002e0', '00000000-0000-4000-8000-0000000000c2', 'x-item');

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c1', true);
INSERT INTO public.folders (id, user_id, name, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000000002a0', '00000000-0000-4000-8000-0000000000c1', 'a', NULL);
INSERT INTO public.folders (id, user_id, name, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000000002b0', '00000000-0000-4000-8000-0000000000c1', 'b', NULL);
INSERT INTO public.folders (id, user_id, name, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000000002c0', '00000000-0000-4000-8000-0000000000c1', 'c', NULL);
INSERT INTO public.folders (id, user_id, name, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000000002a1', '00000000-0000-4000-8000-0000000000c1', 'a1', '00000000-0000-4000-8000-0000000002a0');
INSERT INTO public.folders (id, user_id, name, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000000002a2', '00000000-0000-4000-8000-0000000000c1', 'a2', '00000000-0000-4000-8000-0000000002a0');
INSERT INTO public.folders (id, user_id, name, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000000002b1', '00000000-0000-4000-8000-0000000000c1', 'b1', '00000000-0000-4000-8000-0000000002b0');

INSERT INTO public.collection_items (id, folder_id, user_id, title) VALUES
  ('00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000002a0', '00000000-0000-4000-8000-0000000000c1', 'i1');
INSERT INTO public.collection_items (id, folder_id, user_id, title) VALUES
  ('00000000-0000-4000-8000-0000000003a2', '00000000-0000-4000-8000-0000000002a0', '00000000-0000-4000-8000-0000000000c1', 'i2');
INSERT INTO public.collection_items (id, folder_id, user_id, title) VALUES
  ('00000000-0000-4000-8000-0000000003a3', '00000000-0000-4000-8000-0000000002b0', '00000000-0000-4000-8000-0000000000c1', 'i3');

-- ── New rows go first ───────────────────────────────────────────────────
SELECT results_eq(
  $$SELECT name FROM public.folders WHERE user_id = '00000000-0000-4000-8000-0000000000c1' AND parent_folder_id IS NULL ORDER BY sort_order$$,
  $$VALUES ('c'), ('b'), ('a')$$,
  'new top-level collections are placed first (newest first)');
SELECT results_eq(
  $$SELECT name FROM public.folders WHERE parent_folder_id = '00000000-0000-4000-8000-0000000002a0' ORDER BY sort_order$$,
  $$VALUES ('a2'), ('a1')$$,
  'new nested collections are placed first among their own siblings');
SELECT is(
  (SELECT sort_order FROM public.folders WHERE id = '00000000-0000-4000-8000-0000000002b1'), -1,
  'a child is ordered only against its own parent''s children (b1 is alone under b)');
SELECT results_eq(
  $$SELECT title FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000000000c1' ORDER BY profile_sort_order, id$$,
  $$VALUES ('i3'), ('i2'), ('i1')$$,
  'new items are placed first in the profile-wide order, across collections');
SELECT results_eq(
  $$SELECT title FROM public.collection_items WHERE folder_id = '00000000-0000-4000-8000-0000000002a0' ORDER BY sort_order$$,
  $$VALUES ('i2'), ('i1')$$,
  'the per-collection order is still assigned independently');

-- Moving a collection under another parent puts it first among its new
-- siblings; an update that doesn't change the parent leaves its position.
UPDATE public.folders SET name = 'b1 renamed' WHERE id = '00000000-0000-4000-8000-0000000002b1';
SELECT is((SELECT sort_order FROM public.folders WHERE id = '00000000-0000-4000-8000-0000000002b1'), -1,
  'a non-parent update keeps the collection''s position');
UPDATE public.folders SET parent_folder_id = '00000000-0000-4000-8000-0000000002a0' WHERE id = '00000000-0000-4000-8000-0000000002b1';
SELECT results_eq(
  $$SELECT name FROM public.folders WHERE parent_folder_id = '00000000-0000-4000-8000-0000000002a0' ORDER BY sort_order$$,
  $$VALUES ('b1 renamed'), ('a2'), ('a1')$$,
  'a collection moved under a new parent goes first among its new siblings');
UPDATE public.folders SET parent_folder_id = '00000000-0000-4000-8000-0000000002b0' WHERE id = '00000000-0000-4000-8000-0000000002b1';

-- ── Direct sort_order writes are ignored ────────────────────────────────
UPDATE public.folders SET sort_order = 99 WHERE id = '00000000-0000-4000-8000-0000000002a0';
SELECT is((SELECT sort_order FROM public.folders WHERE id = '00000000-0000-4000-8000-0000000002a0'), -1,
  'a direct sort_order write is ignored (the RPC is the only write path)');
UPDATE public.folders SET name = 'a renamed', sort_order = 42 WHERE id = '00000000-0000-4000-8000-0000000002a0';
SELECT results_eq(
  $$SELECT name, sort_order FROM public.folders WHERE id = '00000000-0000-4000-8000-0000000002a0'$$,
  $$VALUES ('a renamed', -1)$$,
  'other edits in the same update still save; only the sort_order change is dropped');

-- ── reorder_folders ─────────────────────────────────────────────────────
SELECT lives_ok(
  $$SELECT public.reorder_folders(NULL, ARRAY['00000000-0000-4000-8000-0000000002a0', '00000000-0000-4000-8000-0000000002c0', '00000000-0000-4000-8000-0000000002b0']::uuid[])$$,
  'owner can reorder their top-level collections');
SELECT results_eq(
  $$SELECT name, sort_order FROM public.folders WHERE user_id = '00000000-0000-4000-8000-0000000000c1' AND parent_folder_id IS NULL ORDER BY sort_order$$,
  $$VALUES ('a renamed', 0), ('c', 1), ('b', 2)$$,
  'top-level order is saved as dense 0-based positions');
SELECT is(current_setting('cachecase.reordering_folders', true), 'off',
  'reorder_folders switches its write flag back off afterwards');
UPDATE public.folders SET sort_order = 7 WHERE id = '00000000-0000-4000-8000-0000000002c0';
SELECT is((SELECT sort_order FROM public.folders WHERE id = '00000000-0000-4000-8000-0000000002c0'), 1,
  'a direct write right after a reorder is still ignored');
SELECT lives_ok(
  $$SELECT public.reorder_folders('00000000-0000-4000-8000-0000000002a0', ARRAY['00000000-0000-4000-8000-0000000002a1', '00000000-0000-4000-8000-0000000002a2']::uuid[])$$,
  'owner can reorder a nested sibling group');
SELECT results_eq(
  $$SELECT name FROM public.folders WHERE parent_folder_id = '00000000-0000-4000-8000-0000000002a0' ORDER BY sort_order$$,
  $$VALUES ('a1'), ('a2')$$,
  'nested order is saved');
SELECT results_eq(
  $$SELECT parent_folder_id FROM public.folders WHERE id IN ('00000000-0000-4000-8000-0000000002a1', '00000000-0000-4000-8000-0000000002a2', '00000000-0000-4000-8000-0000000002b1') ORDER BY name$$,
  $$VALUES ('00000000-0000-4000-8000-0000000002a0'::uuid), ('00000000-0000-4000-8000-0000000002a0'::uuid), ('00000000-0000-4000-8000-0000000002b0'::uuid)$$,
  'reordering never changes any collection''s parent');
SELECT is((SELECT sort_order FROM public.folders WHERE id = '00000000-0000-4000-8000-0000000002b1'), -1,
  'reordering one group leaves other groups untouched');

SELECT throws_like(
  $$SELECT public.reorder_folders(NULL, ARRAY['00000000-0000-4000-8000-0000000002a0', '00000000-0000-4000-8000-0000000002a0', '00000000-0000-4000-8000-0000000002b0']::uuid[])$$,
  '%Duplicate collection ids%', 'duplicate collection ids are rejected');
SELECT throws_like(
  $$SELECT public.reorder_folders(NULL, ARRAY['00000000-0000-4000-8000-0000000002a0', '00000000-0000-4000-8000-0000000002b0']::uuid[])$$,
  '%does not match the current collections%', 'a stale/partial list (one missing) is rejected');
SELECT throws_like(
  $$SELECT public.reorder_folders(NULL, ARRAY['00000000-0000-4000-8000-0000000002a0', '00000000-0000-4000-8000-0000000002b0', '00000000-0000-4000-8000-0000000002a1']::uuid[])$$,
  '%not in this collection%', 'a nested collection can''t be reordered among the top level');
SELECT throws_like(
  $$SELECT public.reorder_folders(NULL, ARRAY['00000000-0000-4000-8000-0000000002a0', '00000000-0000-4000-8000-0000000002b0', '00000000-0000-4000-8000-0000000002e0']::uuid[])$$,
  '%not in this collection%', 'another user''s collection can''t be included');
SELECT throws_like(
  $$SELECT public.reorder_folders('00000000-0000-4000-8000-0000000002e0', ARRAY['00000000-0000-4000-8000-0000000002e0']::uuid[])$$,
  '%not owned by caller%', 'another user''s collection can''t be used as the parent');
SELECT throws_like(
  $$SELECT public.reorder_folders(NULL, ARRAY[]::uuid[])$$,
  '%No collections supplied%', 'an empty list is rejected');
SELECT throws_like(
  $$SELECT public.reorder_folders(NULL, ARRAY['00000000-0000-4000-8000-0000000002a0', NULL, '00000000-0000-4000-8000-0000000002b0']::uuid[])$$,
  '%must not be null%', 'a null id is rejected');

-- ── move_profile_item ───────────────────────────────────────────────────
-- Start: i3, i2, i1 (adjacent positions -3, -2, -1). Add i4 → first.
INSERT INTO public.collection_items (id, folder_id, user_id, title) VALUES
  ('00000000-0000-4000-8000-0000000003a4', '00000000-0000-4000-8000-0000000002b0', '00000000-0000-4000-8000-0000000000c1', 'i4');
SELECT results_eq(
  $$SELECT title FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000000000c1' AND collection_status = 'active' ORDER BY profile_sort_order, id$$,
  $$VALUES ('i4'), ('i3'), ('i2'), ('i1')$$,
  'starting order');

SELECT lives_ok(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a1', NULL, '00000000-0000-4000-8000-0000000003a4')$$,
  'move to the very start (no item before it)');
SELECT lives_ok(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a4', '00000000-0000-4000-8000-0000000003a2', NULL)$$,
  'move to the very end (no item after it)');
SELECT results_eq(
  $$SELECT title FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000000000c1' AND collection_status = 'active' ORDER BY profile_sort_order, id$$,
  $$VALUES ('i1'), ('i3'), ('i2'), ('i4')$$,
  'first/last moves are saved');
-- i3 (-3) and i2 (-2) are adjacent integers: moving i4 between them must
-- respace the rest first, keeping their order.
SELECT lives_ok(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a4', '00000000-0000-4000-8000-0000000003a3', '00000000-0000-4000-8000-0000000003a2')$$,
  'move between two neighbours with no gap left (respaces)');
SELECT results_eq(
  $$SELECT title FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000000000c1' AND collection_status = 'active' ORDER BY profile_sort_order, id$$,
  $$VALUES ('i1'), ('i3'), ('i4'), ('i2')$$,
  'respacing keeps everyone else''s order');
SELECT lives_ok(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a2', '00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000003a3')$$,
  'move into a gap (midpoint, nothing else written)');
SELECT results_eq(
  $$SELECT title FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000000000c1' AND collection_status = 'active' ORDER BY profile_sort_order, id$$,
  $$VALUES ('i1'), ('i2'), ('i3'), ('i4')$$,
  'midpoint move is saved');
SELECT is(
  (SELECT count(DISTINCT profile_sort_order) FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000000000c1' AND collection_status = 'active')::int,
  (SELECT count(*) FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000000000c1' AND collection_status = 'active')::int,
  'positions stay unique, so the order is total');

-- An unrelated change elsewhere (a new item) doesn't make a move with
-- correct neighbours fail.
INSERT INTO public.collection_items (id, folder_id, user_id, title) VALUES
  ('00000000-0000-4000-8000-0000000003a5', '00000000-0000-4000-8000-0000000002a0', '00000000-0000-4000-8000-0000000000c1', 'i5');
SELECT lives_ok(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a4', '00000000-0000-4000-8000-0000000003a2', '00000000-0000-4000-8000-0000000003a3')$$,
  'a move stays valid after an unrelated item is added (no false "stale")');
SELECT results_eq(
  $$SELECT title FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000000000c1' AND collection_status = 'active' ORDER BY profile_sort_order, id$$,
  $$VALUES ('i5'), ('i1'), ('i2'), ('i4'), ('i3')$$,
  'the new item is first and the move landed where asked');

SELECT throws_like(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a3', '00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000003a4')$$,
  '%does not match your current items%', 'stale: the given neighbours aren''t adjacent any more');
SELECT throws_like(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003e0', NULL, '00000000-0000-4000-8000-0000000003a5')$$,
  '%does not match your current items%', 'another user''s item can''t be moved');
SELECT throws_like(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000003e0', NULL)$$,
  '%does not match your current items%', 'another user''s item can''t be a neighbour');
SELECT throws_like(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000003a1', NULL)$$,
  '%next to itself%', 'an item can''t be its own neighbour');

-- A transferred-out item is no longer part of the order.
RESET ROLE;
UPDATE public.collection_items SET collection_status = 'transferred_out' WHERE id = '00000000-0000-4000-8000-0000000003a2';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a2', NULL, '00000000-0000-4000-8000-0000000003a5')$$,
  '%does not match your current items%', 'a transferred-out item can''t be moved');
SELECT throws_like(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a3', '00000000-0000-4000-8000-0000000003a2', NULL)$$,
  '%does not match your current items%', 'a transferred-out item can''t be a neighbour');
SELECT lives_ok(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a3', '00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000003a4')$$,
  'neighbours are judged among active items only (the transferred-out one between them is skipped)');

-- Collections and the per-collection order are never touched.
SELECT results_eq(
  $$SELECT title, folder_id::text, sort_order FROM public.collection_items WHERE id IN ('00000000-0000-4000-8000-0000000003a1', '00000000-0000-4000-8000-0000000003a3', '00000000-0000-4000-8000-0000000003a4') ORDER BY title$$,
  $$VALUES ('i1', '00000000-0000-4000-8000-0000000002a0', -1), ('i3', '00000000-0000-4000-8000-0000000002b0', -1), ('i4', '00000000-0000-4000-8000-0000000002b0', -2)$$,
  'moves never change an item''s collection or its per-collection order');
SELECT lives_ok(
  $$SELECT public.move_collection_items(ARRAY['00000000-0000-4000-8000-0000000003a1']::uuid[], '00000000-0000-4000-8000-0000000002a0', '00000000-0000-4000-8000-0000000002b0')$$,
  'move_collection_items still works');
SELECT results_eq(
  $$SELECT title FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000000000c1' AND collection_status = 'active' ORDER BY profile_sort_order, id$$,
  $$VALUES ('i5'), ('i1'), ('i3'), ('i4')$$,
  'moving an item between collections keeps its profile position');

-- ── Signed out ──────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT throws_like(
  $$SELECT public.reorder_folders(NULL, ARRAY['00000000-0000-4000-8000-0000000002a0']::uuid[])$$,
  '%Not authenticated%', 'reorder_folders requires a signed-in caller');
SELECT throws_like(
  $$SELECT public.move_profile_item('00000000-0000-4000-8000-0000000003a1', NULL, NULL)$$,
  '%Not authenticated%', 'move_profile_item requires a signed-in caller');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
