-- pgTAP test for 20261204120000_item_image_deletion_ledger.sql (P2.3 Issue 1:
-- reliable server-side item-images deletion). Storage objects are fixture rows
-- only — nothing here talks to the Storage API — and everything happens inside
-- one transaction that is rolled back.
-- Run against a LOCAL database only:  supabase test db

BEGIN;
SELECT plan(147);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
CREATE FUNCTION pg_temp.logout() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid), pg_temp.logout() TO authenticated, anon, service_role;
-- Ledger row for a path (superuser helper).
CREATE FUNCTION pg_temp.led(p_path text) RETURNS private.item_image_deletions LANGUAGE sql AS $$
  SELECT * FROM private.item_image_deletions WHERE path = p_path ORDER BY id DESC LIMIT 1 $$;
CREATE FUNCTION pg_temp.due(p_path text) RETURNS void LANGUAGE sql AS $$
  UPDATE private.item_image_deletions SET not_before = clock_timestamp() - interval '1 second'
   WHERE path = p_path AND state IN ('pending', 'deferred') $$;
CREATE FUNCTION pg_temp.p(p_tail text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '00000000-0000-4000-8000-0000ce000001/' || p_tail $$;
CREATE TEMP TABLE claims (id bigint, path text, claim_token uuid);
GRANT ALL ON claims TO service_role;

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- A (owner), B (another collector), M (admin).
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000ce000001', 'ii-a@example.invalid', '{"username":"ii_a"}'),
  ('00000000-0000-4000-8000-0000ce000002', 'ii-b@example.invalid', '{"username":"ii_b"}'),
  ('00000000-0000-4000-8000-0000ce000003', 'ii-m@example.invalid', '{"username":"ii_m"}');
INSERT INTO public.admin_users (user_id) VALUES ('00000000-0000-4000-8000-0000ce000003');
INSERT INTO public.folders (id, user_id, name, is_public, cover_source, cover_storage_path) VALUES
  ('00000000-0000-4000-8000-0000cef00001', '00000000-0000-4000-8000-0000ce000001', 'F1', true, 'first_card', NULL),
  ('00000000-0000-4000-8000-0000cef00002', '00000000-0000-4000-8000-0000ce000001', 'F2', true, 'upload', pg_temp.p('covers/c1.jpg')),
  ('00000000-0000-4000-8000-0000cef00003', '00000000-0000-4000-8000-0000ce000001', 'F3', true, 'upload', pg_temp.p('covers/c3.jpg'));
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status, item_type) VALUES
  ('00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000cef00001', '00000000-0000-4000-8000-0000ce000001', 'I1', true, 'active', 'trading_card'),
  ('00000000-0000-4000-8000-0000cee00002', '00000000-0000-4000-8000-0000cef00001', '00000000-0000-4000-8000-0000ce000001', 'I2', true, 'active', 'trading_card'),
  ('00000000-0000-4000-8000-0000cee00003', '00000000-0000-4000-8000-0000cef00003', '00000000-0000-4000-8000-0000ce000001', 'I3', true, 'active', 'trading_card');
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata)
SELECT 'item-images', n, o::uuid, o, '{"size": 10}'::jsonb FROM (VALUES
  (pg_temp.p('00000000-0000-4000-8000-0000cee00001/1.jpg'), '00000000-0000-4000-8000-0000ce000001'),
  (pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg'), '00000000-0000-4000-8000-0000ce000001'),
  (pg_temp.p('00000000-0000-4000-8000-0000cee00001/3.jpg'), '00000000-0000-4000-8000-0000ce000001'),
  (pg_temp.p('00000000-0000-4000-8000-0000cee00002/1.jpg'), '00000000-0000-4000-8000-0000ce000001'),
  (pg_temp.p('00000000-0000-4000-8000-0000cee00003/1.jpg'), '00000000-0000-4000-8000-0000ce000001'),
  (pg_temp.p('covers/c1.jpg'), '00000000-0000-4000-8000-0000ce000001'),
  (pg_temp.p('covers/c2.jpg'), '00000000-0000-4000-8000-0000ce000001'),
  (pg_temp.p('covers/c3.jpg'), '00000000-0000-4000-8000-0000ce000001'),
  (pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg'), '00000000-0000-4000-8000-0000ce000001'),
  ('00000000-0000-4000-8000-0000ce000002/00000000-0000-4000-8000-0000cee00009/b.jpg', '00000000-0000-4000-8000-0000ce000002')) v(n, o);
INSERT INTO public.collection_item_images (id, item_id, user_id, image_url, storage_path, sort_order, is_primary) VALUES
  ('00000000-0000-4000-8000-0000ced00001', '00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000001', 'x', pg_temp.p('00000000-0000-4000-8000-0000cee00001/1.jpg'), 0, true),
  ('00000000-0000-4000-8000-0000ced00002', '00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000001', 'x', pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg'), 1, false),
  ('00000000-0000-4000-8000-0000ced00003', '00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000001', 'x', pg_temp.p('00000000-0000-4000-8000-0000cee00001/3.jpg'), 2, false),
  ('00000000-0000-4000-8000-0000ced00004', '00000000-0000-4000-8000-0000cee00002', '00000000-0000-4000-8000-0000ce000001', 'x', pg_temp.p('00000000-0000-4000-8000-0000cee00002/1.jpg'), 0, true),
  ('00000000-0000-4000-8000-0000ced00005', '00000000-0000-4000-8000-0000cee00003', '00000000-0000-4000-8000-0000ce000001', 'x', pg_temp.p('00000000-0000-4000-8000-0000cee00003/1.jpg'), 0, true),
  -- A row owned by A that names B's file (never enqueued).
  ('00000000-0000-4000-8000-0000ced00009', '00000000-0000-4000-8000-0000cee00002', '00000000-0000-4000-8000-0000ce000001', 'x',
   '00000000-0000-4000-8000-0000ce000002/00000000-0000-4000-8000-0000cee00009/b.jpg', 1, false);

-- A legacy URL reference to F3's cover from another row (made before anything
-- is recorded, so it simply exists when the cover is later released).
UPDATE public.collection_items SET image_url = 'http://127.0.0.1:54321/storage/v1/object/public/item-images/' || pg_temp.p('covers/c3.jpg')
 WHERE id = '00000000-0000-4000-8000-0000cee00001';

-- ── 1. Shape, gates and privileges ──────────────────────────────────────────
SELECT ok((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'private.item_image_deletions'::regclass), 'the ledger has RLS on');
SELECT ok(NOT has_table_privilege('authenticated', 'private.item_image_deletions', 'SELECT')
      AND NOT has_table_privilege('anon', 'private.item_image_deletions', 'SELECT')
      AND NOT has_table_privilege('service_role', 'private.item_image_deletions', 'SELECT'), 'no API role can read the ledger directly');
SELECT is((SELECT active FROM cron.job WHERE jobname = 'item-image-cleanup'), false, 'the sweep job exists and is INACTIVE');
SELECT is(private.item_image_cleanup_enabled(), false, 'the switch is OFF by default');
SELECT ok(NOT has_function_privilege('authenticated', 'public.item_image_deletion_claim(integer, integer)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.item_image_deletion_complete(bigint, uuid, text)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.item_image_deletion_candidates(integer)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.item_image_cleanup_begin(text)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.item_image_deletion_retry_failed(bigint[])', 'EXECUTE'),
  'collectors cannot call any worker RPC');
SELECT ok(has_function_privilege('service_role', 'public.item_image_deletion_claim(integer, integer)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.item_image_deletion_complete(bigint, uuid, text)', 'EXECUTE'),
  'the service role can call the worker RPCs');
SELECT ok(has_function_privilege('authenticated', 'public.request_item_upload_cleanup(text[])', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.request_item_upload_cleanup(text[])', 'EXECUTE'),
  'only signed-in collectors may request upload cleanup');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
             AND cmd = 'SELECT' AND qual LIKE '%item-images%'), 0, 'no Storage SELECT policy on item-images was added');

-- ── 2. Enqueue: image removal through the existing RPC ──────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000001');
SELECT is(public.remove_item_image('00000000-0000-4000-8000-0000ced00002'), pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg'),
  'remove_item_image is unchanged: it still returns the storage path');
RESET ROLE;
SELECT is((SELECT row(source, state, owner_id)::text FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg'))),
  row('image_removed', 'pending', '00000000-0000-4000-8000-0000ce000001'::uuid)::text, 'the removed photo is recorded: image_removed, pending, owner A');
SELECT ok((pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg'))).not_before
          BETWEEN clock_timestamp() + interval '14 minutes' AND clock_timestamp() + interval '16 minutes', '…with the 15-minute grace period');
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/1.jpg')), 0,
  'the photo still in use is not recorded');

-- A delete that rolls back records nothing.
SELECT throws_ok($$ DO $x$ BEGIN
    DELETE FROM public.collection_item_images WHERE id = '00000000-0000-4000-8000-0000ced00003';
    RAISE EXCEPTION 'boom';
  END $x$ $$, 'boom', 'a failing transaction…');
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/3.jpg')), 0,
  '…records nothing (the ledger is transactional)');

-- ── 3. Enqueue: item delete, folder delete (cascade), cover replace ─────────
DELETE FROM public.collection_items WHERE id = '00000000-0000-4000-8000-0000cee00002';
SELECT is((pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00002/1.jpg'))).source, 'item_deleted', 'deleting an item records its photos as item_deleted');
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE path LIKE '00000000-0000-4000-8000-0000ce000002/%'), 0,
  'a row naming ANOTHER collector''s file never records that file');
UPDATE public.folders SET cover_storage_path = pg_temp.p('covers/c2.jpg') WHERE id = '00000000-0000-4000-8000-0000cef00002';
SELECT is((pg_temp.led(pg_temp.p('covers/c1.jpg'))).source, 'folder_cover_replaced', 'replacing an uploaded cover records the old cover');
DELETE FROM public.folders WHERE id = '00000000-0000-4000-8000-0000cef00003';
SELECT is((pg_temp.led(pg_temp.p('covers/c3.jpg'))).source, 'folder_deleted', 'deleting a folder records its uploaded cover…');
SELECT is((pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00003/1.jpg'))).source, 'item_deleted', '…and every photo of every item in it');
UPDATE public.folders SET name = 'F2 renamed' WHERE id = '00000000-0000-4000-8000-0000cef00002';
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE path = pg_temp.p('covers/c2.jpg')), 0,
  'an unrelated folder edit records nothing');

-- Idempotent enqueue: one open entry per object.
SELECT private.enqueue_item_image_deletion(pg_temp.p('covers/c1.jpg'), '00000000-0000-4000-8000-0000ce000001', 'folder_cover_replaced', interval '15 minutes');
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE path = pg_temp.p('covers/c1.jpg')), 1, 'enqueueing twice keeps one open entry');
SELECT private.enqueue_item_image_deletion('00000000-0000-4000-8000-0000ce000002/x/y.jpg', '00000000-0000-4000-8000-0000ce000001', 'image_removed', interval '0');
SELECT private.enqueue_item_image_deletion(pg_temp.p('../x.jpg'), '00000000-0000-4000-8000-0000ce000001', 'image_removed', interval '0');
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE path LIKE '%x.jpg' OR path LIKE '%y.jpg'), 0,
  'foreign-owner and traversal paths are never recorded');

-- ── 4. Switch off: nothing is claimed ───────────────────────────────────────
SELECT pg_temp.due(pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg'));
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.item_image_deletion_claim(10, 60)), 0, 'with the switch OFF, nothing is claimed even when due');
SELECT is(public.item_image_cleanup_begin('sweep') ->> 'reason', 'disabled', '…and a run refuses to begin');
RESET ROLE;
UPDATE private.item_image_cleanup_config SET enabled = true;

-- ── 5. Claim re-checks protection ───────────────────────────────────────────
-- Not yet due: never claimed (asserted by the claim below, which returns only the due entry).
SELECT ok((pg_temp.led(pg_temp.p('covers/c1.jpg'))).not_before > clock_timestamp(), 'an entry inside its grace period is not yet due');
-- Protected by a legacy URL reference (set in the fixtures, before the cover
-- was released): kept, never deleted.
UPDATE private.item_image_deletions SET not_before = clock_timestamp() - interval '1 second' WHERE path = pg_temp.p('covers/c3.jpg');
-- Report evidence: deferred.
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence) VALUES
  ('00000000-0000-4000-8000-0000ce100001', '00000000-0000-4000-8000-0000ce000002', 'collection_item', '00000000-0000-4000-8000-0000cee00001',
   '00000000-0000-4000-8000-0000ce000001', 'hate',
   jsonb_build_object('v', 1, 'image_refs', jsonb_build_array(jsonb_build_object('bucket', 'item-images', 'path', pg_temp.p('00000000-0000-4000-8000-0000cee00002/1.jpg')))));
SELECT pg_temp.due(pg_temp.p('00000000-0000-4000-8000-0000cee00002/1.jpg'));
-- Held for moderation quarantine: deferred.
INSERT INTO public.moderated_content (id, target_type, target_id, owner_id, state, reason_code, child_safety, report_id) VALUES
  ('00000000-0000-4000-8000-0000ce200001', 'collection_item', '00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000001',
   'removed', 'hate', false, '00000000-0000-4000-8000-0000ce100001');
SELECT private.queue_media_hold('00000000-0000-4000-8000-0000ce200001', NULL, 'item-images', pg_temp.p('00000000-0000-4000-8000-0000cee00003/1.jpg'),
  '00000000-0000-4000-8000-0000ce000001', 'item_image', false, 'collection_item', '00000000-0000-4000-8000-0000cee00001');
SELECT pg_temp.due(pg_temp.p('00000000-0000-4000-8000-0000cee00003/1.jpg'));

SET LOCAL ROLE service_role;
SELECT is((SELECT array_agg(w ORDER BY w) FROM (SELECT path || '=' || would AS w FROM public.item_image_deletion_candidates(50)
            WHERE not_before <= clock_timestamp()) s),
  ARRAY[pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg') || '=delete',
        pg_temp.p('00000000-0000-4000-8000-0000cee00002/1.jpg') || '=defer:report_evidence',
        pg_temp.p('00000000-0000-4000-8000-0000cee00003/1.jpg') || '=defer:held',
        pg_temp.p('covers/c3.jpg') || '=keep:referenced'],
  'the dry run reports delete / defer / keep without changing anything');
INSERT INTO claims SELECT * FROM public.item_image_deletion_claim(10, 60);
RESET ROLE;
SELECT is((SELECT array_agg(path) FROM claims), ARRAY[pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg')],
  'only the unprotected due entry is claimed');
SELECT is((SELECT row(state, attempts, claim_token IS NOT NULL)::text FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg'))),
  row('claimed', 1, true)::text, '…it is claimed with a lease and token');
SELECT is((SELECT row(state, last_reason)::text FROM pg_temp.led(pg_temp.p('covers/c3.jpg'))), row('kept', 'referenced')::text,
  'a still-referenced object is KEPT (terminal)');
SELECT is((SELECT row(state, last_reason)::text FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00002/1.jpg'))),
  row('deferred', 'report_evidence')::text, 'report evidence defers the deletion');
SELECT ok((pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00002/1.jpg'))).not_before > clock_timestamp() + interval '5 hours',
  '…re-checked hours later');
SELECT is((SELECT row(state, last_reason)::text FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00003/1.jpg'))),
  row('deferred', 'held')::text, 'a moderation hold defers the deletion (cannot be bypassed)');

-- Export in progress: deferred.
INSERT INTO public.account_exports (id, user_id, status) VALUES ('00000000-0000-4000-8000-0000ce300001', '00000000-0000-4000-8000-0000ce000001', 'archiving');
INSERT INTO public.account_export_entries (export_id, seq, archive_name, source_bucket, source_path, size, local_offset, written, part)
VALUES ('00000000-0000-4000-8000-0000ce300001', 1, 'a.jpg', 'item-images', pg_temp.p('covers/c1.jpg'), 10, 0, false, 1);
SELECT pg_temp.due(pg_temp.p('covers/c1.jpg'));
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.item_image_deletion_claim(10, 60)), 0, 'an object in an in-progress export is not claimed');
RESET ROLE;
SELECT is((pg_temp.led(pg_temp.p('covers/c1.jpg'))).last_reason, 'export', '…it is deferred as export');

-- ── 6. New references vs pending / claimed deletions ────────────────────────
-- Re-referencing a CLAIMED object is refused (the worker may be deleting it).
SELECT throws_ok($$ INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary)
  VALUES ('00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000001', 'x',
          '00000000-0000-4000-8000-0000ce000001/00000000-0000-4000-8000-0000cee00001/2.jpg', 5, false) $$,
  '42501', 'content_unavailable', 'a new reference to an object being deleted is refused');
-- Re-referencing a PENDING object cancels the deletion.
UPDATE public.folders SET cover_storage_path = pg_temp.p('covers/c2.jpg') WHERE id = '00000000-0000-4000-8000-0000cef00001';
UPDATE public.folders SET cover_storage_path = NULL WHERE id = '00000000-0000-4000-8000-0000cef00001';
SELECT is((pg_temp.led(pg_temp.p('covers/c2.jpg'))).state, 'pending', 'clearing a cover records it (pending)');
UPDATE public.folders SET cover_storage_path = pg_temp.p('covers/c2.jpg') WHERE id = '00000000-0000-4000-8000-0000cef00001';
SELECT is((SELECT row(state, last_reason)::text FROM pg_temp.led(pg_temp.p('covers/c2.jpg'))), row('cancelled', 'rereferenced')::text,
  'referencing it again CANCELS the pending deletion');
SELECT pg_temp.due(pg_temp.p('covers/c2.jpg'));
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.item_image_deletion_claim(10, 60) WHERE path = pg_temp.p('covers/c2.jpg')), 0,
  '…and a cancelled entry is never claimed');
RESET ROLE;

-- ── 7. Complete: authoritative, stale tokens, retries, failure ──────────────
SET LOCAL ROLE service_role;
SELECT is(public.item_image_deletion_complete((SELECT id FROM claims), gen_random_uuid(), NULL), 'stale_claim', 'a wrong claim token changes nothing');
SELECT is(public.item_image_deletion_complete((SELECT id FROM claims), (SELECT claim_token FROM claims), 'storage_error'), 'retry',
  'the object is still in Storage: retried, never marked deleted');
RESET ROLE;
SELECT is((SELECT row(state, last_error_code)::text FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg'))),
  row('pending', 'storage_error')::text, '…back to pending with the error code');
SELECT ok((pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg'))).not_before > clock_timestamp() + interval '4 minutes', '…with backoff');
SET LOCAL ROLE service_role;
SELECT is(public.item_image_deletion_complete((SELECT id FROM claims), (SELECT claim_token FROM claims), NULL), 'stale_claim',
  'completing the same claim twice changes nothing');
RESET ROLE;
-- The worker removes the object (Storage API), then completes.
SELECT pg_temp.due(pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg'));
DELETE FROM claims;
SET LOCAL ROLE service_role;
INSERT INTO claims SELECT * FROM public.item_image_deletion_claim(10, 60);
RESET ROLE;
SET LOCAL storage.allow_delete_query = 'true';  -- what the Storage API does
DELETE FROM storage.objects WHERE bucket_id = 'item-images' AND name = pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg');
SET LOCAL storage.allow_delete_query = 'false';
SET LOCAL ROLE service_role;
SELECT is(public.item_image_deletion_complete((SELECT id FROM claims), (SELECT claim_token FROM claims), NULL), 'deleted',
  'once the object is really gone, the entry is deleted');
RESET ROLE;
SELECT is((SELECT row(state, attempts)::text FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/2.jpg'))), row('deleted', 2)::text,
  '…after two attempts');

-- Idempotent: an object that is already absent completes as deleted.
SELECT private.enqueue_item_image_deletion(pg_temp.p('00000000-0000-4000-8000-0000cee00001/gone.jpg'), '00000000-0000-4000-8000-0000ce000001', 'image_removed', interval '0');
SELECT pg_temp.due(pg_temp.p('00000000-0000-4000-8000-0000cee00001/gone.jpg'));
DELETE FROM claims;
SET LOCAL ROLE service_role;
INSERT INTO claims SELECT * FROM public.item_image_deletion_claim(10, 60);
SELECT is(public.item_image_deletion_complete((SELECT id FROM claims), (SELECT claim_token FROM claims), NULL), 'deleted',
  'an already-absent object completes as deleted (idempotent)');
RESET ROLE;

-- An expired lease is re-claimed; five failed attempts mark the entry failed.
SELECT private.enqueue_item_image_deletion(pg_temp.p('00000000-0000-4000-8000-0000cee00001/3.jpg'), '00000000-0000-4000-8000-0000ce000001', 'image_removed', interval '0');
UPDATE private.item_image_deletions SET state = 'claimed', claim_token = gen_random_uuid(), lease_expires_at = clock_timestamp() - interval '1 second', attempts = 4
 WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/3.jpg');
DELETE FROM claims;
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.item_image_deletion_claim(10, 60) WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/3.jpg')), 0,
  'a photo still referenced by its gallery row is never claimed, even from an expired lease');
RESET ROLE;
SELECT is((pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/3.jpg'))).state, 'kept', '…it is kept');
SELECT private.enqueue_item_image_deletion(pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg'), '00000000-0000-4000-8000-0000ce000001', 'upload_rejected', interval '0');
UPDATE private.item_image_deletions SET state = 'claimed', claim_token = gen_random_uuid(), lease_expires_at = clock_timestamp() - interval '1 second', attempts = 4
 WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg');
SET LOCAL ROLE service_role;
INSERT INTO claims SELECT * FROM public.item_image_deletion_claim(10, 60) WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg');
SELECT is((SELECT count(*)::int FROM claims WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg')), 1, 'an expired lease is re-claimed');
SELECT is(public.item_image_deletion_complete((SELECT id FROM claims WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg')),
                                               (SELECT claim_token FROM claims WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg')), 'storage_error'),
  'failed', 'the fifth failed attempt marks the entry failed (visible, not silent)');
SELECT is(public.item_image_deletion_retry_failed(ARRAY[(SELECT id FROM claims WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg'))]), 1,
  'an operator can put a failed entry back in the queue');
RESET ROLE;
SELECT is((SELECT row(state, attempts)::text FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg'))), row('pending', 0)::text,
  '…as pending, attempts reset');

-- ── 8. Client cleanup requests for rejected uploads ─────────────────────────
DELETE FROM private.item_image_deletions WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000001');
SELECT is(public.request_item_upload_cleanup(ARRAY[
    pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg'),                                  -- own, exists
    pg_temp.p('00000000-0000-4000-8000-0000cee00001/missing.jpg'),                             -- own, no object
    '00000000-0000-4000-8000-0000ce000002/00000000-0000-4000-8000-0000cee00009/b.jpg',          -- B's file
    pg_temp.p('notanitem/up.jpg')]), 1, 'only the caller''s own existing upload is accepted');
SELECT throws_ok($$ SELECT public.request_item_upload_cleanup(array_fill('x'::text, ARRAY[11])) $$, '22023', 'invalid_argument', 'more than 10 paths are refused');
SELECT pg_temp.logout();
SELECT throws_ok($$ SELECT public.request_item_upload_cleanup(ARRAY['x']) $$, '42501', 'not_authenticated', 'an unauthenticated caller is refused');
RESET ROLE;
SELECT is((SELECT row(source, state)::text FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg'))), row('upload_rejected', 'pending')::text,
  'the accepted upload is recorded as upload_rejected');
SELECT ok((pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/up.jpg'))).not_before > clock_timestamp() + interval '23 hours',
  '…with the 24-hour grace period');
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE path LIKE '00000000-0000-4000-8000-0000ce000002/%'), 0,
  'nothing was recorded for B');

-- ── 9. Runs and admin status ────────────────────────────────────────────────
SET LOCAL ROLE service_role;
CREATE TEMP TABLE run1 AS SELECT public.item_image_cleanup_begin('sweep') AS r;
SELECT is((SELECT (r ->> 'ok')::boolean FROM run1), true, 'with the switch ON a run begins');
SELECT is(public.item_image_cleanup_begin('sweep') ->> 'reason', 'busy', 'only one run at a time');
SELECT lives_ok($$ SELECT public.item_image_cleanup_finish((SELECT (r ->> 'run_id')::uuid FROM run1), 'completed', 1, '{"deleted":1}', NULL, 10) $$, 'a run finishes');
SELECT is(public.item_image_cleanup_begin('sweep') ->> 'ok', 'true', '…and the next run may begin');
SELECT throws_ok($$ SELECT public.item_image_cleanup_begin('kick') $$, '22023', 'invalid_argument', 'unknown triggers are refused');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000001');
SELECT throws_ok($$ SELECT public.admin_item_image_cleanup_status() $$, '42501', NULL, 'a collector cannot read cleanup status');
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000003');
SELECT is((public.admin_item_image_cleanup_status() ->> 'sweep_active')::boolean, false, 'an admin sees the status (sweep inactive)');
SELECT ok((public.admin_item_image_cleanup_status() -> 'by_state') ? 'deleted', '…with counts by state');
RESET ROLE;

-- The dispatcher does nothing without its Vault secret.
SELECT is(private.run_item_image_cleanup(), NULL, 'the dispatcher sends nothing without the worker secret');

-- ── 10. F1: a CLAIMED object is condemned — never referenceable again ───────
-- (whatever the claim's age, retries or outcome; by path or by public URL)
CREATE FUNCTION pg_temp.u(p_path text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'http://127.0.0.1:54321/storage/v1/object/public/item-images/' || p_path $$;
CREATE FUNCTION pg_temp.condemn(p_tail text, p_state text, p_attempts int, p_lease interval) RETURNS void LANGUAGE sql AS $$
  INSERT INTO private.item_image_deletions (path, owner_id, source, state, not_before, attempts, claim_token, lease_expires_at, completed_at)
  VALUES (pg_temp.p(p_tail), '00000000-0000-4000-8000-0000ce000001', 'image_removed', p_state, clock_timestamp(), p_attempts,
          CASE WHEN p_state = 'claimed' THEN gen_random_uuid() END,
          CASE WHEN p_state = 'claimed' THEN clock_timestamp() + p_lease END,
          CASE WHEN p_state = 'deleted' THEN clock_timestamp() END) $$;
SELECT pg_temp.condemn('00000000-0000-4000-8000-0000cee00001/exp.jpg', 'claimed', 1, interval '-1 hour');   -- lease long expired
SELECT pg_temp.condemn('00000000-0000-4000-8000-0000cee00001/ret.jpg', 'pending', 2, NULL);                -- retrying after a claim
SELECT pg_temp.condemn('00000000-0000-4000-8000-0000cee00001/fail.jpg', 'failed', 5, NULL);
SELECT pg_temp.condemn('00000000-0000-4000-8000-0000cee00001/del.jpg', 'deleted', 1, NULL);                -- physically deleted
SELECT pg_temp.condemn('00000000-0000-4000-8000-0000cee00001/def.jpg', 'deferred', 1, NULL);              -- held after a claim
SELECT throws_ok($$ INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary)
  VALUES ('00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000001', 'x', pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg'), 9, false) $$,
  '42501', 'content_unavailable', 'F1: an object whose claim EXPIRED long ago still cannot be referenced (a delayed worker may yet remove it)');
SELECT throws_ok($$ INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary)
  VALUES ('00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000001', 'x', pg_temp.p('00000000-0000-4000-8000-0000cee00001/ret.jpg'), 9, false) $$,
  '42501', 'content_unavailable', 'F1: …nor one being retried after a claim');
SELECT throws_ok($$ INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary)
  VALUES ('00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000001', 'x', pg_temp.p('00000000-0000-4000-8000-0000cee00001/fail.jpg'), 9, false) $$,
  '42501', 'content_unavailable', 'F1: …nor a failed one');
SELECT throws_ok($$ INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary)
  VALUES ('00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000001', 'x', pg_temp.p('00000000-0000-4000-8000-0000cee00001/del.jpg'), 9, false) $$,
  '42501', 'content_unavailable', 'F1/F2: …nor one already physically deleted (no broken gallery row)');
SELECT throws_ok($$ INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary)
  VALUES ('00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000001', 'x', pg_temp.p('00000000-0000-4000-8000-0000cee00001/def.jpg'), 9, false) $$,
  '42501', 'content_unavailable', 'F1: …nor one deferred after a claim');
SELECT throws_ok($$ UPDATE public.collection_items SET image_url = pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg'))
  WHERE id = '00000000-0000-4000-8000-0000cee00001' $$, '42501', 'content_unavailable', 'F1: a public-URL reference on an item is refused too');
SELECT throws_ok($$ UPDATE public.folders SET cover_image_url = pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg'))
  WHERE id = '00000000-0000-4000-8000-0000cef00002' $$, '42501', 'content_unavailable', 'F1: …and a public-URL folder cover');
SELECT throws_ok($$ INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary)
  VALUES ('00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000001', pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg')), NULL, 9, false) $$,
  '42501', 'content_unavailable', 'F1: …and a gallery row naming it by URL only');
SELECT is((SELECT state FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg'))), 'claimed',
  'F1: a refused reference never cancels or releases the claim');
-- The expired claim is re-claimed (a second worker), removed, completed; the
-- first worker's late completion changes nothing.
UPDATE private.item_image_deletions SET claim_token = '00000000-0000-4000-8000-00000000aaaa'
 WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg');
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('item-images', pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg'), '00000000-0000-4000-8000-0000ce000001', '00000000-0000-4000-8000-0000ce000001');
DELETE FROM claims;
SET LOCAL ROLE service_role;
INSERT INTO claims SELECT * FROM public.item_image_deletion_claim(50, 600);
RESET ROLE;
SELECT ok((SELECT claim_token FROM claims WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg'))
          IS DISTINCT FROM '00000000-0000-4000-8000-00000000aaaa'::uuid, 'an abandoned (expired) claim is re-claimed with a new token');
SET LOCAL storage.allow_delete_query = 'true';
DELETE FROM storage.objects WHERE bucket_id = 'item-images' AND name = pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg');
SET LOCAL storage.allow_delete_query = 'false';
SET LOCAL ROLE service_role;
SELECT is(public.item_image_deletion_complete((SELECT id FROM claims WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg')),
                                               (SELECT claim_token FROM claims WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg')), NULL),
  'deleted', 'the second worker completes it');
SELECT is(public.item_image_deletion_complete((SELECT id FROM claims WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/exp.jpg')),
                                               '00000000-0000-4000-8000-00000000aaaa', NULL),
  'stale_claim', 'the first (delayed) worker''s completion changes nothing');
RESET ROLE;
-- Never-claimed: a new reference still cancels it (keeps the file).
SELECT private.enqueue_item_image_deletion(pg_temp.p('00000000-0000-4000-8000-0000cee00001/fresh.jpg'), '00000000-0000-4000-8000-0000ce000001', 'image_removed', interval '15 minutes');
UPDATE public.collection_items SET image_url = pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/fresh.jpg'))
 WHERE id = '00000000-0000-4000-8000-0000cee00001';
SELECT is((SELECT row(state, last_reason)::text FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/fresh.jpg'))),
  row('cancelled', 'rereferenced')::text, 'a never-claimed deletion is cancelled by a new (URL) reference');

-- ── 11. F6: account deletion stays authoritative ────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000ce000004', 'ii-d@example.invalid', '{"username":"ii_d"}');
SELECT private.enqueue_item_image_deletion('00000000-0000-4000-8000-0000ce000004/00000000-0000-4000-8000-0000cee00004/a.jpg',
  '00000000-0000-4000-8000-0000ce000004', 'image_removed', interval '15 minutes');
SELECT private.enqueue_item_image_deletion('00000000-0000-4000-8000-0000ce000004/00000000-0000-4000-8000-0000cee00004/b.jpg',
  '00000000-0000-4000-8000-0000ce000004', 'image_removed', interval '15 minutes');
UPDATE private.item_image_deletions SET state = 'claimed', attempts = 1, claim_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes'
 WHERE path = '00000000-0000-4000-8000-0000ce000004/00000000-0000-4000-8000-0000cee00004/b.jpg';
CREATE TEMP TABLE others AS SELECT count(*)::int AS n FROM private.item_image_deletions WHERE owner_id <> '00000000-0000-4000-8000-0000ce000004';
INSERT INTO public.account_deletion_jobs (user_id, mode) VALUES ('00000000-0000-4000-8000-0000ce000004', 'immediate');
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE owner_id = '00000000-0000-4000-8000-0000ce000004'), 0,
  'F6: an account deletion job clears that account''s ledger rows (pending AND claimed) — no stranded jobs');
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE owner_id <> '00000000-0000-4000-8000-0000ce000004'), (SELECT n FROM others),
  'F6: …and no other account''s rows');
SELECT private.enqueue_item_image_deletion('00000000-0000-4000-8000-0000ce000004/00000000-0000-4000-8000-0000cee00004/c.jpg',
  '00000000-0000-4000-8000-0000ce000004', 'item_deleted', interval '15 minutes');
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE owner_id = '00000000-0000-4000-8000-0000ce000004'), 0,
  'F6: nothing is recorded while the account''s deletion job is open (no duplicate cleanup)');
UPDATE public.account_deletion_jobs SET status = 'completed', completed_at = now(), purge_after = now() + interval '30 days'
 WHERE user_id = '00000000-0000-4000-8000-0000ce000004';
SELECT private.enqueue_item_image_deletion('00000000-0000-4000-8000-0000ce000004/00000000-0000-4000-8000-0000cee00004/d.jpg',
  '00000000-0000-4000-8000-0000ce000004', 'item_deleted', interval '15 minutes');
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE owner_id = '00000000-0000-4000-8000-0000ce000004'), 1,
  'F6: a completed job no longer suppresses recording');

-- ── 12. F8: only recent uploads can be handed in ───────────────────────────
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, created_at) VALUES
  ('item-images', pg_temp.p('00000000-0000-4000-8000-0000cee00001/old.jpg'), '00000000-0000-4000-8000-0000ce000001',
   '00000000-0000-4000-8000-0000ce000001', now() - interval '3 days'),
  ('item-images', pg_temp.p('00000000-0000-4000-8000-0000cee00001/new.jpg'), '00000000-0000-4000-8000-0000ce000001',
   '00000000-0000-4000-8000-0000ce000001', now() - interval '1 hour');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000001');
SELECT is(public.request_item_upload_cleanup(ARRAY[pg_temp.p('00000000-0000-4000-8000-0000cee00001/old.jpg')]), 0,
  'F8: an upload older than 48 h (a historical orphan) is refused');
SELECT is(public.request_item_upload_cleanup(ARRAY[pg_temp.p('00000000-0000-4000-8000-0000cee00001/new.jpg')]), 1,
  'F8: a recent upload is accepted');
RESET ROLE;
INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for) VALUES
  ('00000000-0000-4000-8000-0000ce000002', 'pending_deletion', 'scheduled', now() + interval '30 days');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000002');
SELECT throws_ok($$ SELECT public.request_item_upload_cleanup(ARRAY['x']) $$, '42501', 'not_authenticated', 'a hidden (pending-deletion) account is refused');
RESET ROLE;

-- ── 13. Runs: abandoned runs are reaped; housekeeping ───────────────────────
UPDATE private.item_image_cleanup_runs SET status = 'completed', finished_at = clock_timestamp() WHERE status = 'running';
CREATE TEMP TABLE stuck AS
  WITH i AS (INSERT INTO private.item_image_cleanup_runs (trigger, started_at) VALUES ('sweep', clock_timestamp() - interval '11 minutes') RETURNING id)
  SELECT id FROM i;
INSERT INTO private.item_image_deletions (path, owner_id, source, state, not_before, completed_at)
VALUES (pg_temp.p('00000000-0000-4000-8000-0000cee00001/ancient.jpg'), '00000000-0000-4000-8000-0000ce000001', 'image_removed', 'deleted',
        clock_timestamp(), clock_timestamp() - interval '31 days');
SET LOCAL ROLE service_role;
SELECT is(public.item_image_cleanup_begin('operator') ->> 'ok', 'true', 'a run stuck for more than 10 minutes does not block the next one');
RESET ROLE;
SELECT is((SELECT r.status FROM private.item_image_cleanup_runs r JOIN stuck USING (id)), 'abandoned', '…it is reaped as abandoned');
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/ancient.jpg')), 0,
  'terminal entries older than 30 days are purged');

-- ── 14. A hold that ends releases the deferred deletion ─────────────────────
UPDATE private.media_quarantine SET state = 'cancelled' WHERE source_bucket = 'item-images'
   AND source_path = pg_temp.p('00000000-0000-4000-8000-0000cee00003/1.jpg');
SELECT pg_temp.due(pg_temp.p('00000000-0000-4000-8000-0000cee00003/1.jpg'));
SET LOCAL ROLE service_role;
SELECT is((SELECT would FROM public.item_image_deletion_candidates(500) WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00003/1.jpg')), 'delete',
  'once the hold ends, the deferred deletion is due to delete');
RESET ROLE;

-- ── 15. F7: admin view — counts, categories, safe identification ────────────
SELECT private.enqueue_item_image_deletion(pg_temp.p('00000000-0000-4000-8000-0000cee00001/f7.jpg'), '00000000-0000-4000-8000-0000ce000001', 'image_removed', interval '0');
UPDATE private.item_image_deletions SET state = 'failed', attempts = 5, last_error_code = 'storage_error'
 WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/f7.jpg');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000003');
CREATE TEMP TABLE st AS SELECT public.admin_item_image_cleanup_status() AS j;
RESET ROLE;
SELECT ok((SELECT (j ->> 'failed')::int >= 1 AND (j -> 'error_categories' ->> 'storage_error')::int >= 1 FROM st), 'F7: failed count and error categories');
SELECT ok((SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(j -> 'needs_attention') e
                           WHERE e ->> 'owner_username' = 'ii_a' AND e ->> 'item_id' = '00000000-0000-4000-8000-0000cee00001'
                             AND e ->> 'last_error_code' = 'storage_error') FROM st), 'F7: failed entries identified by owner and item');
SELECT ok((SELECT j::text NOT LIKE '%.jpg%' AND j::text NOT LIKE '%/storage/v1/%' FROM st), 'F7: no storage path or URL is exposed');
SELECT ok(NOT has_table_privilege('authenticated', 'private.item_image_cleanup_runs', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'private.item_image_cleanup_config', 'UPDATE')
      AND NOT has_table_privilege('service_role', 'private.item_image_cleanup_config', 'UPDATE'), 'no API role can read runs or flip the switch');

-- ── 16. Post and share-snapshot URL columns are guarded too ─────────────────
-- (post-commit safety review: a child-safety restriction of a post holds any
-- item-images URL these columns name, so they must never name a condemned
-- object.) Every column, by INSERT and by UPDATE.
CREATE TEMP TABLE pcols (c text PRIMARY KEY);
INSERT INTO pcols VALUES ('posts.image_url'), ('posts.folder_cover_snapshot_url'), ('post_images.image_url'),
  ('card_share_items.snapshot_image_url'), ('folder_share_items.snapshot_image_url'), ('rate_my_grail_cards.snapshot_image_url');
CREATE FUNCTION pg_temp.snap(p_tail text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'http://127.0.0.1:54321/storage/v1/object/public/share-snapshots/00000000-0000-4000-8000-0000ce000001/' || p_tail $$;
-- A parent post for the child tables (a share-snapshots image: a normal post).
INSERT INTO public.posts (id, user_id, post_type, caption, image_url)
VALUES ('00000000-0000-4000-8000-0000cea00001', '00000000-0000-4000-8000-0000ce000001', 'text', 'pp', pg_temp.snap('card_share/x/1.jpg'));
-- Writes one reference into column p_col: a new row (INSERT) or the fixture
-- row tagged p_tag (UPDATE). Returns 'ok' or 'SQLSTATE message'.
CREATE FUNCTION pg_temp.ref(p_col text, p_url text, p_tag text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_tab text := split_part(p_col, '.', 1);
  v_col text := split_part(p_col, '.', 2);
  v_id uuid := gen_random_uuid();
BEGIN
  IF p_tag IS NOT NULL THEN
    EXECUTE format('UPDATE public.%I SET %I = $1 WHERE %s', v_tab, v_col,
                   CASE WHEN v_tab = 'posts' THEN 'caption = $2' ELSE 'post_id = (SELECT id FROM public.posts WHERE caption = $2)' END)
      USING p_url, p_tag || ':' || p_col;
  ELSIF v_tab = 'posts' THEN
    EXECUTE format('INSERT INTO public.posts (id, user_id, post_type, caption, %I) VALUES ($1, %L, %L, %L, $2)',
                   v_col, '00000000-0000-4000-8000-0000ce000001', 'text', 'new') USING v_id, p_url;
  ELSE
    -- one parent post per child row (post_images sort_order / uniqueness)
    INSERT INTO public.posts (id, user_id, post_type, caption) VALUES (v_id, '00000000-0000-4000-8000-0000ce000001', 'text', 'new-parent');
    IF v_tab = 'post_images' THEN
      INSERT INTO public.post_images (post_id, image_url, source_type, sort_order) VALUES (v_id, p_url, 'library', 0);
    ELSE
      EXECUTE format('INSERT INTO public.%I (post_id, %I) VALUES ($1, $2)', v_tab, v_col) USING v_id, p_url;
    END IF;
  END IF;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ' ' || SQLERRM;
END;
$$;
-- Fixture rows per column: 'snap' (a share-snapshots URL) and 'legacy' (an
-- item-images URL written long before anything was recorded — an existing,
-- legitimate reference).
CREATE FUNCTION pg_temp.fixture(p_col text, p_tag text, p_url text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_tab text := split_part(p_col, '.', 1);
  v_col text := split_part(p_col, '.', 2);
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.posts (id, user_id, post_type, caption) VALUES (v_id, '00000000-0000-4000-8000-0000ce000001', 'text', p_tag || ':' || p_col);
  IF v_tab = 'posts' THEN
    EXECUTE format('UPDATE public.posts SET %I = $1 WHERE id = $2', v_col) USING p_url, v_id;
  ELSIF v_tab = 'post_images' THEN
    INSERT INTO public.post_images (post_id, image_url, source_type, sort_order) VALUES (v_id, p_url, 'library', 0);
  ELSE
    EXECUTE format('INSERT INTO public.%I (post_id, %I) VALUES ($1, $2)', v_tab, v_col) USING v_id, p_url;
  END IF;
END;
$$;
CREATE FUNCTION pg_temp.val(p_col text, p_tag text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  EXECUTE format('SELECT %I FROM public.%I WHERE %s', split_part(p_col, '.', 2), split_part(p_col, '.', 1),
                 CASE WHEN split_part(p_col, '.', 1) = 'posts' THEN 'caption = $1'
                      ELSE 'post_id = (SELECT id FROM public.posts WHERE caption = $1)' END)
    INTO v USING p_tag || ':' || p_col;
  RETURN v;
END;
$$;
SELECT pg_temp.fixture(c, 'snap', pg_temp.snap('fx/' || c || '.jpg')) FROM pcols;
SELECT pg_temp.fixture(c, 'legacy', pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/legacy.jpg'))) FROM pcols;

SELECT pg_temp.condemn('00000000-0000-4000-8000-0000cee00001/pl.jpg', 'claimed', 1, interval '10 minutes');  -- live claim (reserved)
SELECT pg_temp.condemn('00000000-0000-4000-8000-0000cee00001/pd.jpg', 'deleted', 1, NULL);                  -- previously claimed

SELECT is(pg_temp.ref(c, pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/pl.jpg'))), '42501 content_unavailable',
          c || ': a NEW row naming a file reserved by a live claim is refused') FROM pcols ORDER BY c;
SELECT is(pg_temp.ref(c, pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/pl.jpg')), 'snap'), '42501 content_unavailable',
          c || ': UPDATING a row to name it is refused') FROM pcols ORDER BY c;
SELECT is(pg_temp.ref(c, pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/pd.jpg'))), '42501 content_unavailable',
          c || ': a previously claimed (deleted) file stays unreferenceable') FROM pcols ORDER BY c;
SELECT is((SELECT state FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/pl.jpg'))), 'claimed',
          'the refused post references never released the claim');
SELECT is(pg_temp.val(c, 'snap'), pg_temp.snap('fx/' || c || '.jpg'), c || ': the refused UPDATE left the row unchanged') FROM pcols ORDER BY c;

-- Never claimed: a legitimate new reference cancels the pending deletion.
SELECT private.enqueue_item_image_deletion(pg_temp.p('00000000-0000-4000-8000-0000cee00001/pn-' || c || '.jpg'),
                                           '00000000-0000-4000-8000-0000ce000001', 'image_removed', interval '15 minutes') FROM pcols;
SELECT is(pg_temp.ref(c, pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/pn-' || c || '.jpg'))) ||
          ' / ' || (SELECT state || ':' || last_reason FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/pn-' || c || '.jpg'))),
          'ok / cancelled:rereferenced', c || ': naming a never-claimed file is accepted and CANCELS its deletion (file kept)') FROM pcols ORDER BY c;

-- Normal share-snapshots links: untouched, by INSERT and UPDATE.
SELECT is(pg_temp.ref(c, pg_temp.snap('new/' || c || '.jpg')) || ' / ' || pg_temp.ref(c, pg_temp.snap('upd/' || c || '.jpg'), 'snap'),
          'ok / ok', c || ': share-snapshots links are inserted and updated as before') FROM pcols ORDER BY c;
SELECT is((SELECT count(*)::int FROM private.item_image_deletions WHERE path LIKE '%/share-snapshots/%' OR path LIKE '%new/%' OR path LIKE '%upd/%'), 0,
          '…and never touch the ledger');

-- Existing references keep working and are never removed or changed — even
-- once the object they name is condemned (only reachable by data written
-- before this guard; the claim then keeps it as referenced_after_claim).
SELECT pg_temp.condemn('00000000-0000-4000-8000-0000cee00001/legacy.jpg', 'claimed', 1, interval '10 minutes');
SELECT is(pg_temp.ref(c, pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/legacy.jpg')), 'legacy') || ' / ' ||
          pg_temp.val(c, 'legacy'), 'ok / ' || pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/legacy.jpg')),
          c || ': rewriting an existing reference unchanged still works, and the value stays') FROM pcols ORDER BY c;
SELECT is((SELECT count(*)::int FROM public.posts WHERE caption = 'legacy:posts.image_url'
             AND image_url = pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/legacy.jpg'))), 1,
          'editing another column of a post that carries one is unaffected');
UPDATE public.posts SET content = 'edited' WHERE caption LIKE 'legacy:%';
SELECT is((SELECT count(*)::int FROM public.posts WHERE caption LIKE 'legacy:%' AND content = 'edited'), 6, '…(caption/content edits pass)');
-- Clearing a column is never blocked.
SELECT is(pg_temp.ref('posts.image_url', NULL, 'legacy'), 'ok', 'clearing an image URL is never blocked');

-- Moderation-hold interaction. A child-safety restriction of a post queues a
-- hold on every item-images URL it names. Because of the guard, that can only
-- be an object no worker has claimed — so the hold always precedes any claim,
-- and the claim then defers instead of deleting.
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence)
SELECT '00000000-0000-4000-8000-0000cea10001', '00000000-0000-4000-8000-0000ce000002', 'post', p.id, p.user_id, 'child_safety', '{"v":1}'
  FROM public.posts p WHERE p.image_url = pg_temp.u(pg_temp.p('00000000-0000-4000-8000-0000cee00001/pn-posts.image_url.jpg'));
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000003');
SELECT ok((public.admin_remove_content('00000000-0000-4000-8000-0000cea10001', 'child_safety', NULL, NULL, false) ->> 'moderation_id') IS NOT NULL,
          'an admin removes the post for child safety');
RESET ROLE;
SELECT ok(private.storage_path_held('item-images', pg_temp.p('00000000-0000-4000-8000-0000cee00001/pn-posts.image_url.jpg')),
          'the item-images file the post names is now held (evidence)');
SELECT private.enqueue_item_image_deletion(pg_temp.p('00000000-0000-4000-8000-0000cee00001/pn-posts.image_url.jpg'),
                                           '00000000-0000-4000-8000-0000ce000001', 'image_removed', interval '0');
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.item_image_deletion_claim(50, 600)
            WHERE path = pg_temp.p('00000000-0000-4000-8000-0000cee00001/pn-posts.image_url.jpg')), 0, '…so its deletion is never claimed');
RESET ROLE;
SELECT is((SELECT state || ':' || last_reason FROM pg_temp.led(pg_temp.p('00000000-0000-4000-8000-0000cee00001/pn-posts.image_url.jpg'))),
          'deferred:held', '…it is deferred as held');
SELECT ok(NOT EXISTS (SELECT 1 FROM private.media_quarantine q WHERE q.source_bucket = 'item-images'
                       AND q.source_path IN (pg_temp.p('00000000-0000-4000-8000-0000cee00001/pl.jpg'), pg_temp.p('00000000-0000-4000-8000-0000cee00001/pd.jpg'))),
          'no hold was ever queued on a reserved or deleted file (no post could name one)');

SELECT * FROM finish();
ROLLBACK;
