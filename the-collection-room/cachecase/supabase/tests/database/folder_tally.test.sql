-- pgTAP test for 20261025120000_add_folder_tally_rpc.sql.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(17);

-- ── Function shape and grants ──────────────────────────────────────────
SELECT has_function('public', 'folder_tally', ARRAY['uuid'], 'function exists');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.folder_tally(uuid)'::regprocedure), false, 'function is SECURITY INVOKER (RLS applies)');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.folder_tally(uuid)'::regprocedure), ARRAY['search_path=""'], 'search_path is pinned to empty');
SELECT ok(has_function_privilege('authenticated', 'public.folder_tally(uuid)', 'EXECUTE'), 'authenticated can execute it');
SELECT ok(NOT has_function_privilege('anon', 'public.folder_tally(uuid)', 'EXECUTE'), 'anon cannot execute it');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- Owner O's tree (all public unless noted):
--   root (2 active + 1 transferred_out)
--   ├── g1 (3 items, 1 of them private)
--   │   └── g1a (2 items)              ← second level of nesting
--   ├── g2 (empty)
--   └── gp PRIVATE (4 items)
--       └── gpc public flag (2 public items) ← hidden from others by its
--                                              private ancestor, not its own flag
--   empty_root (no items, no children)
--   only_galleries (no direct items) └── og1 (1 item)
-- Viewer V is another signed-in user.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000000b1', 'tally-o@example.invalid', '{"username":"tally_test_o"}'),
  ('00000000-0000-4000-8000-0000000000b2', 'tally-v@example.invalid', '{"username":"tally_test_v"}');

INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000000001f0', '00000000-0000-4000-8000-0000000000b1', 'root', true, NULL),
  ('00000000-0000-4000-8000-0000000001f1', '00000000-0000-4000-8000-0000000000b1', 'g1', true, '00000000-0000-4000-8000-0000000001f0'),
  ('00000000-0000-4000-8000-0000000001f2', '00000000-0000-4000-8000-0000000000b1', 'g1a', true, '00000000-0000-4000-8000-0000000001f1'),
  ('00000000-0000-4000-8000-0000000001f3', '00000000-0000-4000-8000-0000000000b1', 'g2', true, '00000000-0000-4000-8000-0000000001f0'),
  ('00000000-0000-4000-8000-0000000001f4', '00000000-0000-4000-8000-0000000000b1', 'gp', false, '00000000-0000-4000-8000-0000000001f0'),
  ('00000000-0000-4000-8000-0000000001f8', '00000000-0000-4000-8000-0000000000b1', 'gpc', true, '00000000-0000-4000-8000-0000000001f4'),
  ('00000000-0000-4000-8000-0000000001f5', '00000000-0000-4000-8000-0000000000b1', 'empty_root', true, NULL),
  ('00000000-0000-4000-8000-0000000001f6', '00000000-0000-4000-8000-0000000000b1', 'only_galleries', true, NULL),
  ('00000000-0000-4000-8000-0000000001f7', '00000000-0000-4000-8000-0000000000b1', 'og1', true, '00000000-0000-4000-8000-0000000001f6');

INSERT INTO public.collection_items (folder_id, user_id, title, is_public, collection_status)
SELECT f.folder_id::uuid, '00000000-0000-4000-8000-0000000000b1', f.title, f.is_public, f.status
FROM (VALUES
  ('00000000-0000-4000-8000-0000000001f0', 'root-1', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f0', 'root-2', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f0', 'root-gone', true, 'transferred_out'),
  ('00000000-0000-4000-8000-0000000001f1', 'g1-1', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f1', 'g1-2', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f1', 'g1-private', false, 'active'),
  ('00000000-0000-4000-8000-0000000001f2', 'g1a-1', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f2', 'g1a-2', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f4', 'gp-1', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f4', 'gp-2', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f4', 'gp-3', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f4', 'gp-4', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f8', 'gpc-1', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f8', 'gpc-2', true, 'active'),
  ('00000000-0000-4000-8000-0000000001f7', 'og1-1', true, 'active')
) AS f(folder_id, title, is_public, status);

-- ── As the owner ────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b1', true);

-- 2 (root, active) + 3 (g1) + 2 (g1a) + 0 (g2) + 4 (gp) + 2 (gpc, two levels down) = 13.
SELECT results_eq($$SELECT * FROM public.folder_tally('00000000-0000-4000-8000-0000000001f0')$$, $$VALUES (13::bigint, 3::bigint)$$,
  'owner: root counts direct + every nested level (active only, each once) and its 3 direct galleries');
SELECT results_eq($$SELECT * FROM public.folder_tally('00000000-0000-4000-8000-0000000001f1')$$, $$VALUES (5::bigint, 1::bigint)$$,
  'owner: gallery with a nested gallery');
SELECT results_eq($$SELECT * FROM public.folder_tally('00000000-0000-4000-8000-0000000001f2')$$, $$VALUES (2::bigint, 0::bigint)$$,
  'owner: direct items only');
SELECT results_eq($$SELECT * FROM public.folder_tally('00000000-0000-4000-8000-0000000001f5')$$, $$VALUES (0::bigint, 0::bigint)$$,
  'owner: empty collection');
SELECT results_eq($$SELECT * FROM public.folder_tally('00000000-0000-4000-8000-0000000001f6')$$, $$VALUES (1::bigint, 1::bigint)$$,
  'owner: collection with only galleries');
SELECT results_eq($$SELECT * FROM public.folder_tally('00000000-0000-4000-8000-0000000001f4')$$, $$VALUES (6::bigint, 1::bigint)$$,
  'owner: own private gallery counts its items and its nested public gallery');

-- Move an item from the root into a nested gallery: totals unchanged.
UPDATE public.collection_items SET folder_id = '00000000-0000-4000-8000-0000000001f2' WHERE title = 'root-1';
SELECT results_eq($$SELECT * FROM public.folder_tally('00000000-0000-4000-8000-0000000001f0')$$, $$VALUES (13::bigint, 3::bigint)$$,
  'owner: moving an item between parent and gallery keeps the total');

-- Detach a gallery (what deleting its parent does via ON DELETE SET NULL;
-- moving a gallery out is the same update): its subtree leaves the tally.
-- Left in root: root-2 (root-1 now lives in g1a) + gp's 4 + gpc's 2 = 7;
-- galleries g2, gp.
UPDATE public.folders SET parent_folder_id = NULL WHERE id = '00000000-0000-4000-8000-0000000001f1';
SELECT results_eq($$SELECT * FROM public.folder_tally('00000000-0000-4000-8000-0000000001f0')$$, $$VALUES (7::bigint, 2::bigint)$$,
  'owner: moving a gallery out removes it and its subtree');
UPDATE public.folders SET parent_folder_id = '00000000-0000-4000-8000-0000000001f0' WHERE id = '00000000-0000-4000-8000-0000000001f1';

-- ── As another signed-in user ───────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b2', true);

-- Sanity check that the fixture exercises the private-ANCESTOR rule: gpc is
-- flagged public itself, yet the viewer can't read it at all.
SELECT is((SELECT count(*) FROM public.folders WHERE id = '00000000-0000-4000-8000-0000000001f8')::int, 0,
  'viewer: a public-flagged gallery under a private gallery is not readable');

-- root-2, g1-1, g1-2, g1a-1, g1a-2, root-1 (now in g1a) = 6 items; galleries
-- g1, g2 — never the private gallery (or its 4 items), the public-flagged
-- gallery nested under it (or its 2 public items), or the private item.
SELECT results_eq($$SELECT * FROM public.folder_tally('00000000-0000-4000-8000-0000000001f0')$$, $$VALUES (6::bigint, 2::bigint)$$,
  'viewer: private galleries, everything nested under them, and private items are excluded');
SELECT results_eq($$SELECT * FROM public.folder_tally('00000000-0000-4000-8000-0000000001f4')$$, $$VALUES (0::bigint, 0::bigint)$$,
  'viewer: a private gallery counts nothing, including its nested public gallery');
SELECT results_eq($$SELECT * FROM public.folder_tally('00000000-0000-4000-8000-0000000001f8')$$, $$VALUES (0::bigint, 0::bigint)$$,
  'viewer: a public-flagged gallery under a private gallery counts nothing when asked directly');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
