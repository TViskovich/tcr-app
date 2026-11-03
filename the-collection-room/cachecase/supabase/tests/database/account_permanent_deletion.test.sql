-- pgTAP test for 20261106120000_account_permanent_deletion.sql and
-- 20261106140000_account_maintenance_schedule.sql (permanent deletion,
-- worker functions, retention policy).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.
--
-- A is permanently deleted. B and C are other collectors whose data must
-- survive (minus copies of A's content). D–H exercise the worker edges.

BEGIN;
SELECT plan(96);

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
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.logout() TO authenticated, anon, service_role;

-- The HMAC key (a Vault secret in production).
SELECT vault.create_secret(repeat('k', 48), 'username_reservation_key');

-- ── 1. Shape and privileges ──────────────────────────────────────────────
SELECT has_table('public', 'account_deletion_jobs', 'deletion jobs table exists');
SELECT has_table('public', 'account_deletion_storage_queue', 'storage manifest table exists');
SELECT is((SELECT count(*)::int FROM (VALUES ('anon'), ('authenticated')) r(role),
             (VALUES ('public.account_deletion_jobs'), ('public.account_deletion_storage_queue')) t(tbl),
             (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv) WHERE has_table_privilege(r.role, t.tbl, p.priv)), 0,
  'clients have no privilege on deletion jobs or manifests');
SELECT ok(NOT has_table_privilege('authenticated', 'private.username_reservations', 'SELECT')
      AND NOT has_table_privilege('anon', 'private.username_reservations', 'SELECT'), 'nobody can read username reservations');
CREATE TEMP TABLE pd_fns AS SELECT unnest(ARRAY[
  'public.account_deletion_start(uuid,text)', 'public.account_deletion_enqueue_due(integer)', 'public.account_deletion_claim(integer,integer)',
  'public.account_deletion_build_manifest(uuid)', 'public.account_deletion_housekeeping()', 'public.account_deletion_preflight()',
  'public.account_deletion_mark_removed(uuid)']::regprocedure[]) AS fn;
SELECT is((SELECT count(*)::int FROM pd_fns WHERE has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')), 0,
  'worker functions are not callable by clients');
SELECT is((SELECT count(*)::int FROM pd_fns WHERE has_function_privilege('service_role', fn, 'EXECUTE')), 7, 'the service role can run every worker function');
SELECT ok(has_function_privilege('anon', 'public.username_is_reserved(text)', 'EXECUTE'), 'sign-up can check a reserved username');
SELECT ok(NOT has_function_privilege('anon', 'public.account_deletion_admin_summary()', 'EXECUTE'), 'anon cannot read the admin summary');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND tgname = 'account_final_deletion'), 'the final-deletion trigger is on auth.users');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.messages'::regclass AND tgname = 'conversation_closed_guard'), 'closed conversations take no messages');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.profiles'::regclass AND tgname = 'profiles_reserved_username'), 'new profiles are checked against reservations');
SELECT is((SELECT array_agg(confdeltype::text ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.ownership_transfers'::regclass
             AND conname IN ('ownership_transfers_from_owner_id_fkey', 'ownership_transfers_to_owner_id_fkey')), ARRAY['n', 'n'],
  'transfer participants are SET NULL (the other side keeps the history)');
SELECT ok(EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'account-maintenance' AND schedule = '*/10 * * * *'), 'the maintenance job is scheduled every 10 minutes');
SELECT is((SELECT jobs.n FROM (SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
             WHERE c.relname IN ('account_deletion_jobs', 'account_deletion_storage_queue', 'account_export_parts') AND t.tgname = 'account_write_guard') jobs), 3,
  'the new tables carry the lifecycle write guard');
SELECT is((SELECT (public.account_deletion_preflight() ->> 'username_key_configured')::boolean), true, 'preflight sees the configured key');

-- ── Fixtures ────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000f1c0000a', 'PD-A@example.invalid', '{"username":"pd_alpha"}'),
  ('00000000-0000-4000-8000-0000f1c0000b', 'pd-b@example.invalid', '{"username":"pd_beta"}'),
  ('00000000-0000-4000-8000-0000f1c0000c', 'pd-c@example.invalid', '{"username":"pd_gamma"}');
-- A's collection and items; B's own item.
INSERT INTO public.folders (id, user_id, name, is_public) VALUES
  ('00000000-0000-4000-8000-0000f1cf000a', '00000000-0000-4000-8000-0000f1c0000a', 'pd A binder', true),
  ('00000000-0000-4000-8000-0000f1cf000b', '00000000-0000-4000-8000-0000f1c0000b', 'pd B binder', true);
INSERT INTO public.collection_items (id, folder_id, user_id, title, item_type, is_public, collection_status) VALUES
  ('00000000-0000-4000-8000-0000f1ce00a1', '00000000-0000-4000-8000-0000f1cf000a', '00000000-0000-4000-8000-0000f1c0000a', 'pd A rookie', 'sports_card', true, 'active'),
  ('00000000-0000-4000-8000-0000f1ce00a2', '00000000-0000-4000-8000-0000f1cf000a', '00000000-0000-4000-8000-0000f1c0000a', 'pd A grail', 'sports_card', true, 'active'),
  ('00000000-0000-4000-8000-0000f1ce00b1', '00000000-0000-4000-8000-0000f1cf000b', '00000000-0000-4000-8000-0000f1c0000b', 'pd B card', 'sports_card', true, 'active');
-- Registry: A owns card 1 (pending transfer A→C) and card 3 (photo);
-- B owns card 2 (accepted earlier from A) and card 4 (pending transfer B→A).
INSERT INTO public.registered_cards (id, current_owner_id, created_by, visibility, snapshot_image_storage_path, snapshot_image_status, snapshot_title) VALUES
  ('00000000-0000-4000-8000-0000f1cc0001', '00000000-0000-4000-8000-0000f1c0000a', '00000000-0000-4000-8000-0000f1c0000a', 'public', NULL, NULL, 'Card One'),
  ('00000000-0000-4000-8000-0000f1cc0002', '00000000-0000-4000-8000-0000f1c0000b', '00000000-0000-4000-8000-0000f1c0000a', 'public', '00000000-0000-4000-8000-0000f1cc0002/original', 'ready', 'Card Two'),
  ('00000000-0000-4000-8000-0000f1cc0003', '00000000-0000-4000-8000-0000f1c0000a', '00000000-0000-4000-8000-0000f1c0000a', 'public', '00000000-0000-4000-8000-0000f1cc0003/original', 'ready', 'Card Three'),
  ('00000000-0000-4000-8000-0000f1cc0004', '00000000-0000-4000-8000-0000f1c0000b', '00000000-0000-4000-8000-0000f1c0000b', 'public', NULL, NULL, 'Card Four');
INSERT INTO public.registry_events (registered_card_id, event_type, actor_id, from_owner_id, to_owner_id) VALUES
  ('00000000-0000-4000-8000-0000f1cc0002', 'ownership_transferred', '00000000-0000-4000-8000-0000f1c0000b', '00000000-0000-4000-8000-0000f1c0000a', '00000000-0000-4000-8000-0000f1c0000b');
INSERT INTO public.ownership_transfers (id, registered_card_id, from_owner_id, to_owner_id, status) VALUES
  ('00000000-0000-4000-8000-0000f1ca0001', '00000000-0000-4000-8000-0000f1cc0001', '00000000-0000-4000-8000-0000f1c0000a', '00000000-0000-4000-8000-0000f1c0000c', 'pending'),
  ('00000000-0000-4000-8000-0000f1ca0002', '00000000-0000-4000-8000-0000f1cc0002', '00000000-0000-4000-8000-0000f1c0000a', '00000000-0000-4000-8000-0000f1c0000b', 'accepted'),
  ('00000000-0000-4000-8000-0000f1ca0004', '00000000-0000-4000-8000-0000f1cc0004', '00000000-0000-4000-8000-0000f1c0000b', '00000000-0000-4000-8000-0000f1c0000a', 'pending');
-- B's posts that copied A's content, plus B's own unrelated content.
INSERT INTO public.posts (id, user_id, post_type, content, caption, image_url, item_id, folder_id, folder_name, folder_cover_snapshot_url, folder_item_count, quote_of_post_id) VALUES
  ('00000000-0000-4000-8000-0000f1cd00a0', '00000000-0000-4000-8000-0000f1c0000a', 'text', 'A original', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-0000f1cd00b1', '00000000-0000-4000-8000-0000f1c0000b', 'card_share', 'B shares cards', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-0000f1cd00b2', '00000000-0000-4000-8000-0000f1c0000b', 'rate_my_grails', 'rate these', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-0000f1cd00b3', '00000000-0000-4000-8000-0000f1c0000b', 'folder_share', NULL, NULL, NULL, NULL, '00000000-0000-4000-8000-0000f1cf000a', 'pd A binder',
   'http://127.0.0.1:54321/storage/v1/object/public/share-snapshots/00000000-0000-4000-8000-0000f1c0000b/cover-of-a.jpg', 2, NULL),
  ('00000000-0000-4000-8000-0000f1cd00b4', '00000000-0000-4000-8000-0000f1c0000b', 'item', NULL, 'love this card', 'http://127.0.0.1:54321/storage/v1/object/public/share-snapshots/00000000-0000-4000-8000-0000f1c0000b/item-of-a.jpg',
   '00000000-0000-4000-8000-0000f1ce00a1', NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-0000f1cd00b5', '00000000-0000-4000-8000-0000f1c0000b', 'text', 'B photo post', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-0000f1cd00b6', '00000000-0000-4000-8000-0000f1c0000b', 'quote', 'B quoting A', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '00000000-0000-4000-8000-0000f1cd00a0');
INSERT INTO public.card_share_items (post_id, item_id, snapshot_image_url, snapshot_title, display_order) VALUES
  ('00000000-0000-4000-8000-0000f1cd00b1', '00000000-0000-4000-8000-0000f1ce00a1', 'http://127.0.0.1:54321/storage/v1/object/public/share-snapshots/00000000-0000-4000-8000-0000f1c0000b/snap-a1.jpg', 'pd A rookie', 0),
  ('00000000-0000-4000-8000-0000f1cd00b1', '00000000-0000-4000-8000-0000f1ce00b1', 'http://127.0.0.1:54321/storage/v1/object/public/share-snapshots/00000000-0000-4000-8000-0000f1c0000b/snap-b1.jpg', 'pd B card', 1);
INSERT INTO public.rate_my_grail_cards (post_id, item_id, snapshot_image_url, snapshot_title) VALUES
  ('00000000-0000-4000-8000-0000f1cd00b2', '00000000-0000-4000-8000-0000f1ce00a2', NULL, 'pd A grail');
INSERT INTO public.folder_share_items (post_id, item_id, snapshot_image_url, snapshot_title) VALUES
  ('00000000-0000-4000-8000-0000f1cd00b3', '00000000-0000-4000-8000-0000f1ce00a1', 'http://127.0.0.1:54321/storage/v1/object/public/share-snapshots/00000000-0000-4000-8000-0000f1c0000b/fold-a1.jpg', 'pd A rookie');
INSERT INTO public.post_images (post_id, item_id, image_url, source_type, sort_order) VALUES
  ('00000000-0000-4000-8000-0000f1cd00b5', '00000000-0000-4000-8000-0000f1ce00a1', 'http://127.0.0.1:54321/storage/v1/object/public/share-snapshots/00000000-0000-4000-8000-0000f1c0000b/pi-a1.jpg', 'item', 0),
  ('00000000-0000-4000-8000-0000f1cd00b5', NULL, 'http://127.0.0.1:54321/storage/v1/object/public/share-snapshots/00000000-0000-4000-8000-0000f1c0000b/own.jpg', 'library', 1);
INSERT INTO public.comments (user_id, post_id, body) VALUES
  ('00000000-0000-4000-8000-0000f1c0000a', '00000000-0000-4000-8000-0000f1cd00b5', 'A comment on B'),
  ('00000000-0000-4000-8000-0000f1c0000c', '00000000-0000-4000-8000-0000f1cd00b5', 'C comment on B');
INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by) VALUES
  ('00000000-0000-4000-8000-0000f1ce00b1', '00000000-0000-4000-8000-0000f1c0000a', '00000000-0000-4000-8000-0000f1c0000b'),
  ('00000000-0000-4000-8000-0000f1ce00a1', '00000000-0000-4000-8000-0000f1c0000b', '00000000-0000-4000-8000-0000f1c0000a');
-- DMs: A↔B with a photo from A.
INSERT INTO public.conversations (id) VALUES ('00000000-0000-4000-8000-0000f1cb00ab');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000f1cb00ab', '00000000-0000-4000-8000-0000f1c0000a'),
  ('00000000-0000-4000-8000-0000f1cb00ab', '00000000-0000-4000-8000-0000f1c0000b');
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('dm-attachments', '00000000-0000-4000-8000-0000f1cb00ab/00000000-0000-4000-8000-0000f1c90003/image.jpg', '00000000-0000-4000-8000-0000f1c0000a', '00000000-0000-4000-8000-0000f1c0000a');
INSERT INTO public.messages (id, conversation_id, sender_id, body) VALUES
  ('00000000-0000-4000-8000-0000f1c90001', '00000000-0000-4000-8000-0000f1cb00ab', '00000000-0000-4000-8000-0000f1c0000a', 'from A'),
  ('00000000-0000-4000-8000-0000f1c90002', '00000000-0000-4000-8000-0000f1cb00ab', '00000000-0000-4000-8000-0000f1c0000b', 'from B');
INSERT INTO public.messages (id, conversation_id, sender_id, attachment_type, attachment_storage_path, attachment_width, attachment_height) VALUES
  ('00000000-0000-4000-8000-0000f1c90003', '00000000-0000-4000-8000-0000f1cb00ab', '00000000-0000-4000-8000-0000f1c0000a', 'image',
   '00000000-0000-4000-8000-0000f1cb00ab/00000000-0000-4000-8000-0000f1c90003/image.jpg', 10, 10);
-- Storage: A's own folders, A's registry photo, B's copies of A's content
-- and B's own unrelated files.
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('item-images', '00000000-0000-4000-8000-0000f1c0000a/photo.jpg'),
  ('avatars', '00000000-0000-4000-8000-0000f1c0000a/avatar.jpg'),
  ('share-snapshots', '00000000-0000-4000-8000-0000f1c0000a/own-post.jpg'),
  ('account-exports', '00000000-0000-4000-8000-0000f1c0000a/job/export.zip'),
  ('registry-images', '00000000-0000-4000-8000-0000f1cc0003/original'),
  ('registry-images', '00000000-0000-4000-8000-0000f1cc0002/original'),
  ('share-snapshots', '00000000-0000-4000-8000-0000f1c0000b/snap-a1.jpg'),
  ('share-snapshots', '00000000-0000-4000-8000-0000f1c0000b/fold-a1.jpg'),
  ('share-snapshots', '00000000-0000-4000-8000-0000f1c0000b/pi-a1.jpg'),
  ('share-snapshots', '00000000-0000-4000-8000-0000f1c0000b/item-of-a.jpg'),
  ('share-snapshots', '00000000-0000-4000-8000-0000f1c0000b/cover-of-a.jpg'),
  ('share-snapshots', '00000000-0000-4000-8000-0000f1c0000b/snap-b1.jpg'),
  ('share-snapshots', '00000000-0000-4000-8000-0000f1c0000b/own.jpg'),
  ('item-images', '00000000-0000-4000-8000-0000f1c0000b/photo.jpg');
-- Waitlist: linked row, a same-email row, an unrelated row.
INSERT INTO public.waitlist_signups (name, email, status, onboarded_user_id, onboarded_at) VALUES
  ('Alpha', 'pd-alpha-invite@example.invalid', 'onboarded', '00000000-0000-4000-8000-0000f1c0000a', now());
INSERT INTO public.waitlist_signups (name, email, status) VALUES
  ('Alpha again', 'pd-a@example.invalid', 'waitlisted'),
  ('Someone else', 'pd-other@example.invalid', 'waitlisted');

-- ── 2. Starting deletion and claiming jobs ────────────────────────────────
SET LOCAL ROLE service_role;
CREATE TEMP TABLE pd_job AS SELECT * FROM public.account_deletion_start('00000000-0000-4000-8000-0000f1c0000a', 'immediate');
GRANT SELECT ON pd_job TO service_role;
SELECT is((SELECT status FROM pd_job), 'queued', 'Delete Now queues a job');
SELECT is((SELECT state FROM public.account_lifecycle WHERE user_id = '00000000-0000-4000-8000-0000f1c0000a'), 'deleting', 'the account is deleting before anything irreversible');
SELECT throws_ok($$ SELECT public.cancel_account_deletion('00000000-0000-4000-8000-0000f1c0000a') $$, 'P0001', 'account_lifecycle_deleting_is_final',
  'cancellation is impossible once deleting');
SELECT is((SELECT id FROM public.account_deletion_start('00000000-0000-4000-8000-0000f1c0000a', 'immediate')), (SELECT id FROM pd_job),
  'repeating Delete Now returns the same job');
SELECT is((SELECT count(*)::int FROM public.account_deletion_claim(5, 120) WHERE id = (SELECT id FROM pd_job)), 1, 'a worker claims the job');
SELECT is((SELECT count(*)::int FROM public.account_deletion_claim(5, 120) WHERE id = (SELECT id FROM pd_job)), 0, 'a second worker cannot claim it while leased');
UPDATE public.account_deletion_jobs SET lease_until = now() - interval '1 second' WHERE id = (SELECT id FROM pd_job);
SELECT is((SELECT runs FROM public.account_deletion_claim(5, 120) WHERE id = (SELECT id FROM pd_job)), 2, 'an expired lease can be reclaimed (runs counted)');
RESET ROLE;

-- Not-deleting accounts are never processed, even with a stray job row.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000f1c0000d', 'pd-d@example.invalid', '{"username":"pd_delta"}');
SET LOCAL ROLE service_role;
SELECT is((SELECT state FROM public.schedule_account_deletion('00000000-0000-4000-8000-0000f1c0000d')), 'pending_deletion', 'D is pending (14 days)');
RESET ROLE;
INSERT INTO public.account_deletion_jobs (user_id, mode) VALUES ('00000000-0000-4000-8000-0000f1c0000d', 'scheduled');
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.account_deletion_claim(50, 120) WHERE user_id = '00000000-0000-4000-8000-0000f1c0000d'), 0,
  'a job for an account that is not deleting is never claimed');
SELECT ok(public.cancel_account_deletion('00000000-0000-4000-8000-0000f1c0000d'), 'D can still cancel during the window');
SELECT is((SELECT count(*)::int FROM public.account_deletion_claim(50, 120) WHERE user_id = '00000000-0000-4000-8000-0000f1c0000d'), 0,
  'a cancelled account is never processed');
RESET ROLE;

-- The scheduler starts only accounts whose window has ended.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000f1c0000e', 'pd-e@example.invalid', '{"username":"pd_epsilon"}'),
  ('00000000-0000-4000-8000-0000f1c0000f', 'pd-f@example.invalid', '{"username":"pd_zeta"}');
ALTER TABLE public.account_lifecycle DISABLE TRIGGER account_lifecycle_transition;
INSERT INTO public.account_lifecycle (user_id, state, mode, requested_at, scheduled_for) VALUES
  ('00000000-0000-4000-8000-0000f1c0000e', 'pending_deletion', 'scheduled', now() - interval '15 days', now() - interval '1 day'),
  ('00000000-0000-4000-8000-0000f1c0000f', 'pending_deletion', 'scheduled', now() - interval '1 day', now() + interval '13 days');
ALTER TABLE public.account_lifecycle ENABLE TRIGGER account_lifecycle_transition;
SET LOCAL ROLE service_role;
SELECT is(public.account_deletion_enqueue_due(50), 1, 'the scheduler starts exactly the one due account');
SELECT is((SELECT state FROM public.account_lifecycle WHERE user_id = '00000000-0000-4000-8000-0000f1c0000e'), 'deleting', 'the due account is now deleting');
SELECT is((SELECT mode || ':' || status FROM public.account_deletion_jobs WHERE user_id = '00000000-0000-4000-8000-0000f1c0000e'), 'scheduled:queued', 'with a queued scheduled job');
SELECT is((SELECT state FROM public.account_lifecycle WHERE user_id = '00000000-0000-4000-8000-0000f1c0000f'), 'pending_deletion', 'an account still in its window is untouched');
SELECT is(public.account_deletion_enqueue_due(50), 0, 'running the scheduler again starts nothing new');
RESET ROLE;

-- ── 3. The durable file manifest ─────────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT is(public.account_deletion_build_manifest((SELECT id FROM pd_job)), 11, 'the manifest lists exactly A’s eleven files');
SELECT is(public.account_deletion_build_manifest((SELECT id FROM pd_job)), 11, 'rebuilding the manifest is idempotent');
RESET ROLE;
CREATE TEMP TABLE pd_manifest AS SELECT bucket || ':' || path AS f FROM public.account_deletion_storage_queue WHERE job_id = (SELECT id FROM pd_job);
SELECT ok((SELECT count(*) FROM pd_manifest WHERE f IN (
  'item-images:00000000-0000-4000-8000-0000f1c0000a/photo.jpg', 'avatars:00000000-0000-4000-8000-0000f1c0000a/avatar.jpg',
  'share-snapshots:00000000-0000-4000-8000-0000f1c0000a/own-post.jpg', 'account-exports:00000000-0000-4000-8000-0000f1c0000a/job/export.zip')) = 4,
  'own folders: item photos, avatars, own post photos and export archives');
SELECT ok(EXISTS (SELECT 1 FROM pd_manifest WHERE f = 'dm-attachments:00000000-0000-4000-8000-0000f1cb00ab/00000000-0000-4000-8000-0000f1c90003/image.jpg'),
  'A’s DM photo');
SELECT ok(EXISTS (SELECT 1 FROM pd_manifest WHERE f = 'registry-images:00000000-0000-4000-8000-0000f1cc0003/original'), 'the registry photo of a card A still owns');
SELECT ok(NOT EXISTS (SELECT 1 FROM pd_manifest WHERE f LIKE 'registry-images:00000000-0000-4000-8000-0000f1cc0002/%'),
  'not the registry photo of a card already transferred to B');
SELECT is((SELECT count(*)::int FROM pd_manifest WHERE f LIKE 'share-snapshots:00000000-0000-4000-8000-0000f1c0000b/%'), 5,
  'the five copies of A’s content in B’s posts');
SELECT ok(NOT EXISTS (SELECT 1 FROM pd_manifest WHERE f IN ('share-snapshots:00000000-0000-4000-8000-0000f1c0000b/snap-b1.jpg',
  'share-snapshots:00000000-0000-4000-8000-0000f1c0000b/own.jpg', 'item-images:00000000-0000-4000-8000-0000f1c0000b/photo.jpg')),
  'never B’s own files');
SET LOCAL ROLE service_role;
SELECT is(public.account_deletion_mark_removed((SELECT id FROM pd_job)), 11, 'nothing is marked removed while the files still exist');
RESET ROLE;

-- ── 4. Final deletion (what deleteUser triggers), atomically ──────────────
SELECT pg_temp.logout();
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000f1c0000a';
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000f1c0000a'), 0, 'A’s profile is gone');
SELECT is((SELECT count(*)::int FROM public.folders WHERE user_id = '00000000-0000-4000-8000-0000f1c0000a')
        + (SELECT count(*)::int FROM public.collection_items WHERE user_id = '00000000-0000-4000-8000-0000f1c0000a'), 0, 'A’s collections and items are gone');
SELECT is((SELECT count(*)::int FROM public.account_lifecycle WHERE user_id = '00000000-0000-4000-8000-0000f1c0000a'), 0, 'the lifecycle row went with the account');
SELECT is((SELECT status FROM public.account_deletion_jobs WHERE id = (SELECT id FROM pd_job)), 'queued', 'the job record survives (no foreign key)');
-- Registry
SELECT is((SELECT status || ':' || visibility FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000f1cc0001'), 'owner_account_deleted:private',
  'a card A owned is marked owner_account_deleted and private');
SELECT ok((SELECT current_owner_id IS NULL AND created_by IS NULL FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000f1cc0001'),
  'its owner and creator are no longer identified');
SELECT ok((SELECT snapshot_image_storage_path IS NULL AND snapshot_image_status = 'unavailable' FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000f1cc0003'),
  'its registry photo reference is removed');
SELECT is((SELECT cc_id IS NOT NULL AND snapshot_title = 'Card Three' FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000f1cc0003'), true,
  'the minimal Cache ID record (non-personal card details) is kept');
SELECT is((SELECT status || ':' || visibility || ':' || current_owner_id::text FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000f1cc0002'),
  'owner_registered:public:00000000-0000-4000-8000-0000f1c0000b', 'a card already transferred to B is untouched');
SELECT is((SELECT snapshot_image_storage_path FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000f1cc0002'),
  '00000000-0000-4000-8000-0000f1cc0002/original', '…including its photo');
SELECT ok((SELECT from_owner_id IS NULL AND to_owner_id = '00000000-0000-4000-8000-0000f1c0000b' FROM public.registry_events WHERE registered_card_id = '00000000-0000-4000-8000-0000f1cc0002'),
  'registry history keeps the event, without A’s identity');
-- Transfers
SELECT is((SELECT status || ':' || closed_reason FROM public.ownership_transfers WHERE id = '00000000-0000-4000-8000-0000f1ca0001'), 'cancelled:account_deleted',
  'A’s outgoing pending transfer is cancelled (account_deleted)');
SELECT is((SELECT status || ':' || closed_reason FROM public.ownership_transfers WHERE id = '00000000-0000-4000-8000-0000f1ca0004'), 'cancelled:account_deleted',
  'B’s pending transfer to A is cancelled (account_deleted)');
SELECT is((SELECT current_owner_id FROM public.registered_cards WHERE id = '00000000-0000-4000-8000-0000f1cc0004'), '00000000-0000-4000-8000-0000f1c0000b'::uuid,
  'no ownership changed');
SELECT ok((SELECT status = 'accepted' AND from_owner_id IS NULL AND to_owner_id = '00000000-0000-4000-8000-0000f1c0000b' FROM public.ownership_transfers WHERE id = '00000000-0000-4000-8000-0000f1ca0002'),
  'B keeps the history of the transfer B accepted from A');
SELECT is((SELECT count(*)::int FROM public.ownership_transfers WHERE id IN ('00000000-0000-4000-8000-0000f1ca0001', '00000000-0000-4000-8000-0000f1ca0004')), 2,
  'the other participants keep their transfer records');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE transfer_id IN ('00000000-0000-4000-8000-0000f1ca0001', '00000000-0000-4000-8000-0000f1ca0004')), 0,
  'no transfer notification was sent');
-- Other collectors' posts
SELECT is((SELECT count(*)::int FROM public.posts WHERE user_id = '00000000-0000-4000-8000-0000f1c0000b'), 6, 'all six of B’s posts survive');
SELECT is((SELECT array_agg(snapshot_title) FROM public.card_share_items WHERE post_id = '00000000-0000-4000-8000-0000f1cd00b1'), ARRAY['pd B card'],
  'card share: A’s copied card is removed, B’s own card stays');
SELECT is((SELECT count(*)::int FROM public.rate_my_grail_cards WHERE post_id = '00000000-0000-4000-8000-0000f1cd00b2'), 0, 'Rate My Grails: A’s copied card is removed');
SELECT ok((SELECT folder_id IS NULL AND folder_name IS NULL AND folder_cover_snapshot_url IS NULL FROM public.posts WHERE id = '00000000-0000-4000-8000-0000f1cd00b3'),
  'collection share: A’s collection name and cover are removed');
SELECT is((SELECT count(*)::int FROM public.folder_share_items WHERE post_id = '00000000-0000-4000-8000-0000f1cd00b3'), 0, '…and its copied items');
SELECT ok((SELECT image_url IS NULL AND item_id IS NULL AND caption = 'love this card' FROM public.posts WHERE id = '00000000-0000-4000-8000-0000f1cd00b4'),
  'item post: A’s copied photo is removed, B’s caption stays');
SELECT is((SELECT array_agg(source_type) FROM public.post_images WHERE post_id = '00000000-0000-4000-8000-0000f1cd00b5'), ARRAY['library'],
  'photo post: the copy of A’s item is removed, B’s own photo stays');
SELECT ok((SELECT quote_of_post_id IS NULL AND content = 'B quoting A' FROM public.posts WHERE id = '00000000-0000-4000-8000-0000f1cd00b6'),
  'B’s quote of A’s post stays, without the quoted post');
SELECT is((SELECT array_agg(body) FROM public.comments WHERE post_id = '00000000-0000-4000-8000-0000f1cd00b5'), ARRAY['C comment on B'],
  'A’s comment on B’s post is gone; C’s stays');
SELECT is((SELECT count(*)::int FROM public.collection_item_tags WHERE '00000000-0000-4000-8000-0000f1c0000a' IN (tagged_user_id, tagged_by)), 0, 'tags by and of A are gone');
-- Messages
SELECT is((SELECT array_agg(body) FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000f1cb00ab'), ARRAY['from B'],
  'A’s messages and photo message are deleted; B’s message stays');
SELECT is((SELECT count(*)::int FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000f1cb00ab'), 1, 'the conversation still exists for B');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000f1c0000b');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000f1cb00ab'), 1, 'B can still read their own message');
SELECT throws_ok($$ INSERT INTO public.messages (conversation_id, sender_id, body) VALUES ('00000000-0000-4000-8000-0000f1cb00ab', '00000000-0000-4000-8000-0000f1c0000b', 'hello?') $$,
  '42501', 'conversation_closed', 'the conversation is read-only for B');
RESET ROLE;
SELECT pg_temp.logout();
-- Waitlist and username
SELECT is((SELECT array_agg(name) FROM public.waitlist_signups WHERE email ILIKE 'pd-%'), ARRAY['Someone else'],
  'A’s waitlist records (linked and same email) are deleted; unrelated ones stay');
SELECT ok(public.username_is_reserved('pd_alpha'), 'A’s username is reserved');
SELECT ok(public.username_is_reserved('PD_Alpha '), 'reservations ignore case and surrounding spaces');
SELECT ok(NOT public.username_is_reserved('pd_beta'), 'other usernames are not reserved');
SELECT ok((SELECT reserved_until BETWEEN now() + interval '89 days' AND now() + interval '91 days' FROM private.username_reservations LIMIT 1),
  'for 90 days');
SELECT ok(NOT EXISTS (SELECT 1 FROM private.username_reservations r WHERE r.username_hmac = convert_to('pd_alpha', 'UTF8')
             OR r.username_hmac = extensions.digest('pd_alpha', 'sha256')), 'stored as a keyed HMAC — not the name, not a plain hash');
SELECT throws_ok($$ INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000f1c00011', 'imposter@example.invalid', '{"username":"pd_alpha"}') $$, '23505', 'username_reserved',
  'nobody can sign up with the reserved username');

-- ── 5. Recovery, configuration and housekeeping ──────────────────────────
-- A deletion outside the lifecycle (e.g. an aborted sign-up being rolled
-- back) applies the policy but reserves nothing.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000f1c00012', 'pd-g@example.invalid', '{"username":"pd_eta"}');
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000f1c00012';
SELECT ok(NOT public.username_is_reserved('pd_eta'), 'deleting an account outside the lifecycle reserves nothing');
-- Without the key, a lifecycle deletion fails atomically (nothing deleted).
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000f1c00013', 'pd-h@example.invalid', '{"username":"pd_theta"}');
SET LOCAL ROLE service_role;
SELECT is((SELECT status FROM public.account_deletion_start('00000000-0000-4000-8000-0000f1c00013', 'immediate')), 'queued', 'H is deleting');
RESET ROLE;
DELETE FROM vault.secrets WHERE name = 'username_reservation_key';
SELECT is((SELECT (public.account_deletion_preflight() ->> 'username_key_configured')::boolean), false, 'preflight reports the missing key');
SELECT throws_ok($$ DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000f1c00013' $$, 'P0001', 'username_reservation_key_missing',
  'without the key the deletion is refused');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000f1c00013'), 1, '…and nothing was deleted');
SELECT throws_ok($$ SELECT public.username_is_reserved('pd_alpha') $$, 'P0001', 'username_reservation_unavailable',
  'without the key the reservation check fails closed (Checkpoint 5)');
SELECT throws_ok($$ INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000f1c00014', 'pd-i@example.invalid', '{"username":"pd_iota"}') $$, 'P0001', 'username_reservation_unavailable',
  'and sign-up is refused while reservations exist (fails closed)');
SELECT vault.create_secret(repeat('k', 48), 'username_reservation_key');
-- Completion and purge.
UPDATE public.account_deletion_jobs SET status = 'completed', completed_at = now() - interval '31 days', purge_after = now() - interval '1 day'
  WHERE id = (SELECT id FROM pd_job);
INSERT INTO private.username_reservations (username_hmac, reserved_until) VALUES ('\x00ff'::bytea, now() - interval '1 day');
SET LOCAL ROLE service_role;
SELECT is(public.account_deletion_housekeeping(), '{"jobs_purged": 1, "reservations_expired": 1}'::jsonb,
  'housekeeping purges 30-day-old job identity and expired reservations');
RESET ROLE;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs WHERE id = (SELECT id FROM pd_job)),
  'the job record is deleted 30 days after completion (Checkpoint 5)');
SELECT is((SELECT count(*)::int FROM public.account_deletion_storage_queue WHERE job_id = (SELECT id FROM pd_job)), 0, 'and its file manifest is purged');
SELECT ok(public.username_is_reserved('pd_alpha'), 'unexpired reservations are kept');

-- ── 6. Admin indicator ───────────────────────────────────────────────────
UPDATE public.account_deletion_jobs SET status = 'failed', failed_at = now(), last_error_code = 'storage_remove_failed'
  WHERE user_id = '00000000-0000-4000-8000-0000f1c0000e';
INSERT INTO public.admin_users (user_id) VALUES ('00000000-0000-4000-8000-0000f1c0000c');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000f1c0000b');
SELECT throws_ok($$ SELECT public.account_deletion_admin_summary() $$, '42501', 'forbidden', 'a non-admin cannot read the deletion summary');
SELECT pg_temp.login('00000000-0000-4000-8000-0000f1c0000c');
SELECT is((public.account_deletion_admin_summary() ->> 'failed')::int, 1, 'an admin sees one failed deletion');
SELECT is(public.account_deletion_admin_summary() -> 'failure_codes', '{"storage_remove_failed": 1}'::jsonb, 'with its failure code');
SELECT ok(public.account_deletion_admin_summary()::text !~ '0000f1c0000e', 'and no account identity');
RESET ROLE;
SELECT pg_temp.logout();

-- ── 7. Regressions ───────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000f1c0000b');
SELECT lives_ok($$ INSERT INTO public.collection_item_tags (item_id, tagged_user_id, tagged_by) VALUES
  ('00000000-0000-4000-8000-0000f1ce00b1', '00000000-0000-4000-8000-0000f1c0000c', '00000000-0000-4000-8000-0000f1c0000b') $$, 'tagging still works');
SELECT isnt(public.get_or_create_conversation('00000000-0000-4000-8000-0000f1c0000c'), NULL, 'new DMs between active collectors still work');
RESET ROLE;
SELECT pg_temp.logout();
SELECT ok(to_regclass('public.conversation_group_departures') IS NULL, 'Group Messaging stays inactive');

SELECT * FROM finish();
ROLLBACK;
