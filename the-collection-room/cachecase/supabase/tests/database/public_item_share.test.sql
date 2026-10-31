-- pgTAP test for 20261031120000_add_resolve_public_item_share.sql.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(29);

-- ── Function shape and grants ──────────────────────────────────────────
SELECT has_function('public', 'resolve_public_item_share', ARRAY['uuid'], 'function exists');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.resolve_public_item_share(uuid)'::regprocedure), true,
  'function is SECURITY DEFINER');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.resolve_public_item_share(uuid)'::regprocedure), ARRAY['search_path=""'],
  'search_path is pinned to empty');
SELECT ok(NOT has_function_privilege('anon', 'public.resolve_public_item_share(uuid)', 'EXECUTE'), 'anon cannot execute it');
SELECT ok(NOT has_function_privilege('authenticated', 'public.resolve_public_item_share(uuid)', 'EXECUTE'), 'authenticated cannot execute it');
SELECT ok(has_function_privilege('service_role', 'public.resolve_public_item_share(uuid)', 'EXECUTE'), 'service_role can execute it');
-- The exact output columns: nothing beyond the approved public fields and
-- the (server-side only) image storage path.
SELECT is(pg_get_function_result('public.resolve_public_item_share(uuid)'::regprocedure),
  'TABLE(item_type text, title text, subtitle text, owner_username text, owner_display_name text, image_storage_path text)',
  'returns only the approved columns');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- Owner O:
--   pub (public)                      item_pub (pokemon, 2 images), item_priv (private item),
--   │                                 item_gone (transferred_out), item_grail (private, Grail slot),
--   │                                 item_trade (trading_card, sparse fields)
--   └── pub_child (public)            item_nested (sports_card, no image)
--   priv (PRIVATE)                    item_in_priv (public item), item_grail_pf (public, Grail slot)
--   priv_parent (PRIVATE)
--   └── under_priv (public flag)      item_under_priv (public item) ← hidden by its ancestor
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000003a1', 'share-o@example.invalid', '{"username":"share_test_o","display_name":"Share Owner"}');

INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000000003f0', '00000000-0000-4000-8000-0000000003a1', 'pub', true, NULL),
  ('00000000-0000-4000-8000-0000000003f1', '00000000-0000-4000-8000-0000000003a1', 'pub_child', true, '00000000-0000-4000-8000-0000000003f0'),
  ('00000000-0000-4000-8000-0000000003f2', '00000000-0000-4000-8000-0000000003a1', 'priv', false, NULL),
  ('00000000-0000-4000-8000-0000000003f3', '00000000-0000-4000-8000-0000000003a1', 'priv_parent', false, NULL),
  ('00000000-0000-4000-8000-0000000003f4', '00000000-0000-4000-8000-0000000003a1', 'under_priv', true, '00000000-0000-4000-8000-0000000003f3');

INSERT INTO public.collection_items
  (id, folder_id, user_id, item_type, title, player, year, brand, description, estimated_value, is_public, collection_status)
VALUES
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-0000000003f0', '00000000-0000-4000-8000-0000000003a1',
   'pokemon', 'Charizard', NULL, NULL, NULL, 'secret notes', 999.00, true, 'active'),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-0000000003f1', '00000000-0000-4000-8000-0000000003a1',
   'sports_card', 'Topps #311', 'Mickey Mantle', 1952, 'Topps', NULL, NULL, true, 'active'),
  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-0000000003f0', '00000000-0000-4000-8000-0000000003a1',
   'pokemon', 'Private Item', NULL, NULL, NULL, NULL, NULL, false, 'active'),
  ('00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-0000000003f0', '00000000-0000-4000-8000-0000000003a1',
   'pokemon', 'Transferred', NULL, NULL, NULL, NULL, NULL, true, 'transferred_out'),
  ('00000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-0000000003f0', '00000000-0000-4000-8000-0000000003a1',
   'pokemon', 'Grail Private Item', NULL, NULL, NULL, NULL, NULL, false, 'active'),
  ('00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-0000000003f2', '00000000-0000-4000-8000-0000000003a1',
   'pokemon', 'In Private Folder', NULL, NULL, NULL, NULL, NULL, true, 'active'),
  ('00000000-0000-4000-8000-000000000307', '00000000-0000-4000-8000-0000000003f2', '00000000-0000-4000-8000-0000000003a1',
   'pokemon', 'Grail In Private Folder', NULL, NULL, NULL, NULL, NULL, true, 'active'),
  ('00000000-0000-4000-8000-000000000308', '00000000-0000-4000-8000-0000000003f4', '00000000-0000-4000-8000-0000000003a1',
   'pokemon', 'Under Private Ancestor', NULL, NULL, NULL, NULL, NULL, true, 'active'),
  ('00000000-0000-4000-8000-000000000309', '00000000-0000-4000-8000-0000000003f0', '00000000-0000-4000-8000-0000000003a1',
   'trading_card', 'Black Lotus', NULL, NULL, NULL, NULL, NULL, true, 'active'),
  ('00000000-0000-4000-8000-00000000030a', '00000000-0000-4000-8000-0000000003f0', '00000000-0000-4000-8000-0000000003a1',
   'pokemon', 'Deleted', NULL, NULL, NULL, NULL, NULL, true, 'active');

INSERT INTO public.pokemon_card_details (item_id, pokemon_name, set_name, card_number, rarity) VALUES
  ('00000000-0000-4000-8000-000000000301', 'Charizard', 'Base Set', '4/102', 'Rare Holo');
INSERT INTO public.trading_card_details (item_id, franchise, set_name, card_number) VALUES
  ('00000000-0000-4000-8000-000000000309', 'Magic: The Gathering', '  ', NULL);

-- item_pub: the primary image wins over an earlier non-primary one.
INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary) VALUES
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-0000000003a1', 'https://x.invalid/first.jpg',
   '00000000-0000-4000-8000-0000000003a1/items/first.jpg', 0, false),
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-0000000003a1', 'https://x.invalid/primary.jpg',
   '00000000-0000-4000-8000-0000000003a1/items/primary.jpg', 1, true),
  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-0000000003a1', 'https://x.invalid/private.jpg',
   '00000000-0000-4000-8000-0000000003a1/items/private.jpg', 0, true);

-- Grail-showcase both "private" items: the in-app exception must NOT make
-- them publicly shareable.
INSERT INTO public.profile_grail_slots (user_id, slot_index, entry_type, item_id) VALUES
  ('00000000-0000-4000-8000-0000000003a1', 0, 'item', '00000000-0000-4000-8000-000000000305'),
  ('00000000-0000-4000-8000-0000000003a1', 1, 'item', '00000000-0000-4000-8000-000000000307');

DELETE FROM public.collection_items WHERE id = '00000000-0000-4000-8000-00000000030a';

-- ── Client roles are refused outright ──────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000301')$$,
  '42501', NULL, 'anon: calling the function is denied');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000003a1","role":"authenticated"}', true);
SELECT throws_ok($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000301')$$,
  '42501', NULL, 'authenticated (even the owner): calling the function is denied');
RESET ROLE;

-- ── As the Edge Function (service_role) ────────────────────────────────
SET LOCAL ROLE service_role;

-- Shareable items.
SELECT results_eq(
  $$SELECT item_type, title, subtitle, owner_username, owner_display_name, image_storage_path
    FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000301')$$,
  $$VALUES ('pokemon'::text, 'Charizard'::text, 'Base Set · #4/102'::text, 'share_test_o'::text, 'Share Owner'::text,
            '00000000-0000-4000-8000-0000000003a1/items/primary.jpg'::text)$$,
  'public item in a public folder: approved fields + the PRIMARY image path');
SELECT results_eq(
  $$SELECT item_type, title, subtitle, image_storage_path
    FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000302')$$,
  $$VALUES ('sports_card'::text, 'Mickey Mantle'::text, '1952 Topps'::text, NULL::text)$$,
  'public item in a public nested gallery: player leads the title; no image -> NULL path');
SELECT results_eq(
  $$SELECT title, subtitle FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000309')$$,
  $$VALUES ('Black Lotus'::text, 'Magic: The Gathering'::text)$$,
  'blank and missing category fields are left out of the subtitle');

-- Not shareable: every case returns no row at all.
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000303')$$,
  'private item in a public folder: no row');
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000304')$$,
  'transferred_out item: no row');
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000305')$$,
  'Grail-showcased private item: no row');
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000306')$$,
  'public item in a private folder: no row');
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000307')$$,
  'Grail-showcased item in a private folder: no row');
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000308')$$,
  'public item in a public-flagged gallery under a private ancestor: no row');
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-00000000030a')$$,
  'deleted item: no row');
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-0000000003ff')$$,
  'nonexistent id: no row');
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-0000000003f0')$$,
  'a folder id is not an item id: no row');
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share(NULL)$$,
  'NULL id: no row');

RESET ROLE;

-- ── Privacy changes take effect immediately ────────────────────────────
UPDATE public.collection_items SET is_public = false WHERE id = '00000000-0000-4000-8000-000000000301';
SET LOCAL ROLE service_role;
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000301')$$,
  'item made private: no row');
RESET ROLE;
UPDATE public.collection_items SET is_public = true WHERE id = '00000000-0000-4000-8000-000000000301';

UPDATE public.folders SET is_public = false WHERE id = '00000000-0000-4000-8000-0000000003f0';
SET LOCAL ROLE service_role;
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000301')$$,
  'folder made private: its item has no row');
SELECT is_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000302')$$,
  'parent folder made private: the nested gallery''s item has no row');
RESET ROLE;
UPDATE public.folders SET is_public = true WHERE id = '00000000-0000-4000-8000-0000000003f0';

UPDATE public.folders SET is_public = true WHERE id = '00000000-0000-4000-8000-0000000003f3';
SET LOCAL ROLE service_role;
SELECT isnt_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000308')$$,
  'private ancestor made public: the nested item becomes shareable');
RESET ROLE;

-- Transferred back to active (sanity check that the status alone gated it).
UPDATE public.collection_items SET collection_status = 'active' WHERE id = '00000000-0000-4000-8000-000000000304';
SET LOCAL ROLE service_role;
SELECT isnt_empty($$SELECT * FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000304')$$,
  'the same item while active: shareable');
RESET ROLE;

-- The image goes with its item: removing every image leaves the item
-- shareable with no image path.
DELETE FROM public.collection_item_images WHERE item_id = '00000000-0000-4000-8000-000000000301';
SET LOCAL ROLE service_role;
SELECT results_eq(
  $$SELECT title, image_storage_path FROM public.resolve_public_item_share('00000000-0000-4000-8000-000000000301')$$,
  $$VALUES ('Charizard'::text, NULL::text)$$,
  'images removed: still shareable, image path NULL');
RESET ROLE;

-- Private-detail columns never feature in the output, whatever their value.
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['description', 'estimated_value', 'serial_number', 'grade', 'grading_company',
                               'purchase_price', 'user_id', 'folder_id', 'image_id', 'rarity'])
    AS c(col)
    WHERE pg_get_function_result('public.resolve_public_item_share(uuid)'::regprocedure) LIKE '%' || c.col || '%'
  ),
  'no private or internal column name appears in the result signature');

SELECT * FROM finish();
ROLLBACK;
