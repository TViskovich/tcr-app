-- pgTAP test for 20261118120000_media_signing_moderation.sql (Phase 2B M2.3a:
-- media signing and snapshot-copy security).
-- Run against a LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(95);

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
-- Copy ids handed back by the ledger, for later steps.
CREATE TEMP TABLE c (k text PRIMARY KEY, id uuid, dest text);
GRANT ALL ON c TO service_role;

-- ── 1. Shape and privileges ─────────────────────────────────────────────
CREATE TEMP TABLE m23_fns (fn regprocedure);
INSERT INTO m23_fns VALUES
  ('public.folder_cover_eligibility(uuid[],uuid)'), ('public.signing_blocked_image_ids(uuid,uuid[])'),
  ('public.share_snapshot_copy_begin(uuid,text,uuid,uuid,text,text,uuid)'), ('public.share_snapshot_copy_publish(uuid,text)'),
  ('public.share_snapshot_copy_discard(uuid[])'), ('public.share_snapshot_copy_removed(uuid[])'),
  ('public.share_snapshot_eligible_items(uuid,uuid[])');

SELECT is((SELECT count(*)::int FROM m23_fns t JOIN pg_proc p ON p.oid = t.fn
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""']), 7,
  'all 7 helpers are SECURITY DEFINER with a pinned, empty search_path');
SELECT is((SELECT count(*)::int FROM m23_fns t
           WHERE has_function_privilege('anon', t.fn, 'EXECUTE') OR has_function_privilege('authenticated', t.fn, 'EXECUTE')), 0,
  'no helper is executable by signed-out or signed-in collectors');
SELECT is((SELECT count(*)::int FROM m23_fns t WHERE has_function_privilege('service_role', t.fn, 'EXECUTE')), 7,
  'every helper is executable by the service role');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'private' AND p.proname IN ('item_images_path_protected', 'share_snapshot_problem')
             AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('service_role', p.oid, 'EXECUTE'))), 0,
  'internal snapshot checks are executable by no API role');
SELECT has_table('private', 'share_snapshot_copies', 'the copy ledger exists, outside the exposed schemas');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'private.share_snapshot_copies'::regclass)
      AND NOT has_table_privilege('anon', 'private.share_snapshot_copies', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_table_privilege('authenticated', 'private.share_snapshot_copies', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_table_privilege('service_role', 'private.share_snapshot_copies', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'the ledger: RLS on, no table privileges for any API role');

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT * FROM public.folder_cover_eligibility(ARRAY[gen_random_uuid()], NULL) $$, '42501', NULL,
  'a signed-in collector cannot call folder_cover_eligibility');
SELECT throws_ok($$ SELECT public.share_snapshot_copy_begin(gen_random_uuid(), 'post_photo', NULL, NULL, 'a/b.jpg', NULL, NULL) $$, '42501', NULL,
  'a signed-in collector cannot reserve a copy');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT * FROM public.signing_blocked_image_ids(gen_random_uuid(), ARRAY[gen_random_uuid()]) $$, '42501', NULL,
  'a signed-out caller cannot probe blocks');
RESET ROLE;

-- ── Fixtures ────────────────────────────────────────────────────────────
-- A owns the folders; O is another collector; K is blocked by A; Z owns a
-- private item; H is pending deletion (hidden); M is the moderating admin.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000be000001', 'm23-a@example.invalid', '{"username":"m23_a"}'),
  ('00000000-0000-4000-8000-0000be000002', 'm23-o@example.invalid', '{"username":"m23_o"}'),
  ('00000000-0000-4000-8000-0000be000003', 'm23-k@example.invalid', '{"username":"m23_k"}'),
  ('00000000-0000-4000-8000-0000be000004', 'm23-z@example.invalid', '{"username":"m23_z"}'),
  ('00000000-0000-4000-8000-0000be000005', 'm23-h@example.invalid', '{"username":"m23_h"}'),
  ('00000000-0000-4000-8000-0000be000006', 'm23-m@example.invalid', '{"username":"m23_m"}');
INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES ('00000000-0000-4000-8000-0000be000001', '00000000-0000-4000-8000-0000be000003');

INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id, cover_source, cover_item_id, cover_storage_path) VALUES
  ('00000000-0000-4000-8000-0000bef00001', '00000000-0000-4000-8000-0000be000001', 'm23 public', true, NULL, 'first_card', NULL, NULL),
  ('00000000-0000-4000-8000-0000bef00002', '00000000-0000-4000-8000-0000be000001', 'm23 private grail', false, NULL, 'upload', NULL, '00000000-0000-4000-8000-0000be000001/covers/c2.jpg'),
  ('00000000-0000-4000-8000-0000bef00004', '00000000-0000-4000-8000-0000be000001', 'm23 cover is a moderated image', true, NULL, 'upload', NULL, '00000000-0000-4000-8000-0000be000001/m23/1.jpg'),
  ('00000000-0000-4000-8000-0000bef00005', '00000000-0000-4000-8000-0000be000005', 'm23 hidden owner', true, NULL, 'first_card', NULL, NULL),
  ('00000000-0000-4000-8000-0000bef00006', '00000000-0000-4000-8000-0000be000001', 'm23 upload cover', true, NULL, 'upload', NULL, '00000000-0000-4000-8000-0000be000001/covers/c6.jpg'),
  ('00000000-0000-4000-8000-0000bef0000a', '00000000-0000-4000-8000-0000be000003', 'm23 K public', true, NULL, 'first_card', NULL, NULL),
  ('00000000-0000-4000-8000-0000bef0000b', '00000000-0000-4000-8000-0000be000004', 'm23 Z private', false, NULL, 'first_card', NULL, NULL);
INSERT INTO public.folders (id, user_id, name, is_public, parent_folder_id) VALUES
  ('00000000-0000-4000-8000-0000bef00007', '00000000-0000-4000-8000-0000be000001', 'm23 child of grail', true, '00000000-0000-4000-8000-0000bef00002');
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status, item_type, created_at) VALUES
  ('00000000-0000-4000-8000-0000bee00001', '00000000-0000-4000-8000-0000bef00001', '00000000-0000-4000-8000-0000be000001', 'm23 i1 image moderated', true, 'active', 'sports_card', now() - interval '3 hours'),
  ('00000000-0000-4000-8000-0000bee00002', '00000000-0000-4000-8000-0000bef00001', '00000000-0000-4000-8000-0000be000001', 'm23 i2 item moderated', true, 'active', 'sports_card', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-0000bee00003', '00000000-0000-4000-8000-0000bef00001', '00000000-0000-4000-8000-0000be000001', 'm23 i3 clean', true, 'active', 'sports_card', now() - interval '4 hours'),
  ('00000000-0000-4000-8000-0000bee00004', '00000000-0000-4000-8000-0000bef00001', '00000000-0000-4000-8000-0000be000001', 'm23 i4 private', false, 'active', 'sports_card', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-0000bee00005', '00000000-0000-4000-8000-0000bef00002', '00000000-0000-4000-8000-0000be000001', 'm23 i5 in grail folder', true, 'active', 'sports_card', now()),
  ('00000000-0000-4000-8000-0000bee0000a', '00000000-0000-4000-8000-0000bef0000a', '00000000-0000-4000-8000-0000be000003', 'm23 K item', true, 'active', 'sports_card', now()),
  ('00000000-0000-4000-8000-0000bee0000b', '00000000-0000-4000-8000-0000bef0000b', '00000000-0000-4000-8000-0000be000004', 'm23 Z private item', false, 'active', 'sports_card', now()),
  ('00000000-0000-4000-8000-0000bee0000c', '00000000-0000-4000-8000-0000bef00005', '00000000-0000-4000-8000-0000be000005', 'm23 H item', true, 'active', 'sports_card', now());
-- F3: a public folder whose picked cover is Z's PRIVATE item; F8: a public
-- folder whose picked cover is I5, an item inside the (soon moderated) F2.
-- (20261121120000 now refuses F3's cover outright; it is inserted as a legacy
-- row predating that guard, with triggers suspended for this one statement, so
-- the signing defense in depth stays tested.)
SET LOCAL session_replication_role = replica;
INSERT INTO public.folders (id, user_id, name, is_public, cover_source, cover_item_id) VALUES
  ('00000000-0000-4000-8000-0000bef00003', '00000000-0000-4000-8000-0000be000001', 'm23 foreign cover', true, 'item', '00000000-0000-4000-8000-0000bee0000b');
SET LOCAL session_replication_role = origin;
INSERT INTO public.folders (id, user_id, name, is_public, cover_source, cover_item_id) VALUES
  ('00000000-0000-4000-8000-0000bef00008', '00000000-0000-4000-8000-0000be000001', 'm23 cover from grail folder', true, 'item', '00000000-0000-4000-8000-0000bee00005');
INSERT INTO public.collection_item_images (id, item_id, user_id, image_url, storage_path, sort_order, is_primary) VALUES
  ('00000000-0000-4000-8000-0000beb00001', '00000000-0000-4000-8000-0000bee00001', '00000000-0000-4000-8000-0000be000001', 'https://x.invalid/1', '00000000-0000-4000-8000-0000be000001/m23/1.jpg', 0, true),
  ('00000000-0000-4000-8000-0000beb00002', '00000000-0000-4000-8000-0000bee00002', '00000000-0000-4000-8000-0000be000001', 'https://x.invalid/2', '00000000-0000-4000-8000-0000be000001/m23/2.jpg', 0, true),
  ('00000000-0000-4000-8000-0000beb00003', '00000000-0000-4000-8000-0000bee00003', '00000000-0000-4000-8000-0000be000001', 'https://x.invalid/3', '00000000-0000-4000-8000-0000be000001/m23/3.jpg', 0, true),
  ('00000000-0000-4000-8000-0000beb00004', '00000000-0000-4000-8000-0000bee00004', '00000000-0000-4000-8000-0000be000001', 'https://x.invalid/4', '00000000-0000-4000-8000-0000be000001/m23/4.jpg', 0, true),
  ('00000000-0000-4000-8000-0000beb00005', '00000000-0000-4000-8000-0000bee00005', '00000000-0000-4000-8000-0000be000001', 'https://x.invalid/5', '00000000-0000-4000-8000-0000be000001/m23/5.jpg', 0, true),
  ('00000000-0000-4000-8000-0000beb0000a', '00000000-0000-4000-8000-0000bee0000a', '00000000-0000-4000-8000-0000be000003', 'https://x.invalid/k', '00000000-0000-4000-8000-0000be000003/m23/k.jpg', 0, true);
INSERT INTO public.profile_grail_slots (user_id, slot_index, entry_type, item_id, collection_id) VALUES
  ('00000000-0000-4000-8000-0000be000001', 1, 'collection', NULL, '00000000-0000-4000-8000-0000bef00002');
-- A text post still carrying a legacy item-images URL, and a report whose
-- evidence names an item-images path: both make those paths "referenced".
INSERT INTO public.posts (id, user_id, post_type, content, image_url) VALUES
  ('00000000-0000-4000-8000-0000bed00001', '00000000-0000-4000-8000-0000be000001', 'text', 'm23 post',
   'http://127.0.0.1:54321/storage/v1/object/public/item-images/00000000-0000-4000-8000-0000be000001/posted.jpg');
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence) VALUES
  ('00000000-0000-4000-8000-0000be100001', '00000000-0000-4000-8000-0000be000002', 'collection_item', '00000000-0000-4000-8000-0000bee00001', '00000000-0000-4000-8000-0000be000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000be100002', '00000000-0000-4000-8000-0000be000002', 'collection_item', '00000000-0000-4000-8000-0000bee00002', '00000000-0000-4000-8000-0000be000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000be100003', '00000000-0000-4000-8000-0000be000002', 'folder', '00000000-0000-4000-8000-0000bef00002', '00000000-0000-4000-8000-0000be000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000be100004', '00000000-0000-4000-8000-0000be000002', 'collection_item', '00000000-0000-4000-8000-0000bee00003', '00000000-0000-4000-8000-0000be000001', 'hate', '{"v":1}'),
  ('00000000-0000-4000-8000-0000be100005', '00000000-0000-4000-8000-0000be000002', 'collection_item', '00000000-0000-4000-8000-0000bee00004', '00000000-0000-4000-8000-0000be000001', 'hate',
   '{"v":1,"image_refs":[{"bucket":"item-images","path":"00000000-0000-4000-8000-0000be000001/evidence.jpg"}]}');
INSERT INTO public.moderated_content (target_type, target_id, owner_id, state, reason_code, report_id, created_by) VALUES
  ('item_image', '00000000-0000-4000-8000-0000beb00001', '00000000-0000-4000-8000-0000be000001', 'hidden', 'hate', '00000000-0000-4000-8000-0000be100001', '00000000-0000-4000-8000-0000be000006'),
  ('collection_item', '00000000-0000-4000-8000-0000bee00002', '00000000-0000-4000-8000-0000be000001', 'removed', 'hate', '00000000-0000-4000-8000-0000be100002', '00000000-0000-4000-8000-0000be000006');
INSERT INTO public.account_lifecycle (user_id, state, mode, requested_at, scheduled_for)
  VALUES ('00000000-0000-4000-8000-0000be000005', 'pending_deletion', 'scheduled', now(), now() + interval '30 days');
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('avatars', '00000000-0000-4000-8000-0000be000001/a.jpg', '00000000-0000-4000-8000-0000be000001', '00000000-0000-4000-8000-0000be000001'),
  ('avatars', '00000000-0000-4000-8000-0000be000002/o.jpg', '00000000-0000-4000-8000-0000be000002', '00000000-0000-4000-8000-0000be000002'),
  ('share-snapshots', '00000000-0000-4000-8000-0000be000001/post/x/s.jpg', '00000000-0000-4000-8000-0000be000001', '00000000-0000-4000-8000-0000be000001');

-- Shorthands (superuser-owned temp functions calling the service-role helpers).
CREATE FUNCTION pg_temp.auth(p_folder uuid, p_caller uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT coalesce((SELECT authorized FROM public.folder_cover_eligibility(ARRAY[p_folder], p_caller)), false) $$;
CREATE FUNCTION pg_temp.restricted(p_folder uuid, p_caller uuid) RETURNS uuid[] LANGUAGE sql AS $$
  SELECT ARRAY(SELECT unnest(restricted_item_ids) ORDER BY 1) FROM public.folder_cover_eligibility(ARRAY[p_folder], p_caller) $$;
CREATE FUNCTION pg_temp.begin_copy(p_caller uuid, p_kind text, p_item uuid, p_folder uuid, p_path text, p_type text, p_target uuid)
RETURNS jsonb LANGUAGE sql AS $$ SELECT public.share_snapshot_copy_begin(p_caller, p_kind, p_item, p_folder, p_path, p_type, p_target) $$;
GRANT EXECUTE ON FUNCTION pg_temp.auth(uuid, uuid), pg_temp.restricted(uuid, uuid),
  pg_temp.begin_copy(uuid, text, uuid, uuid, text, text, uuid) TO service_role;

-- ── 2. Folder-cover eligibility ─────────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT ok(pg_temp.auth('00000000-0000-4000-8000-0000bef00001', '00000000-0000-4000-8000-0000be000002'), 'O: public folder authorized');
SELECT is(pg_temp.restricted('00000000-0000-4000-8000-0000bef00001', '00000000-0000-4000-8000-0000be000002'),
  ARRAY['00000000-0000-4000-8000-0000bee00001', '00000000-0000-4000-8000-0000bee00002']::uuid[],
  'O: the moderated item and the item with a moderated primary image are restricted');
SELECT ok(pg_temp.auth('00000000-0000-4000-8000-0000bef00001', NULL), 'signed out: public folder authorized');
SELECT is(pg_temp.restricted('00000000-0000-4000-8000-0000bef00001', NULL),
  ARRAY['00000000-0000-4000-8000-0000bee00001', '00000000-0000-4000-8000-0000bee00002']::uuid[], 'signed out: same restricted items');
SELECT ok(pg_temp.auth('00000000-0000-4000-8000-0000bef00001', '00000000-0000-4000-8000-0000be000001')
      AND pg_temp.restricted('00000000-0000-4000-8000-0000bef00001', '00000000-0000-4000-8000-0000be000001') = '{}',
  'owner: authorized, nothing restricted (owners keep their own moderated content)');
SELECT ok(NOT pg_temp.auth('00000000-0000-4000-8000-0000bef00001', '00000000-0000-4000-8000-0000be000003'), 'K (blocked by the owner): not authorized');
SELECT ok(NOT pg_temp.auth('00000000-0000-4000-8000-0000bef0000a', '00000000-0000-4000-8000-0000be000001'), 'A: not authorized for the folder of someone A blocked');
SELECT ok(pg_temp.auth('00000000-0000-4000-8000-0000bef00002', '00000000-0000-4000-8000-0000be000002')
      AND pg_temp.auth('00000000-0000-4000-8000-0000bef00002', NULL),
  'Grail exception preserved: a private folder in its owner''s Grail slot is authorized');
SELECT ok(NOT pg_temp.auth('00000000-0000-4000-8000-0000bef00002', '00000000-0000-4000-8000-0000be000003'), 'the Grail exception does not override a block');
SELECT is((SELECT cover_item_owned FROM public.folder_cover_eligibility(ARRAY['00000000-0000-4000-8000-0000bef00003'::uuid], '00000000-0000-4000-8000-0000be000002')), false,
  'O: a picked cover that is another collector''s item is flagged');
SELECT is((SELECT cover_item_owned FROM public.folder_cover_eligibility(ARRAY['00000000-0000-4000-8000-0000bef00003'::uuid], '00000000-0000-4000-8000-0000be000001')), false,
  'owner: flagged too (a folder never signs another collector''s item)');
SELECT is((SELECT cover_item_owned FROM public.folder_cover_eligibility(ARRAY['00000000-0000-4000-8000-0000bef00008'::uuid], '00000000-0000-4000-8000-0000be000002')), true,
  'an own picked cover item is not flagged');
SELECT is((SELECT cover_path_restricted FROM public.folder_cover_eligibility(ARRAY['00000000-0000-4000-8000-0000bef00004'::uuid], '00000000-0000-4000-8000-0000be000002')), true,
  'O: an upload cover that is a moderated item image is restricted');
SELECT is((SELECT cover_path_restricted FROM public.folder_cover_eligibility(ARRAY['00000000-0000-4000-8000-0000bef00004'::uuid], '00000000-0000-4000-8000-0000be000001')), false,
  'owner: the same cover is not restricted');
SELECT is((SELECT cover_path_restricted FROM public.folder_cover_eligibility(ARRAY['00000000-0000-4000-8000-0000bef00006'::uuid], '00000000-0000-4000-8000-0000be000002')), false,
  'an ordinary upload cover is not restricted');
SELECT ok(NOT pg_temp.auth('00000000-0000-4000-8000-0000bef00005', '00000000-0000-4000-8000-0000be000002'), 'a hidden owner''s folder: not authorized');
SELECT ok(NOT pg_temp.auth('00000000-0000-4000-8000-0000bef00001', '00000000-0000-4000-8000-0000be000005'), 'a hidden caller: not authorized');
SELECT is((SELECT count(*)::int FROM public.folder_cover_eligibility(ARRAY[gen_random_uuid()], NULL)), 0, 'unknown folder: no row');
SELECT is((SELECT count(*)::int FROM public.folder_cover_eligibility(
             ARRAY(SELECT '00000000-0000-4000-8000-0000bef00001'::uuid FROM generate_series(1, 51)), NULL)), 0,
  'more than 50 ids: nothing');
RESET ROLE;

-- Moderate F2 (the private Grail folder).
INSERT INTO public.moderated_content (target_type, target_id, owner_id, state, reason_code, report_id, created_by) VALUES
  ('folder', '00000000-0000-4000-8000-0000bef00002', '00000000-0000-4000-8000-0000be000001', 'hidden', 'hate', '00000000-0000-4000-8000-0000be100003', '00000000-0000-4000-8000-0000be000006');
SET LOCAL ROLE service_role;
SELECT ok(NOT pg_temp.auth('00000000-0000-4000-8000-0000bef00002', '00000000-0000-4000-8000-0000be000002')
      AND NOT pg_temp.auth('00000000-0000-4000-8000-0000bef00002', NULL),
  'a moderated folder in a Grail slot: not authorized for others or signed-out visitors');
SELECT ok(pg_temp.auth('00000000-0000-4000-8000-0000bef00002', '00000000-0000-4000-8000-0000be000001'), 'the owner still sees it');
SELECT ok(NOT pg_temp.auth('00000000-0000-4000-8000-0000bef00007', '00000000-0000-4000-8000-0000be000002'), 'a subfolder of the moderated folder: not authorized');
SELECT ok('00000000-0000-4000-8000-0000bee00005' = ANY (pg_temp.restricted('00000000-0000-4000-8000-0000bef00008', '00000000-0000-4000-8000-0000be000002')),
  'a picked cover item living in a moderated folder is restricted');

-- ── 3. Item-image blocks ────────────────────────────────────────────────
SELECT is(ARRAY(SELECT public.signing_blocked_image_ids('00000000-0000-4000-8000-0000be000003', ARRAY['00000000-0000-4000-8000-0000beb00003'::uuid])),
  ARRAY['00000000-0000-4000-8000-0000beb00003']::uuid[], 'K: the blocking owner''s image is reported');
SELECT is(ARRAY(SELECT public.signing_blocked_image_ids('00000000-0000-4000-8000-0000be000001', ARRAY['00000000-0000-4000-8000-0000beb0000a'::uuid])),
  ARRAY['00000000-0000-4000-8000-0000beb0000a']::uuid[], 'A: the image of someone A blocked is reported (both directions)');
SELECT is(ARRAY(SELECT public.signing_blocked_image_ids('00000000-0000-4000-8000-0000be000002', ARRAY['00000000-0000-4000-8000-0000beb00003'::uuid])),
  '{}'::uuid[], 'O (no block): nothing');
SELECT is(ARRAY(SELECT public.signing_blocked_image_ids('00000000-0000-4000-8000-0000be000001', ARRAY['00000000-0000-4000-8000-0000beb00003'::uuid])),
  '{}'::uuid[], 'the owner: nothing');
SELECT is(ARRAY(SELECT public.signing_blocked_image_ids(NULL, ARRAY['00000000-0000-4000-8000-0000beb00003'::uuid])),
  '{}'::uuid[], 'signed out: nothing');

-- ── 4. Republishable items (folder share) ───────────────────────────────
SELECT is(ARRAY(SELECT x FROM public.share_snapshot_eligible_items('00000000-0000-4000-8000-0000be000002', ARRAY[
             '00000000-0000-4000-8000-0000bee00001', '00000000-0000-4000-8000-0000bee00002', '00000000-0000-4000-8000-0000bee00003',
             '00000000-0000-4000-8000-0000bee00004', '00000000-0000-4000-8000-0000bee00005', '00000000-0000-4000-8000-0000bee0000c']::uuid[]) x ORDER BY 1),
  ARRAY['00000000-0000-4000-8000-0000bee00003', '00000000-0000-4000-8000-0000bee00004']::uuid[],
  'O: moderated items, items in a moderated folder and a hidden owner''s items are not republishable');
SELECT is(ARRAY(SELECT x FROM public.share_snapshot_eligible_items('00000000-0000-4000-8000-0000be000001', ARRAY[
             '00000000-0000-4000-8000-0000bee00001', '00000000-0000-4000-8000-0000bee00002', '00000000-0000-4000-8000-0000bee00003']::uuid[]) x ORDER BY 1),
  ARRAY['00000000-0000-4000-8000-0000bee00003']::uuid[], 'the owner cannot republish their own moderated items either');
SELECT is((SELECT count(*)::int FROM public.share_snapshot_eligible_items('00000000-0000-4000-8000-0000be000003', ARRAY['00000000-0000-4000-8000-0000bee00003']::uuid[])), 0,
  'K (blocked): nothing republishable');
SELECT is((SELECT count(*)::int FROM public.share_snapshot_eligible_items(NULL, ARRAY['00000000-0000-4000-8000-0000bee00003']::uuid[])), 0,
  'no caller: nothing');

-- ── 5. Reserving a copy ─────────────────────────────────────────────────
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'item', '00000000-0000-4000-8000-0000bee00002', NULL,
            '00000000-0000-4000-8000-0000be000001/m23/2.jpg', 'card_share', gen_random_uuid()) ->> 'reason', 'restricted',
  'owner: a moderated item cannot be copied to a public snapshot');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'item', '00000000-0000-4000-8000-0000bee00001', NULL,
            '00000000-0000-4000-8000-0000be000001/m23/1.jpg', 'card_share', gen_random_uuid()) ->> 'reason', 'restricted',
  'owner: an item whose image is moderated cannot be copied');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'item', '00000000-0000-4000-8000-0000bee00005', NULL,
            '00000000-0000-4000-8000-0000be000001/m23/5.jpg', 'post', gen_random_uuid()) ->> 'reason', 'restricted',
  'owner: an item inside a moderated folder cannot be copied');
INSERT INTO c SELECT 'item', (r ->> 'copy_id')::uuid, r ->> 'destination'
  FROM (SELECT pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'item', '00000000-0000-4000-8000-0000bee00003', NULL,
          '00000000-0000-4000-8000-0000be000001/m23/3.jpg', 'card_share', '00000000-0000-4000-8000-0000be900001') r) x;
SELECT ok((SELECT id IS NOT NULL FROM c WHERE k = 'item'), 'owner: a clean item is reserved');
SELECT is((SELECT dest FROM c WHERE k = 'item'),
  '00000000-0000-4000-8000-0000be000001/card_share/00000000-0000-4000-8000-0000be900001/00000000-0000-4000-8000-0000bee00003-' || (SELECT id FROM c WHERE k = 'item'),
  'the destination is derived from the copy id, under the caller''s own prefix');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'item', '00000000-0000-4000-8000-0000bee00003', NULL,
            '00000000-0000-4000-8000-0000be000001/m23/4.jpg', 'post', gen_random_uuid()) ->> 'reason', 'source',
  'a path that is not this item''s image is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000003', 'item', '00000000-0000-4000-8000-0000bee00003', NULL,
            '00000000-0000-4000-8000-0000be000001/m23/3.jpg', 'post', gen_random_uuid()) ->> 'reason', 'source',
  'K (blocked): refused, without revealing the block');
SELECT ok((pg_temp.begin_copy('00000000-0000-4000-8000-0000be000002', 'item', '00000000-0000-4000-8000-0000bee00003', NULL,
            '00000000-0000-4000-8000-0000be000001/m23/3.jpg', 'post', gen_random_uuid()) ->> 'ok')::boolean,
  'O (no block): a clean public item may be reposted');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000005', 'item', '00000000-0000-4000-8000-0000bee00003', NULL,
            '00000000-0000-4000-8000-0000be000001/m23/3.jpg', 'post', gen_random_uuid()) ->> 'reason', 'caller',
  'a hidden caller is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000002', 'item', '00000000-0000-4000-8000-0000bee0000c', NULL,
            '00000000-0000-4000-8000-0000be000005/x.jpg', 'post', gen_random_uuid()) ->> 'reason', 'source',
  'a hidden owner''s item is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'post_photo', NULL, NULL,
            '00000000-0000-4000-8000-0000be000001/../x.jpg', NULL, NULL) ->> 'reason', 'source', 'a traversal path is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'post_photo', NULL, NULL,
            '/00000000-0000-4000-8000-0000be000001/x.jpg', NULL, NULL) ->> 'reason', 'source', 'an absolute path is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'item', '00000000-0000-4000-8000-0000bee00003', NULL,
            '00000000-0000-4000-8000-0000be000001/m23/3.jpg', 'registry', gen_random_uuid()) ->> 'reason', 'invalid', 'an unknown snapshot type is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'item', '00000000-0000-4000-8000-0000bee00003', NULL,
            '00000000-0000-4000-8000-0000be000001/m23/3.jpg', 'post', NULL) ->> 'reason', 'invalid', 'an item copy needs a target');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'avatar', NULL, NULL,
            '00000000-0000-4000-8000-0000be000001/x.jpg', NULL, NULL) ->> 'reason', 'kind', 'an unknown kind is refused');

INSERT INTO c SELECT 'cover', (r ->> 'copy_id')::uuid, r ->> 'destination'
  FROM (SELECT pg_temp.begin_copy('00000000-0000-4000-8000-0000be000002', 'folder_cover', NULL, '00000000-0000-4000-8000-0000bef00006',
          '00000000-0000-4000-8000-0000be000001/covers/c6.jpg', 'folder_share', '00000000-0000-4000-8000-0000be900002') r) x;
SELECT is((SELECT dest FROM c WHERE k = 'cover'),
  '00000000-0000-4000-8000-0000be000002/folder_share/00000000-0000-4000-8000-0000be900002/cover-' || (SELECT id FROM c WHERE k = 'cover'),
  'folder cover: reserved under the reposting caller''s prefix');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000002', 'folder_cover', NULL, '00000000-0000-4000-8000-0000bef00006',
            '00000000-0000-4000-8000-0000be000001/m23/3.jpg', 'folder_share', gen_random_uuid()) ->> 'reason', 'source',
  'folder cover: a path that is not the folder''s cover is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'folder_cover', NULL, '00000000-0000-4000-8000-0000bef00002',
            '00000000-0000-4000-8000-0000be000001/covers/c2.jpg', 'folder_share', gen_random_uuid()) ->> 'reason', 'restricted',
  'folder cover: a moderated folder''s cover cannot be republished, even by its owner');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000003', 'folder_cover', NULL, '00000000-0000-4000-8000-0000bef00006',
            '00000000-0000-4000-8000-0000be000001/covers/c6.jpg', 'folder_share', gen_random_uuid()) ->> 'reason', 'source',
  'folder cover: K (blocked) is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000002', 'folder_cover', NULL, '00000000-0000-4000-8000-0000bef00006',
            '00000000-0000-4000-8000-0000be000001/covers/c6.jpg', 'post', gen_random_uuid()) ->> 'reason', 'invalid',
  'folder cover: only for a folder share');

INSERT INTO c SELECT 'staging', (r ->> 'copy_id')::uuid, r ->> 'destination'
  FROM (SELECT pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'post_photo', NULL, NULL,
          '00000000-0000-4000-8000-0000be000001/1700000000000.jpg', NULL, NULL) r) x;
SELECT is((SELECT dest FROM c WHERE k = 'staging'),
  '00000000-0000-4000-8000-0000be000001/post-upload/' || (SELECT id FROM c WHERE k = 'staging'), 'staging upload: reserved');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'post_photo', NULL, NULL,
            '00000000-0000-4000-8000-0000be000001/m23/3.jpg', NULL, NULL) ->> 'reason', 'referenced',
  'staging: an existing item image path is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'post_photo', NULL, NULL,
            '00000000-0000-4000-8000-0000be000001/m23/1.jpg', NULL, NULL) ->> 'reason', 'restricted',
  'staging: a moderated image path is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'post_photo', NULL, NULL,
            '00000000-0000-4000-8000-0000be000001/covers/c6.jpg', NULL, NULL) ->> 'reason', 'referenced',
  'staging: a folder cover path is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'post_photo', NULL, NULL,
            '00000000-0000-4000-8000-0000be000001/posted.jpg', NULL, NULL) ->> 'reason', 'referenced',
  'staging: a path a post still links to is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'post_photo', NULL, NULL,
            '00000000-0000-4000-8000-0000be000001/evidence.jpg', NULL, NULL) ->> 'reason', 'referenced',
  'staging: a path held as report evidence is refused');
SELECT is(pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'post_photo', NULL, NULL,
            '00000000-0000-4000-8000-0000be000002/1700000000000.jpg', NULL, NULL) ->> 'reason', 'source',
  'staging: another collector''s path is refused');
SELECT is((SELECT count(*)::int FROM c), 3, 'only the three valid requests were reserved');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM private.share_snapshot_copies WHERE status = 'reserved' AND caller_id IN (
             '00000000-0000-4000-8000-0000be000001', '00000000-0000-4000-8000-0000be000002')), 4,
  'refusals leave no ledger row (4 reservations, incl. O''s repost)');

-- ── 6. Publishing ───────────────────────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT is(public.share_snapshot_copy_publish((SELECT id FROM c WHERE k = 'item'), (SELECT dest FROM c WHERE k = 'item') || '.gif') ->> 'reason',
  'destination', 'publish: an extension outside the allowed set is refused');
SELECT is(public.share_snapshot_copy_publish((SELECT id FROM c WHERE k = 'item'), (SELECT dest FROM c WHERE k = 'cover') || '.jpg') ->> 'reason',
  'destination', 'publish: another copy''s destination is refused');
SELECT is(public.share_snapshot_copy_publish((SELECT id FROM c WHERE k = 'item'), (SELECT dest FROM c WHERE k = 'item') || '.jpg'),
  '{"ok": true, "delete_source": false}'::jsonb, 'publish: a clean item copy is published; its source is never deleted');
SELECT is(public.share_snapshot_copy_publish((SELECT id FROM c WHERE k = 'item'), (SELECT dest FROM c WHERE k = 'item') || '.jpg') ->> 'reason',
  'state', 'publish: only once');
SELECT is(public.share_snapshot_copy_publish(gen_random_uuid(), 'x/y.jpg') ->> 'reason', 'state', 'publish: unknown copy');
SELECT is(public.share_snapshot_copy_publish((SELECT id FROM c WHERE k = 'staging'), (SELECT dest FROM c WHERE k = 'staging') || '.png'),
  '{"ok": true, "delete_source": true}'::jsonb, 'publish: a still-unreferenced staging upload may then be deleted');
RESET ROLE;
SELECT is((SELECT status || ':' || dest_path FROM private.share_snapshot_copies WHERE id = (SELECT id FROM c WHERE k = 'item')),
  'published:' || (SELECT dest FROM c WHERE k = 'item') || '.jpg', 'the ledger records the published object');

-- Races: moderation (or a new reference) lands between reserving and publishing.
SET LOCAL ROLE service_role;
INSERT INTO c SELECT 'race', (r ->> 'copy_id')::uuid, r ->> 'destination'
  FROM (SELECT pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'item', '00000000-0000-4000-8000-0000bee00003', NULL,
          '00000000-0000-4000-8000-0000be000001/m23/3.jpg', 'post', gen_random_uuid()) r) x;
INSERT INTO c SELECT 'race2', (r ->> 'copy_id')::uuid, r ->> 'destination'
  FROM (SELECT pg_temp.begin_copy('00000000-0000-4000-8000-0000be000001', 'post_photo', NULL, NULL,
          '00000000-0000-4000-8000-0000be000001/1700000000001.jpg', NULL, NULL) r) x;
RESET ROLE;
INSERT INTO public.moderated_content (target_type, target_id, owner_id, state, reason_code, report_id, created_by) VALUES
  ('collection_item', '00000000-0000-4000-8000-0000bee00003', '00000000-0000-4000-8000-0000be000001', 'hidden', 'hate', '00000000-0000-4000-8000-0000be100004', '00000000-0000-4000-8000-0000be000006');
INSERT INTO public.collection_item_images (id, item_id, user_id, image_url, storage_path, sort_order, is_primary) VALUES
  ('00000000-0000-4000-8000-0000beb00009', '00000000-0000-4000-8000-0000bee00004', '00000000-0000-4000-8000-0000be000001', 'https://x.invalid/9',
   '00000000-0000-4000-8000-0000be000001/1700000000001.jpg', 1, false);
SET LOCAL ROLE service_role;
SELECT is(public.share_snapshot_copy_publish((SELECT id FROM c WHERE k = 'race'), (SELECT dest FROM c WHERE k = 'race') || '.jpg') ->> 'reason',
  'restricted', 'race: an item moderated mid-copy is refused at publication');
SELECT is(public.share_snapshot_copy_publish((SELECT id FROM c WHERE k = 'race2'), (SELECT dest FROM c WHERE k = 'race2') || '.jpg') ->> 'reason',
  'referenced', 'race: a staging path referenced mid-copy is refused, so it is never deleted');
RESET ROLE;
SELECT is((SELECT array_agg(status ORDER BY status) FROM private.share_snapshot_copies WHERE id IN (SELECT id FROM c WHERE k IN ('race', 'race2'))),
  ARRAY['rejected', 'rejected'], 'both are recorded as rejected, with their objects');

-- ── 7. Discarding ───────────────────────────────────────────────────────
SET LOCAL ROLE service_role;
-- (M2.3b, 20261119120000) The race above moderated I3 after its 'item' copy was
-- published, so that copy is now held for quarantine: discard must leave it.
SELECT is((SELECT count(*)::int FROM public.share_snapshot_copy_discard(ARRAY[(SELECT id FROM c WHERE k = 'item')])), 0,
  'discard: a published copy held for quarantine (its item was moderated since) is never handed out');
SELECT is((SELECT paths FROM public.share_snapshot_copy_discard(ARRAY[(SELECT id FROM c WHERE k = 'cover')])),
  ARRAY(SELECT (SELECT dest FROM c WHERE k = 'cover') || '.' || e FROM unnest(ARRAY['jpg', 'png', 'webp', 'heic', 'heif']) e),
  'discard: an unpublished copy yields only its own destination, per allowed extension');
SELECT is((SELECT paths FROM public.share_snapshot_copy_discard(ARRAY[(SELECT id FROM c WHERE k = 'race')])),
  ARRAY[(SELECT dest FROM c WHERE k = 'race') || '.jpg'], 'discard: a rejected copy yields its object');
SELECT is((SELECT count(*)::int FROM public.share_snapshot_copy_discard(ARRAY[gen_random_uuid()])), 0, 'discard: an unknown copy yields nothing');
SELECT is(public.share_snapshot_copy_removed(ARRAY[(SELECT id FROM c WHERE k = 'race'), (SELECT id FROM c WHERE k = 'cover'), (SELECT id FROM c WHERE k = 'staging')]), 2,
  'removed: only discarded copies are marked');
SELECT is((SELECT count(*)::int FROM public.share_snapshot_copy_discard(ARRAY[(SELECT id FROM c WHERE k = 'cover')])), 0,
  'discard: a removed copy is never handed out again');
SELECT is((SELECT count(*)::int FROM public.share_snapshot_copy_discard(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 51)))), 0,
  'discard: more than 50 ids is refused');
RESET ROLE;
SELECT is((SELECT status FROM private.share_snapshot_copies WHERE id = (SELECT id FROM c WHERE k = 'staging')), 'published',
  'a published copy that was not discarded is untouched');
SELECT throws_ok($$ INSERT INTO private.share_snapshot_copies (caller_id, kind, source_path, dest_base, status)
                    VALUES ('00000000-0000-4000-8000-0000be000001', 'item', 'a/b', 'a/c', 'reserved') $$, '23514', NULL,
  'ledger shape: an item copy needs its item');

-- ── 8. Public buckets: no anonymous listing ─────────────────────────────
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND policyname IN ('avatars_select_public', 'share_snapshots_select_public')),
  'the "anyone may list" policies are gone');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'storage' AND policyname IN ('avatars_select_own', 'share_snapshots_select_own')
             AND cmd = 'SELECT' AND roles = '{authenticated}' AND permissive = 'PERMISSIVE'), 2,
  'owner-only SELECT policies for both public buckets');
SET LOCAL ROLE anon;
SELECT pg_temp.logout();
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id IN ('avatars', 'share-snapshots') AND name LIKE '00000000-0000-4000-8000-0000be%'), 0,
  'signed out: cannot list avatars or snapshots');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000001');
SELECT is((SELECT array_agg(name ORDER BY name) FROM storage.objects WHERE bucket_id IN ('avatars', 'share-snapshots') AND name LIKE '00000000-0000-4000-8000-0000be%'),
  ARRAY['00000000-0000-4000-8000-0000be000001/a.jpg', '00000000-0000-4000-8000-0000be000001/post/x/s.jpg'],
  'A: sees only their own avatar and snapshot (needed for removing them)');
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000002');
SELECT is((SELECT array_agg(name ORDER BY name) FROM storage.objects WHERE bucket_id IN ('avatars', 'share-snapshots') AND name LIKE '00000000-0000-4000-8000-0000be%'),
  ARRAY['00000000-0000-4000-8000-0000be000002/o.jpg'], 'O: sees only their own avatar');
SELECT pg_temp.logout();
RESET ROLE;

-- ── 9. Account deletion ─────────────────────────────────────────────────
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000be000002';
SELECT is((SELECT count(*)::int FROM private.share_snapshot_copies WHERE caller_id = '00000000-0000-4000-8000-0000be000002'), 0,
  'deleting an account removes its ledger rows');

SELECT * FROM finish();
ROLLBACK;
