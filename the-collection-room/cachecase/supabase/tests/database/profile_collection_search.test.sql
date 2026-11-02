-- pgTAP test for 20261031160000_add_profile_collection_search.sql (Phase B —
-- Profile Collections search).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(26);

-- ── Shape and grants ────────────────────────────────────────────────────
SELECT has_function('public', 'search_profile_collections', ARRAY['uuid', 'text', 'boolean', 'integer', 'integer'],
  'collection search function exists');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.search_profile_collections(uuid,text,boolean,integer,integer)'::regprocedure), false,
  'collection search is SECURITY INVOKER (RLS applies)');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.search_profile_collections(uuid,text,boolean,integer,integer)'::regprocedure), ARRAY['search_path=""'],
  'search_path is pinned to empty');
SELECT ok(has_function_privilege('authenticated', 'public.search_profile_collections(uuid,text,boolean,integer,integer)', 'EXECUTE'), 'authenticated can search');
SELECT ok(NOT has_function_privilege('anon', 'public.search_profile_collections(uuid,text,boolean,integer,integer)', 'EXECUTE'), 'anon cannot search');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- Owner O, visitor V, another collector X.
--   Comics (public; description "Golden Age keys", genre "Superheroes")
--   └── Batman (public)
--       └── Joker Variants (public)
--   Pokémon Binder (public)
--   Vault (PRIVATE)
--   └── Hidden Batman (public flag) ← under a private ancestor
--   Grail Box (PRIVATE, showcased in O's Grails)
--   X: Batman (public) — another collector
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000007a1', 'csearch-o@example.invalid', '{"username":"csearch_test_o"}'),
  ('00000000-0000-4000-8000-0000000007a2', 'csearch-v@example.invalid', '{"username":"csearch_test_v"}'),
  ('00000000-0000-4000-8000-0000000007a3', 'csearch-x@example.invalid', '{"username":"csearch_test_x"}');

INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id, description, genre) VALUES
  ('00000000-0000-4000-8000-0000000007f1', '00000000-0000-4000-8000-0000000007a1', 'Comics', true, NULL, 'Golden Age keys', 'Superheroes'),
  ('00000000-0000-4000-8000-0000000007f2', '00000000-0000-4000-8000-0000000007a1', 'Batman', true, '00000000-0000-4000-8000-0000000007f1', NULL, NULL),
  ('00000000-0000-4000-8000-0000000007f3', '00000000-0000-4000-8000-0000000007a1', 'Joker Variants', true, '00000000-0000-4000-8000-0000000007f2', NULL, NULL),
  ('00000000-0000-4000-8000-0000000007f4', '00000000-0000-4000-8000-0000000007a1', 'Pokémon Binder', true, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-0000000007f5', '00000000-0000-4000-8000-0000000007a1', 'Vault', false, NULL, 'Batman grails', NULL),
  ('00000000-0000-4000-8000-0000000007f6', '00000000-0000-4000-8000-0000000007a1', 'Hidden Batman', true, '00000000-0000-4000-8000-0000000007f5', NULL, NULL),
  ('00000000-0000-4000-8000-0000000007f7', '00000000-0000-4000-8000-0000000007a1', 'Grail Box', false, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-0000000007f8', '00000000-0000-4000-8000-0000000007a3', 'Batman', true, NULL, NULL, NULL);

-- An item inside Comics whose metadata mentions Catwoman: collection search
-- must not match item metadata.
INSERT INTO public.collection_items (id, folder_id, user_id, item_type, title, is_public, collection_status) VALUES
  ('00000000-0000-4000-8000-0000000007c1', '00000000-0000-4000-8000-0000000007f1', '00000000-0000-4000-8000-0000000007a1', 'comic_book', 'Catwoman #1', true, 'active');

INSERT INTO public.profile_grail_slots (user_id, slot_index, entry_type, collection_id) VALUES
  ('00000000-0000-4000-8000-0000000007a1', 0, 'collection', '00000000-0000-4000-8000-0000000007f7');

-- Results as "name<path>" entries in RESULT order, e.g.
-- 'Batman<Comics>;Joker Variants<Comics/Batman>'.
CREATE FUNCTION pg_temp.hits(p_query text, p_include_private boolean DEFAULT false,
                             p_owner uuid DEFAULT '00000000-0000-4000-8000-0000000007a1')
RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(name || '<' || array_to_string(path, '/') || '>', ';'), '')
  FROM public.search_profile_collections(p_owner, p_query, p_include_private, 200, 0);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.hits(text, boolean, uuid) TO authenticated;

-- ── As a visitor ────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000007a2","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000007a2', true);

SELECT is(pg_temp.hits('batman'), 'Batman<Comics>',
  'visitor: the nested public collection, with its path — never one under a private ancestor, never another collector''s');
SELECT is(pg_temp.hits('joker'), 'Joker Variants<Comics/Batman>', 'visitor: a second-level nested collection with its full path');
SELECT is(pg_temp.hits('golden age'), 'Comics<>', 'visitor: description matches');
SELECT is(pg_temp.hits('superhero'), 'Comics<>', 'visitor: genre matches (word-start partial)');
SELECT is(pg_temp.hits('POKEMON'), 'Pokémon Binder<>', 'visitor: case and accents folded');
SELECT is(pg_temp.hits('atman'), '', 'visitor: no mid-word matches');
SELECT is(pg_temp.hits('vault'), '', 'visitor: a private collection is never found');
SELECT is(pg_temp.hits('grail'), '', 'visitor: a private Grail-showcased collection is not searchable (nor the private Vault''s description)');
SELECT is(pg_temp.hits('hidden'), '', 'visitor: a public collection under a private ancestor is never found');
SELECT is(pg_temp.hits('batman', true), 'Batman<Comics>', 'visitor passing include_private still gets the visitor view');
SELECT is(pg_temp.hits('catwoman'), '', 'collection search does not match item metadata');
SELECT is(pg_temp.hits(''), '', 'empty query returns nothing');
SELECT is(pg_temp.hits('batman', false, '00000000-0000-4000-8000-0000000007a3'), 'Batman<>', 'scope: another profile returns only its own collections');

-- ── As the owner ────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000007a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000007a1', true);

-- Path-then-name order (a parent sorts before its children): "comics/batman"
-- < "vault" < "vault/hidden batman". (Vault matches through its description
-- "Batman grails".)
SELECT is(pg_temp.hits('batman', true), 'Batman<Comics>;Vault<>;Hidden Batman<Vault>',
  'owner + include_private: private collections and everything under them, with paths, in path order');
SELECT is(pg_temp.hits('grail', true), 'Grail Box<>;Vault<>', 'owner + include_private: private Grail Box and Vault (description)');
SELECT is(pg_temp.hits('batman', false), 'Batman<Comics>', 'owner without include_private: the public view (Search Collections sheet behaviour)');

-- Pagination / no duplicates.
SELECT is((SELECT count(*)::int FROM public.search_profile_collections('00000000-0000-4000-8000-0000000007a1', 'batman', true, 2, 0)), 2, 'page 1 has 2');
SELECT is((SELECT count(*)::int FROM public.search_profile_collections('00000000-0000-4000-8000-0000000007a1', 'batman', true, 2, 2)), 1, 'page 2 has the last 1');
SELECT is(
  (SELECT array_agg(folder_id) FROM (
    SELECT folder_id FROM public.search_profile_collections('00000000-0000-4000-8000-0000000007a1', 'batman', true, 2, 0)
    UNION ALL SELECT folder_id FROM public.search_profile_collections('00000000-0000-4000-8000-0000000007a1', 'batman', true, 2, 2)
  ) pages),
  (SELECT array_agg(folder_id) FROM public.search_profile_collections('00000000-0000-4000-8000-0000000007a1', 'batman', true, 200, 0)),
  'pages concatenate to the full ordered result');
SELECT is(
  (SELECT (count(*) - count(DISTINCT folder_id))::int FROM public.search_profile_collections('00000000-0000-4000-8000-0000000007a1', 'b', true, 200, 0)), 0,
  'no duplicate results');

RESET ROLE;

SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.search_profile_collections('00000000-0000-4000-8000-0000000007a1', 'batman', false, 10, 0)$$,
  '42501', NULL, 'anon: calling collection search is denied');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
