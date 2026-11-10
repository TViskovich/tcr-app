-- pgTAP test for 20261114120000_add_content_reports.sql (content reporting,
-- App Store moderation Phase 2A Gate 1 — database only).
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(79);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid) TO authenticated;

-- ── 1. Shape, privileges, exposure ──────────────────────────────────────
SELECT has_table('public', 'content_reports', 'content_reports exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.content_reports'::regclass), 'RLS is on');
SELECT ok(NOT has_table_privilege('anon', 'public.content_reports', 'SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('authenticated', 'public.content_reports', 'SELECT,INSERT,UPDATE,DELETE'),
  'clients have no table privileges at all');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = 'public.content_reports'::regclass AND polpermissive), 0,
  'no permissive (granting) policies — nothing for clients to read or write');
SELECT ok(EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.content_reports'::regclass AND polname = 'account_lifecycle_read_guard' AND NOT polpermissive)
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.content_reports'::regclass AND tgname = 'account_write_guard'),
  'carries the account-lifecycle read and write guards');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.content_reports'::regclass AND tgname = 'content_reports_immutable'),
  'has the immutability trigger');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'public.content_reports'::regclass AND contype = 'f' AND confdeltype = 'n'), 4,
  'reporter, owner, reviewer and claimer ids are set to NULL (not cascaded) when an account is deleted');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.content_reports'::regclass AND contype = 'f'
             AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.content_reports'::regclass AND attname = 'target_id')]),
  'target_id has no foreign key (reports outlive their content)');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'content_reports_one_open_per_reporter'), 'one open report per reporter and target (unique)');
SELECT ok((SELECT NOT prosecdef FROM pg_proc WHERE oid = 'public.submit_report(text,uuid,text,text)'::regprocedure),
  'submit_report runs as the caller (its visibility check is the caller''s RLS)');
SELECT ok((SELECT prosecdef AND proconfig = ARRAY['search_path=""'] FROM pg_proc WHERE oid = 'private.file_content_report(text,uuid,text,text)'::regprocedure),
  'the filing helper is SECURITY DEFINER with an empty search_path');
SELECT ok((SELECT prosecdef AND proconfig = ARRAY['search_path=""'] FROM pg_proc WHERE oid = 'private.content_reports_guard_update()'::regprocedure),
  'the immutability guard is SECURITY DEFINER with an empty search_path');
SELECT ok(NOT has_function_privilege('anon', 'public.submit_report(text,uuid,text,text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.submit_report(text,uuid,text,text)', 'EXECUTE'),
  'only signed-in collectors can submit');
SELECT ok(NOT has_function_privilege('anon', 'private.file_content_report(text,uuid,text,text)', 'EXECUTE'),
  'signed-out callers cannot run the filing helper');
SELECT ok(NOT has_function_privilege('authenticated', 'private.content_reports_guard_update()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'private.report_text(text)', 'EXECUTE'),
  'other private helpers are not executable by clients');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname ~ 'report' AND p.proname <> 'submit_report'
             -- Admin queue functions (20261115120000) are exposed but each checks admin_users itself.
             AND NOT (p.proname LIKE 'admin\_%' AND p.prosecdef AND p.prosrc LIKE '%private.require_admin()%')
             AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))), 0,
  'submit_report is the only non-admin report function exposed through the API');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- A reports; B owns content; C is a bystander; D is pending deletion; E/F cascades.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000ce000001', 'cr-a@example.invalid', '{"username":"cr_a"}'),
  ('00000000-0000-4000-8000-0000ce000002', 'cr-b@example.invalid', '{"username":"cr_b"}'),
  ('00000000-0000-4000-8000-0000ce000003', 'cr-c@example.invalid', '{"username":"cr_c"}'),
  ('00000000-0000-4000-8000-0000ce000004', 'cr-d@example.invalid', '{"username":"cr_d"}');
UPDATE public.profiles SET bio = repeat('b', 3000) WHERE id = '00000000-0000-4000-8000-0000ce000002';
INSERT INTO public.folders (id, user_id, name, is_public) VALUES
  ('00000000-0000-4000-8000-0000cef00001', '00000000-0000-4000-8000-0000ce000002', 'cr b public', true),
  ('00000000-0000-4000-8000-0000cef00002', '00000000-0000-4000-8000-0000ce000002', 'cr b private', false),
  ('00000000-0000-4000-8000-0000cef00004', '00000000-0000-4000-8000-0000ce000004', 'cr d public', true);
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public, collection_status, item_type) VALUES
  ('00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000cef00001', '00000000-0000-4000-8000-0000ce000002', 'cr public card', true, 'active', 'sports_card'),
  ('00000000-0000-4000-8000-0000cee00002', '00000000-0000-4000-8000-0000cef00002', '00000000-0000-4000-8000-0000ce000002', 'cr private card', false, 'active', 'sports_card');
INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path) VALUES
  ('00000000-0000-4000-8000-0000cee00001', '00000000-0000-4000-8000-0000ce000002', 'https://example.invalid/x.jpg', '00000000-0000-4000-8000-0000ce000002/cr/x.jpg');
INSERT INTO public.posts (id, user_id, content, post_type) VALUES
  ('00000000-0000-4000-8000-0000ced00001', '00000000-0000-4000-8000-0000ce000002', 'cr post by B', 'text'),
  ('00000000-0000-4000-8000-0000ced00003', '00000000-0000-4000-8000-0000ce000003', 'cr post by C', 'text'),
  ('00000000-0000-4000-8000-0000ced00004', '00000000-0000-4000-8000-0000ce000004', 'cr post by D', 'text'),
  ('00000000-0000-4000-8000-0000ced000a1', '00000000-0000-4000-8000-0000ce000001', 'cr post by A', 'text');
INSERT INTO public.comments (id, user_id, post_id, body) VALUES
  ('00000000-0000-4000-8000-0000cec00001', '00000000-0000-4000-8000-0000ce000002', '00000000-0000-4000-8000-0000ced00003', 'cr comment by B'),
  ('00000000-0000-4000-8000-0000cec000a1', '00000000-0000-4000-8000-0000ce000001', '00000000-0000-4000-8000-0000ced00003', 'cr comment by A');
INSERT INTO public.item_comments (id, user_id, item_id, body) VALUES
  ('00000000-0000-4000-8000-0000ce1c0001', '00000000-0000-4000-8000-0000ce000002', '00000000-0000-4000-8000-0000cee00001', 'cr item comment'),
  ('00000000-0000-4000-8000-0000ce1c0002', '00000000-0000-4000-8000-0000ce000002', '00000000-0000-4000-8000-0000cee00002', 'cr comment on private item');
INSERT INTO public.folder_comments (id, user_id, folder_id, body) VALUES
  ('00000000-0000-4000-8000-0000ce2c0001', '00000000-0000-4000-8000-0000ce000002', '00000000-0000-4000-8000-0000cef00001', 'cr folder comment');
INSERT INTO public.gallery_comments (id, user_id, folder_id, body, player_key) VALUES
  ('00000000-0000-4000-8000-0000ce3c0001', '00000000-0000-4000-8000-0000ce000002', '00000000-0000-4000-8000-0000cef00001', 'cr gallery comment', 'p1');
INSERT INTO public.conversations (id) VALUES ('00000000-0000-4000-8000-0000cea00001'), ('00000000-0000-4000-8000-0000cea00002');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('00000000-0000-4000-8000-0000cea00001', '00000000-0000-4000-8000-0000ce000001'),
  ('00000000-0000-4000-8000-0000cea00001', '00000000-0000-4000-8000-0000ce000002'),
  ('00000000-0000-4000-8000-0000cea00002', '00000000-0000-4000-8000-0000ce000002'),
  ('00000000-0000-4000-8000-0000cea00002', '00000000-0000-4000-8000-0000ce000003');
INSERT INTO public.messages (id, conversation_id, sender_id, body) VALUES
  ('00000000-0000-4000-8000-0000ceb00001', '00000000-0000-4000-8000-0000cea00001', '00000000-0000-4000-8000-0000ce000002', 'cr abusive message from B'),
  ('00000000-0000-4000-8000-0000ceb00002', '00000000-0000-4000-8000-0000cea00001', '00000000-0000-4000-8000-0000ce000001', 'cr reply from A'),
  ('00000000-0000-4000-8000-0000ceb00003', '00000000-0000-4000-8000-0000cea00002', '00000000-0000-4000-8000-0000ce000002', 'cr private B to C');
INSERT INTO public.account_lifecycle (user_id, state, mode, requested_at, scheduled_for)
  VALUES ('00000000-0000-4000-8000-0000ce000004', 'pending_deletion', 'scheduled', now(), now() + interval '30 days');

CREATE TEMP TABLE notif_before AS SELECT count(*) AS n FROM public.notifications WHERE user_id = '00000000-0000-4000-8000-0000ce000002';

-- ── 2. Every report type, as A ──────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000001');
SELECT is(public.submit_report('profile', '00000000-0000-4000-8000-0000ce000002', 'impersonation'), '{"status": "received", "already_reported": false}'::jsonb, 'profile');
SELECT is(public.submit_report('post', '00000000-0000-4000-8000-0000ced00001', 'spam'), '{"status": "received", "already_reported": false}'::jsonb, 'post');
SELECT is(public.submit_report('comment', '00000000-0000-4000-8000-0000cec00001', 'harassment', '  context here  '), '{"status": "received", "already_reported": false}'::jsonb, 'comment (on a third party''s post)');
SELECT is(public.submit_report('item_comment', '00000000-0000-4000-8000-0000ce1c0001', 'hate'), '{"status": "received", "already_reported": false}'::jsonb, 'item comment');
SELECT is(public.submit_report('folder_comment', '00000000-0000-4000-8000-0000ce2c0001', 'sexual'), '{"status": "received", "already_reported": false}'::jsonb, 'folder comment');
RESET ROLE;
-- Rate limit is 5 per 10 minutes: age A's first reports so the matrix can continue.
-- Test-only time travel: created_at is immutable, so backdate with triggers off (rolled back).
SET LOCAL session_replication_role = replica;
UPDATE public.content_reports SET created_at = created_at - interval '11 minutes';
SET LOCAL session_replication_role = DEFAULT;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000001');
SELECT is(public.submit_report('gallery_comment', '00000000-0000-4000-8000-0000ce3c0001', 'violence'), '{"status": "received", "already_reported": false}'::jsonb, 'gallery comment');
SELECT is(public.submit_report('message', '00000000-0000-4000-8000-0000ceb00001', 'harassment'), '{"status": "received", "already_reported": false}'::jsonb, 'direct message (A is a participant)');
SELECT is(public.submit_report('collection_item', '00000000-0000-4000-8000-0000cee00001', 'scam_fraud'), '{"status": "received", "already_reported": false}'::jsonb, 'public collection item');
SELECT is(public.submit_report('folder', '00000000-0000-4000-8000-0000cef00001', 'intellectual_property'), '{"status": "received", "already_reported": false}'::jsonb, 'public folder');
SELECT is(public.submit_report('post', '00000000-0000-4000-8000-0000ced00001', 'other'), '{"status": "received", "already_reported": true}'::jsonb,
  'a duplicate is acknowledged, not stored twice');

-- ── 3. Refusals (neutral) ───────────────────────────────────────────────
SELECT throws_ok($$ SELECT public.submit_report('message', '00000000-0000-4000-8000-0000ceb00003', 'spam') $$, 'P0002', 'not_found',
  'a message in someone else''s conversation');
SELECT throws_ok($$ SELECT public.submit_report('collection_item', '00000000-0000-4000-8000-0000cee00002', 'spam') $$, 'P0002', 'not_found', 'a private item');
SELECT throws_ok($$ SELECT public.submit_report('folder', '00000000-0000-4000-8000-0000cef00002', 'spam') $$, 'P0002', 'not_found', 'a private folder');
SELECT throws_ok($$ SELECT public.submit_report('item_comment', '00000000-0000-4000-8000-0000ce1c0002', 'spam') $$, 'P0002', 'not_found', 'a comment on a private item');
SELECT throws_ok($$ SELECT public.submit_report('post', '00000000-0000-4000-8000-0000ced00004', 'spam') $$, 'P0002', 'not_found', 'a pending-deletion collector''s post');
SELECT throws_ok($$ SELECT public.submit_report('profile', '00000000-0000-4000-8000-0000ce000004', 'spam') $$, 'P0002', 'not_found', 'a pending-deletion profile');
SELECT throws_ok($$ SELECT public.submit_report('post', gen_random_uuid(), 'spam') $$, 'P0002', 'not_found', 'an unknown id');
SELECT throws_ok($$ SELECT public.submit_report('post', NULL, 'spam') $$, 'P0002', 'not_found', 'a null id');
SELECT throws_ok($$ SELECT public.submit_report('message', '00000000-0000-4000-8000-0000ceb00002', 'spam') $$, '22023', 'cannot_report_self', 'your own message');
SELECT throws_ok($$ SELECT public.submit_report('post', '00000000-0000-4000-8000-0000ced000a1', 'spam') $$, '22023', 'cannot_report_self', 'your own post');
SELECT throws_ok($$ SELECT public.submit_report('comment', '00000000-0000-4000-8000-0000cec000a1', 'spam') $$, '22023', 'cannot_report_self', 'your own comment');
SELECT throws_ok($$ SELECT public.submit_report('profile', '00000000-0000-4000-8000-0000ce000001', 'spam') $$, '22023', 'cannot_report_self', 'your own profile');
SELECT throws_ok($$ SELECT public.submit_report('notification', '00000000-0000-4000-8000-0000ce000002', 'spam') $$, '22023', 'invalid_target_type', 'an unknown type');
SELECT throws_ok($$ SELECT public.submit_report('post', '00000000-0000-4000-8000-0000ced00003', 'rude') $$, '22023', 'invalid_reason', 'an unknown reason');
SELECT throws_ok($$ SELECT public.submit_report('post', '00000000-0000-4000-8000-0000ced00003', 'spam', repeat('x', 501)) $$, '22023', 'details_too_long', 'details over 500 characters');

-- ── 4. Direct access and privilege escalation ───────────────────────────
SELECT throws_ok($$ SELECT count(*) FROM public.content_reports $$, '42501', NULL, 'A cannot read reports, not even its own');
SELECT throws_ok($$ INSERT INTO public.content_reports (reporter_id, target_type, target_id, target_owner_id, reason)
                    VALUES ('00000000-0000-4000-8000-0000ce000001', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000ce000003', 'spam') $$,
  '42501', NULL, 'A cannot insert a forged report directly');
SELECT throws_ok($$ UPDATE public.content_reports SET status = 'dismissed' $$, '42501', NULL, 'A cannot change a report''s status');
SELECT throws_ok($$ DELETE FROM public.content_reports $$, '42501', NULL, 'A cannot delete reports');
-- Calling the helper directly (only possible with SQL access — the private
-- schema is not served by the API) still re-checks visibility and derives
-- the owner/evidence itself.
SELECT throws_ok($$ SELECT private.file_content_report('message', '00000000-0000-4000-8000-0000ceb00003', 'spam', NULL) $$, 'P0002', 'not_found',
  'the helper itself refuses a message A cannot see');
SELECT throws_ok($$ SELECT private.file_content_report('collection_item', '00000000-0000-4000-8000-0000cee00002', 'spam', NULL) $$, 'P0002', 'not_found',
  'the helper itself refuses a private item');

SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000002');
SELECT throws_ok($$ SELECT count(*) FROM public.content_reports $$, '42501', NULL, 'the reported collector cannot read reports');
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000003');
SELECT throws_ok($$ SELECT count(*) FROM public.content_reports WHERE target_owner_id = '00000000-0000-4000-8000-0000ce000002' $$, '42501', NULL,
  'a bystander cannot enumerate reports');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT public.submit_report('post', '00000000-0000-4000-8000-0000ced00003', 'spam') $$, '42501', NULL, 'signed-out callers cannot report');
RESET ROLE;

-- ── 5. Stored rows: trusted owner, bounded evidence, no notifications ──
SELECT is((SELECT count(*)::int FROM public.content_reports WHERE reporter_id = '00000000-0000-4000-8000-0000ce000001'), 9, 'nine reports stored for A');
SELECT is((SELECT count(DISTINCT target_owner_id)::int FROM public.content_reports WHERE reporter_id = '00000000-0000-4000-8000-0000ce000001'), 1,
  'every owner was derived on the server (all B)');
SELECT is((SELECT char_length(evidence ->> 'bio') FROM public.content_reports WHERE target_type = 'profile'), 2000, 'evidence text is capped at 2,000 characters');
SELECT is((SELECT evidence ->> 'body' FROM public.content_reports WHERE target_type = 'message'), 'cr abusive message from B', 'the reported message is captured');
SELECT ok((SELECT NOT (evidence::text LIKE '%cr reply from A%') AND NOT (evidence ? 'conversation_id') FROM public.content_reports WHERE target_type = 'message'),
  '…and nothing else from the conversation (no other messages, no conversation id)');
SELECT is((SELECT evidence -> 'image_refs' -> 0 ->> 'bucket' FROM public.content_reports WHERE target_type = 'collection_item'), 'item-images',
  'images are stored as bucket/path references');
SELECT ok((SELECT evidence::text NOT LIKE '%sign%' AND evidence::text NOT LIKE '%token=%' FROM public.content_reports WHERE target_type = 'collection_item'),
  '…never as signed or public links to private files');
SELECT is((SELECT details FROM public.content_reports WHERE target_type = 'comment'), 'context here', 'details are trimmed');
SELECT is((SELECT priority FROM public.content_reports WHERE target_type = 'gallery_comment'), 'urgent', 'violence is urgent');
SELECT is((SELECT priority FROM public.content_reports WHERE target_type = 'post'), 'normal', 'spam is normal');
SELECT is((SELECT count(*) FROM public.notifications WHERE user_id = '00000000-0000-4000-8000-0000ce000002'), (SELECT n FROM notif_before),
  'the reported collector got no notification from any of the reports');

-- ── 6. Immutability ─────────────────────────────────────────────────────
SELECT throws_ok($$ UPDATE public.content_reports SET evidence = '{"forged": true}' WHERE target_type = 'post' $$, '42501', 'content_report_evidence_immutable',
  'evidence cannot be rewritten');
SELECT throws_ok($$ UPDATE public.content_reports SET evidence = NULL WHERE target_type = 'post' $$, '42501', 'content_report_evidence_immutable',
  'evidence cannot be purged before its retention date');
SELECT throws_ok($$ UPDATE public.content_reports SET target_owner_id = '00000000-0000-4000-8000-0000ce000003' WHERE target_type = 'post' $$, '42501', 'content_report_immutable',
  'the owner cannot be reassigned');
SELECT throws_ok($$ UPDATE public.content_reports SET reason = 'other' WHERE target_type = 'post' $$, '42501', 'content_report_immutable', 'the reason cannot change');
-- (A resolved report carries its outcome — 20261115120000_moderation_admin.sql.)
UPDATE public.content_reports SET status = 'dismissed', reviewed_at = now(), resolution = 'no_violation', resolution_reason = 'within_guidelines',
  evidence_purge_after = now() - interval '1 second' WHERE target_type = 'post';
SELECT lives_ok($$ UPDATE public.content_reports SET evidence = NULL WHERE target_type = 'post' $$, 'evidence can be purged after its retention date');
SELECT ok((SELECT evidence IS NULL AND evidence_purged_at IS NOT NULL FROM public.content_reports WHERE target_type = 'post'), '…and the purge is recorded');

-- ── 7. Blocking compatibility ───────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000003');
SELECT lives_ok($$ SELECT public.block_collector('00000000-0000-4000-8000-0000ce000002') $$, 'C blocks B');
SELECT is(public.submit_report('message', '00000000-0000-4000-8000-0000ceb00003', 'harassment'), '{"status": "received", "already_reported": false}'::jsonb,
  'C can still report B''s historical message after blocking B');
SELECT is(public.submit_report('profile', '00000000-0000-4000-8000-0000ce000002', 'harassment'), '{"status": "received", "already_reported": false}'::jsonb,
  'the blocker can still report the blocked collector''s profile');
SELECT throws_ok($$ SELECT public.submit_report('post', '00000000-0000-4000-8000-0000ced00001', 'spam') $$, 'P0002', 'not_found',
  'posts hidden by the block are not reportable (report before blocking)');
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000002');
SELECT throws_ok($$ SELECT public.submit_report('profile', '00000000-0000-4000-8000-0000ce000003', 'spam') $$, 'P0002', 'not_found',
  'the blocked collector cannot see (or report) the blocker''s profile');
RESET ROLE;

-- ── 8. Rate limits ──────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('00000000-0000-4000-8000-0000ce000009', 'cr-r@example.invalid', '{"username":"cr_r"}');
INSERT INTO public.posts (id, user_id, content, post_type)
  SELECT ('00000000-0000-4000-8000-0000ce9' || lpad(g::text, 5, '0'))::uuid, '00000000-0000-4000-8000-0000ce000003', 'cr rate ' || g, 'text' FROM generate_series(1, 25) g;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000009');
SELECT lives_ok($$ SELECT public.submit_report('post', ('00000000-0000-4000-8000-0000ce9' || lpad(g::text, 5, '0'))::uuid, 'spam') FROM generate_series(1, 5) g $$,
  'five reports in ten minutes are accepted');
SELECT throws_ok($$ SELECT public.submit_report('post', '00000000-0000-4000-8000-0000ce900006', 'spam') $$, '54000', 'rate_limited', 'the sixth within ten minutes is refused');
SELECT is(public.submit_report('post', '00000000-0000-4000-8000-0000ce900001', 'spam'), '{"status": "received", "already_reported": true}'::jsonb,
  'a duplicate is still acknowledged while rate-limited');
RESET ROLE;
-- Test-only time travel: created_at is immutable, so backdate with triggers off (rolled back).
SET LOCAL session_replication_role = replica;
UPDATE public.content_reports SET created_at = now() - interval '11 hours' WHERE reporter_id = '00000000-0000-4000-8000-0000ce000009';
SET LOCAL session_replication_role = DEFAULT;
INSERT INTO public.content_reports (reporter_id, target_type, target_id, target_owner_id, reason, created_at)
  SELECT '00000000-0000-4000-8000-0000ce000009', 'post', gen_random_uuid(), '00000000-0000-4000-8000-0000ce000003', 'spam', now() - interval '12 hours'
  FROM generate_series(1, 15);
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000ce000009');
SELECT throws_ok($$ SELECT public.submit_report('post', '00000000-0000-4000-8000-0000ce900007', 'spam') $$, '54000', 'rate_limited', 'the 21st within a day is refused');
RESET ROLE;

-- ── 9. Deletion: reports survive content and account deletion ──────────
DELETE FROM public.comments WHERE id = '00000000-0000-4000-8000-0000cec00001';
SELECT ok((SELECT evidence ->> 'body' = 'cr comment by B' FROM public.content_reports WHERE target_type = 'comment'),
  'a report outlives its deleted comment, with its evidence');
SELECT lives_ok($$ DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000ce000001' $$, 'the reporter''s account can be deleted');
SELECT is((SELECT count(*)::int FROM public.content_reports WHERE reporter_id IS NULL AND target_owner_id = '00000000-0000-4000-8000-0000ce000002'
             AND target_type IN ('profile', 'message', 'comment')), 3, '…its reports remain, anonymised (reporter → NULL)');

SELECT * FROM finish();
ROLLBACK;
