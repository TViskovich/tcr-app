-- Profile ordering backfill regression — step 1 of 3 (see run.sh).
-- Runs against the LOCAL database reset to the version just BEFORE
-- 20261026120000_add_profile_ordering.sql: folders has no sort_order and
-- collection_items no profile_sort_order yet. Seeds data whose display
-- order is known, and snapshots that order as the app showed it before
-- the migration (newest first: created_at DESC, NULLs first — PostgREST's
-- DESC default; ties broken by id, since before they were arbitrary).

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS ordering_check;
DROP TABLE IF EXISTS ordering_check.expected;
CREATE TABLE ordering_check.expected (kind text, grp text, ids uuid[]);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-00000000bf01', 'backfill-1@example.invalid', '{"username":"backfill_u1"}'),
  ('00000000-0000-4000-8000-00000000bf02', 'backfill-2@example.invalid', '{"username":"backfill_u2"}');

-- User 1: four top-level collections (two with the same created_at, one
-- with none), two nested under the first, one nested under the second.
INSERT INTO public.folders (id, user_id, name, parent_folder_id, created_at) VALUES
  ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000bf01', 'oldest', NULL, '2026-01-01T00:00:00Z'),
  ('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000bf01', 'tie-b', NULL, '2026-03-01T00:00:00Z'),
  ('00000000-0000-4000-8000-00000000f003', '00000000-0000-4000-8000-00000000bf01', 'tie-a', NULL, '2026-03-01T00:00:00Z'),
  ('00000000-0000-4000-8000-00000000f004', '00000000-0000-4000-8000-00000000bf01', 'no-date', NULL, NULL),
  ('00000000-0000-4000-8000-00000000f011', '00000000-0000-4000-8000-00000000bf01', 'child-old', '00000000-0000-4000-8000-00000000f001', '2026-02-01T00:00:00Z'),
  ('00000000-0000-4000-8000-00000000f012', '00000000-0000-4000-8000-00000000bf01', 'child-new', '00000000-0000-4000-8000-00000000f001', '2026-04-01T00:00:00Z'),
  ('00000000-0000-4000-8000-00000000f021', '00000000-0000-4000-8000-00000000bf01', 'only-child', '00000000-0000-4000-8000-00000000f002', '2026-05-01T00:00:00Z'),
  -- User 2's own top level — must not mix with user 1's.
  ('00000000-0000-4000-8000-00000000f201', '00000000-0000-4000-8000-00000000bf02', 'u2-a', NULL, '2026-06-01T00:00:00Z'),
  ('00000000-0000-4000-8000-00000000f202', '00000000-0000-4000-8000-00000000bf02', 'u2-b', NULL, '2026-07-01T00:00:00Z');

-- User 1: 1,500 items — more than one API page — spread over three
-- collections, with deliberate created_at ties (every 7th shares a
-- timestamp with its neighbour) and one transferred-out item.
INSERT INTO public.collection_items (id, folder_id, user_id, title, created_at, collection_status)
SELECT
  ('00000000-0000-4000-8001-' || lpad(to_hex(n), 12, '0'))::uuid,
  (ARRAY['00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f011', '00000000-0000-4000-8000-00000000f021'])[1 + n % 3]::uuid,
  '00000000-0000-4000-8000-00000000bf01',
  'item ' || n,
  timestamptz '2026-01-01T00:00:00Z' + make_interval(mins => n - (CASE WHEN n % 7 = 0 THEN 1 ELSE 0 END)),
  CASE WHEN n = 777 THEN 'transferred_out' ELSE 'active' END
FROM generate_series(1, 1500) AS n;

-- User 2: a few items of their own.
INSERT INTO public.collection_items (id, folder_id, user_id, title, created_at)
SELECT
  ('00000000-0000-4000-8002-' || lpad(to_hex(n), 12, '0'))::uuid,
  '00000000-0000-4000-8000-00000000f201',
  '00000000-0000-4000-8000-00000000bf02',
  'u2 item ' || n,
  timestamptz '2026-02-01T00:00:00Z' + make_interval(hours => n)
FROM generate_series(1, 5) AS n;

-- Snapshot: each sibling group of collections, newest first.
INSERT INTO ordering_check.expected (kind, grp, ids)
SELECT 'folders', user_id::text || ':' || coalesce(parent_folder_id::text, 'top'),
       array_agg(id ORDER BY created_at DESC NULLS FIRST, id)
FROM public.folders
WHERE user_id IN ('00000000-0000-4000-8000-00000000bf01', '00000000-0000-4000-8000-00000000bf02')
GROUP BY user_id, parent_folder_id;

-- Snapshot: each owner's active items (the Items tab), newest first.
INSERT INTO ordering_check.expected (kind, grp, ids)
SELECT 'profile_items', user_id::text,
       array_agg(id ORDER BY created_at DESC NULLS FIRST, id)
FROM public.collection_items
WHERE user_id IN ('00000000-0000-4000-8000-00000000bf01', '00000000-0000-4000-8000-00000000bf02')
  AND collection_status = 'active'
GROUP BY user_id;

-- Snapshot: each collection's own item order — must not change at all.
INSERT INTO ordering_check.expected (kind, grp, ids)
SELECT 'collection_items', folder_id::text, array_agg(id ORDER BY sort_order, id)
FROM public.collection_items
WHERE user_id IN ('00000000-0000-4000-8000-00000000bf01', '00000000-0000-4000-8000-00000000bf02')
GROUP BY folder_id;

SELECT kind, count(*) AS groups, sum(array_length(ids, 1)) AS rows FROM ordering_check.expected GROUP BY kind ORDER BY kind;
