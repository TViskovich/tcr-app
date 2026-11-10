-- pgTAP test for 20261119120000_media_quarantine_foundation.sql (Phase 2B
-- M2.3b: private media quarantine foundation — schema, queueing, holds,
-- Storage guards, worker contract). Nothing here touches real files: Storage
-- objects are fixture rows only, and no job is executed.
-- Run against a LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(126);

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
CREATE FUNCTION pg_temp.u(p_bucket text, p_path text) RETURNS text LANGUAGE sql AS $$
  SELECT 'http://127.0.0.1:54321/storage/v1/object/public/' || p_bucket || '/' || p_path $$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid), pg_temp.logout(), pg_temp.u(text, text) TO authenticated, anon, service_role;
-- Job helpers (superuser).
CREATE FUNCTION pg_temp.job(p_bucket text, p_path text) RETURNS private.media_quarantine LANGUAGE sql AS $$
  SELECT * FROM private.media_quarantine WHERE source_bucket = p_bucket AND source_path = p_path ORDER BY created_at DESC LIMIT 1 $$;
CREATE FUNCTION pg_temp.holds(p_bucket text, p_path text) RETURNS integer LANGUAGE sql AS $$
  SELECT count(*)::int FROM private.media_quarantine_holds h JOIN private.media_quarantine q ON q.id = h.quarantine_id
   WHERE q.source_bucket = p_bucket AND q.source_path = p_path AND h.ended_at IS NULL $$;
CREATE FUNCTION pg_temp.mod(p_report uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$
  SELECT moderation_id FROM public.content_reports WHERE id = p_report $$;
-- Run a Storage delete/update as the CURRENT role and report how many rows it hit.
CREATE FUNCTION pg_temp.del(p_bucket text, p_name text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  IF p_name IS NULL THEN DELETE FROM storage.objects WHERE bucket_id = p_bucket; ELSE
  DELETE FROM storage.objects WHERE bucket_id = p_bucket AND name = p_name; END IF;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;
CREATE FUNCTION pg_temp.upd(p_bucket text, p_name text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  UPDATE storage.objects SET metadata = '{}' WHERE bucket_id = p_bucket AND name = p_name;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.del(text, text), pg_temp.upd(text, text) TO authenticated, anon;
CREATE TEMP TABLE leases (id uuid PRIMARY KEY, lease uuid);
GRANT ALL ON leases TO service_role;

-- ── 1. Shape and privileges ─────────────────────────────────────────────
SELECT ok(EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'moderation-quarantine' AND NOT public), 'a private moderation-quarantine bucket exists');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'moderation_quarantine_deny'
                   AND permissive = 'RESTRICTIVE' AND cmd = 'ALL'), 'a restrictive FOR ALL policy denies the bucket to every API role');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'storage' AND permissive = 'RESTRICTIVE' AND policyname IN
            ('moderation_hold_insert_guard', 'moderation_hold_update_guard', 'moderation_hold_delete_guard', 'moderation_child_safety_read_guard')), 4,
  'restrictive held-path guards for insert, update, delete and child-safety reads');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.oid IN ('private.media_quarantine'::regclass, 'private.media_quarantine_holds'::regclass,
             'private.media_quarantine_events'::regclass) AND c.relrowsecurity), 3, 'the three job tables have RLS on');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r,
             unnest(ARRAY['private.media_quarantine', 'private.media_quarantine_holds', 'private.media_quarantine_events']) t
           WHERE has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')), 0,
  'no API role has any privilege on the job tables');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.storage_paths_held(text,text[])', 'public.share_snapshot_copy_source_removed(uuid)',
             'public.media_quarantine_claim(integer,integer)', 'public.media_quarantine_advance(uuid,uuid,text,jsonb)']::regprocedure[]) f
           WHERE has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
              OR NOT has_function_privilege('service_role', f, 'EXECUTE')), 0, 'worker and cleanup functions: service role only');
SELECT ok(has_function_privilege('authenticated', 'public.admin_media_quarantine_status(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.admin_media_quarantine_status(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('service_role', 'public.admin_media_quarantine_status(uuid)', 'EXECUTE'),
  'admin status: signed-in (admin-checked) only');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'private' AND p.proname IN ('queue_media_hold', 'queue_media_for_restriction', 'queue_profile_field_media',
                   'end_media_holds', 'moderated_content_media', 'moderated_profile_fields_media', 'account_deletion_skip_held',
                   'reject_held_media_reference', 'media_child_safety_held', 'public_object_path')
             AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))), 0,
  'internal queueing helpers are not executable by collectors');
SELECT ok((SELECT bool_and(prosecdef AND proconfig = ARRAY['search_path=""']) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE (n.nspname = 'public' AND p.proname IN ('storage_paths_held', 'share_snapshot_copy_source_removed', 'media_quarantine_claim',
                   'media_quarantine_advance', 'admin_media_quarantine_status'))
              OR (n.nspname = 'private' AND p.proname IN ('queue_media_hold', 'queue_media_for_restriction', 'end_media_holds', 'storage_path_held'))),
  'elevated functions pin an empty search_path');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'media_quarantine_one_live'), 'one live job per source object (unique)');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- A is reported; B reposted A's items; C is an unrelated collector whose
-- files A's rows point at; R reports; M1, M2 are admins.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000bf000001', 'mq-a@example.invalid', '{"username":"mq_a"}'),
  ('00000000-0000-4000-8000-0000bf000002', 'mq-b@example.invalid', '{"username":"mq_b"}'),
  ('00000000-0000-4000-8000-0000bf000003', 'mq-c@example.invalid', '{"username":"mq_c"}'),
  ('00000000-0000-4000-8000-0000bf000004', 'mq-r@example.invalid', '{"username":"mq_r"}'),
  ('00000000-0000-4000-8000-0000bf000005', 'mq-m1@example.invalid', '{"username":"mq_m1"}'),
  ('00000000-0000-4000-8000-0000bf000006', 'mq-m2@example.invalid', '{"username":"mq_m2"}');
INSERT INTO public.admin_users (user_id) VALUES ('00000000-0000-4000-8000-0000bf000005'), ('00000000-0000-4000-8000-0000bf000006');
UPDATE public.profiles SET
  avatar_url = pg_temp.u('avatars', '00000000-0000-4000-8000-0000bf000001/av.jpg'),
  hero_image_url = pg_temp.u('avatars', '00000000-0000-4000-8000-0000bf000003/c.jpg'),       -- C's file
  showcase_badge_url = pg_temp.u('avatars', '00000000-0000-4000-8000-0000bf000001/badge/b.jpg')
 WHERE id = '00000000-0000-4000-8000-0000bf000001';
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata)
SELECT b, n, o::uuid, o, '{"size": 1234, "mimetype": "image/jpeg"}'::jsonb FROM (VALUES
  ('avatars', '00000000-0000-4000-8000-0000bf000001/av.jpg', '00000000-0000-4000-8000-0000bf000001'),
  ('avatars', '00000000-0000-4000-8000-0000bf000001/badge/b.jpg', '00000000-0000-4000-8000-0000bf000001'),
  ('avatars', '00000000-0000-4000-8000-0000bf000003/c.jpg', '00000000-0000-4000-8000-0000bf000003'),
  ('item-images', '00000000-0000-4000-8000-0000bf000001/q/a1.jpg', '00000000-0000-4000-8000-0000bf000001'),
  ('item-images', '00000000-0000-4000-8000-0000bf000001/q/a2.jpg', '00000000-0000-4000-8000-0000bf000001'),
  ('item-images', '00000000-0000-4000-8000-0000bf000001/q/b1.jpg', '00000000-0000-4000-8000-0000bf000001'),
  ('item-images', '00000000-0000-4000-8000-0000bf000001/covers/c.jpg', '00000000-0000-4000-8000-0000bf000001'),
  ('share-snapshots', '00000000-0000-4000-8000-0000bf000001/card_share/g/ia-1.jpg', '00000000-0000-4000-8000-0000bf000001'),
  ('share-snapshots', '00000000-0000-4000-8000-0000bf000003/x/c.jpg', '00000000-0000-4000-8000-0000bf000003'),
  ('share-snapshots', '00000000-0000-4000-8000-0000bf000002/folder_share/g2/ia-2.jpg', '00000000-0000-4000-8000-0000bf000002'),
  ('share-snapshots', '00000000-0000-4000-8000-0000bf000002/folder_share/g2/cover-2.jpg', '00000000-0000-4000-8000-0000bf000002'),
  ('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-x.jpg', '00000000-0000-4000-8000-0000bf000002'),
  ('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-y.jpg', '00000000-0000-4000-8000-0000bf000002'),
  ('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-v.jpg', '00000000-0000-4000-8000-0000bf000002'),
  ('share-snapshots', '00000000-0000-4000-8000-0000bf000002/folder_share/t/cover-z.jpg', '00000000-0000-4000-8000-0000bf000002'),
  ('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ib-w.jpg', '00000000-0000-4000-8000-0000bf000002'),
  ('dm-attachments', '00000000-0000-4000-8000-0000bfa00001/00000000-0000-4000-8000-0000bf500001/image.jpg', '00000000-0000-4000-8000-0000bf000001'),
  ('dm-attachments', '00000000-0000-4000-8000-0000bfa00001/00000000-0000-4000-8000-0000bf500002/image.jpg', '00000000-0000-4000-8000-0000bf000001')
) v(b, n, o);
CREATE TEMP TABLE fixture_objects AS SELECT bucket_id, name FROM storage.objects WHERE name LIKE '%0000bf%';

INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id, cover_source, cover_storage_path) VALUES
  ('00000000-0000-4000-8000-0000bff00001', '00000000-0000-4000-8000-0000bf000001', 'mq fa', true, NULL, 'upload', '00000000-0000-4000-8000-0000bf000001/covers/c.jpg');
INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000bff00002', '00000000-0000-4000-8000-0000bf000001', 'mq fa2', true, '00000000-0000-4000-8000-0000bff00001');
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status, item_type) VALUES
  ('00000000-0000-4000-8000-0000bfe00001', '00000000-0000-4000-8000-0000bff00001', '00000000-0000-4000-8000-0000bf000001', 'mq ia', true, 'active', 'sports_card'),
  ('00000000-0000-4000-8000-0000bfe00002', '00000000-0000-4000-8000-0000bff00002', '00000000-0000-4000-8000-0000bf000001', 'mq ib', true, 'active', 'sports_card');
INSERT INTO public.collection_item_images (id, item_id, user_id, image_url, storage_path, sort_order, is_primary) VALUES
  ('00000000-0000-4000-8000-0000bfb00001', '00000000-0000-4000-8000-0000bfe00001', '00000000-0000-4000-8000-0000bf000001', 'https://x.invalid/a1', '00000000-0000-4000-8000-0000bf000001/q/a1.jpg', 0, true),
  ('00000000-0000-4000-8000-0000bfb00002', '00000000-0000-4000-8000-0000bfe00001', '00000000-0000-4000-8000-0000bf000001', 'https://x.invalid/a2', '00000000-0000-4000-8000-0000bf000001/q/a2.jpg', 1, false),
  ('00000000-0000-4000-8000-0000bfb00003', '00000000-0000-4000-8000-0000bfe00002', '00000000-0000-4000-8000-0000bf000001', 'https://x.invalid/b1', '00000000-0000-4000-8000-0000bf000001/q/b1.jpg', 0, true);
INSERT INTO public.posts (id, user_id, post_type, caption, image_url) VALUES
  ('00000000-0000-4000-8000-0000bfd00001', '00000000-0000-4000-8000-0000bf000001', 'card_share', 'mq p1', 'https://evil.invalid/x.jpg'),
  ('00000000-0000-4000-8000-0000bfd00003', '00000000-0000-4000-8000-0000bf000001', 'text', 'mq p3', NULL);
INSERT INTO public.posts (id, user_id, post_type, caption, folder_id, folder_name, folder_item_count, folder_cover_snapshot_url) VALUES
  ('00000000-0000-4000-8000-0000bfd00002', '00000000-0000-4000-8000-0000bf000002', 'folder_share', 'mq p2', '00000000-0000-4000-8000-0000bff00001', 'mq fa', 1,
   pg_temp.u('share-snapshots', '00000000-0000-4000-8000-0000bf000002/folder_share/g2/cover-2.jpg'));
INSERT INTO public.card_share_items (post_id, item_id, snapshot_image_url, snapshot_title) VALUES
  ('00000000-0000-4000-8000-0000bfd00001', '00000000-0000-4000-8000-0000bfe00001', pg_temp.u('share-snapshots', '00000000-0000-4000-8000-0000bf000001/card_share/g/ia-1.jpg'), 'mq ia'),
  ('00000000-0000-4000-8000-0000bfd00001', '00000000-0000-4000-8000-0000bfe00002', pg_temp.u('share-snapshots', '00000000-0000-4000-8000-0000bf000003/x/c.jpg'), 'mq ib');
INSERT INTO public.folder_share_items (post_id, item_id, snapshot_image_url, snapshot_title) VALUES
  ('00000000-0000-4000-8000-0000bfd00002', '00000000-0000-4000-8000-0000bfe00001', pg_temp.u('share-snapshots', '00000000-0000-4000-8000-0000bf000002/folder_share/g2/ia-2.jpg'), 'mq ia');
INSERT INTO private.share_snapshot_copies (caller_id, kind, item_id, folder_id, source_path, dest_base, dest_path, status) VALUES
  ('00000000-0000-4000-8000-0000bf000002', 'item', '00000000-0000-4000-8000-0000bfe00001', NULL, '00000000-0000-4000-8000-0000bf000001/q/a1.jpg',
   '00000000-0000-4000-8000-0000bf000002/post/t/ia-x', '00000000-0000-4000-8000-0000bf000002/post/t/ia-x.jpg', 'published'),
  ('00000000-0000-4000-8000-0000bf000002', 'item', '00000000-0000-4000-8000-0000bfe00001', NULL, '00000000-0000-4000-8000-0000bf000001/q/a2.jpg',
   '00000000-0000-4000-8000-0000bf000002/post/t/ia-y', '00000000-0000-4000-8000-0000bf000002/post/t/ia-y.jpg', 'published'),
  ('00000000-0000-4000-8000-0000bf000002', 'item', '00000000-0000-4000-8000-0000bfe00001', NULL, '00000000-0000-4000-8000-0000bf000001/q/a1.jpg',
   '00000000-0000-4000-8000-0000bf000002/post/t/ia-v', '00000000-0000-4000-8000-0000bf000002/post/t/ia-v.jpg', 'rejected'),
  ('00000000-0000-4000-8000-0000bf000002', 'folder_cover', NULL, '00000000-0000-4000-8000-0000bff00001', '00000000-0000-4000-8000-0000bf000001/covers/c.jpg',
   '00000000-0000-4000-8000-0000bf000002/folder_share/t/cover-z', '00000000-0000-4000-8000-0000bf000002/folder_share/t/cover-z.jpg', 'published'),
  ('00000000-0000-4000-8000-0000bf000002', 'item', '00000000-0000-4000-8000-0000bfe00002', NULL, '00000000-0000-4000-8000-0000bf000001/q/b1.jpg',
   '00000000-0000-4000-8000-0000bf000002/post/t/ib-w', '00000000-0000-4000-8000-0000bf000002/post/t/ib-w.jpg', 'published');
INSERT INTO public.conversations (id) VALUES ('00000000-0000-4000-8000-0000bfa00001');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000bfa00001', '00000000-0000-4000-8000-0000bf000001'),
  ('00000000-0000-4000-8000-0000bfa00001', '00000000-0000-4000-8000-0000bf000004');
INSERT INTO public.messages (id, conversation_id, sender_id, body, attachment_type, attachment_storage_path, attachment_width, attachment_height) VALUES
  ('00000000-0000-4000-8000-0000bf500001', '00000000-0000-4000-8000-0000bfa00001', '00000000-0000-4000-8000-0000bf000001', NULL, 'image',
   '00000000-0000-4000-8000-0000bfa00001/00000000-0000-4000-8000-0000bf500001/image.jpg', 1, 1),
  ('00000000-0000-4000-8000-0000bf500002', '00000000-0000-4000-8000-0000bfa00001', '00000000-0000-4000-8000-0000bf000001', NULL, 'image',
   '00000000-0000-4000-8000-0000bfa00001/00000000-0000-4000-8000-0000bf500002/image.jpg', 1, 1);
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence) VALUES
  ('00000000-0000-4000-8000-0000bf100001', '00000000-0000-4000-8000-0000bf000004', 'post', '00000000-0000-4000-8000-0000bfd00001', '00000000-0000-4000-8000-0000bf000001', 'spam', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bf100002', '00000000-0000-4000-8000-0000bf000004', 'collection_item', '00000000-0000-4000-8000-0000bfe00001', '00000000-0000-4000-8000-0000bf000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bf100003', '00000000-0000-4000-8000-0000bf000003', 'collection_item', '00000000-0000-4000-8000-0000bfe00001', '00000000-0000-4000-8000-0000bf000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bf100004', '00000000-0000-4000-8000-0000bf000002', 'collection_item', '00000000-0000-4000-8000-0000bfe00001', '00000000-0000-4000-8000-0000bf000001', 'hate',
   '{"v":1,"image_refs":[{"bucket":"item-images","path":"00000000-0000-4000-8000-0000bf000001/q/a2.jpg"}]}'),
  ('00000000-0000-4000-8000-0000bf100005', '00000000-0000-4000-8000-0000bf000004', 'folder', '00000000-0000-4000-8000-0000bff00001', '00000000-0000-4000-8000-0000bf000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bf100006', '00000000-0000-4000-8000-0000bf000004', 'profile', '00000000-0000-4000-8000-0000bf000001', '00000000-0000-4000-8000-0000bf000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bf100007', '00000000-0000-4000-8000-0000bf000004', 'message', '00000000-0000-4000-8000-0000bf500001', '00000000-0000-4000-8000-0000bf000001', 'child_safety', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bf100008', '00000000-0000-4000-8000-0000bf000004', 'collection_item', '00000000-0000-4000-8000-0000bfe00002', '00000000-0000-4000-8000-0000bf000001', 'child_safety', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bf100009', '00000000-0000-4000-8000-0000bf000006', 'collection_item', '00000000-0000-4000-8000-0000bfe00001', '00000000-0000-4000-8000-0000bf000001', 'child_safety', '{"v":1}'),
  ('00000000-0000-4000-8000-0000bf10000a', '00000000-0000-4000-8000-0000bf000004', 'message', '00000000-0000-4000-8000-0000bf500002', '00000000-0000-4000-8000-0000bf000001', 'child_safety', '{"v":1}');

-- ── 2. A post restriction queues its own public snapshots ───────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000005');
SELECT is(public.admin_hide_content('00000000-0000-4000-8000-0000bf100001', 'pending_review') ->> 'state', 'hidden', 'M1 hides post P1');
RESET ROLE;
SELECT is((SELECT row(source_bucket, owner_id, media_kind, state, desired, origin_target_type, child_safety)::text
             FROM pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000001/card_share/g/ia-1.jpg')),
  row('share-snapshots', '00000000-0000-4000-8000-0000bf000001'::uuid, 'share_snapshot', 'pending', 'quarantine', 'post', false)::text,
  'the post''s own snapshot is queued: pending, owner verified, origin post');
SELECT is((SELECT size_bytes FROM pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000001/card_share/g/ia-1.jpg')), 1234::bigint,
  'size is captured from the object''s metadata');
SELECT ok((pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000003/x/c.jpg')).id IS NULL,
  'a URL in A''s post pointing at C''s file is NOT queued');
SELECT is((SELECT count(*)::int FROM private.media_quarantine_events WHERE moderation_id = pg_temp.mod('00000000-0000-4000-8000-0000bf100001')
             AND event = 'skipped' AND detail ->> 'reason' = 'not_owned'), 1, '…and the skip is recorded');
SELECT is((SELECT count(*)::int FROM private.media_quarantine_holds WHERE moderation_id = pg_temp.mod('00000000-0000-4000-8000-0000bf100001')), 1,
  'external URLs are ignored: exactly one hold for the post');

-- ── 3. An item restriction queues every public copy of it ───────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000005');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000bf100002', 'hate', NULL, NULL, false) ->> 'state', 'removed', 'M1 removes item IA');
RESET ROLE;
SELECT ok((pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-x.jpg')).id IS NOT NULL
      AND (pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-y.jpg')).id IS NOT NULL,
  'ledgered copies made by another collector are queued');
SELECT is((pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-x.jpg')).owner_id, '00000000-0000-4000-8000-0000bf000002'::uuid,
  '…owned by the collector whose namespace holds them');
SELECT ok((pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-v.jpg')).id IS NULL, 'a rejected ledger copy is not queued');
SELECT ok((pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/folder_share/g2/ia-2.jpg')).id IS NOT NULL,
  'an older snapshot row naming the item, in B''s own namespace, is queued');
SELECT is(pg_temp.holds('share-snapshots', '00000000-0000-4000-8000-0000bf000001/card_share/g/ia-1.jpg'), 2,
  'multiple holds: the post and the item both hold A''s snapshot');
SELECT is((SELECT count(*)::int FROM private.media_quarantine WHERE source_path = '00000000-0000-4000-8000-0000bf000001/card_share/g/ia-1.jpg'), 1,
  '…on a single job');
SELECT ok((pg_temp.job('item-images', '00000000-0000-4000-8000-0000bf000001/q/a1.jpg')).id IS NULL,
  'private item images are not queued without a child-safety restriction');

-- ── 4. Duplicates and idempotency ───────────────────────────────────────
CREATE TEMP TABLE before_dup AS SELECT (SELECT count(*) FROM private.media_quarantine) AS jobs, (SELECT count(*) FROM private.media_quarantine_holds) AS holds;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000006');
SELECT ok((public.admin_remove_content('00000000-0000-4000-8000-0000bf100003', 'hate', NULL, NULL, false) ->> 'moderation_id')::uuid
          = pg_temp.mod('00000000-0000-4000-8000-0000bf100002'), 'a second report on IA links the existing restriction');
RESET ROLE;
SELECT is((SELECT row((SELECT count(*) FROM private.media_quarantine), (SELECT count(*) FROM private.media_quarantine_holds))::text),
  (SELECT row(jobs, holds)::text FROM before_dup), 'linking queues no duplicate jobs or holds');
SELECT lives_ok($$ SELECT private.queue_media_for_restriction(m) FROM public.moderated_content m
                   WHERE m.id = pg_temp.mod('00000000-0000-4000-8000-0000bf100002') $$, 're-deriving the same restriction is harmless');
SELECT is((SELECT row((SELECT count(*) FROM private.media_quarantine), (SELECT count(*) FROM private.media_quarantine_holds))::text),
  (SELECT row(jobs, holds)::text FROM before_dup), '…and idempotent');
SELECT throws_ok($$ INSERT INTO private.media_quarantine (source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id, quarantine_path)
                    VALUES ('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-x.jpg', '00000000-0000-4000-8000-0000bf000002',
                            'share_snapshot', 'post', gen_random_uuid(), 'q/dup/original') $$, '23505', NULL,
  'a second live job for the same object is impossible');

-- ── 5. An image restriction queues only copies of that image ────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000005');
SELECT is(public.admin_hide_content('00000000-0000-4000-8000-0000bf100004', 'pending_review', NULL, 0) ->> 'state', 'hidden', 'M1 hides IA''s second image');
RESET ROLE;
SELECT is(pg_temp.holds('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-y.jpg'), 2, 'the copy made from that image gains a hold');
SELECT is(pg_temp.holds('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-x.jpg'), 1, 'a copy of the other image does not');

-- ── 6. A folder restriction covers its tree ─────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000005');
SELECT is(public.admin_hide_content('00000000-0000-4000-8000-0000bf100005', 'pending_review') ->> 'state', 'hidden', 'M1 hides folder FA');
RESET ROLE;
SELECT ok((pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/folder_share/t/cover-z.jpg')).id IS NOT NULL
      AND (pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/folder_share/g2/cover-2.jpg')).id IS NOT NULL,
  'ledgered and older folder-cover snapshots are queued');
SELECT ok((pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ib-w.jpg')).id IS NOT NULL,
  'a copy of an item in a subfolder is queued');
SELECT is(pg_temp.holds('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-x.jpg'), 2, 'items already held gain the folder''s hold');
SELECT ok((pg_temp.job('item-images', '00000000-0000-4000-8000-0000bf000001/covers/c.jpg')).id IS NULL, 'the private cover upload is not queued (no child safety)');

-- ── 7. Profile fields ───────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000005');
SELECT is((public.admin_clear_profile_fields('00000000-0000-4000-8000-0000bf100006', ARRAY['avatar_url', 'hero_image_url', 'showcase_badge_url'], 'hate')
             -> 'cleared') @> '["avatar_url","hero_image_url","showcase_badge_url"]'::jsonb, true, 'M1 clears A''s three image fields');
RESET ROLE;
SELECT is((SELECT row(media_kind, state, owner_id)::text FROM pg_temp.job('avatars', '00000000-0000-4000-8000-0000bf000001/av.jpg')),
  row('avatar', 'pending', '00000000-0000-4000-8000-0000bf000001'::uuid)::text, 'the cleared avatar is queued');
SELECT ok((pg_temp.job('avatars', '00000000-0000-4000-8000-0000bf000001/badge/b.jpg')).id IS NOT NULL, 'the cleared badge is queued');
SELECT ok((pg_temp.job('avatars', '00000000-0000-4000-8000-0000bf000003/c.jpg')).id IS NULL,
  'a hero URL pointing at C''s avatar is NOT queued (C''s unrelated image is safe)');
SELECT ok((SELECT h.profile_field_id IS NOT NULL FROM private.media_quarantine_holds h
            JOIN private.media_quarantine q ON q.id = h.quarantine_id WHERE q.source_path = '00000000-0000-4000-8000-0000bf000001/av.jpg'),
  'the avatar hold names its field restriction');

-- ── 8. Child safety ─────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000005');
SELECT is(public.admin_hide_content('00000000-0000-4000-8000-0000bf100007', 'urgent_risk') ->> 'state', 'hidden', 'M1 hides a DM photo reported for child safety');
SELECT is(public.admin_hide_content('00000000-0000-4000-8000-0000bf100008', 'urgent_risk') ->> 'state', 'hidden', 'M1 hides IB, reported for child safety');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000006');
SELECT ok((public.admin_remove_content('00000000-0000-4000-8000-0000bf100009', 'child_safety', NULL, NULL, false) ->> 'moderation_id')::uuid
          = pg_temp.mod('00000000-0000-4000-8000-0000bf100002'), 'a child-safety report links IA''s existing restriction');
RESET ROLE;
SELECT is((SELECT row(media_kind, child_safety, legal_hold, state)::text
             FROM pg_temp.job('dm-attachments', '00000000-0000-4000-8000-0000bfa00001/00000000-0000-4000-8000-0000bf500001/image.jpg')),
  row('dm_photo', true, true, 'pending')::text, 'the DM photo is queued with a legal hold');
SELECT ok((pg_temp.job('item-images', '00000000-0000-4000-8000-0000bf000001/q/b1.jpg')).child_safety, 'IB''s private image is queued for child safety');
SELECT ok((pg_temp.job('item-images', '00000000-0000-4000-8000-0000bf000001/q/a1.jpg')).child_safety
      AND (pg_temp.job('item-images', '00000000-0000-4000-8000-0000bf000001/q/a2.jpg')).child_safety,
  'upgrading IA''s restriction to child safety queues its private images');
SELECT ok((pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ia-x.jpg')).legal_hold
      AND (pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ib-w.jpg')).legal_hold,
  '…and upgrades its existing public jobs to a legal hold');
SELECT ok(NOT (pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/folder_share/t/cover-z.jpg')).child_safety,
  'jobs held only by other restrictions are not upgraded');
SELECT is((SELECT storage_path FROM public.resolve_item_images_for_signing(ARRAY['00000000-0000-4000-8000-0000bfb00003'::uuid])), NULL,
  'a child-safety-held image is not signable, even for its owner');
SELECT ok('00000000-0000-4000-8000-0000bfe00002'::uuid = ANY ((SELECT restricted_item_ids FROM public.folder_cover_eligibility(
             ARRAY['00000000-0000-4000-8000-0000bff00002'::uuid], '00000000-0000-4000-8000-0000bf000001'))::uuid[]),
  'nor usable as the owner''s own folder cover');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.export_owned_storage_objects('00000000-0000-4000-8000-0000bf000001')
                       WHERE name = '00000000-0000-4000-8000-0000bf000001/q/b1.jpg')
      AND EXISTS (SELECT 1 FROM public.export_owned_storage_objects('00000000-0000-4000-8000-0000bf000001')
                   WHERE name = '00000000-0000-4000-8000-0000bf000001/av.jpg'),
  'Download My Data excludes child-safety-held files, and keeps other held files');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000bf000001')
                       WHERE message_id = '00000000-0000-4000-8000-0000bf500001')
      AND EXISTS (SELECT 1 FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000bf000001')
                   WHERE message_id = '00000000-0000-4000-8000-0000bf500002'),
  '…and the child-safety-held DM photo, keeping the sender''s other photo');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000001');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'dm-attachments' AND name LIKE '00000000-0000-4000-8000-0000bfa00001/%'), 1,
  'the sender can read only their unheld DM photo (no signed URL for the held one)');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000004');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'dm-attachments' AND name LIKE '00000000-0000-4000-8000-0000bfa00001/%'), 1,
  '…and so can the recipient');
RESET ROLE;

-- ── 9. Atomicity with the moderation decision ───────────────────────────
CREATE TEMP TABLE before_fail AS SELECT (SELECT count(*) FROM public.moderated_content) AS mods,
  (SELECT count(*) FROM public.moderation_actions) AS audit, (SELECT count(*) FROM private.media_quarantine) AS jobs;
ALTER TABLE private.media_quarantine ADD CONSTRAINT test_reject_dm CHECK (source_path NOT LIKE '%0000bf500002%') NOT VALID;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000005');
SELECT throws_ok($$ SELECT public.admin_hide_content('00000000-0000-4000-8000-0000bf10000a', 'urgent_risk') $$, '23514', NULL,
  'a queueing failure fails the whole moderation action');
RESET ROLE;
ALTER TABLE private.media_quarantine DROP CONSTRAINT test_reject_dm;
SELECT is((SELECT row((SELECT count(*) FROM public.moderated_content), (SELECT count(*) FROM public.moderation_actions),
                      (SELECT count(*) FROM private.media_quarantine))::text),
  (SELECT row(mods, audit, jobs)::text FROM before_fail), '…leaving no restriction, audit row or job behind');
SELECT is((SELECT status FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000bf10000a'), 'open', '…and the report untouched');

-- ── 10. Held-path Storage guards ────────────────────────────────────────
SET LOCAL storage.allow_delete_query = 'true'; -- allow SQL deletes; RLS still applies
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000001');
SELECT is(pg_temp.del('avatars', '00000000-0000-4000-8000-0000bf000001/av.jpg'), 0, 'the owner cannot delete a held avatar');
SELECT is(pg_temp.upd('avatars', '00000000-0000-4000-8000-0000bf000001/av.jpg'), 0, '…nor overwrite it');
SELECT throws_ok($$ INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
                    ('item-images', '00000000-0000-4000-8000-0000bf000001/q/b1.jpg', '00000000-0000-4000-8000-0000bf000001', '00000000-0000-4000-8000-0000bf000001')
                    $$, '42501', NULL,
  '…nor upload over a held item image (the insert half of an upsert)');
SELECT lives_ok($$ INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
                   ('avatars', '00000000-0000-4000-8000-0000bf000001/new.jpg', '00000000-0000-4000-8000-0000bf000001', '00000000-0000-4000-8000-0000bf000001') $$,
  'ordinary uploads are unaffected');
SELECT is(pg_temp.del('avatars', '00000000-0000-4000-8000-0000bf000001/new.jpg'), 1, '…and so are ordinary deletions');
SELECT throws_ok($$ INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
                    ('moderation-quarantine', 'q/x/original', '00000000-0000-4000-8000-0000bf000001', '00000000-0000-4000-8000-0000bf000001') $$, '42501', NULL,
  'a collector cannot upload into the quarantine bucket');
RESET ROLE;
-- The worker's source removal (simulated), then a re-upload at the same path.
SET LOCAL storage.allow_delete_query = 'true';
DELETE FROM storage.objects WHERE bucket_id = 'avatars' AND name = '00000000-0000-4000-8000-0000bf000001/badge/b.jpg';
INSERT INTO storage.objects (bucket_id, name) VALUES ('moderation-quarantine', 'q/fixture/original');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000001');
SELECT throws_ok($$ INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
                    ('avatars', '00000000-0000-4000-8000-0000bf000001/badge/b.jpg', '00000000-0000-4000-8000-0000bf000001', '00000000-0000-4000-8000-0000bf000001') $$,
  '42501', NULL, 'nobody can re-upload at a reserved path');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'moderation-quarantine'), 0, 'collectors cannot see quarantine objects');
SELECT is(pg_temp.del('moderation-quarantine', NULL), 0, '…or delete them');
SELECT pg_temp.logout();
RESET ROLE;
SET LOCAL ROLE anon;
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'moderation-quarantine'), 0, 'neither can signed-out visitors');
RESET ROLE;

-- ── 11. Reference guards ────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000001');
SELECT throws_ok($$ UPDATE public.posts SET image_url = pg_temp.u('share-snapshots', '00000000-0000-4000-8000-0000bf000001/card_share/g/ia-1.jpg')
                    WHERE id = '00000000-0000-4000-8000-0000bfd00003' $$, '42501', 'content_unavailable', 'no new link to a held snapshot');
SELECT lives_ok($$ UPDATE public.posts SET caption = 'mq p3 edited' WHERE id = '00000000-0000-4000-8000-0000bfd00003' $$,
  'unrelated edits still work');
SELECT throws_ok($$ INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary) VALUES
                    ('00000000-0000-4000-8000-0000bfe00002', '00000000-0000-4000-8000-0000bf000001', 'https://x.invalid', '00000000-0000-4000-8000-0000bf000001/q/b1.jpg', 3, false) $$,
  '42501', 'content_unavailable', 'no new item image on a held path');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000003');
SELECT throws_ok($$ UPDATE public.profiles SET avatar_url = pg_temp.u('avatars', '00000000-0000-4000-8000-0000bf000001/av.jpg')
                    WHERE id = '00000000-0000-4000-8000-0000bf000003' $$, '42501', 'content_unavailable',
  'no other collector may use a held avatar URL');
SELECT lives_ok($$ UPDATE public.profiles SET avatar_url = pg_temp.u('avatars', '00000000-0000-4000-8000-0000bf000003/c.jpg')
                   WHERE id = '00000000-0000-4000-8000-0000bf000003' $$, 'an unheld avatar URL is fine');
RESET ROLE;

-- ── 12. Staging-upload reservation ──────────────────────────────────────
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('item-images', '00000000-0000-4000-8000-0000bf000001/1700000000001.jpg', '00000000-0000-4000-8000-0000bf000001', '00000000-0000-4000-8000-0000bf000001');
CREATE TEMP TABLE st AS SELECT (public.share_snapshot_copy_begin('00000000-0000-4000-8000-0000bf000001', 'post_photo', NULL, NULL,
  '00000000-0000-4000-8000-0000bf000001/1700000000001.jpg', NULL, NULL)) AS r;
SELECT is((public.share_snapshot_copy_publish(((SELECT r FROM st) ->> 'copy_id')::uuid, ((SELECT r FROM st) ->> 'destination') || '.jpg')) ->> 'delete_source',
  'true', 'staging copy published; its source may be deleted');
SELECT is((SELECT source_state FROM private.share_snapshot_copies WHERE id = ((SELECT r FROM st) ->> 'copy_id')::uuid), 'deleting',
  'the staging source is reserved while it is deleted');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000001');
SELECT throws_ok($$ INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary) VALUES
                    ('00000000-0000-4000-8000-0000bfe00002', '00000000-0000-4000-8000-0000bf000001', 'https://x.invalid',
                     '00000000-0000-4000-8000-0000bf000001/1700000000001.jpg', 4, false) $$, '42501', 'content_unavailable',
  'a reference to a staging path being deleted is refused (race closed)');
RESET ROLE;
SELECT ok(public.share_snapshot_copy_source_removed(((SELECT r FROM st) ->> 'copy_id')::uuid), 'the deletion is reported');
SELECT ok(NOT public.share_snapshot_copy_source_removed(((SELECT r FROM st) ->> 'copy_id')::uuid), '…only once');
SELECT ok(NOT public.share_snapshot_copy_source_removed(gen_random_uuid()), 'unknown copies are ignored');

-- ── 13. Worker contract: leases and transitions ─────────────────────────
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT * FROM public.media_quarantine_claim(1, 60) $$, '42501', NULL, 'collectors cannot claim jobs');
SELECT throws_ok($$ SELECT public.media_quarantine_advance(gen_random_uuid(), gen_random_uuid(), 'copied') $$, '42501', NULL, '…or advance them');
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000002');
SELECT throws_ok($$ SELECT public.admin_media_quarantine_status(gen_random_uuid()) $$, '42501', NULL, '…or read job status');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok($$ SELECT * FROM public.media_quarantine_claim(0, 60) $$, '22023', NULL, 'claim: limits are validated');
INSERT INTO leases SELECT id, lease_token FROM public.media_quarantine_claim(50, 120);
SELECT ok((SELECT count(*) FROM leases) > 0, 'the worker can claim pending jobs under a lease');
SELECT is((SELECT count(*)::int FROM public.media_quarantine_claim(50, 120)), 0, 'claimed jobs are not handed out twice');
RESET ROLE;
CREATE TEMP TABLE av AS SELECT q.id, l.lease FROM private.media_quarantine q JOIN leases l ON l.id = q.id
  WHERE q.source_path = '00000000-0000-4000-8000-0000bf000001/av.jpg';
CREATE TEMP TABLE sn AS SELECT q.id, l.lease FROM private.media_quarantine q JOIN leases l ON l.id = q.id
  WHERE q.source_path = '00000000-0000-4000-8000-0000bf000002/post/t/ia-x.jpg';
GRANT SELECT ON av, sn TO service_role;
SET LOCAL ROLE service_role;
SELECT is(public.media_quarantine_advance((SELECT id FROM av), gen_random_uuid(), 'copied') ->> 'reason', 'lease', 'a wrong lease is refused');
SELECT is(public.media_quarantine_advance((SELECT id FROM sn), (SELECT lease FROM sn), 'quarantined', '{"source_removed": "true"}') ->> 'reason',
  'invalid_transition', 'pending → quarantined (skipping copy and verify) is refused');
SELECT is(public.media_quarantine_advance((SELECT id FROM sn), (SELECT lease FROM sn), 'copied',
            jsonb_build_object('source_sha256', repeat('a', 64), 'quarantine_sha256', repeat('a', 64))) ->> 'ok', 'true', 'pending → copied');
SELECT is(public.media_quarantine_advance((SELECT id FROM sn), (SELECT lease FROM sn), 'restored') ->> 'reason',
  'invalid_transition', 'copied → restored is refused');
RESET ROLE;
UPDATE private.media_quarantine SET quarantine_sha256 = repeat('b', 64) WHERE id = (SELECT id FROM sn);
SET LOCAL ROLE service_role;
SELECT is(public.media_quarantine_advance((SELECT id FROM sn), (SELECT lease FROM sn), 'verified') ->> 'reason',
  'invalid_transition', 'verified needs matching checksums');
SELECT is(public.media_quarantine_advance((SELECT id FROM sn), (SELECT lease FROM sn), 'verified', jsonb_build_object('quarantine_sha256', repeat('a', 64))) ->> 'ok',
  'true', 'copied → verified once the copy''s checksum matches');
SELECT is(public.media_quarantine_advance((SELECT id FROM sn), (SELECT lease FROM sn), 'quarantined') ->> 'reason', 'source_not_removed',
  'no "quarantined" until the worker confirms the source was removed');
SELECT throws_ok($$ SELECT state FROM private.media_quarantine $$, '42501', NULL, 'the service role cannot read job rows directly');
RESET ROLE;
SELECT is((SELECT state FROM private.media_quarantine WHERE id = (SELECT id FROM sn)), 'verified', '…which are still verified, not quarantined');
SELECT is(public.media_quarantine_advance((SELECT id FROM sn), (SELECT lease FROM sn), 'verified', '{"error": "storage_timeout"}') ->> 'ok', 'true',
  'a failed attempt is recorded without changing state');
SELECT ok((SELECT next_attempt_at > clock_timestamp() AND last_error = 'storage_timeout' FROM private.media_quarantine WHERE id = (SELECT id FROM sn)),
  '…with a retry back-off');
SELECT throws_ok($$ UPDATE private.media_quarantine SET source_path = 'x/y' WHERE id = (SELECT id FROM sn) $$, '42501', 'media_quarantine_immutable',
  'a job''s source cannot be rewritten');
SELECT throws_ok($$ DELETE FROM private.media_quarantine WHERE id = (SELECT id FROM sn) $$, '42501', 'media_quarantine_immutable', 'jobs cannot be deleted');
SELECT throws_ok($$ DELETE FROM private.media_quarantine_holds $$, '42501', 'media_quarantine_immutable', 'holds cannot be deleted');
SELECT throws_ok($$ UPDATE private.media_quarantine_events SET event = 'x' $$, '42501', 'media_quarantine_immutable', 'events are append-only');
SELECT throws_ok($$ TRUNCATE private.media_quarantine_events $$, '42501', 'media_quarantine_immutable', 'events cannot be truncated');
SELECT throws_ok($$ UPDATE private.media_quarantine SET child_safety = false WHERE child_safety $$, '42501', 'media_quarantine_immutable',
  'a child-safety flag cannot be cleared');

-- Simulate the worker quarantining A's avatar (source removed).
SET LOCAL ROLE service_role;
SELECT is(public.media_quarantine_advance((SELECT id FROM av), (SELECT lease FROM av), 'copied',
            jsonb_build_object('source_sha256', repeat('c', 64), 'quarantine_sha256', repeat('c', 64))) ->> 'ok', 'true', 'avatar: copied');
SELECT is(public.media_quarantine_advance((SELECT id FROM av), (SELECT lease FROM av), 'verified') ->> 'ok', 'true', 'avatar: verified');
SELECT is(public.media_quarantine_advance((SELECT id FROM av), (SELECT lease FROM av), 'quarantined', '{"source_removed": "true"}') ->> 'ok', 'true',
  'avatar: quarantined once the source is gone');
RESET ROLE;
SET LOCAL storage.allow_delete_query = 'true';
DELETE FROM storage.objects WHERE bucket_id = 'avatars' AND name = '00000000-0000-4000-8000-0000bf000001/av.jpg';
SELECT ok((SELECT quarantined_at IS NOT NULL AND source_removed_at IS NOT NULL AND lease_token IS NULL FROM private.media_quarantine WHERE id = (SELECT id FROM av)),
  'quarantined: timestamps set, lease released');

-- ── 14. Restoration and release (no file is moved here) ─────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000006');
SELECT is(public.admin_restore_profile_fields('00000000-0000-4000-8000-0000bf000001', ARRAY['avatar_url'], 'resolved_in_error') ->> 'report_id', NULL,
  'restoring the avatar succeeds although its file is in quarantine (preserved evidence)');
RESET ROLE;
SELECT is((SELECT avatar_url FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000bf000001'),
  pg_temp.u('avatars', '00000000-0000-4000-8000-0000bf000001/av.jpg'), 'the original URL is written back');
SELECT is((SELECT row(state, desired)::text FROM private.media_quarantine WHERE id = (SELECT id FROM av)), row('restore_pending', 'restore')::text,
  'the job awaits the worker''s restore');
SELECT ok(NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'avatars' AND name = '00000000-0000-4000-8000-0000bf000001/av.jpg'),
  'and the file is NOT moved back by this gate');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000006');
SELECT lives_ok($$ SELECT public.admin_release_profile_fields('00000000-0000-4000-8000-0000bf000001', ARRAY['showcase_badge_url'], 'owner_may_edit') $$,
  'releasing the badge');
RESET ROLE;
SELECT ok((SELECT desired = 'retain' AND state = 'pending' AND retain_until BETWEEN now() + interval '89 days' AND now() + interval '91 days'
             FROM pg_temp.job('avatars', '00000000-0000-4000-8000-0000bf000001/badge/b.jpg')),
  'a released field keeps its file out, with a 90-day retention clock (purge is M4)');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000005');
SELECT lives_ok($$ SELECT public.admin_restore_content(pg_temp.mod('00000000-0000-4000-8000-0000bf100001'), 'resolved_in_error', NULL, 'overturn') $$,
  'restoring post P1');
RESET ROLE;
SELECT is((SELECT row(state, desired)::text FROM pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000001/card_share/g/ia-1.jpg')),
  row('pending', 'quarantine')::text, 'a file still held by the item stays queued for quarantine');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000005');
SELECT lives_ok($$ SELECT public.admin_restore_content(pg_temp.mod('00000000-0000-4000-8000-0000bf100005'), 'resolved_in_error', NULL, 'overturn') $$,
  'restoring folder FA');
RESET ROLE;
SELECT is((pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/folder_share/t/cover-z.jpg')).state, 'cancelled',
  'a pending job whose only hold ended with restore is cancelled — nothing to move');
SELECT ok((pg_temp.job('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ib-w.jpg')).state = 'pending'
      AND pg_temp.holds('share-snapshots', '00000000-0000-4000-8000-0000bf000002/post/t/ib-w.jpg') = 1,
  'a job also held by the child-safety restriction stays queued');
SELECT ok(NOT private.storage_path_held('share-snapshots', '00000000-0000-4000-8000-0000bf000002/folder_share/t/cover-z.jpg'),
  'a cancelled job no longer reserves its path');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000bf000005');
SELECT ok(jsonb_array_length(public.admin_media_quarantine_status(pg_temp.mod('00000000-0000-4000-8000-0000bf100002')) -> 'jobs') >= 5,
  'admins can read a restriction''s jobs');
SELECT ok(jsonb_array_length(public.admin_media_quarantine_status(pg_temp.mod('00000000-0000-4000-8000-0000bf100001')) -> 'skipped') = 1,
  '…and what was skipped');
RESET ROLE;

-- ── 15. Account deletion keeps evidence ─────────────────────────────────
INSERT INTO public.account_deletion_jobs (id, user_id, mode) VALUES ('00000000-0000-4000-8000-0000bfc00001', '00000000-0000-4000-8000-0000bf000001', 'immediate');
INSERT INTO public.account_deletion_storage_queue (job_id, bucket, path) VALUES
  ('00000000-0000-4000-8000-0000bfc00001', 'item-images', '00000000-0000-4000-8000-0000bf000001/q/b1.jpg'),
  ('00000000-0000-4000-8000-0000bfc00001', 'item-images', '00000000-0000-4000-8000-0000bf000001/covers/c.jpg');
SELECT is((SELECT array_agg(path ORDER BY path) FROM public.account_deletion_storage_queue WHERE job_id = '00000000-0000-4000-8000-0000bfc00001'),
  ARRAY['00000000-0000-4000-8000-0000bf000001/covers/c.jpg'], 'held files never enter the deletion manifest; others do');
CREATE TEMP TABLE before_del AS SELECT (SELECT count(*) FROM private.media_quarantine) AS jobs,
  (SELECT count(*) FROM private.media_quarantine_holds WHERE ended_at IS NULL) AS holds;
DELETE FROM auth.users WHERE id IN ('00000000-0000-4000-8000-0000bf000002', '00000000-0000-4000-8000-0000bf000001');
SELECT is((SELECT row((SELECT count(*) FROM private.media_quarantine), (SELECT count(*) FROM private.media_quarantine_holds WHERE ended_at IS NULL))::text),
  (SELECT row(jobs, holds)::text FROM before_del), 'deleting the reported and the reposting collectors keeps every job and active hold');
SELECT ok(EXISTS (SELECT 1 FROM private.media_quarantine WHERE owner_id = '00000000-0000-4000-8000-0000bf000001' AND child_safety),
  'child-safety evidence keeps its verified owner id');

-- ── 16. Queueing never touched a file ───────────────────────────────────
SELECT is((SELECT count(*)::int FROM fixture_objects f WHERE NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = f.bucket_id AND o.name = f.name)), 2,
  'only the two objects this test removed itself are gone');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'moderation-quarantine'), 1, 'the quarantine bucket holds only the test''s own object');

SELECT * FROM finish();
ROLLBACK;
