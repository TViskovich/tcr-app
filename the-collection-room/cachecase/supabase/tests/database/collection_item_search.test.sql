-- pgTAP test for 20261031140000_add_collection_item_search.sql.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(49);

-- ── Shape and grants ────────────────────────────────────────────────────
SELECT has_function('public', 'search_collection_items', ARRAY['uuid', 'text', 'integer', 'integer'], 'search function exists');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.search_collection_items(uuid,text,integer,integer)'::regprocedure), false,
  'search function is SECURITY INVOKER (RLS applies)');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.search_collection_items(uuid,text,integer,integer)'::regprocedure), ARRAY['search_path=""'],
  'search_path is pinned to empty');
SELECT ok(has_function_privilege('authenticated', 'public.search_collection_items(uuid,text,integer,integer)', 'EXECUTE'), 'authenticated can search');
SELECT ok(NOT has_function_privilege('anon', 'public.search_collection_items(uuid,text,integer,integer)', 'EXECUTE'), 'anon cannot search');
SELECT ok(has_table_privilege('authenticated', 'public.collection_item_search_documents', 'SELECT'), 'authenticated can read the documents view');
SELECT ok(NOT has_table_privilege('anon', 'public.collection_item_search_documents', 'SELECT'), 'anon cannot read the documents view');
SELECT ok(NOT has_table_privilege('authenticated', 'public.collection_item_search_documents', 'INSERT'), 'the documents view is read-only');
SELECT is((SELECT reloptions FROM pg_class WHERE oid = 'public.collection_item_search_documents'::regclass), ARRAY['security_invoker=true'],
  'documents view is security_invoker');

-- ── Normalization ───────────────────────────────────────────────────────
SELECT is(public.search_normalize_text('First Printing'), '1st print', '"First Printing" normalizes to "1st print"');
SELECT is(public.search_normalize_text('1st Print'), '1st print', '"1st Print" normalizes to "1st print"');
SELECT is(public.search_normalize_text('  Pokémon  4/102 '), 'pokemon 4 102', 'accents folded, punctuation becomes word breaks');
SELECT is(public.search_document(ARRAY['Spider-Man', NULL, '  ', '1st Print']), 'spider man | 1st print | spiderman | 1st print',
  'one segment per non-empty field; hyphenated words also indexed joined');
SELECT is(public.search_query_terms('first printing joker'), ARRAY['1st print', 'joker'], 'ordinal + next word is one phrase term');
SELECT is(public.search_query_terms('   '), '{}'::text[], 'blank query has no terms');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- Owner O; viewer V (another signed-in user).
--   comics (public): c1 Batman (Joker, 1st Print), c2 Detective Comics
--     (Later Printing, key type First Appearance), c3 PRIVATE item (Joker),
--     c4 transferred_out (Joker), c5 Spider-Man, c6 21st Anniversary
--     variant, s1 sports card, p1 Pokémon, o1 Other/Sneakers
--   others (public): x1 comic with Joker — a different folder
--   priv (PRIVATE): z1 public comic with Joker
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000005a1', 'search-o@example.invalid', '{"username":"search_test_o"}'),
  ('00000000-0000-4000-8000-0000000005a2', 'search-v@example.invalid', '{"username":"search_test_v"}');

INSERT INTO public.folders (id, user_id, name, is_public) VALUES
  ('00000000-0000-4000-8000-0000000005f0', '00000000-0000-4000-8000-0000000005a1', 'comics', true),
  ('00000000-0000-4000-8000-0000000005f1', '00000000-0000-4000-8000-0000000005a1', 'others', true),
  ('00000000-0000-4000-8000-0000000005f2', '00000000-0000-4000-8000-0000000005a1', 'priv', false);

INSERT INTO public.collection_items (id, folder_id, user_id, item_type, title, player, team, year, brand, description, is_public, collection_status)
VALUES
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-0000000005f0', '00000000-0000-4000-8000-0000000005a1', 'comic_book', 'Batman', NULL, NULL, NULL, NULL, NULL, true, 'active'),
  ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-0000000005f0', '00000000-0000-4000-8000-0000000005a1', 'comic_book', 'Detective Comics', NULL, NULL, NULL, NULL, NULL, true, 'active'),
  ('00000000-0000-4000-8000-000000000503', '00000000-0000-4000-8000-0000000005f0', '00000000-0000-4000-8000-0000000005a1', 'comic_book', 'Private Comic', NULL, NULL, NULL, NULL, NULL, false, 'active'),
  ('00000000-0000-4000-8000-000000000504', '00000000-0000-4000-8000-0000000005f0', '00000000-0000-4000-8000-0000000005a1', 'comic_book', 'Gone Comic', NULL, NULL, NULL, NULL, NULL, true, 'transferred_out'),
  ('00000000-0000-4000-8000-000000000505', '00000000-0000-4000-8000-0000000005f0', '00000000-0000-4000-8000-0000000005a1', 'comic_book', 'Spider-Man', NULL, NULL, NULL, NULL, NULL, true, 'active'),
  ('00000000-0000-4000-8000-000000000506', '00000000-0000-4000-8000-0000000005f0', '00000000-0000-4000-8000-0000000005a1', 'comic_book', 'Anniversary', NULL, NULL, NULL, NULL, NULL, true, 'active'),
  ('00000000-0000-4000-8000-000000000507', '00000000-0000-4000-8000-0000000005f0', '00000000-0000-4000-8000-0000000005a1', 'sports_card', 'Topps #311', 'Mickey Mantle', 'Yankees', 1952, 'Topps', 'Rookie year gem', true, 'active'),
  ('00000000-0000-4000-8000-000000000508', '00000000-0000-4000-8000-0000000005f0', '00000000-0000-4000-8000-0000000005a1', 'pokemon', 'Charizard', NULL, NULL, NULL, NULL, NULL, true, 'active'),
  ('00000000-0000-4000-8000-000000000509', '00000000-0000-4000-8000-0000000005f0', '00000000-0000-4000-8000-0000000005a1', 'other', 'Air Jordan 1', NULL, NULL, 1985, 'Nike', NULL, true, 'active'),
  ('00000000-0000-4000-8000-00000000050a', '00000000-0000-4000-8000-0000000005f1', '00000000-0000-4000-8000-0000000005a1', 'comic_book', 'Other Folder Comic', NULL, NULL, NULL, NULL, NULL, true, 'active'),
  ('00000000-0000-4000-8000-00000000050b', '00000000-0000-4000-8000-0000000005f2', '00000000-0000-4000-8000-0000000005a1', 'comic_book', 'Private Folder Comic', NULL, NULL, NULL, NULL, NULL, true, 'active');

INSERT INTO public.comic_book_details (item_id, series_title, issue_number, publisher, printing, characters, key_types, is_key_issue, cover_variant) VALUES
  ('00000000-0000-4000-8000-000000000501', 'Batman', '1', 'DC', '1st Print', 'Batman, Joker, Catwoman', '{}', false, NULL),
  ('00000000-0000-4000-8000-000000000502', 'Detective Comics', '27', 'DC', 'Later Printing', 'Batman', '{"First Appearance"}', true, NULL),
  ('00000000-0000-4000-8000-000000000503', 'Private', '1', 'DC', '1st Print', 'Joker', '{}', false, NULL),
  ('00000000-0000-4000-8000-000000000504', 'Gone', '1', 'DC', '1st Print', 'Joker', '{}', false, NULL),
  ('00000000-0000-4000-8000-000000000505', 'Amazing Spider-Man', '300', 'Marvel', NULL, 'Venom', '{}', false, NULL),
  ('00000000-0000-4000-8000-000000000506', 'Anniversary', '1', 'Image', NULL, NULL, '{}', false, '21st Anniversary Variant'),
  ('00000000-0000-4000-8000-00000000050a', 'Elsewhere', '1', 'DC', '1st Print', 'Joker', '{}', false, NULL),
  ('00000000-0000-4000-8000-00000000050b', 'Hidden', '1', 'DC', '1st Print', 'Joker', '{}', false, NULL);

INSERT INTO public.pokemon_card_details (item_id, pokemon_name, set_name, card_number, rarity) VALUES
  ('00000000-0000-4000-8000-000000000508', 'Charizard', 'Base Set', '4/102', 'Rare Holo');

INSERT INTO public.other_item_details (item_id, category, search_identifier, details) VALUES
  ('00000000-0000-4000-8000-000000000509', 'sneakers', '555088-001',
   '{"colorway":"Bred","condition":"Deadstock (DS)","extras":["Hangtag"]}');

-- The matching items for one query (default: the comics folder), as their
-- sorted last-3-digit fixture tags, e.g. '501,503'.
CREATE FUNCTION pg_temp.hits(p_query text, p_folder uuid DEFAULT '00000000-0000-4000-8000-0000000005f0')
RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(right(item_id::text, 3), ',' ORDER BY right(item_id::text, 3)), '')
  FROM public.search_collection_items(p_folder, p_query, 200, 0);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.hits(text, uuid) TO authenticated;

-- ── As another signed-in user ───────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000005a2","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000005a2', true);

SELECT is(pg_temp.hits('joker'), '501', 'viewer: "joker" finds the comic whose characters include Joker — not the private, transferred or other-folder ones');
SELECT is(pg_temp.hits('JOKER'), '501', 'case-insensitive');
SELECT is(pg_temp.hits('jok'), '501', 'partial: a word prefix matches');
SELECT is(pg_temp.hits('oker'), '', 'mid-word fragments do not match');
SELECT is(pg_temp.hits('first printing'), '501', '"first printing" matches "1st Print" — not "Later Printing" + "First Appearance"');
SELECT is(pg_temp.hits('1st printing'), '501', '"1st printing" matches "1st Print"');
SELECT is(pg_temp.hits('1st print'), '501', '"1st print" matches "1st Print"');
SELECT is(pg_temp.hits('first appearance'), '502', 'key types are searchable, ordinal words normalized');
SELECT is(pg_temp.hits('1st'), '501,502', '"1st" matches 1st Print and First Appearance — never "21st"');
SELECT is(pg_temp.hits('21st'), '506', '"21st" matches only 21st');
SELECT is(pg_temp.hits('key issue'), '502', 'structured flags have human-readable labels');
SELECT is(pg_temp.hits('joker 1st print'), '501', 'every term must match (AND)');
SELECT is(pg_temp.hits('joker venom'), '', 'terms from different items do not combine');
SELECT is(pg_temp.hits('spiderman'), '505', 'hyphenated title found by the joined spelling');
SELECT is(pg_temp.hits('spider man'), '505', 'hyphenated title found by separate words');
SELECT is(pg_temp.hits('mantle yankees'), '507', 'sports card player + team');
SELECT is(pg_temp.hits('rookie'), '507', 'item notes/description');
SELECT is(pg_temp.hits('1952 topps'), '507', 'sports card year + brand');
SELECT is(pg_temp.hits('base set rare holo'), '508', 'Pokémon set + rarity');
SELECT is(pg_temp.hits('pokemon'), '508', 'item type label, accents folded');
SELECT is(pg_temp.hits('bred deadstock'), '509', 'Other details values (stored labels) are searchable');
SELECT is(pg_temp.hits('hangtag'), '509', 'Other details list values are searchable');
SELECT is(pg_temp.hits('555088'), '509', 'Other search identifier (SKU) is searchable');
SELECT is(pg_temp.hits('sneakers nike'), '509', 'Other category label + brand');
SELECT is(pg_temp.hits(''), '', 'empty query returns nothing');
SELECT is(pg_temp.hits('joker', '00000000-0000-4000-8000-0000000005f2'), '', 'viewer: a private folder returns nothing');
SELECT is((SELECT count(*)::int FROM public.collection_item_search_documents WHERE folder_id = '00000000-0000-4000-8000-0000000005f2'), 0,
  'viewer: the documents view itself hides private-folder items');

-- ── As the owner ────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000005a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000005a1', true);

SELECT is(pg_temp.hits('joker'), '501,503', 'owner: also finds their own private item; still never the transferred one');
SELECT is(pg_temp.hits('joker', '00000000-0000-4000-8000-0000000005f2'), '50b', 'owner: their own private folder is searchable');

-- Pagination: "comic" (the Comic Book type label) matches the 5 active
-- comics in the folder. Pages of 2 cover each exactly once, in order.
SELECT is((SELECT count(*)::int FROM public.search_collection_items('00000000-0000-4000-8000-0000000005f0', 'comic', 2, 0)), 2, 'page 1 has 2');
SELECT is((SELECT count(*)::int FROM public.search_collection_items('00000000-0000-4000-8000-0000000005f0', 'comic', 2, 2)), 2, 'page 2 has 2');
SELECT is((SELECT count(*)::int FROM public.search_collection_items('00000000-0000-4000-8000-0000000005f0', 'comic', 2, 4)), 1, 'page 3 has the last 1');
SELECT is(
  (SELECT array_agg(item_id) FROM (
    SELECT item_id FROM public.search_collection_items('00000000-0000-4000-8000-0000000005f0', 'comic', 2, 0)
    UNION ALL SELECT item_id FROM public.search_collection_items('00000000-0000-4000-8000-0000000005f0', 'comic', 2, 2)
    UNION ALL SELECT item_id FROM public.search_collection_items('00000000-0000-4000-8000-0000000005f0', 'comic', 2, 4)
  ) pages),
  (SELECT array_agg(item_id) FROM public.search_collection_items('00000000-0000-4000-8000-0000000005f0', 'comic', 200, 0)),
  'pages concatenate to the full ordered result, no gaps or repeats');

RESET ROLE;

-- ── anon is refused ─────────────────────────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.search_collection_items('00000000-0000-4000-8000-0000000005f0', 'joker', 10, 0)$$,
  '42501', NULL, 'anon: calling the search function is denied');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
