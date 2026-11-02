-- pgTAP test for 20261031145000_add_shared_search_matching.sql — the
-- compatibility migration between the deployed 20261031140000 and the
-- pending 20261031150000 / 20261031160000. Checks the end state those two
-- rely on; search behaviour itself is covered by the collection/profile
-- search tests.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(14);

-- ── search_document_matches ─────────────────────────────────────────────
SELECT has_function('public', 'search_document_matches', ARRAY['text', 'text[]'], 'shared matcher exists');
SELECT is((SELECT provolatile FROM pg_proc WHERE oid = 'public.search_document_matches(text,text[])'::regprocedure), 'i',
  'shared matcher is IMMUTABLE');
SELECT ok(has_function_privilege('authenticated', 'public.search_document_matches(text,text[])', 'EXECUTE'), 'authenticated can execute the matcher');
SELECT ok(NOT has_function_privilege('anon', 'public.search_document_matches(text,text[])', 'EXECUTE'), 'anon cannot execute the matcher');

-- ── The recreated view ──────────────────────────────────────────────────
-- The deployed columns first, in their deployed order, then the two added.
SELECT is(
  (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
   WHERE attrelid = 'public.collection_item_search_documents'::regclass AND attnum > 0 AND NOT attisdropped),
  ARRAY['item_id', 'user_id', 'folder_id', 'collection_status', 'sort_order', 'document', 'is_public', 'sort_name'],
  'view keeps its deployed columns and appends is_public, sort_name');
SELECT is((SELECT reloptions FROM pg_class WHERE oid = 'public.collection_item_search_documents'::regclass), ARRAY['security_invoker=true'],
  'recreated view is still security_invoker (RLS applies)');
SELECT ok(has_table_privilege('authenticated', 'public.collection_item_search_documents', 'SELECT'), 'authenticated can read the recreated view');
SELECT ok(NOT has_table_privilege('anon', 'public.collection_item_search_documents', 'SELECT'), 'anon cannot read the recreated view');
SELECT ok(NOT has_table_privilege('authenticated', 'public.collection_item_search_documents', 'INSERT'), 'the recreated view is read-only');

-- ── Collection Search on the shared rule ────────────────────────────────
SELECT ok((SELECT prosrc FROM pg_proc WHERE oid = 'public.search_collection_items(uuid,text,integer,integer)'::regprocedure)
  LIKE '%search_document_matches%', 'search_collection_items uses the shared matcher');
SELECT ok(has_function_privilege('authenticated', 'public.search_collection_items(uuid,text,integer,integer)', 'EXECUTE'),
  'authenticated can still run Collection Search');
SELECT ok(NOT has_function_privilege('anon', 'public.search_collection_items(uuid,text,integer,integer)', 'EXECUTE'),
  'anon still cannot run Collection Search');

-- ── The pending migrations' functions exist on top of it ─────────────────
SELECT has_function('public', 'search_profile_items', ARRAY['uuid', 'text', 'integer', 'integer'], '150000 applied on top');
SELECT has_function('public', 'search_profile_collections', ARRAY['uuid', 'text', 'boolean', 'integer', 'integer'], '160000 applied on top');

SELECT * FROM finish();
ROLLBACK;
