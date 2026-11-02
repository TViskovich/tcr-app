-- pgTAP test for 20261031150000_add_profile_item_search.sql (Phase A —
-- Profile Items search) and the shared matching helper it reuses.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(31);

-- ── Shape and grants ────────────────────────────────────────────────────
SELECT has_function('public', 'search_profile_items', ARRAY['uuid', 'text', 'integer', 'integer'], 'profile search function exists');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.search_profile_items(uuid,text,integer,integer)'::regprocedure), false,
  'profile search is SECURITY INVOKER (RLS applies)');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.search_profile_items(uuid,text,integer,integer)'::regprocedure), ARRAY['search_path=""'],
  'search_path is pinned to empty');
SELECT ok(has_function_privilege('authenticated', 'public.search_profile_items(uuid,text,integer,integer)', 'EXECUTE'), 'authenticated can search');
SELECT ok(NOT has_function_privilege('anon', 'public.search_profile_items(uuid,text,integer,integer)', 'EXECUTE'), 'anon cannot search');

-- ── Shared matching rule ────────────────────────────────────────────────
SELECT ok(public.search_document_matches('batman | joker catwoman | 1st print', ARRAY['jok', '1st print']), 'every term matches a word start');
SELECT ok(NOT public.search_document_matches('batman | later print | 1st appearance', ARRAY['1st print']), 'phrase term needs its words together');
SELECT ok(NOT public.search_document_matches('anniversary | 21st anniversary', ARRAY['1st']), 'no mid-word match');
SELECT ok(NOT public.search_document_matches('batman', '{}'::text[]), 'no terms never matches');
SELECT ok(NOT public.search_document_matches(NULL, ARRAY['batman']), 'no document never matches');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- Owner O, visitor V, and another collector X (scope check).
--   O pub (public)
--   ├── nested (public)            a2 "Batman Beyond" comic, Joker, 1st Print
--   │                              (+ a1 below lives in pub itself)
--   pub:                           a1 "Detective Comics" comic, Joker
--                                  a3 PRIVATE item, Joker
--                                  a4 transferred_out, Joker
--                                  a5 PRIVATE item, Joker, in O's Grails
--                                  a6 Pokémon Charizard, Base Set
--   O priv (PRIVATE)               b1 public item, Joker
--   └── priv_child (public flag)   b2 public item, Joker ← hidden by its ancestor
--   X pub                          x1 public item, Joker
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000006a1', 'psearch-o@example.invalid', '{"username":"psearch_test_o"}'),
  ('00000000-0000-4000-8000-0000000006a2', 'psearch-v@example.invalid', '{"username":"psearch_test_v"}'),
  ('00000000-0000-4000-8000-0000000006a3', 'psearch-x@example.invalid', '{"username":"psearch_test_x"}');

INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000000006f0', '00000000-0000-4000-8000-0000000006a1', 'pub', true, NULL),
  ('00000000-0000-4000-8000-0000000006f1', '00000000-0000-4000-8000-0000000006a1', 'nested', true, '00000000-0000-4000-8000-0000000006f0'),
  ('00000000-0000-4000-8000-0000000006f2', '00000000-0000-4000-8000-0000000006a1', 'priv', false, NULL),
  ('00000000-0000-4000-8000-0000000006f3', '00000000-0000-4000-8000-0000000006a1', 'priv_child', true, '00000000-0000-4000-8000-0000000006f2'),
  ('00000000-0000-4000-8000-0000000006f4', '00000000-0000-4000-8000-0000000006a3', 'x pub', true, NULL);

INSERT INTO public.collection_items (id, folder_id, user_id, item_type, title, is_public, collection_status) VALUES
  ('00000000-0000-4000-8000-0000000006c1', '00000000-0000-4000-8000-0000000006f0', '00000000-0000-4000-8000-0000000006a1', 'comic_book', 'Detective Comics', true, 'active'),
  ('00000000-0000-4000-8000-0000000006c2', '00000000-0000-4000-8000-0000000006f1', '00000000-0000-4000-8000-0000000006a1', 'comic_book', 'Batman Beyond', true, 'active'),
  ('00000000-0000-4000-8000-0000000006c3', '00000000-0000-4000-8000-0000000006f0', '00000000-0000-4000-8000-0000000006a1', 'comic_book', 'Private Item', false, 'active'),
  ('00000000-0000-4000-8000-0000000006c4', '00000000-0000-4000-8000-0000000006f0', '00000000-0000-4000-8000-0000000006a1', 'comic_book', 'Gone Item', true, 'transferred_out'),
  ('00000000-0000-4000-8000-0000000006c5', '00000000-0000-4000-8000-0000000006f0', '00000000-0000-4000-8000-0000000006a1', 'comic_book', 'Grail Private', false, 'active'),
  ('00000000-0000-4000-8000-0000000006c6', '00000000-0000-4000-8000-0000000006f0', '00000000-0000-4000-8000-0000000006a1', 'pokemon', 'Charizard', true, 'active'),
  ('00000000-0000-4000-8000-0000000006d1', '00000000-0000-4000-8000-0000000006f2', '00000000-0000-4000-8000-0000000006a1', 'comic_book', 'In Private Folder', true, 'active'),
  ('00000000-0000-4000-8000-0000000006d2', '00000000-0000-4000-8000-0000000006f3', '00000000-0000-4000-8000-0000000006a1', 'comic_book', 'Under Private Ancestor', true, 'active'),
  ('00000000-0000-4000-8000-0000000006e1', '00000000-0000-4000-8000-0000000006f4', '00000000-0000-4000-8000-0000000006a3', 'comic_book', 'Someone Else', true, 'active');

INSERT INTO public.comic_book_details (item_id, series_title, printing, characters, key_types) VALUES
  ('00000000-0000-4000-8000-0000000006c1', 'Detective Comics', 'Later Printing', 'Joker', '{}'),
  ('00000000-0000-4000-8000-0000000006c2', 'Batman Beyond', '1st Print', 'Joker', '{}'),
  ('00000000-0000-4000-8000-0000000006c3', 'Private', NULL, 'Joker', '{}'),
  ('00000000-0000-4000-8000-0000000006c4', 'Gone', NULL, 'Joker', '{}'),
  ('00000000-0000-4000-8000-0000000006c5', 'Grail', NULL, 'Joker', '{}'),
  ('00000000-0000-4000-8000-0000000006d1', 'Private Folder', NULL, 'Joker', '{}'),
  ('00000000-0000-4000-8000-0000000006d2', 'Under Private', NULL, 'Joker', '{}'),
  ('00000000-0000-4000-8000-0000000006e1', 'Elsewhere', NULL, 'Joker', '{}');

INSERT INTO public.pokemon_card_details (item_id, pokemon_name, set_name, rarity) VALUES
  ('00000000-0000-4000-8000-0000000006c6', 'Charizard', 'Base Set', 'Rare Holo');

-- a5 is showcased in O's Grails: visible to visitors on the Grails, but not
-- one of their searchable Items.
INSERT INTO public.profile_grail_slots (user_id, slot_index, entry_type, item_id) VALUES
  ('00000000-0000-4000-8000-0000000006a1', 0, 'item', '00000000-0000-4000-8000-0000000006c5');

-- O's profile search results for a query, as their fixture tags in
-- RESULT order, e.g. 'c2,c1'.
CREATE FUNCTION pg_temp.hits(p_query text, p_owner uuid DEFAULT '00000000-0000-4000-8000-0000000006a1')
RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(right(item_id::text, 2), ','), '')
  FROM public.search_profile_items(p_owner, p_query, 200, 0);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.hits(text, uuid) TO authenticated;

-- ── As a visitor ────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000006a2","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000006a2', true);

-- Name order: "Batman Beyond" (c2) before "Detective Comics" (c1).
SELECT is(pg_temp.hits('joker'), 'c2,c1',
  'visitor: public items in public folders, nested ones included, in name order');
SELECT ok(pg_temp.hits('joker') NOT LIKE '%c3%', 'visitor: never the private item');
SELECT ok(pg_temp.hits('joker') NOT LIKE '%c4%', 'visitor: never a transferred-out item');
SELECT ok(pg_temp.hits('joker') NOT LIKE '%c5%', 'visitor: never a private Grail-only item');
SELECT ok(pg_temp.hits('joker') NOT LIKE '%d1%', 'visitor: never an item in a private folder');
SELECT ok(pg_temp.hits('joker') NOT LIKE '%d2%', 'visitor: never an item under a private ancestor folder');
SELECT ok(pg_temp.hits('joker') NOT LIKE '%e1%', 'scope: never another collector''s item');
SELECT is(pg_temp.hits('first printing'), 'c2', 'visitor: comic printing normalization (1st Print, not Later Printing)');
SELECT is(pg_temp.hits('base set holo'), 'c6', 'visitor: Pokémon details');
SELECT is(pg_temp.hits('jok', '00000000-0000-4000-8000-0000000006a3'), 'e1', 'scope: another profile returns only its own items');
SELECT is(pg_temp.hits(''), '', 'empty query returns nothing');

-- ── As the owner ────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000006a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000006a1', true);

-- Names: Batman Beyond (c2), Detective Comics (c1), Grail Private (c5),
-- In Private Folder (d1), Private Item (c3), Under Private Ancestor (d2).
SELECT is(pg_temp.hits('joker'), 'c2,c1,c5,d1,c3,d2',
  'owner: every active item, private items and private (nested) folders included, in name order');
SELECT ok(pg_temp.hits('joker') NOT LIKE '%c4%', 'owner: still never a transferred-out item');
SELECT ok(pg_temp.hits('joker') NOT LIKE '%e1%', 'owner: still only their own items');

-- Pagination: pages of 4 + 2 concatenate to the full ordered result.
SELECT is((SELECT count(*)::int FROM public.search_profile_items('00000000-0000-4000-8000-0000000006a1', 'joker', 4, 0)), 4, 'page 1 has 4');
SELECT is((SELECT count(*)::int FROM public.search_profile_items('00000000-0000-4000-8000-0000000006a1', 'joker', 4, 4)), 2, 'page 2 has the last 2');
SELECT is(
  (SELECT array_agg(item_id) FROM (
    SELECT item_id FROM public.search_profile_items('00000000-0000-4000-8000-0000000006a1', 'joker', 4, 0)
    UNION ALL SELECT item_id FROM public.search_profile_items('00000000-0000-4000-8000-0000000006a1', 'joker', 4, 4)
  ) pages),
  (SELECT array_agg(item_id) FROM public.search_profile_items('00000000-0000-4000-8000-0000000006a1', 'joker', 200, 0)),
  'pages concatenate to the full ordered result');
SELECT is(
  (SELECT count(*) - count(DISTINCT item_id) FROM public.search_profile_items('00000000-0000-4000-8000-0000000006a1', 'joker', 200, 0))::int, 0,
  'no duplicate results');
SELECT is(
  (SELECT count(*)::int FROM public.search_profile_items('00000000-0000-4000-8000-0000000006a1', 'joker', 1000, 0)), 6,
  'limit is clamped (to 200) without error');

-- Collection Search still scopes to one folder with the shared rule.
SELECT is(
  (SELECT string_agg(right(item_id::text, 2), ',' ORDER BY right(item_id::text, 2))
   FROM public.search_collection_items('00000000-0000-4000-8000-0000000006f1', 'joker', 200, 0)),
  'c2', 'collection search: only that folder''s own items');

RESET ROLE;

SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.search_profile_items('00000000-0000-4000-8000-0000000006a1', 'joker', 10, 0)$$,
  '42501', NULL, 'anon: calling profile search is denied');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
