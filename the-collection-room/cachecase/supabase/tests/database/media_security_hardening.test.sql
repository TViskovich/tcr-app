-- pgTAP test for 20261121120000_media_security_hardening.sql (Phase 2B M2.3d).
-- Run against a LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(51);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
CREATE FUNCTION pg_temp.u(p_bucket text, p_path text) RETURNS text LANGUAGE sql AS $$
  SELECT 'http://127.0.0.1:54321/storage/v1/object/public/' || p_bucket || '/' || p_path $$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid), pg_temp.u(text, text) TO authenticated, service_role;
-- Storage writes as the CURRENT role, reporting the error code (or 'ok').
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.try(text) TO authenticated, service_role;
SET LOCAL storage.allow_delete_query = 'true';

-- ── 1. Shape and privileges ─────────────────────────────────────────────
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'storage.objects'::regclass AND tgname = 'moderation_held_write_guard' AND tgenabled = 'O'),
  'a row trigger guards every Storage write');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.backfill_snapshot_check(text,uuid,text,text)', 'public.share_snapshot_reconcile_candidates(integer,integer)',
             'public.share_snapshot_reconcile_claim(uuid,integer)', 'public.share_snapshot_unledgered_orphans(integer)']::regprocedure[]) f
           WHERE has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
              OR NOT has_function_privilege('service_role', f, 'EXECUTE')), 0, 'backfill and reconciliation helpers: service role only');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'private'
             AND p.proname IN ('storage_held_write_guard', 'share_snapshot_path_referenced', 'share_snapshot_reconcile_reason', 'folder_cover_item_guard')
             AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('service_role', p.oid, 'EXECUTE'))), 0, 'internal helpers: no API role');
SELECT ok((SELECT bool_and(prosecdef AND proconfig = ARRAY['search_path=""']) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE (n.nspname = 'public' AND p.proname IN ('backfill_snapshot_check', 'share_snapshot_reconcile_candidates', 'share_snapshot_reconcile_claim',
                                                          'share_snapshot_unledgered_orphans'))
              OR (n.nspname = 'private' AND p.proname IN ('storage_held_write_guard', 'folder_cover_item_guard'))),
  'elevated functions pin an empty search_path');
SELECT is((SELECT count(*)::int FROM public.folders f JOIN public.collection_items ci ON ci.id = f.cover_item_id WHERE ci.user_id <> f.user_id), 0,
  'existing data: no folder uses another collector''s item as its cover');

-- ── Fixtures ────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000c0000001', 'msh-a@example.invalid', '{"username":"msh_a"}'),
  ('00000000-0000-4000-8000-0000c0000002', 'msh-b@example.invalid', '{"username":"msh_b"}'),
  ('00000000-0000-4000-8000-0000c0000003', 'msh-r@example.invalid', '{"username":"msh_r"}'),
  ('00000000-0000-4000-8000-0000c0000004', 'msh-m@example.invalid', '{"username":"msh_m"}');
INSERT INTO public.folders (id, user_id, name, is_public) VALUES
  ('00000000-0000-4000-8000-0000c0f00001', '00000000-0000-4000-8000-0000c0000001', 'msh a', true),
  ('00000000-0000-4000-8000-0000c0f00002', '00000000-0000-4000-8000-0000c0000002', 'msh b', true);
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status, item_type) VALUES
  ('00000000-0000-4000-8000-0000c0e00001', '00000000-0000-4000-8000-0000c0f00001', '00000000-0000-4000-8000-0000c0000001', 'msh a1', true, 'active', 'sports_card'),
  ('00000000-0000-4000-8000-0000c0e00002', '00000000-0000-4000-8000-0000c0f00002', '00000000-0000-4000-8000-0000c0000002', 'msh b private', false, 'active', 'sports_card'),
  ('00000000-0000-4000-8000-0000c0e00003', '00000000-0000-4000-8000-0000c0f00002', '00000000-0000-4000-8000-0000c0000002', 'msh b public', true, 'active', 'sports_card');
INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT b, n, '{"size": 10, "mimetype": "image/jpeg"}'::jsonb FROM (VALUES
  ('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg'),
  ('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/unref.jpg'),
  ('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/ref.jpg'),
  ('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/orphan-old.jpg'),
  ('item-images', '00000000-0000-4000-8000-0000c0000001/legacy.jpg'),
  ('item-images', '00000000-0000-4000-8000-0000c0000001/legacy2.jpg'),
  ('item-images', '00000000-0000-4000-8000-0000c0000001/stage-old.jpg')) v(b, n);
UPDATE storage.objects SET created_at = now() - interval '30 days' WHERE name = '00000000-0000-4000-8000-0000c0000001/post/p/orphan-old.jpg';
-- P1: a post whose share snapshot gets held; P2/P3: legacy posts still on item-images URLs.
INSERT INTO public.posts (id, user_id, post_type, content, image_url) VALUES
  ('00000000-0000-4000-8000-0000c0d00001', '00000000-0000-4000-8000-0000c0000001', 'text', 'msh p1', pg_temp.u('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg')),
  ('00000000-0000-4000-8000-0000c0d00002', '00000000-0000-4000-8000-0000c0000001', 'text', 'msh p2', pg_temp.u('item-images', '00000000-0000-4000-8000-0000c0000001/legacy.jpg')),
  ('00000000-0000-4000-8000-0000c0d00003', '00000000-0000-4000-8000-0000c0000001', 'text', 'msh p3', pg_temp.u('item-images', '00000000-0000-4000-8000-0000c0000001/legacy2.jpg')),
  ('00000000-0000-4000-8000-0000c0d00004', '00000000-0000-4000-8000-0000c0000001', 'text', 'msh p4', pg_temp.u('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/ref.jpg'));
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence) VALUES
  ('00000000-0000-4000-8000-0000c0100001', '00000000-0000-4000-8000-0000c0000003', 'post', '00000000-0000-4000-8000-0000c0d00001', '00000000-0000-4000-8000-0000c0000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000c0100002', '00000000-0000-4000-8000-0000c0000003', 'post', '00000000-0000-4000-8000-0000c0d00003', '00000000-0000-4000-8000-0000c0000001', 'hate', '{"v":1}');
INSERT INTO public.moderated_content (target_type, target_id, owner_id, state, reason_code, report_id, created_by) VALUES
  ('post', '00000000-0000-4000-8000-0000c0d00001', '00000000-0000-4000-8000-0000c0000001', 'hidden', 'hate', '00000000-0000-4000-8000-0000c0100001', '00000000-0000-4000-8000-0000c0000004'),
  ('post', '00000000-0000-4000-8000-0000c0d00003', '00000000-0000-4000-8000-0000c0000001', 'hidden', 'hate', '00000000-0000-4000-8000-0000c0100002', '00000000-0000-4000-8000-0000c0000004');
CREATE TEMP TABLE held AS SELECT id FROM private.media_quarantine WHERE source_path = '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg';
GRANT SELECT ON held TO service_role;

-- ── 2. Storage write guard: no role may touch a held path ───────────────
SELECT is((SELECT state FROM private.media_quarantine WHERE id = (SELECT id FROM held)), 'pending', 'fixture: P1''s snapshot is held (pending)');
SET LOCAL ROLE service_role;
SELECT is(pg_temp.try($$ DELETE FROM storage.objects WHERE bucket_id = 'share-snapshots' AND name = '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg' $$),
  'media_held', 'service role: deleting a held object is refused');
SELECT is(pg_temp.try($$ UPDATE storage.objects SET metadata = '{}' WHERE bucket_id = 'share-snapshots' AND name = '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg' $$),
  'media_held', 'service role: overwriting it is refused');
SELECT is(pg_temp.try($$ UPDATE storage.objects SET name = '00000000-0000-4000-8000-0000c0000001/post/p/moved.jpg' WHERE bucket_id = 'share-snapshots' AND name = '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg' $$),
  'media_held', 'service role: moving it away is refused');
SELECT is(pg_temp.try($$ UPDATE storage.objects SET name = '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg' WHERE bucket_id = 'share-snapshots' AND name = '00000000-0000-4000-8000-0000c0000001/post/p/unref.jpg' $$),
  'media_held', 'service role: moving another object onto it is refused');
SELECT is(pg_temp.try($$ DELETE FROM storage.objects WHERE bucket_id = 'share-snapshots' AND name = '00000000-0000-4000-8000-0000c0000001/post/p/unref.jpg' $$),
  'ok', 'service role: unheld objects are unaffected');
RESET ROLE;
-- The worker's own steps: copied → verified, then delete; quarantined, then restoring.
UPDATE private.media_quarantine SET state = 'copied', source_sha256 = repeat('a', 64) WHERE id = (SELECT id FROM held);
UPDATE private.media_quarantine SET state = 'verified', quarantine_sha256 = repeat('a', 64) WHERE id = (SELECT id FROM held);
SET LOCAL ROLE service_role;
SELECT is(pg_temp.try($$ UPDATE storage.objects SET metadata = '{}' WHERE bucket_id = 'share-snapshots' AND name = '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg' $$),
  'media_held', 'while verified: overwriting is still refused');
SELECT is(pg_temp.try($$ DELETE FROM storage.objects WHERE bucket_id = 'share-snapshots' AND name = '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg' $$),
  'ok', 'while verified: the worker may remove the source');
RESET ROLE;
UPDATE private.media_quarantine SET state = 'quarantined', source_removed_at = now(), quarantined_at = now() WHERE id = (SELECT id FROM held);
SET LOCAL ROLE service_role;
SELECT is(pg_temp.try($$ INSERT INTO storage.objects (bucket_id, name) VALUES ('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg') $$),
  'media_held', 'quarantined: nothing may recreate the file (the backfill bypass)');
RESET ROLE;
UPDATE private.media_quarantine SET state = 'restore_pending', desired = 'restore' WHERE id = (SELECT id FROM held);
SET LOCAL ROLE service_role;
SELECT is(pg_temp.try($$ INSERT INTO storage.objects (bucket_id, name) VALUES ('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg') $$),
  'media_held', 'restore_pending: still refused until the restore worker runs');
RESET ROLE;
UPDATE private.media_quarantine SET state = 'restoring' WHERE id = (SELECT id FROM held);
SET LOCAL ROLE service_role;
SELECT is(pg_temp.try($$ INSERT INTO storage.objects (bucket_id, name) VALUES ('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg') $$),
  'ok', 'restoring: the restore worker may write the original back');
SELECT is(pg_temp.try($$ DELETE FROM storage.objects WHERE bucket_id = 'share-snapshots' AND name = '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg' $$),
  'media_held', 'restoring: but not delete it');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000c0000001');
SELECT is(pg_temp.try($$ INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/x.jpg', '00000000-0000-4000-8000-0000c0000001') $$) <> 'media_held',
  true, 'collectors'' unrelated writes never hit the guard');
RESET ROLE;

-- ── 3. Historical backfill ──────────────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT is(public.backfill_snapshot_check('posts', '00000000-0000-4000-8000-0000c0d00002', pg_temp.u('item-images', '00000000-0000-4000-8000-0000c0000001/legacy.jpg'),
            '00000000-0000-4000-8000-0000c0000001/historical-post/00000000-0000-4000-8000-0000c0d00002'), NULL, 'an unaffected legacy row may be backfilled');
SELECT is(public.backfill_snapshot_check('posts', '00000000-0000-4000-8000-0000c0d00003', pg_temp.u('item-images', '00000000-0000-4000-8000-0000c0000001/legacy2.jpg'),
            '00000000-0000-4000-8000-0000c0000001/historical-post/00000000-0000-4000-8000-0000c0d00003'), 'restricted', 'a moderated post is never republished');
SELECT is(public.backfill_snapshot_check('posts', '00000000-0000-4000-8000-0000c0d00002', pg_temp.u('item-images', '00000000-0000-4000-8000-0000c0000001/legacy.jpg'),
            '00000000-0000-4000-8000-0000c0000001/post/p/held'), 'destination_held', 'a held destination is refused');
SELECT is(public.backfill_snapshot_check('posts', '00000000-0000-4000-8000-0000c0d00002', pg_temp.u('item-images', '00000000-0000-4000-8000-0000c0000001/legacy.jpg'),
            '00000000-0000-4000-8000-0000c0000002/historical-post/x'), 'invalid_destination', 'a destination outside the owner''s namespace is refused');
SELECT is(public.backfill_snapshot_check('posts', '00000000-0000-4000-8000-0000c0d00002', 'https://evil.invalid/x.jpg', 'x/y'), 'invalid_source', 'a non-item-images source is refused');
SELECT is(public.backfill_snapshot_check('profiles', '00000000-0000-4000-8000-0000c0d00002', 'x', 'y'), 'invalid_table', 'only the three backfilled tables');
SELECT is(public.backfill_snapshot_check('posts', gen_random_uuid(), 'x', 'y'), 'row_missing', 'unknown rows are refused');
RESET ROLE;

-- ── 4. Snapshot reconciliation ──────────────────────────────────────────
INSERT INTO private.share_snapshot_copies (id, caller_id, kind, item_id, source_path, dest_base, dest_path, status, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000c0c00001', '00000000-0000-4000-8000-0000c0000001', 'item', '00000000-0000-4000-8000-0000c0e00001', 'a/s', '00000000-0000-4000-8000-0000c0000001/post/p/abandoned', NULL, 'reserved', now() - interval '3 days', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000c0c00002', '00000000-0000-4000-8000-0000c0000001', 'item', '00000000-0000-4000-8000-0000c0e00001', 'a/s', '00000000-0000-4000-8000-0000c0000001/post/p/fresh', NULL, 'reserved', now(), now()),
  ('00000000-0000-4000-8000-0000c0c00003', '00000000-0000-4000-8000-0000c0000001', 'item', '00000000-0000-4000-8000-0000c0e00001', 'a/s', '00000000-0000-4000-8000-0000c0000001/post/p/unref', '00000000-0000-4000-8000-0000c0000001/post/p/unref.jpg', 'published', now() - interval '3 days', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000c0c00004', '00000000-0000-4000-8000-0000c0000001', 'item', '00000000-0000-4000-8000-0000c0e00001', 'a/s', '00000000-0000-4000-8000-0000c0000001/post/p/ref', '00000000-0000-4000-8000-0000c0000001/post/p/ref.jpg', 'published', now() - interval '3 days', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000c0c00005', '00000000-0000-4000-8000-0000c0000001', 'item', '00000000-0000-4000-8000-0000c0e00001', 'a/s', '00000000-0000-4000-8000-0000c0000001/post/p/held', '00000000-0000-4000-8000-0000c0000001/post/p/held.jpg', 'published', now() - interval '3 days', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000c0c00007', '00000000-0000-4000-8000-0000c0000001', 'item', '00000000-0000-4000-8000-0000c0e00001', 'a/s', '00000000-0000-4000-8000-0000c0000001/post/p/new-unref', '00000000-0000-4000-8000-0000c0000001/post/p/new-unref.jpg', 'published', now() - interval '2 hours', now() - interval '2 hours');
INSERT INTO private.share_snapshot_copies (id, caller_id, kind, source_path, dest_base, dest_path, status, source_state, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000c0c00006', '00000000-0000-4000-8000-0000c0000001', 'post_photo', '00000000-0000-4000-8000-0000c0000001/stage-old.jpg',
   '00000000-0000-4000-8000-0000c0000001/post-upload/s', '00000000-0000-4000-8000-0000c0000001/post-upload/s.jpg', 'published', 'deleting', now() - interval '3 days', now() - interval '3 days');
SET LOCAL ROLE service_role;
SELECT throws_ok($$ SELECT * FROM public.share_snapshot_reconcile_candidates(1, 10) $$, '22023', NULL, 'a grace period under 24 hours is refused');
SELECT is((SELECT array_agg(copy_id::text || ':' || reason ORDER BY copy_id) FROM public.share_snapshot_reconcile_candidates(24, 100)
            WHERE copy_id::text LIKE '00000000-0000-4000-8000-0000c0c%'),
  ARRAY['00000000-0000-4000-8000-0000c0c00001:abandoned', '00000000-0000-4000-8000-0000c0c00003:unreferenced', '00000000-0000-4000-8000-0000c0c00006:staging'],
  'candidates: abandoned, unreferenced and stale staging — never fresh, referenced or held copies');
SELECT is(public.share_snapshot_unledgered_orphans(24), 1, 'one old unreferenced object outside the ledger is reported (never deleted)');
SELECT is(public.share_snapshot_reconcile_claim('00000000-0000-4000-8000-0000c0c00004', 24) ->> 'reason', 'not_eligible', 'claim: a referenced copy is refused');
SELECT is(public.share_snapshot_reconcile_claim('00000000-0000-4000-8000-0000c0c00005', 24) ->> 'reason', 'not_eligible', 'claim: a held copy is refused');
SELECT is(public.share_snapshot_reconcile_claim('00000000-0000-4000-8000-0000c0c00002', 24) ->> 'reason', 'not_eligible', 'claim: a copy inside the grace period is refused');
SELECT is(public.share_snapshot_reconcile_claim('00000000-0000-4000-8000-0000c0c00007', 24) ->> 'reason', 'not_eligible', 'claim: an unreferenced copy younger than the grace period is refused');
SELECT is(public.share_snapshot_reconcile_claim('00000000-0000-4000-8000-0000c0c00003', 24),
  jsonb_build_object('ok', true, 'reason', 'unreferenced', 'bucket', 'share-snapshots', 'paths', jsonb_build_array('00000000-0000-4000-8000-0000c0000001/post/p/unref.jpg')),
  'claim: an unreferenced copy yields exactly its own object');
SELECT is((SELECT jsonb_array_length(public.share_snapshot_reconcile_claim('00000000-0000-4000-8000-0000c0c00001', 24) -> 'paths')), 5,
  'claim: an abandoned copy yields only its own destination, per allowed extension');
SELECT is(public.share_snapshot_reconcile_claim('00000000-0000-4000-8000-0000c0c00006', 24) ->> 'bucket', 'item-images', 'claim: a stale staging source');
RESET ROLE;
SELECT is((SELECT status FROM private.share_snapshot_copies WHERE id = '00000000-0000-4000-8000-0000c0c00003'), 'discarded', 'a claimed copy is discarded');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000c0000001');
SELECT throws_ok($$ UPDATE public.posts SET image_url = pg_temp.u('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/unref.jpg')
                    WHERE id = '00000000-0000-4000-8000-0000c0d00002' $$, '42501', 'content_unavailable',
  'a claimed (being removed) snapshot cannot gain a new reference');
RESET ROLE;
-- A reference committed before the claim wins: the claim re-checks.
INSERT INTO private.share_snapshot_copies (id, caller_id, kind, item_id, source_path, dest_base, dest_path, status, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000c0c00008', '00000000-0000-4000-8000-0000c0000001', 'item', '00000000-0000-4000-8000-0000c0e00001', 'a/s',
   '00000000-0000-4000-8000-0000c0000001/post/p/late', '00000000-0000-4000-8000-0000c0000001/post/p/late.jpg', 'published', now() - interval '3 days', now() - interval '3 days');
SET LOCAL ROLE service_role;
SELECT ok(EXISTS (SELECT 1 FROM public.share_snapshot_reconcile_candidates(24, 100) WHERE copy_id = '00000000-0000-4000-8000-0000c0c00008'), 'listed as unreferenced…');
RESET ROLE;
UPDATE public.posts SET image_url = pg_temp.u('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/late.jpg') WHERE id = '00000000-0000-4000-8000-0000c0d00002';
SET LOCAL ROLE service_role;
SELECT is(public.share_snapshot_reconcile_claim('00000000-0000-4000-8000-0000c0c00008', 24) ->> 'reason', 'not_eligible',
  '…but a reference added before the claim makes the claim refuse it');
RESET ROLE;

-- ── 4b. Poison jobs: an exhausted job is flagged, never claimed again ──
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/poison.jpg', '{"size": 10, "mimetype": "image/jpeg"}');
INSERT INTO public.posts (id, user_id, post_type, content, image_url) VALUES
  ('00000000-0000-4000-8000-0000c0d00009', '00000000-0000-4000-8000-0000c0000001', 'text', 'msh poison', pg_temp.u('share-snapshots', '00000000-0000-4000-8000-0000c0000001/post/p/poison.jpg'));
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence) VALUES
  ('00000000-0000-4000-8000-0000c0100009', '00000000-0000-4000-8000-0000c0000003', 'post', '00000000-0000-4000-8000-0000c0d00009', '00000000-0000-4000-8000-0000c0000001', 'hate', '{"v":1}');
INSERT INTO public.moderated_content (target_type, target_id, owner_id, state, reason_code, report_id, created_by) VALUES
  ('post', '00000000-0000-4000-8000-0000c0d00009', '00000000-0000-4000-8000-0000c0000001', 'hidden', 'hate', '00000000-0000-4000-8000-0000c0100009', '00000000-0000-4000-8000-0000c0000004');
-- Five claims whose worker died each time (no step, no error recorded).
UPDATE private.media_quarantine SET attempts = 5, lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second'
 WHERE source_path = '00000000-0000-4000-8000-0000c0000001/post/p/poison.jpg';
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.media_quarantine_claim(50, 60) c
            WHERE c.source_path = '00000000-0000-4000-8000-0000c0000001/post/p/poison.jpg'), 0, 'an exhausted job is not claimed again');
RESET ROLE;
SELECT is((SELECT needs_attention::text || ':' || last_error FROM private.media_quarantine
            WHERE source_path = '00000000-0000-4000-8000-0000c0000001/post/p/poison.jpg'), 'true:attempts_exhausted',
  '…it is flagged for an admin as attempts_exhausted');
SELECT is((SELECT count(*)::int FROM private.media_quarantine_events e JOIN private.media_quarantine q ON q.id = e.quarantine_id
            WHERE q.source_path = '00000000-0000-4000-8000-0000c0000001/post/p/poison.jpg' AND e.event = 'needs_attention'), 1, '…with an event');

-- ── 5. Folder covers ────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000c0000001');
SELECT lives_ok($$ UPDATE public.folders SET cover_source = 'item', cover_item_id = '00000000-0000-4000-8000-0000c0e00001'
                   WHERE id = '00000000-0000-4000-8000-0000c0f00001' $$, 'a collector may pick their own item as cover');
SELECT throws_ok($$ UPDATE public.folders SET cover_item_id = '00000000-0000-4000-8000-0000c0e00002' WHERE id = '00000000-0000-4000-8000-0000c0f00001' $$,
  '22023', 'invalid_cover_item', 'another collector''s private item is refused');
SELECT throws_ok($$ UPDATE public.folders SET cover_item_id = '00000000-0000-4000-8000-0000c0e00003' WHERE id = '00000000-0000-4000-8000-0000c0f00001' $$,
  '22023', 'invalid_cover_item', '…and so is their public item');
SELECT throws_ok($$ INSERT INTO public.folders (user_id, name, is_public, cover_source, cover_item_id)
                    VALUES ('00000000-0000-4000-8000-0000c0000001', 'msh new', true, 'item', '00000000-0000-4000-8000-0000c0e00002') $$,
  '22023', 'invalid_cover_item', 'also on folder creation');
SELECT lives_ok($$ UPDATE public.folders SET name = 'msh a renamed' WHERE id = '00000000-0000-4000-8000-0000c0f00001' $$, 'unrelated edits are unaffected');
SELECT lives_ok($$ UPDATE public.folders SET cover_item_id = NULL, cover_source = 'first_card' WHERE id = '00000000-0000-4000-8000-0000c0f00001' $$, 'clearing the cover is fine');
RESET ROLE;
SELECT throws_ok($$ UPDATE public.folders SET cover_item_id = '00000000-0000-4000-8000-0000c0e00002' WHERE id = '00000000-0000-4000-8000-0000c0f00001' $$,
  '22023', 'invalid_cover_item', 'the rule holds for database operators too');
-- Legacy rows that predate the rule keep working for unrelated edits.
SET LOCAL session_replication_role = replica;
UPDATE public.folders SET cover_item_id = '00000000-0000-4000-8000-0000c0e00002' WHERE id = '00000000-0000-4000-8000-0000c0f00001';
SET LOCAL session_replication_role = origin;
SELECT lives_ok($$ UPDATE public.folders SET name = 'msh legacy' WHERE id = '00000000-0000-4000-8000-0000c0f00001' $$, 'a legacy row can still be renamed');
SELECT lives_ok($$ UPDATE public.folders SET cover_item_id = '00000000-0000-4000-8000-0000c0e00001' WHERE id = '00000000-0000-4000-8000-0000c0f00001' $$,
  '…and repaired to its own item');

SELECT * FROM finish();
ROLLBACK;
