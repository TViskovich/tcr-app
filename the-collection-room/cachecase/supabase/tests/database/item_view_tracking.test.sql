-- pgTAP test for 20261101120000_add_item_view_tracking.sql.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back. (True
-- multi-session concurrency can't be exercised inside one transaction;
-- here duplicate calls run back to back, and the unique-key mechanism that
-- serializes real concurrent calls is asserted structurally.)

BEGIN;
SELECT plan(53);

-- ── Shape and permissions ───────────────────────────────────────────────
SELECT has_function('public', 'record_item_view', ARRAY['uuid'], 'record_item_view(uuid) exists');
SELECT is(pg_get_function_arguments('public.record_item_view(uuid)'::regprocedure), 'p_item_id uuid',
  'the only argument is the item — the viewer can never be passed in');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.record_item_view(uuid)'::regprocedure), true,
  'record_item_view is SECURITY DEFINER (it writes tables no client can)');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.record_item_view(uuid)'::regprocedure), ARRAY['search_path=""'],
  'record_item_view pins search_path');
SELECT ok(has_function_privilege('authenticated', 'public.record_item_view(uuid)', 'EXECUTE'), 'authenticated can record views');
SELECT ok(NOT has_function_privilege('anon', 'public.record_item_view(uuid)', 'EXECUTE'), 'anon cannot record views');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.profile_item_view_counts(uuid,integer,integer)'::regprocedure), false,
  'profile_item_view_counts is SECURITY INVOKER (RLS applies)');
SELECT ok(NOT has_function_privilege('anon', 'public.profile_item_view_counts(uuid,integer,integer)', 'EXECUTE'), 'anon cannot read totals');
SELECT ok(has_table_privilege('authenticated', 'public.collection_item_view_counts', 'SELECT'), 'authenticated can read (visible) totals');
SELECT ok(NOT has_table_privilege('authenticated', 'public.collection_item_view_counts', 'INSERT'), 'authenticated cannot insert totals');
SELECT ok(NOT has_table_privilege('authenticated', 'public.collection_item_view_counts', 'UPDATE'), 'authenticated cannot update totals');
SELECT ok(NOT has_table_privilege('authenticated', 'public.collection_item_view_counts', 'DELETE'), 'authenticated cannot delete totals');
SELECT ok(NOT has_table_privilege('anon', 'public.collection_item_view_counts', 'SELECT'), 'anon cannot read totals');
SELECT ok(NOT has_table_privilege('authenticated', 'public.collection_item_view_dedupe', 'SELECT'), 'no client can read the dedupe table');
SELECT ok(NOT has_table_privilege('authenticated', 'public.collection_item_view_dedupe', 'INSERT'), 'no client can write the dedupe table');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.collection_item_view_dedupe'::regclass), 'dedupe table has RLS on');
SELECT col_is_pk('public', 'collection_item_view_dedupe', ARRAY['item_id', 'viewer_id'],
  'one dedupe row per (item, viewer) — the key concurrent calls serialize on');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- Owner O; viewers V1, V2.
--   pub (public):  a1 public item, a2 PRIVATE item, a5 transferred_out,
--                  b1/b2/b3 public items (sorting)
--   priv (PRIVATE): a3 public item, a4 PRIVATE item showcased in O's Grails
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000008a1', 'views-o@example.invalid', '{"username":"views_test_o"}'),
  ('00000000-0000-4000-8000-0000000008a2', 'views-v1@example.invalid', '{"username":"views_test_v1"}'),
  ('00000000-0000-4000-8000-0000000008a3', 'views-v2@example.invalid', '{"username":"views_test_v2"}');

INSERT INTO public.folders (id, user_id, name, is_public) VALUES
  ('00000000-0000-4000-8000-0000000008f0', '00000000-0000-4000-8000-0000000008a1', 'pub', true),
  ('00000000-0000-4000-8000-0000000008f1', '00000000-0000-4000-8000-0000000008a1', 'priv', false);

INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status) VALUES
  ('00000000-0000-4000-8000-0000000008c1', '00000000-0000-4000-8000-0000000008f0', '00000000-0000-4000-8000-0000000008a1', 'a1', true, 'active'),
  ('00000000-0000-4000-8000-0000000008c2', '00000000-0000-4000-8000-0000000008f0', '00000000-0000-4000-8000-0000000008a1', 'a2', false, 'active'),
  ('00000000-0000-4000-8000-0000000008c3', '00000000-0000-4000-8000-0000000008f1', '00000000-0000-4000-8000-0000000008a1', 'a3', true, 'active'),
  ('00000000-0000-4000-8000-0000000008c4', '00000000-0000-4000-8000-0000000008f1', '00000000-0000-4000-8000-0000000008a1', 'a4', false, 'active'),
  ('00000000-0000-4000-8000-0000000008c5', '00000000-0000-4000-8000-0000000008f0', '00000000-0000-4000-8000-0000000008a1', 'a5', true, 'transferred_out'),
  ('00000000-0000-4000-8000-0000000008d1', '00000000-0000-4000-8000-0000000008f0', '00000000-0000-4000-8000-0000000008a1', 'b1', true, 'active'),
  ('00000000-0000-4000-8000-0000000008d2', '00000000-0000-4000-8000-0000000008f0', '00000000-0000-4000-8000-0000000008a1', 'b2', true, 'active'),
  ('00000000-0000-4000-8000-0000000008d3', '00000000-0000-4000-8000-0000000008f0', '00000000-0000-4000-8000-0000000008a1', 'b3', true, 'active');

INSERT INTO public.profile_grail_slots (user_id, slot_index, entry_type, item_id) VALUES
  ('00000000-0000-4000-8000-0000000008a1', 0, 'item', '00000000-0000-4000-8000-0000000008c4');

-- Totals for sorting, set directly (as the migration role): b1 = b2 = 5
-- (a tie), b3 = 9; a2 (private) = 7.
INSERT INTO public.collection_item_view_counts (item_id, view_count) VALUES
  ('00000000-0000-4000-8000-0000000008d1', 5),
  ('00000000-0000-4000-8000-0000000008d2', 5),
  ('00000000-0000-4000-8000-0000000008d3', 9),
  ('00000000-0000-4000-8000-0000000008c2', 7);

-- Stale dedupe rows elsewhere, for the retention check.
INSERT INTO public.collection_item_view_dedupe (item_id, viewer_id, last_counted_at) VALUES
  ('00000000-0000-4000-8000-0000000008d1', '00000000-0000-4000-8000-0000000008a3', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-0000000008d2', '00000000-0000-4000-8000-0000000008a3', now() - interval '45 minutes');

CREATE FUNCTION pg_temp.views(p_item uuid) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COALESCE((SELECT view_count FROM public.collection_item_view_counts WHERE item_id = p_item), 0);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.views(uuid) TO authenticated;

-- ── As viewer V1 ────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000008a2","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000008a2', true);

SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c1'), true, 'V1: first view of a public item counts');
SELECT is(pg_temp.views('00000000-0000-4000-8000-0000000008c1'), 1::bigint, 'total is 1');
SELECT throws_ok($$SELECT * FROM public.collection_item_view_dedupe$$, '42501', NULL, 'V1 cannot read the dedupe table');
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c1'), false, 'V1: an immediate repeat is not counted');
SELECT is(pg_temp.views('00000000-0000-4000-8000-0000000008c1'), 1::bigint, 'total still 1');
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c3'), false, 'V1: a public item in a PRIVATE folder is not counted');
SELECT is(pg_temp.views('00000000-0000-4000-8000-0000000008c3'), 0::bigint, 'no total for the inaccessible item');
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c2'), false, 'V1: a private item is not counted');
SELECT is(pg_temp.views('00000000-0000-4000-8000-0000000008c2'), 7::bigint, 'private item''s total unchanged');
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c4'), true,
  'V1: a private item showcased in Grails IS counted (Grails visibility exception respected)');
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c5'), false, 'V1: a transferred-out item is not counted');
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008ff'), false, 'V1: a nonexistent item is not counted (same answer as inaccessible)');
SELECT is(public.record_item_view(NULL), false, 'V1: NULL is not counted');

-- Duplicate calls in one statement: exactly one counts.
SELECT is(
  (SELECT array_agg(v ORDER BY v) FROM (
     SELECT public.record_item_view('00000000-0000-4000-8000-0000000008d3') AS v
     UNION ALL SELECT public.record_item_view('00000000-0000-4000-8000-0000000008d3')
     UNION ALL SELECT public.record_item_view('00000000-0000-4000-8000-0000000008d3')
   ) s),
  ARRAY[false, false, true], 'three back-to-back calls: exactly one counts');
SELECT is(pg_temp.views('00000000-0000-4000-8000-0000000008d3'), 10::bigint, 'b3 went from 9 to 10, not 12');

-- Totals readable only for visible items.
SELECT is((SELECT count(*)::int FROM public.collection_item_view_counts WHERE item_id = '00000000-0000-4000-8000-0000000008c1'), 1,
  'V1 can read the total of an item they can see');
SELECT is((SELECT count(*)::int FROM public.collection_item_view_counts WHERE item_id = '00000000-0000-4000-8000-0000000008c2'), 0,
  'V1 cannot read the total of a private item');
SELECT throws_ok($$UPDATE public.collection_item_view_counts SET view_count = 1000000$$, '42501', NULL,
  'V1 cannot edit totals directly');
SELECT throws_ok($$INSERT INTO public.collection_item_view_dedupe VALUES ('00000000-0000-4000-8000-0000000008c1', '00000000-0000-4000-8000-0000000008a3', now() - interval '1 day')$$,
  '42501', NULL, 'V1 cannot forge another viewer''s dedupe row');

-- Sorting totals as a visitor: the Items tab's set only (no private a2, no
-- Grail-only a4), highest first, ties by id, zero-view items absent.
SELECT is(
  (SELECT string_agg(right(item_id::text, 2) || '=' || view_count, ',') FROM public.profile_item_view_counts('00000000-0000-4000-8000-0000000008a1', 1000, 0)),
  'd3=10,d1=5,d2=5,c1=1', 'visitor totals: Items-tab set, highest first, ties by id');
SELECT is(
  (SELECT string_agg(right(item_id::text, 2), ',') FROM public.profile_item_view_counts('00000000-0000-4000-8000-0000000008a1', 2, 1)),
  'd1,d2', 'totals paginate in the same order');

-- ── 30-minute window expiry ─────────────────────────────────────────────
RESET ROLE;
UPDATE public.collection_item_view_dedupe SET last_counted_at = now() - interval '31 minutes'
WHERE item_id = '00000000-0000-4000-8000-0000000008c1' AND viewer_id = '00000000-0000-4000-8000-0000000008a2';
SET LOCAL ROLE authenticated;
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c1'), true, 'V1: counts again once the last counted view is 31 minutes old');
SELECT is(pg_temp.views('00000000-0000-4000-8000-0000000008c1'), 2::bigint, 'total is 2');
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c1'), false, 'V1: and the window restarts from that view');

RESET ROLE;
UPDATE public.collection_item_view_dedupe SET last_counted_at = now() - interval '29 minutes'
WHERE item_id = '00000000-0000-4000-8000-0000000008c1' AND viewer_id = '00000000-0000-4000-8000-0000000008a2';
SET LOCAL ROLE authenticated;
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c1'), false, 'V1: 29 minutes after the last counted view is still deduplicated');

-- ── A different viewer ──────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000008a3","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000008a3', true);
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c1'), true, 'V2: a different viewer''s first view counts');
SELECT is(pg_temp.views('00000000-0000-4000-8000-0000000008c1'), 3::bigint, 'total is 3');
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c1'), false, 'V2: their repeat does not');

-- ── The owner ───────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000008a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000008a1', true);
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c1'), false, 'owner: viewing their own item never counts');
SELECT is(public.record_item_view('00000000-0000-4000-8000-0000000008c2'), false, 'owner: not even their own private item');
SELECT is(pg_temp.views('00000000-0000-4000-8000-0000000008c1'), 3::bigint, 'total unchanged by the owner');
SELECT is((SELECT count(*)::int FROM public.collection_item_view_counts WHERE item_id = '00000000-0000-4000-8000-0000000008c2'), 1,
  'owner can read their private item''s total');
SELECT is(
  (SELECT string_agg(right(item_id::text, 2) || '=' || view_count, ',') FROM public.profile_item_view_counts('00000000-0000-4000-8000-0000000008a1', 1000, 0)),
  'd3=10,c2=7,d1=5,d2=5,c1=3,c4=1', 'owner totals include their private and Grail-only items');

RESET ROLE;

-- ── Retention ───────────────────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM public.collection_item_view_dedupe WHERE last_counted_at < now() - interval '30 minutes'), 0,
  'stale dedupe rows (past the window) were swept by record_item_view');
SELECT is((SELECT count(*)::int FROM public.collection_item_view_dedupe), 4,
  'only live (item, viewer) rows remain — no per-view event log');

-- ── anon ────────────────────────────────────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.record_item_view('00000000-0000-4000-8000-0000000008c1')$$, '42501', NULL, 'anon: recording a view is denied');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
