-- pgTAP test for 20261203120000_admin_report_media.sql (Phase 2B M5.3:
-- report-scoped media inspection, media restoration scope, legal-hold
-- metadata, profile-field release and image-level enforcement). Synthetic
-- fixtures inside one rolled-back transaction; isolated disposable stack only:
--   PGOPTIONS='-c cachecase.isolated_stack=on' (or SET it first).

BEGIN;
DO $$ BEGIN
  IF current_setting('cachecase.isolated_stack', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'refusing: report media tests run only on an isolated stack (cachecase.isolated_stack=on)';
  END IF;
END $$;
SELECT plan(79);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e5300' || lpad(n::text, 3, '0'))::uuid $$;
CREATE FUNCTION pg_temp.r(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e5310' || lpad(n::text, 3, '0'))::uuid $$;
CREATE FUNCTION pg_temp.t(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e5320' || lpad(n::text, 3, '0'))::uuid $$;
CREATE FUNCTION pg_temp.ver(n int) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT private.report_review_version(c) FROM public.content_reports c WHERE c.id = pg_temp.r(n) $$;
CREATE FUNCTION pg_temp.claim(n int) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.admin_report_case_action(pg_temp.r(n), 'claim', pg_temp.ver(n)) $$;
CREATE FUNCTION pg_temp.enf(n int, p_action text, p_reason text, p_note text DEFAULT NULL, p_opts jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.admin_report_enforce(pg_temp.r(n), p_action, pg_temp.ver(n), p_reason, p_note, p_opts) $$;
CREATE FUNCTION pg_temp.ev(n int) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.admin_report_evidence(pg_temp.r(n)) $$;
CREATE FUNCTION pg_temp.auth(p_admin int, n int, p_ref int, p_confirm boolean DEFAULT false) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$
  SELECT public.report_media_authorize(pg_temp.u(p_admin), pg_temp.r(n), p_ref, p_confirm) $$;
CREATE FUNCTION pg_temp.sq(q text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v text; BEGIN EXECUTE q INTO v; RETURN v; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid), pg_temp.u(int), pg_temp.r(int), pg_temp.t(int), pg_temp.ver(int), pg_temp.claim(int),
  pg_temp.enf(int, text, text, text, jsonb), pg_temp.ev(int), pg_temp.auth(int, int, int, boolean), pg_temp.sq(text) TO authenticated, anon, service_role;
CREATE TEMP TABLE v (k text PRIMARY KEY, val jsonb);
GRANT ALL ON v TO authenticated, anon, service_role;

-- ── 1. Shape and privileges ─────────────────────────────────────────────
SELECT ok((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%'
             AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
             AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
           FROM pg_proc p WHERE p.oid = 'public.admin_report_evidence(uuid)'::regprocedure),
  'admin_report_evidence: SECURITY DEFINER, require_admin, signed-in callers only');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.report_media_authorize(uuid,uuid,integer,boolean)',
             'public.media_quarantine_report_scope(uuid,uuid[])']::regprocedure[]) f
           WHERE has_function_privilege('service_role', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE')
             AND NOT has_function_privilege('anon', f, 'EXECUTE')), 2,
  'the two Edge Function authorizers are service-role only');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'private.report_media_access'::regclass)
      AND NOT has_table_privilege('authenticated', 'private.report_media_access', 'SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('service_role', 'private.report_media_access', 'SELECT,INSERT,UPDATE,DELETE'),
  'the media access log: RLS on, no client or service-role table privileges');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'private.report_media_access'::regclass
             AND tgname IN ('report_media_access_append_only', 'report_media_access_no_truncate') AND tgenabled = 'O'), 2,
  'the media access log is append-only');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'private' AND p.proname LIKE 'report_media%'
             AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))), 0,
  'private media helpers are not executable by clients');
SELECT ok((SELECT p.prosrc ~ 'public\.admin_release_profile_fields' AND p.prosrc ~ 'image_index' AND p.prosrc ~ 'report_changed'
             AND p.prosrc !~ '(INSERT INTO|UPDATE|DELETE FROM) (public|private)\.'
           FROM pg_proc p WHERE p.oid = 'public.admin_report_enforce(uuid,text,text,text,text,jsonb)'::regprocedure),
  'admin_report_enforce adds release and image_index and still writes nothing itself');
SELECT ok((SELECT has_function_privilege('authenticated', 'public.admin_report_enforce(uuid,text,text,text,text,jsonb)', 'EXECUTE')
             AND NOT has_function_privilege('anon', 'public.admin_report_enforce(uuid,text,text,text,text,jsonb)', 'EXECUTE')),
  'admin_report_enforce keeps its grants');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- 1 admin A · 2 admin B · 3 reporter C · 4 owner O · 5 profile owner Q ·
-- 6 collector N · 7 admin S (suspended)
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT pg_temp.u(i), 'rmd-' || i || '@example.invalid', jsonb_build_object('username', 'rmd_user_' || i) FROM generate_series(1, 7) i;
INSERT INTO public.admin_users (user_id) SELECT pg_temp.u(i) FROM unnest(ARRAY[1, 2, 7]) i;
INSERT INTO public.account_suspensions (user_id, reason_code) VALUES (pg_temp.u(7), 'spam');
UPDATE public.profiles SET display_name = 'RMD-SECRET-NAME', bio = 'RMD-SECRET-BIO' WHERE id = pg_temp.u(5);
INSERT INTO public.folders (id, user_id, name, is_public) VALUES (pg_temp.t(1), pg_temp.u(4), 'rmd folder', true);
INSERT INTO public.collection_items (id, folder_id, user_id, title, is_public) VALUES
  (pg_temp.t(2), pg_temp.t(1), pg_temp.u(4), 'rmd item', true), (pg_temp.t(3), pg_temp.t(1), pg_temp.u(4), 'rmd item 2', true);
INSERT INTO public.collection_item_images (id, item_id, user_id, image_url, storage_path) VALUES
  (pg_temp.t(11), pg_temp.t(2), pg_temp.u(4), 'https://x.invalid', pg_temp.u(4) || '/rmd-img-1.jpg'),
  (pg_temp.t(12), pg_temp.t(2), pg_temp.u(4), 'https://x.invalid', pg_temp.u(4) || '/rmd-img-2.jpg'),
  (pg_temp.t(13), pg_temp.t(3), pg_temp.u(4), 'https://x.invalid', pg_temp.u(4) || '/rmd-img-3.jpg');
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('item-images', pg_temp.u(4) || '/rmd-img-1.jpg'), ('item-images', pg_temp.u(4) || '/rmd-img-3.jpg');   -- img-2 is missing
INSERT INTO public.conversations (id) VALUES (pg_temp.t(9));
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES (pg_temp.t(9), pg_temp.u(3)), (pg_temp.t(9), pg_temp.u(4));
INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('dm-attachments', pg_temp.t(9) || '/' || pg_temp.t(5) || '/image.jpg', pg_temp.u(4));
INSERT INTO public.messages (id, conversation_id, sender_id, body, attachment_type, attachment_storage_path) VALUES
  (pg_temp.t(5), pg_temp.t(9), pg_temp.u(4), 'rmd DM', 'image', pg_temp.t(9) || '/' || pg_temp.t(5) || '/image.jpg');

INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence, priority) VALUES
  (pg_temp.r(1), pg_temp.u(3), 'collection_item', pg_temp.t(2), pg_temp.u(4), 'spam',
   jsonb_build_object('v', 1, 'title', 'rmd item', 'image_refs', jsonb_build_array(
     jsonb_build_object('bucket', 'item-images', 'path', pg_temp.u(4) || '/rmd-img-1.jpg'),
     jsonb_build_object('bucket', 'item-images', 'path', pg_temp.u(4) || '/rmd-img-2.jpg'))), 'normal'),
  (pg_temp.r(2), pg_temp.u(3), 'message', pg_temp.t(5), pg_temp.u(4), 'child_safety',
   jsonb_build_object('v', 1, 'body', 'rmd DM', 'attachment_ref', jsonb_build_object('bucket', 'dm-attachments', 'path', pg_temp.t(9) || '/' || pg_temp.t(5) || '/image.jpg')), 'urgent'),
  (pg_temp.r(3), pg_temp.u(3), 'collection_item', pg_temp.t(3), pg_temp.u(4), 'spam',
   jsonb_build_object('v', 1, 'image_refs', jsonb_build_array(jsonb_build_object('bucket', 'item-images', 'path', pg_temp.u(4) || '/rmd-img-3.jpg'))), 'normal'),
  (pg_temp.r(4), pg_temp.u(3), 'profile', pg_temp.u(5), pg_temp.u(5), 'harassment', '{"v":1,"username":"rmd_user_5"}', 'normal');

-- ── 2. Evidence list (admin) ────────────────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT pg_temp.ev(1) $$, '42501', NULL, 'signed-out: evidence refused');
SELECT throws_ok($$ SELECT public.report_media_authorize(pg_temp.u(1), pg_temp.r(1), 1) $$, '42501', NULL, 'signed-out: cannot call the media authorizer');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login(pg_temp.u(6));
SELECT throws_ok($$ SELECT pg_temp.ev(1) $$, '42501', 'forbidden', 'collector: evidence refused');
SELECT pg_temp.login(pg_temp.u(1));
SELECT throws_ok($$ SELECT public.report_media_authorize(pg_temp.u(1), pg_temp.r(1), 1) $$, '42501', NULL,
  'even an admin session cannot call the media authorizer directly (service role only)');
SELECT throws_ok($$ SELECT public.media_quarantine_report_scope(pg_temp.r(1), ARRAY[gen_random_uuid()]) $$, '42501', NULL,
  'nor the restore scope check');
INSERT INTO v SELECT 'e1', pg_temp.ev(1);
SELECT is((SELECT jsonb_agg(jsonb_build_array(m -> 'ref', m ->> 'kind', m -> 'image_index', m -> 'available') ORDER BY (m ->> 'ref')::int)
             FROM jsonb_array_elements((SELECT val -> 'media' FROM v WHERE k = 'e1')) m),
  '[[1, "item_image", 0, true], [2, "item_image", 1, false]]'::jsonb, 'the report''s two item images, in order, with availability');
SELECT ok((SELECT val::text FROM v WHERE k = 'e1') !~ ('rmd-img|item-images|' || pg_temp.u(4)::text),
  'no path, bucket or owner id in the evidence list');
SELECT is((SELECT val -> 'jobs' FROM v WHERE k = 'e1'), '[]'::jsonb, 'no quarantine jobs yet');
SELECT is(jsonb_array_length(pg_temp.ev(2) -> 'media'), 1, 'the DM report lists its photo');
SELECT ok((pg_temp.ev(2) -> 'media' -> 0 ->> 'child_safety')::boolean, 'flagged child safety');
SELECT throws_ok($$ SELECT public.admin_report_evidence('00000000-0000-4000-8000-000000000bad') $$, 'PT404', 'not_found', 'unknown report');

-- ── 3. Media authorization (as the Edge Function's service role) ────────
RESET ROLE;
SELECT is(pg_temp.auth(1, 1, 1) ->> 'path', pg_temp.u(4) || '/rmd-img-1.jpg', 'A, report 1, ref 1: that image is signed');
SELECT is(pg_temp.auth(1, 1, 1) ->> 'bucket', 'item-images', '…from its own bucket');
SELECT is(pg_temp.auth(1, 1, 2) ->> 'reason', 'unavailable', 'a missing object is refused, never resolved elsewhere');
SELECT is(pg_temp.auth(1, 1, 3) ->> 'reason', 'not_found', 'a position the report does not have is refused');
SELECT is(pg_temp.auth(1, 3, 1) ->> 'path', pg_temp.u(4) || '/rmd-img-3.jpg', 'report 3 resolves only to report 3''s own image');
SELECT ok(NOT EXISTS (SELECT 1 FROM generate_series(1, 5) g WHERE pg_temp.auth(1, 1, g) ->> 'path' = pg_temp.u(4) || '/rmd-img-3.jpg'),
  'no position of report 1 reaches report 3''s image (cross-report refusal)');
SELECT is(pg_temp.auth(6, 1, 1) ->> 'reason', 'forbidden', 'collector refused');
SELECT is(pg_temp.auth(7, 1, 1) ->> 'reason', 'forbidden', 'suspended admin refused');
SELECT is(public.report_media_authorize(NULL, pg_temp.r(1), 1) ->> 'reason', 'forbidden', 'no admin id refused');
SELECT is(public.report_media_authorize(pg_temp.u(1), '00000000-0000-4000-8000-000000000bad', 1) ->> 'reason', 'not_found', 'unknown report refused');
SELECT is(pg_temp.auth(1, 2, 1) ->> 'reason', 'child_safety_confirmation_required', 'child-safety media needs explicit confirmation');
SELECT ok(pg_temp.auth(1, 2, 1) ->> 'path' IS NULL, '…and no path is returned without it');
SELECT is(pg_temp.auth(1, 2, 1, true) ->> 'allowed', 'true', 'with confirmation it may be shown');
SELECT is((SELECT count(*)::int FROM private.report_media_access WHERE report_id = pg_temp.r(2)), 3, 'every child-safety request is logged');
SELECT is((SELECT count(*)::int FROM private.report_media_access WHERE report_id = pg_temp.r(2) AND allowed AND child_safety), 1,
  'the one allowed child-safety view is recorded as such');
SELECT throws_ok($$ UPDATE private.report_media_access SET allowed = true $$, '42501', 'report_media_access_append_only', 'the log cannot be rewritten');
SELECT throws_ok($$ DELETE FROM private.report_media_access $$, '42501', 'report_media_access_append_only', 'or deleted');

-- ── 4. Image-level enforcement ──────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login(pg_temp.u(1));
SELECT lives_ok($$ SELECT pg_temp.claim(1) $$, 'A claims report 1');
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'remove', 'spam', NULL, '{"image_index": "x"}') $$, '22023', 'invalid_argument', 'image_index must be an integer');
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'remove', 'spam', NULL, '{"image_index": 7}') $$, '22023', 'invalid_argument', 'an image position the report lacks is refused');
SELECT lives_ok($$ SELECT pg_temp.enf(1, 'remove', 'spam', NULL, '{"image_index": 0}') $$, 'A removes image 1 only');
SELECT is(pg_temp.sq(format('SELECT string_agg(target_type || %L || target_id, %L) FROM public.moderated_content WHERE owner_id = %L AND lifted_at IS NULL',
            ':', ',', pg_temp.u(4))), 'item_image:' || pg_temp.t(11), 'exactly that image is restricted — not the item, not image 2');
SELECT is((SELECT jsonb_agg(m -> 'image_restricted' ORDER BY (m ->> 'ref')::int) FROM jsonb_array_elements(pg_temp.ev(1) -> 'media') m),
  '[true, false]'::jsonb, 'the evidence list marks the restricted image');
SELECT throws_ok($$ SELECT pg_temp.enf(2, 'hide', 'pending_review', NULL, '{"image_index": 0}') $$, 'PT409', 'claim_required',
  'image actions still need the claim');
SELECT lives_ok($$ SELECT pg_temp.claim(2) $$, 'A claims the DM report');
SELECT throws_ok($$ SELECT pg_temp.enf(2, 'hide', 'pending_review', NULL, '{"image_index": 0}') $$, '22023', 'invalid_argument',
  'image_index only applies to collection items');

-- ── 5. Restoration jobs: scope, state and the second administrator ──────
SELECT lives_ok($$ SELECT pg_temp.enf(2, 'remove', 'child_safety') $$, 'A removes the child-safety DM');
INSERT INTO v SELECT 'job', to_jsonb(pg_temp.sq(format('SELECT h.quarantine_id FROM private.media_quarantine_holds h JOIN public.moderated_content m ON m.id = h.moderation_id WHERE m.target_id = %L', pg_temp.t(5))));
SELECT ok((SELECT val #>> '{}' FROM v WHERE k = 'job') IS NOT NULL, 'the DM photo is queued for quarantine');
SELECT is(jsonb_array_length(pg_temp.ev(2) -> 'jobs'), 1, 'the report lists its one job');
SELECT is(pg_temp.ev(2) -> 'jobs' -> 0 ->> 'restore_blocked', 'not_released', 'not restorable while the restriction stands');
SELECT ok((pg_temp.ev(2) -> 'jobs' -> 0 ->> 'child_safety')::boolean AND (pg_temp.ev(2) -> 'jobs' -> 0 ->> 'legal_hold')::boolean,
  'child-safety job, evidence copy under legal hold');
SELECT is(jsonb_array_length(pg_temp.ev(1) -> 'jobs'), 0, 'report 1 does not list report 2''s job');
RESET ROLE;
-- The worker moves the original into quarantine (simulated: no Storage here).
SET LOCAL session_replication_role = replica;
UPDATE private.media_quarantine SET state = 'quarantined', source_removed_at = now(), quarantined_at = now(),
       source_sha256 = repeat('d', 64), quarantine_sha256 = repeat('d', 64)
 WHERE id = (SELECT (val #>> '{}')::uuid FROM v WHERE k = 'job');
DELETE FROM storage.objects WHERE bucket_id = 'dm-attachments' AND name = pg_temp.t(9) || '/' || pg_temp.t(5) || '/image.jpg';
SET LOCAL session_replication_role = origin;
SELECT is(pg_temp.auth(1, 2, 1, true) ->> 'reason', 'quarantined', 'a quarantined original is not served (quarantine copies stay service-only)');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login(pg_temp.u(2));
SELECT lives_ok($$ SELECT pg_temp.enf(2, 'restore', 'child_safety_review_cleared', 'rmd second review', '{"disposition": "reopen", "confirm_child_safety": true}') $$,
  'B lifts the child-safety restriction (second review)');
SELECT is(pg_temp.ev(2) -> 'jobs' -> 0 ->> 'state', 'restore_pending', 'the media now awaits a separate restore');
SELECT ok(pg_temp.ev(2) -> 'jobs' -> 0 ->> 'restore_blocked' IS NULL, 'B may restore it');
SELECT pg_temp.login(pg_temp.u(1));
SELECT is(pg_temp.ev(2) -> 'jobs' -> 0 ->> 'restore_blocked', 'second_admin_required', 'A, who imposed it, may not');
RESET ROLE;
SELECT is(public.media_quarantine_report_scope(pg_temp.r(2), ARRAY[(SELECT (val #>> '{}')::uuid FROM v WHERE k = 'job')]), '{}'::uuid[],
  'scope: the job belongs to report 2');
SELECT is(public.media_quarantine_report_scope(pg_temp.r(1), ARRAY[(SELECT (val #>> '{}')::uuid FROM v WHERE k = 'job')]),
  ARRAY[(SELECT (val #>> '{}')::uuid FROM v WHERE k = 'job')], 'scope: not report 1''s (refused as not_in_report)');
SELECT is(cardinality(public.media_quarantine_report_scope('00000000-0000-4000-8000-000000000bad', ARRAY[gen_random_uuid(), gen_random_uuid()])), 2,
  'scope: an unknown report covers nothing');
SELECT is(cardinality(public.media_quarantine_report_scope(pg_temp.r(2), ARRAY[gen_random_uuid()])), 1, 'scope: an unknown job is out of scope');
SELECT ok((public.media_quarantine_authorize(pg_temp.u(1), 'restore', ARRAY[(SELECT (val #>> '{}')::uuid FROM v WHERE k = 'job')], true) -> 'jobs' -> 0 ->> 'reason')
  = 'second_admin_required', 'the existing restore authorization agrees: A is refused');
SELECT ok((public.media_quarantine_authorize(pg_temp.u(2), 'restore', ARRAY[(SELECT (val #>> '{}')::uuid FROM v WHERE k = 'job')], false) -> 'jobs' -> 0 ->> 'reason')
  = 'child_safety_confirmation_required', '…B needs the confirmation');
SELECT ok((public.media_quarantine_authorize(pg_temp.u(2), 'restore', ARRAY[(SELECT (val #>> '{}')::uuid FROM v WHERE k = 'job')], true) -> 'jobs' -> 0 ->> 'allowed')::boolean,
  '…and with it B is allowed');

-- ── 6. Legal holds: minimal metadata ────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login(pg_temp.u(1));
SELECT lives_ok($$ SELECT public.admin_place_legal_hold('report', pg_temp.r(2), 'law_enforcement_request', 'RMD-SECRET-HOLD-NOTE', NULL) $$,
  'hold placed on report 2 (existing function; child-safety holds have no end date)');
SELECT is((SELECT jsonb_agg(h ->> 'subject' || ':' || (h ->> 'basis_code')) FROM jsonb_array_elements(pg_temp.ev(2) -> 'legal_holds') h),
  '["report:law_enforcement_request"]'::jsonb, 'the hold is listed with its basis code');
SELECT ok(pg_temp.ev(2)::text !~ 'RMD-SECRET-HOLD-NOTE|placed_by', 'never its note or who placed it');
SELECT is(pg_temp.ev(1) -> 'legal_holds', '[]'::jsonb, 'report 1 shows no hold');

-- ── 7. Profile-field release ────────────────────────────────────────────
SELECT lives_ok($$ SELECT pg_temp.claim(4) $$, 'A claims the profile report');
SELECT lives_ok($$ SELECT pg_temp.enf(4, 'clear_profile_fields', 'harassment', NULL, '{"fields": ["display_name", "bio"]}') $$, 'A clears display name and bio');
INSERT INTO v SELECT 'v4', to_jsonb(pg_temp.ver(4));
SELECT throws_ok($$ SELECT pg_temp.enf(4, 'release_profile_fields', 'appeal_granted', NULL, '{"fields": ["bio"]}') $$, '22023', 'invalid_reason_code',
  'release takes release reasons only');
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'release_profile_fields', 'owner_may_edit', NULL, '{"fields": ["bio"]}') $$, '22023', 'unsupported_target',
  'release applies to profile reports only');
SELECT throws_ok($$ SELECT pg_temp.enf(4, 'release_profile_fields', 'owner_may_edit', NULL, '{"fields": ["bio"], "disposition": "reopen"}') $$, '22023', 'invalid_disposition',
  'a release never decides the reports');
SELECT lives_ok($$ SELECT pg_temp.enf(4, 'release_profile_fields', 'owner_may_edit', NULL, '{"fields": ["bio"]}') $$, 'A releases bio');
SELECT throws_ok($$ SELECT public.admin_report_enforce(pg_temp.r(4), 'release_profile_fields', (SELECT val #>> '{}' FROM v WHERE k = 'v4'), 'owner_may_edit', NULL, '{"fields": ["display_name"]}') $$,
  'PT409', 'report_changed', 'a release from a stale screen is refused');
SELECT is(pg_temp.sq(format('SELECT string_agg(field || %L || status, %L ORDER BY field) FROM public.moderated_profile_fields WHERE user_id = %L', ':', ',', pg_temp.u(5))),
  'bio:released,display_name:active', 'bio released; display name still restricted');
SELECT is(pg_temp.sq(format('SELECT COALESCE(bio, %L) FROM public.profiles WHERE id = %L', '∅', pg_temp.u(5))), '∅', 'the value is not restored by a release');
SELECT is(pg_temp.sq(format('SELECT status FROM public.content_reports WHERE id = %L', pg_temp.r(4))), 'actioned', 'the report decision is unchanged');
SELECT is(pg_temp.sq(format('SELECT count(*) FROM public.moderation_actions WHERE report_id = %L AND action = %L', pg_temp.r(4), 'release_profile_fields')), '1',
  'release audited');
RESET ROLE;
SELECT lives_ok($$ UPDATE public.profiles SET bio = 'rmd new bio' WHERE id = pg_temp.u(5) $$, 'the collector may now edit the released field');
SELECT throws_ok($$ UPDATE public.profiles SET display_name = 'rmd new name' WHERE id = pg_temp.u(5) $$, NULL, 'profile_field_locked',
  '…but not the field still restricted');

SELECT * FROM finish();
ROLLBACK;
