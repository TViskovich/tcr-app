-- pgTAP test for 20261105120000_add_account_exports.sql (Download My Data).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(31);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated;

-- ── Shape and privileges ────────────────────────────────────────────────
SELECT has_table('public', 'account_exports', 'account_exports exists');
SELECT has_table('public', 'account_export_entries', 'account_export_entries exists');
SELECT is((SELECT count(*)::int FROM pg_class WHERE oid IN ('public.account_exports'::regclass, 'public.account_export_entries'::regclass) AND relrowsecurity), 2,
  'RLS is on for both');
SELECT is((SELECT count(*)::int FROM (VALUES ('anon'), ('authenticated')) r(role), (VALUES ('public.account_exports'), ('public.account_export_entries')) t(tbl),
             (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
           WHERE has_table_privilege(r.role, t.tbl, p.priv)), 0,
  'clients have no privilege at all on export jobs or plans');
SELECT ok(has_table_privilege('service_role', 'public.account_exports', 'SELECT,INSERT,UPDATE,DELETE'), 'the service role manages export jobs');
SELECT ok((SELECT NOT public FROM storage.buckets WHERE id = 'account-exports'), 'the account-exports bucket is private');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
             AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%account-exports%'), 0,
  'no Storage policy grants anyone access to the account-exports bucket');
CREATE TEMP TABLE ex_fns AS SELECT unnest(ARRAY['public.export_owned_storage_objects(uuid,text,text,integer)',
  'public.account_export_unreleased_records(uuid)']::regprocedure[]) AS fn;
SELECT is((SELECT count(*)::int FROM ex_fns WHERE has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')), 0,
  'the export helpers are not callable by clients');
SELECT is((SELECT count(*)::int FROM ex_fns t JOIN pg_proc p ON p.oid = t.fn WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""']), 2,
  'the export helpers are SECURITY DEFINER with a pinned search_path');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polname = 'account_lifecycle_read_guard' AND NOT polpermissive
             AND polrelid IN ('public.account_exports'::regclass, 'public.account_export_entries'::regclass)), 2,
  'both tables carry the account-lifecycle read guard');

-- ── Fixtures ────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000e1c00001', 'ex-a@example.invalid', '{"username":"ex_a"}'),
  ('00000000-0000-4000-8000-0000e1c00002', 'ex-b@example.invalid', '{"username":"ex_b"}');
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('item-images', '00000000-0000-4000-8000-0000e1c00001/item/photo.jpg', '{"size": 1000}'),
  ('item-images', '00000000-0000-4000-8000-0000e1c00001/cover.jpg', '{"size": 2000}'),
  ('avatars', '00000000-0000-4000-8000-0000e1c00001/avatar.jpg', '{"size": 300}'),
  ('share-snapshots', '00000000-0000-4000-8000-0000e1c00001/post/1.jpg', '{"size": 400}'),
  -- not A's export material:
  ('registry-images', '00000000-0000-4000-8000-0000e1c00001/original', '{"size": 500}'),
  ('item-images', '00000000-0000-4000-8000-0000e1c00002/item/photo.jpg', '{"size": 600}'),
  ('item-images', '00000000-0000-4000-8000-0000e1c00001x/lookalike.jpg', '{"size": 700}'),
  ('item-images', 'shared/00000000-0000-4000-8000-0000e1c00001/elsewhere.jpg', '{"size": 800}');
INSERT INTO public.folders (id, user_id, name) VALUES
  ('00000000-0000-4000-8000-0000e1cf0001', '00000000-0000-4000-8000-0000e1c00001', 'ex binder');
INSERT INTO public.collection_items (id, folder_id, user_id, title, item_type, collection_status) VALUES
  ('00000000-0000-4000-8000-0000e1ce0001', '00000000-0000-4000-8000-0000e1cf0001', '00000000-0000-4000-8000-0000e1c00001', 'ex card', 'sports_card', 'active');
INSERT INTO public.registered_cards (id, current_owner_id, created_by, visibility, collection_item_id) VALUES
  ('00000000-0000-4000-8000-0000e1cc0001', '00000000-0000-4000-8000-0000e1c00001', '00000000-0000-4000-8000-0000e1c00001', 'private',
   '00000000-0000-4000-8000-0000e1ce0001');

-- ── Owned objects: only the collector's own folders ─────────────────────
CREATE TEMP TABLE ex_owned AS
  SELECT * FROM public.export_owned_storage_objects('00000000-0000-4000-8000-0000e1c00001');
SELECT is((SELECT count(*)::int FROM ex_owned), 4, 'A has exactly four exportable files');
SELECT is((SELECT array_agg(bucket_id || ':' || name ORDER BY bucket_id, name) FROM ex_owned),
  ARRAY['avatars:00000000-0000-4000-8000-0000e1c00001/avatar.jpg',
        'item-images:00000000-0000-4000-8000-0000e1c00001/cover.jpg',
        'item-images:00000000-0000-4000-8000-0000e1c00001/item/photo.jpg',
        'share-snapshots:00000000-0000-4000-8000-0000e1c00001/post/1.jpg'],
  'item photos, collection covers, avatars and own post photos, in a stable order');
SELECT is((SELECT sum(size)::int FROM ex_owned), 3700, 'sizes come from the stored metadata');
SELECT ok(NOT EXISTS (SELECT 1 FROM ex_owned WHERE name LIKE '00000000-0000-4000-8000-0000e1c00002/%'), 'B’s files are never listed for A');
SELECT ok(NOT EXISTS (SELECT 1 FROM ex_owned WHERE name LIKE '%lookalike%' OR name LIKE 'shared/%'),
  'a look-alike folder name or A’s id deeper in a path does not count');
SELECT ok(NOT EXISTS (SELECT 1 FROM ex_owned WHERE bucket_id = 'registry-images'), 'unreleased registry images are not listed');
SELECT is((SELECT count(*)::int FROM public.export_owned_storage_objects('00000000-0000-4000-8000-0000e1c00001', '', '', 2)), 2,
  'pagination: a page holds at most the limit');
SELECT is((SELECT array_agg(name ORDER BY bucket_id, name) FROM public.export_owned_storage_objects(
             '00000000-0000-4000-8000-0000e1c00001', 'item-images', '00000000-0000-4000-8000-0000e1c00001/cover.jpg', 1000)),
  ARRAY['00000000-0000-4000-8000-0000e1c00001/item/photo.jpg', '00000000-0000-4000-8000-0000e1c00001/post/1.jpg'],
  'pagination: the next page starts strictly after the cursor');
SELECT is((SELECT count(*)::int FROM public.export_owned_storage_objects('00000000-0000-4000-8000-0000e1c00001', '', '', 100000)), 4,
  'an oversized limit is capped (1,000), not trusted');

-- ── Unreleased-feature audit ────────────────────────────────────────────
SELECT is(public.account_export_unreleased_records('00000000-0000-4000-8000-0000e1c00001') ->> 'registered_cards_owned', '1',
  'unreleased registry cards are counted for the job record');
SELECT is(public.account_export_unreleased_records('00000000-0000-4000-8000-0000e1c00002') ->> 'registered_cards_owned', '0',
  'and only the collector’s own');

-- ── Jobs ────────────────────────────────────────────────────────────────
INSERT INTO public.account_exports (id, user_id) VALUES ('00000000-0000-4000-8000-0000e1ca0001', '00000000-0000-4000-8000-0000e1c00001');
SELECT throws_ok($$ INSERT INTO public.account_exports (user_id) VALUES ('00000000-0000-4000-8000-0000e1c00001') $$, '23505', NULL,
  'only one export can be in progress per collector');
SELECT lives_ok($$ INSERT INTO public.account_exports (user_id) VALUES ('00000000-0000-4000-8000-0000e1c00002') $$,
  'another collector can export at the same time');
SELECT throws_ok($$ UPDATE public.account_exports SET status = 'ready' WHERE id = '00000000-0000-4000-8000-0000e1ca0001' $$, '23514', NULL,
  'a job can only be ready with an archive and an expiry');
UPDATE public.account_exports SET status = 'ready', object_path = 'x/y.zip', expires_at = now() + interval '7 days'
  WHERE id = '00000000-0000-4000-8000-0000e1ca0001';
SELECT lives_ok($$ INSERT INTO public.account_exports (user_id) VALUES ('00000000-0000-4000-8000-0000e1c00001') $$,
  'a new export can start once the previous one is ready');
SELECT throws_ok($$ INSERT INTO public.account_exports (user_id, status) VALUES ('00000000-0000-4000-8000-0000e1c00001', 'paused') $$, '23514', NULL,
  'unknown states are rejected');
INSERT INTO public.account_export_entries (export_id, seq, archive_name, source_bucket, source_path, size, local_offset)
VALUES ('00000000-0000-4000-8000-0000e1ca0001', 0, 'README.txt', 'account-exports', 'x', 10, 0);
SELECT throws_ok($$ INSERT INTO public.account_export_entries (export_id, seq, archive_name, source_bucket, source_path, size, local_offset)
                    VALUES ('00000000-0000-4000-8000-0000e1ca0001', 1, 'bad', 'b', 'p', -1, 0) $$, '23514', NULL,
  'plan sizes cannot be negative');

SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000e1c00001');
SELECT throws_ok($$ SELECT count(*) FROM public.account_exports $$, '42501', NULL, 'A cannot read export jobs directly, not even their own');
SELECT throws_ok($$ SELECT * FROM public.export_owned_storage_objects('00000000-0000-4000-8000-0000e1c00002') $$, '42501', NULL,
  'A cannot list B’s files through the helper');
RESET ROLE;

-- ── Final account deletion removes jobs and plans ───────────────────────
DELETE FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000e1cc0001';
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000e1c00001';
SELECT is((SELECT count(*)::int FROM public.account_exports WHERE user_id = '00000000-0000-4000-8000-0000e1c00001'), 0,
  'deleting the account removes its export jobs');
SELECT is((SELECT count(*)::int FROM public.account_export_entries WHERE export_id = '00000000-0000-4000-8000-0000e1ca0001'), 0,
  'and their plans');

SELECT * FROM finish();
ROLLBACK;
