-- pgTAP test for 20261111120000_account_export_sent_dm_photos.sql
-- (Download My Data: the DM photos a collector SENT).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.
--
-- A sends photos to B (conversation AB) and to C (AC); B and C send their
-- own. Cases the message trigger would normally refuse (wrong Storage owner,
-- malformed path, missing object, wrong bucket) are written with that one
-- trigger switched off, to prove the function checks them itself.

BEGIN;
SELECT plan(29);

-- ── Shape and privileges ────────────────────────────────────────────────
SELECT has_function('public', 'export_sent_message_attachments', ARRAY['uuid', 'uuid', 'integer'],
  'export_sent_message_attachments(uuid, uuid, integer) exists');
SELECT is(pg_get_function_result('public.export_sent_message_attachments(uuid,uuid,integer)'::regprocedure),
  'TABLE(message_id uuid, bucket_id text, name text, size bigint)', 'returns message_id, bucket_id, name, size');
SELECT ok((SELECT NOT prosecdef AND proconfig = ARRAY['search_path=""'] AND provolatile = 's' FROM pg_proc
           WHERE oid = 'public.export_sent_message_attachments(uuid,uuid,integer)'::regprocedure),
  'SECURITY INVOKER, STABLE, with search_path pinned to empty');
SELECT is((SELECT count(*)::int FROM (VALUES ('anon'), ('authenticated')) r(role)
           WHERE has_function_privilege(r.role, 'public.export_sent_message_attachments(uuid,uuid,integer)', 'EXECUTE')), 0,
  'clients (anon, authenticated) cannot execute it');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                      WHERE p.oid = 'public.export_sent_message_attachments(uuid,uuid,integer)'::regprocedure AND a.grantee = 0),
  'no PUBLIC execute grant');
SELECT ok(has_function_privilege('service_role', 'public.export_sent_message_attachments(uuid,uuid,integer)', 'EXECUTE'),
  'service_role can execute it');
-- Only PERMISSIVE policies grant access; restrictive guards (lifecycle,
-- content moderation 20261116120000) can only narrow it.
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND permissive = 'PERMISSIVE'
             AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%dm-attachments%'), 3,
  'Storage policies for dm-attachments are unchanged (no new read access)');

-- ── Fixtures ────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000d6c00001', 'dmx-a@example.invalid', '{"username":"dmx_a"}'),
  ('00000000-0000-4000-8000-0000d6c00002', 'dmx-b@example.invalid', '{"username":"dmx_b"}'),
  ('00000000-0000-4000-8000-0000d6c00003', 'dmx-c@example.invalid', '{"username":"dmx_c"}');
INSERT INTO public.conversations (id) VALUES
  ('00000000-0000-4000-8000-0000d6cb00ab'), ('00000000-0000-4000-8000-0000d6cb00ac'), ('00000000-0000-4000-8000-0000d6cb00bc');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000d6cb00ab', '00000000-0000-4000-8000-0000d6c00001'),
  ('00000000-0000-4000-8000-0000d6cb00ab', '00000000-0000-4000-8000-0000d6c00002'),
  ('00000000-0000-4000-8000-0000d6cb00ac', '00000000-0000-4000-8000-0000d6c00001'),
  ('00000000-0000-4000-8000-0000d6cb00ac', '00000000-0000-4000-8000-0000d6c00003'),
  ('00000000-0000-4000-8000-0000d6cb00bc', '00000000-0000-4000-8000-0000d6c00002'),
  ('00000000-0000-4000-8000-0000d6cb00bc', '00000000-0000-4000-8000-0000d6c00003');

-- Objects (path = <conversation>/<message>/image.jpg unless noted).
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata) VALUES
  -- m01 A→AB, m03 A→AC: A's own photos
  ('dm-attachments', '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0001/image.jpg',
   '00000000-0000-4000-8000-0000d6c00001', '00000000-0000-4000-8000-0000d6c00001', '{"size": 1001}'),
  ('dm-attachments', '00000000-0000-4000-8000-0000d6cb00ac/00000000-0000-4000-8000-0000d6ca0003/image.jpg',
   '00000000-0000-4000-8000-0000d6c00001', '00000000-0000-4000-8000-0000d6c00001', '{"size": 1003}'),
  -- m02 B→AB (recipient's photo), m04 C→BC (another conversation)
  ('dm-attachments', '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0002/image.jpg',
   '00000000-0000-4000-8000-0000d6c00002', '00000000-0000-4000-8000-0000d6c00002', '{"size": 1002}'),
  ('dm-attachments', '00000000-0000-4000-8000-0000d6cb00bc/00000000-0000-4000-8000-0000d6ca0004/image.jpg',
   '00000000-0000-4000-8000-0000d6c00003', '00000000-0000-4000-8000-0000d6c00003', '{"size": 1004}'),
  -- m05 A→AB but Storage says B uploaded it
  ('dm-attachments', '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0005/image.jpg',
   '00000000-0000-4000-8000-0000d6c00002', '00000000-0000-4000-8000-0000d6c00002', '{"size": 1005}'),
  -- m06 A→AB pointing at a non-standard file name
  ('dm-attachments', '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0006/photo.png',
   '00000000-0000-4000-8000-0000d6c00001', '00000000-0000-4000-8000-0000d6c00001', '{"size": 1006}'),
  -- m07 A in AB pointing at a path under ANOTHER conversation
  ('dm-attachments', '00000000-0000-4000-8000-0000d6cb00bc/00000000-0000-4000-8000-0000d6ca0007/image.jpg',
   '00000000-0000-4000-8000-0000d6c00001', '00000000-0000-4000-8000-0000d6c00001', '{"size": 1007}'),
  -- (m08: no object at all)
  -- m09 A→AB, message deleted below
  ('dm-attachments', '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0009/image.jpg',
   '00000000-0000-4000-8000-0000d6c00001', '00000000-0000-4000-8000-0000d6c00001', '{"size": 1009}'),
  -- orphan upload by A (no message), m10
  ('dm-attachments', '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0010/image.jpg',
   '00000000-0000-4000-8000-0000d6c00001', '00000000-0000-4000-8000-0000d6c00001', '{"size": 1010}'),
  -- m11 A→AB whose object is in the WRONG bucket
  ('item-images', '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0011/image.jpg',
   '00000000-0000-4000-8000-0000d6c00001', '00000000-0000-4000-8000-0000d6c00001', '{"size": 1011}'),
  -- m12 A→AC recorded through owner_id only (newer Storage versions)
  ('dm-attachments', '00000000-0000-4000-8000-0000d6cb00ac/00000000-0000-4000-8000-0000d6ca0012/image.jpg',
   NULL, '00000000-0000-4000-8000-0000d6c00001', '{"size": 1012}');

-- Valid messages go through every trigger.
INSERT INTO public.messages (id, conversation_id, sender_id, attachment_type, attachment_storage_path) VALUES
  ('00000000-0000-4000-8000-0000d6ca0001', '00000000-0000-4000-8000-0000d6cb00ab', '00000000-0000-4000-8000-0000d6c00001', 'image',
   '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0001/image.jpg'),
  ('00000000-0000-4000-8000-0000d6ca0002', '00000000-0000-4000-8000-0000d6cb00ab', '00000000-0000-4000-8000-0000d6c00002', 'image',
   '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0002/image.jpg'),
  ('00000000-0000-4000-8000-0000d6ca0003', '00000000-0000-4000-8000-0000d6cb00ac', '00000000-0000-4000-8000-0000d6c00001', 'image',
   '00000000-0000-4000-8000-0000d6cb00ac/00000000-0000-4000-8000-0000d6ca0003/image.jpg'),
  ('00000000-0000-4000-8000-0000d6ca0004', '00000000-0000-4000-8000-0000d6cb00bc', '00000000-0000-4000-8000-0000d6c00003', 'image',
   '00000000-0000-4000-8000-0000d6cb00bc/00000000-0000-4000-8000-0000d6ca0004/image.jpg'),
  ('00000000-0000-4000-8000-0000d6ca0009', '00000000-0000-4000-8000-0000d6cb00ab', '00000000-0000-4000-8000-0000d6c00001', 'image',
   '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0009/image.jpg');
INSERT INTO public.messages (conversation_id, sender_id, body) VALUES
  ('00000000-0000-4000-8000-0000d6cb00ab', '00000000-0000-4000-8000-0000d6c00001', 'a text message from A');

-- Invalid rows the trigger would refuse (written with only that trigger off).
ALTER TABLE public.messages DISABLE TRIGGER messages_enforce_attachment_visibility;
INSERT INTO public.messages (id, conversation_id, sender_id, attachment_type, attachment_storage_path) VALUES
  ('00000000-0000-4000-8000-0000d6ca0005', '00000000-0000-4000-8000-0000d6cb00ab', '00000000-0000-4000-8000-0000d6c00001', 'image',
   '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0005/image.jpg'),
  ('00000000-0000-4000-8000-0000d6ca0006', '00000000-0000-4000-8000-0000d6cb00ab', '00000000-0000-4000-8000-0000d6c00001', 'image',
   '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0006/photo.png'),
  ('00000000-0000-4000-8000-0000d6ca0007', '00000000-0000-4000-8000-0000d6cb00ab', '00000000-0000-4000-8000-0000d6c00001', 'image',
   '00000000-0000-4000-8000-0000d6cb00bc/00000000-0000-4000-8000-0000d6ca0007/image.jpg'),
  ('00000000-0000-4000-8000-0000d6ca0008', '00000000-0000-4000-8000-0000d6cb00ab', '00000000-0000-4000-8000-0000d6c00001', 'image',
   '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0008/image.jpg'),
  ('00000000-0000-4000-8000-0000d6ca0011', '00000000-0000-4000-8000-0000d6cb00ab', '00000000-0000-4000-8000-0000d6c00001', 'image',
   '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0011/image.jpg'),
  ('00000000-0000-4000-8000-0000d6ca0012', '00000000-0000-4000-8000-0000d6cb00ac', '00000000-0000-4000-8000-0000d6c00001', 'image',
   '00000000-0000-4000-8000-0000d6cb00ac/00000000-0000-4000-8000-0000d6ca0012/image.jpg');
ALTER TABLE public.messages ENABLE TRIGGER messages_enforce_attachment_visibility;
DELETE FROM public.messages WHERE id = '00000000-0000-4000-8000-0000d6ca0009'; -- deleted message (object stays, now orphaned)

-- ── As the export worker (service_role) ─────────────────────────────────
SET LOCAL ROLE service_role;
CREATE TEMP TABLE dm_a AS SELECT * FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c00001');

SELECT results_eq($$ SELECT message_id FROM dm_a $$,
  ARRAY['00000000-0000-4000-8000-0000d6ca0001', '00000000-0000-4000-8000-0000d6ca0003', '00000000-0000-4000-8000-0000d6ca0012']::uuid[],
  'A gets exactly A''s own sent photos, in message-id order');
SELECT results_eq($$ SELECT bucket_id, name, size FROM dm_a WHERE message_id = '00000000-0000-4000-8000-0000d6ca0001' $$,
  $$ VALUES ('dm-attachments'::text, '00000000-0000-4000-8000-0000d6cb00ab/00000000-0000-4000-8000-0000d6ca0001/image.jpg'::text, 1001::bigint) $$,
  'each row names the exact dm-attachments object and its size');
SELECT ok(NOT EXISTS (SELECT 1 FROM dm_a WHERE message_id = '00000000-0000-4000-8000-0000d6ca0002'), 'the recipient''s (B''s) photo in the same conversation is excluded');
SELECT ok(NOT EXISTS (SELECT 1 FROM dm_a WHERE message_id = '00000000-0000-4000-8000-0000d6ca0004'), 'photos in a conversation A is not in are excluded');
SELECT ok(EXISTS (SELECT 1 FROM dm_a WHERE message_id = '00000000-0000-4000-8000-0000d6ca0003'), 'A''s photo in another of A''s conversations is included');
SELECT ok(NOT EXISTS (SELECT 1 FROM dm_a WHERE message_id = '00000000-0000-4000-8000-0000d6ca0005'), 'a photo whose Storage owner is not the sender is excluded');
SELECT ok(NOT EXISTS (SELECT 1 FROM dm_a WHERE message_id IN ('00000000-0000-4000-8000-0000d6ca0006', '00000000-0000-4000-8000-0000d6ca0007')),
  'malformed paths (wrong file name, another conversation''s folder) are excluded');
SELECT ok(NOT EXISTS (SELECT 1 FROM dm_a WHERE message_id = '00000000-0000-4000-8000-0000d6ca0008'), 'a message whose object is missing is excluded');
SELECT ok(NOT EXISTS (SELECT 1 FROM dm_a WHERE name LIKE '%d6ca0009%' OR name LIKE '%d6ca0010%'), 'deleted-message and orphaned uploads are excluded');
SELECT ok(NOT EXISTS (SELECT 1 FROM dm_a WHERE message_id = '00000000-0000-4000-8000-0000d6ca0011' OR bucket_id <> 'dm-attachments'),
  'an object in any other bucket is excluded');
SELECT results_eq($$ SELECT message_id FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c00002') $$,
  ARRAY['00000000-0000-4000-8000-0000d6ca0002']::uuid[], 'B gets only B''s own photo');

-- Paging: deterministic, no gaps or repeats; limit clamped to 1..1000.
SELECT results_eq($$ SELECT message_id FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c00001', NULL, 1) $$,
  ARRAY['00000000-0000-4000-8000-0000d6ca0001']::uuid[], 'page 1 (limit 1)');
SELECT results_eq($$ SELECT message_id FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c00001', '00000000-0000-4000-8000-0000d6ca0001', 1) $$,
  ARRAY['00000000-0000-4000-8000-0000d6ca0003']::uuid[], 'page 2 continues after the last message id');
SELECT results_eq($$ SELECT message_id FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c00001', '00000000-0000-4000-8000-0000d6ca0003', 5) $$,
  ARRAY['00000000-0000-4000-8000-0000d6ca0012']::uuid[], 'page 3');
SELECT is((SELECT count(*)::int FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c00001', '00000000-0000-4000-8000-0000d6ca0012')), 0,
  'nothing after the last page');
SELECT is((SELECT count(*)::int FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c00001', NULL, 0)), 1,
  'a zero limit is clamped to 1');
SELECT is((SELECT count(*)::int FROM public.export_sent_message_attachments(NULL)) + (SELECT count(*)::int FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c0ffff')), 0,
  'NULL or unknown user: no rows');

-- Hidden / departed recipient: A's own photos stay A's.
SELECT is((SELECT state FROM public.schedule_account_deletion('00000000-0000-4000-8000-0000d6c00003')), 'pending_deletion', 'C (A''s recipient in AC) goes pending');
SELECT ok(EXISTS (SELECT 1 FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c00001') WHERE message_id = '00000000-0000-4000-8000-0000d6ca0003'),
  'A''s photo to a pending-deletion recipient is still included');
RESET ROLE;
DELETE FROM public.conversation_participants WHERE user_id = '00000000-0000-4000-8000-0000d6c00003'; -- C has left (as after deletion)
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c00001')), 3,
  'and after the recipient is gone from the conversation');
RESET ROLE;

-- ── Clients cannot call it ──────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT * FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c00001') $$, '42501', NULL,
  'authenticated callers are refused');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT * FROM public.export_sent_message_attachments('00000000-0000-4000-8000-0000d6c00001') $$, '42501', NULL,
  'anonymous callers are refused');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
