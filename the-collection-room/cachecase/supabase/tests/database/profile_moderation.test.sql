-- pgTAP test for 20261117120000_profile_moderation.sql (profile field
-- moderation, App Store moderation Phase 2B M2.2).
-- Run against a LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(110);

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

-- ── 1. Shape, privileges, exposure ──────────────────────────────────────
CREATE TEMP TABLE pm_fns (fn regprocedure);
INSERT INTO pm_fns VALUES ('public.admin_clear_profile_fields(uuid,text[],text,text,boolean)'), ('public.admin_profile_moderation_status(uuid)'),
  ('public.admin_restore_profile_fields(uuid,text[],text,text,text,boolean)'), ('public.admin_release_profile_fields(uuid,text[],text,text,boolean)');

SELECT has_table('public', 'moderated_profile_fields', 'moderated_profile_fields exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.moderated_profile_fields'::regclass)
      AND (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.moderated_profile_fields'::regclass AND polpermissive) = 0,
  'RLS on, no permissive policies');
SELECT ok(NOT has_table_privilege('anon', 'public.moderated_profile_fields', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_table_privilege('authenticated', 'public.moderated_profile_fields', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_table_privilege('service_role', 'public.moderated_profile_fields', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'no API role — not even the service role — can touch original values');
SELECT ok(EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.moderated_profile_fields'::regclass AND polname = 'account_lifecycle_read_guard' AND NOT polpermissive)
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.moderated_profile_fields'::regclass AND tgname = 'account_write_guard'),
  'carries the account-lifecycle guards');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'moderated_profile_fields_one_active'), 'one active restriction per collector and field');
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conrelid = 'public.moderated_profile_fields'::regclass AND contype = 'f'
             AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.moderated_profile_fields'::regclass AND attname = 'user_id')]),
  'c', 'originals are deleted with the account');
SELECT is((SELECT count(*)::int FROM pm_fns t JOIN pg_proc p ON p.oid = t.fn
           WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%'), 4,
  'all 4 admin functions are SECURITY DEFINER, pinned, and check admin_users');
SELECT is((SELECT count(*)::int FROM pm_fns t WHERE has_function_privilege('anon', t.fn, 'EXECUTE') OR has_function_privilege('service_role', t.fn, 'EXECUTE')), 0,
  'admin functions: not for signed-out callers or the service role');
SELECT ok(has_function_privilege('authenticated', 'public.my_profile_moderation()', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.my_profile_moderation()', 'EXECUTE'), 'my_profile_moderation: signed-in only');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'private'
             AND p.proname IN ('write_moderated_profile_field', 'end_profile_field_restrictions', 'check_profile_child_safety',
                               'profile_fields_valid', 'profile_media_present', 'moderated_profile_fields_guard')
             AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
                  OR has_function_privilege('service_role', p.oid, 'EXECUTE'))), 0,
  'internal helpers (including the field writer) are not executable by API roles');
SELECT ok((SELECT NOT prosecdef FROM pg_proc WHERE oid = 'private.enforce_profile_field_locks()'::regprocedure),
  'the lock trigger runs as the updating role (so only the admin path can bypass it)');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_trigger t JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr)
           WHERE t.tgrelid = 'public.profiles'::regclass AND t.tgname = 'profile_field_lock'),
  ARRAY['avatar_url', 'bio', 'display_name', 'hero_display_name', 'hero_image_url', 'location', 'showcase_badge_url', 'tagline', 'website'],
  'the lock covers exactly the 9 supported fields');
SELECT is((SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND data_type = 'text'
             AND column_name IN ('display_name', 'bio', 'tagline', 'location', 'website', 'hero_display_name', 'avatar_url', 'hero_image_url', 'showcase_badge_url')
             AND is_nullable = 'YES' AND has_column_privilege('authenticated', 'public.profiles', column_name, 'UPDATE')), 9,
  'all 9 fields exist, are nullable text and are client-editable (so they need the lock)');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- P and Q are reported collectors; O, V, B are other collectors (P blocks
-- B); M1, M2 are admins.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000be000001', 'pm-p@example.invalid', '{"username":"pm_p"}'),
  ('00000000-0000-4000-8000-0000be000002', 'pm-o@example.invalid', '{"username":"pm_o"}'),
  ('00000000-0000-4000-8000-0000be000003', 'pm-v@example.invalid', '{"username":"pm_v"}'),
  ('00000000-0000-4000-8000-0000be000004', 'pm-q@example.invalid', '{"username":"pm_q"}'),
  ('00000000-0000-4000-8000-0000be000005', 'pm-m1@example.invalid', '{"username":"pm_m1"}'),
  ('00000000-0000-4000-8000-0000be000006', 'pm-m2@example.invalid', '{"username":"pm_m2"}'),
  ('00000000-0000-4000-8000-0000be000007', 'pm-b@example.invalid', '{"username":"pm_b"}');
INSERT INTO public.admin_users (user_id) VALUES ('00000000-0000-4000-8000-0000be000005'), ('00000000-0000-4000-8000-0000be000006');
UPDATE public.profiles SET display_name = 'PM Abusive Name', bio = 'pm abusive bio', tagline = 'pm tagline', location = 'pm location',
  website = 'pm.example', hero_display_name = 'pm hero', showcase_badge_url = NULL,
  avatar_url = 'http://127.0.0.1:54321/storage/v1/object/public/avatars/00000000-0000-4000-8000-0000be000001/avatar.jpg',
  hero_image_url = 'http://127.0.0.1:54321/storage/v1/object/public/avatars/00000000-0000-4000-8000-0000be000001/hero/h.jpg'
 WHERE id = '00000000-0000-4000-8000-0000be000001';
UPDATE public.profiles SET bio = 'pm q bio', display_name = 'pm q name' WHERE id = '00000000-0000-4000-8000-0000be000004';
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('avatars', '00000000-0000-4000-8000-0000be000001/avatar.jpg', '00000000-0000-4000-8000-0000be000001', '00000000-0000-4000-8000-0000be000001'),
  ('avatars', '00000000-0000-4000-8000-0000be000001/hero/h.jpg', '00000000-0000-4000-8000-0000be000001', '00000000-0000-4000-8000-0000be000001');
INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES ('00000000-0000-4000-8000-0000be000001', '00000000-0000-4000-8000-0000be000007');
INSERT INTO public.posts (id, user_id, content, post_type) VALUES
  ('00000000-0000-4000-8000-0000bed00001', '00000000-0000-4000-8000-0000be000001', 'pm post', 'text');
INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence) VALUES
  ('00000000-0000-4000-8000-0000be100001', '00000000-0000-4000-8000-0000be000002', 'profile', '00000000-0000-4000-8000-0000be000001', '00000000-0000-4000-8000-0000be000001', 'hate', '{"v":1,"bio":"pm abusive bio"}'),
  ('00000000-0000-4000-8000-0000be100002', '00000000-0000-4000-8000-0000be000003', 'profile', '00000000-0000-4000-8000-0000be000001', '00000000-0000-4000-8000-0000be000001', 'harassment', '{"v":1}'),
  ('00000000-0000-4000-8000-0000be100003', '00000000-0000-4000-8000-0000be000002', 'profile', '00000000-0000-4000-8000-0000be000004', '00000000-0000-4000-8000-0000be000004', 'child_safety', '{"v":1}'),
  ('00000000-0000-4000-8000-0000be100004', '00000000-0000-4000-8000-0000be000002', 'post', '00000000-0000-4000-8000-0000bed00001', '00000000-0000-4000-8000-0000be000001', 'spam', '{"v":1}'),
  ('00000000-0000-4000-8000-0000be100005', '00000000-0000-4000-8000-0000be000003', 'profile', '00000000-0000-4000-8000-0000be000004', '00000000-0000-4000-8000-0000be000004', 'spam', '{"v":1}');
CREATE TEMP TABLE before_p AS SELECT * FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001';
GRANT SELECT ON before_p TO authenticated;

-- ── 2. Authorization ────────────────────────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001', ARRAY['bio'], 'hate') $$, '42501', NULL, 'signed-out: cannot clear');
SELECT throws_ok($$ SELECT public.my_profile_moderation() $$, '42501', NULL, 'signed-out: no owner status');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000002');
SELECT throws_ok($$ SELECT public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001', ARRAY['bio'], 'hate') $$, '42501', 'forbidden', 'collector: clear refused');
SELECT throws_ok($$ SELECT public.admin_profile_moderation_status('00000000-0000-4000-8000-0000be000001') $$, '42501', 'forbidden', 'collector: status refused');
SELECT throws_ok($$ SELECT public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['bio'], 'resolved_in_error') $$, '42501', 'forbidden', 'collector: restore refused');
SELECT throws_ok($$ SELECT public.admin_release_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['bio'], 'owner_may_edit') $$, '42501', 'forbidden', 'collector: release refused');
SELECT throws_ok($$ SELECT count(*) FROM public.moderated_profile_fields $$, '42501', NULL, 'collector: no direct access to originals');
SELECT throws_ok($$ SELECT private.write_moderated_profile_field('00000000-0000-4000-8000-0000be000002', 'bio', 'x') $$, '42501', NULL, 'collector: cannot call the field writer');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok($$ SELECT count(*) FROM public.moderated_profile_fields $$, '42501', NULL, 'service role: no access to originals');
RESET ROLE;

-- ── 3. Clear ────────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000005');
SELECT throws_ok($$ SELECT public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001', ARRAY['username'], 'hate') $$, '22023', 'invalid_fields', 'username cannot be cleared');
SELECT throws_ok($$ SELECT public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001', ARRAY['bio', 'bio'], 'hate') $$, '22023', 'invalid_fields', 'duplicate fields refused');
SELECT throws_ok($$ SELECT public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001', '{}'::text[], 'hate') $$, '22023', 'invalid_fields', 'empty field list refused');
SELECT throws_ok($$ SELECT public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001', ARRAY['bio', NULL], 'hate') $$, '22023', 'invalid_fields', 'null field refused');
SELECT throws_ok($$ SELECT public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001', ARRAY['bio'], 'pending_review') $$, '22023', 'invalid_reason_code', 'a violation reason is required');
SELECT throws_ok($$ SELECT public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100004', ARRAY['bio'], 'hate') $$, '22023', 'unsupported_target', 'only profile reports clear profile fields');
SELECT throws_ok($$ SELECT public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001', ARRAY['showcase_badge_url'], 'hate') $$, 'PT409', 'nothing_to_clear', 'a blank field cannot be "removed"');
SELECT throws_ok($$ SELECT public.admin_hide_content('00000000-0000-4000-8000-0000be100001', 'pending_review') $$, '22023', 'unsupported_target', 'content hide still refuses profiles');

-- Atomicity: if the audit row cannot be written, nothing is cleared.
RESET ROLE;
ALTER TABLE public.moderation_actions ADD CONSTRAINT pm_test_fail CHECK (action <> 'clear_profile_fields') NOT VALID;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001', ARRAY['bio'], 'hate') $$, '23514', NULL, 'a failing audit insert fails the clear');
RESET ROLE;
SELECT ok((SELECT bio = 'pm abusive bio' FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001')
      AND NOT EXISTS (SELECT 1 FROM public.moderated_profile_fields WHERE user_id = '00000000-0000-4000-8000-0000be000001')
      AND NOT EXISTS (SELECT 1 FROM public.moderated_content WHERE target_type = 'profile' AND target_id = '00000000-0000-4000-8000-0000be000001')
      AND (SELECT status = 'open' FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000be100001'),
  '… field, restriction, umbrella and report all unchanged (one transaction)');
ALTER TABLE public.moderation_actions DROP CONSTRAINT pm_test_fail;
SET LOCAL ROLE authenticated;

SELECT is((SELECT x - 'moderation_id' FROM public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001',
             ARRAY['bio', 'avatar_url', 'display_name', 'showcase_badge_url'], 'hate', 'abusive text and photo') x),
  '{"report_id": "00000000-0000-4000-8000-0000be100001", "report_status": "actioned", "changed": true,
    "cleared": ["bio", "avatar_url", "display_name"], "already_locked": [], "empty": ["showcase_badge_url"], "related_resolved": 0,
    "public_media_still_reachable": ["avatar_url"]}'::jsonb,
  'M1 clears bio, avatar and display name (the blank badge is skipped); the avatar''s public URL is reported as still reachable');
SELECT is(public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001', ARRAY['bio', 'avatar_url', 'display_name'], 'hate') -> 'changed', 'false'::jsonb,
  'clearing again is a no-op retry');
SELECT throws_ok($$ SELECT public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100001', ARRAY['bio'], 'spam') $$, 'PT409', 'already_resolved', 'a different decision on a resolved report is refused');
RESET ROLE;
SELECT ok((SELECT bio IS NULL AND avatar_url IS NULL AND display_name IS NULL FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001'),
  'the three fields are cleared in profiles itself');
SELECT ok((SELECT p.tagline = b.tagline AND p.location = b.location AND p.website = b.website AND p.hero_display_name = b.hero_display_name
             AND p.hero_image_url = b.hero_image_url AND p.username = b.username AND p.hero_theme = b.hero_theme
           FROM public.profiles p, before_p b WHERE p.id = b.id), 'every other field is untouched');
SELECT ok((SELECT status = 'actioned' AND resolution = 'content_removed' AND moderation_id IS NOT NULL
           FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000be100001'), 'the report is actioned and linked');
SELECT ok((SELECT state = 'removed' AND owner_id = '00000000-0000-4000-8000-0000be000001' AND lifted_at IS NULL
           FROM public.moderated_content WHERE target_type = 'profile' AND target_id = '00000000-0000-4000-8000-0000be000001'),
  'one active profile restriction (umbrella)');
SELECT is((SELECT array_agg(field ORDER BY field) FROM public.moderated_profile_fields WHERE user_id = '00000000-0000-4000-8000-0000be000001' AND status = 'active'),
  ARRAY['avatar_url', 'bio', 'display_name'], 'three active field restrictions');
SELECT ok((SELECT original_value = 'pm abusive bio' FROM public.moderated_profile_fields WHERE user_id = '00000000-0000-4000-8000-0000be000001' AND field = 'bio'),
  'the original is preserved server-side');
SELECT ok((SELECT metadata -> 'fields' = '["bio", "avatar_url", "display_name"]'::jsonb AND note = 'abusive text and photo'
             AND metadata::text NOT LIKE '%pm abusive%' AND metadata::text NOT LIKE '%avatar.jpg%'
           FROM public.moderation_actions WHERE report_id = '00000000-0000-4000-8000-0000be100001' AND action = 'clear_profile_fields'),
  'the audit row names the fields but never contains their values');
SELECT ok(EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'avatars' AND name = '00000000-0000-4000-8000-0000be000001/avatar.jpg'),
  'no Storage object is deleted by clearing (quarantine is M2.3)');

-- ── 4. Public reads ─────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000002');
SELECT ok((SELECT bio IS NULL AND display_name IS NULL AND avatar_url IS NULL AND tagline = 'pm tagline'
           FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001'), 'another collector reads the cleared values');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE display_name ILIKE '%Abusive%' OR bio ILIKE '%abusive%'), 0, 'profile search no longer matches the cleared text');
SELECT is(public.my_profile_moderation(), '{"locked_fields": []}'::jsonb, 'another collector learns nothing about P''s restrictions');
RESET ROLE; SELECT pg_temp.logout(); SET LOCAL ROLE anon;
SELECT ok((SELECT bio IS NULL AND display_name IS NULL FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001'), 'signed out: cleared values');
RESET ROLE; SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000007');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001'), 0, 'blocking still hides the profile from the blocked collector');

-- ── 5. The lock ─────────────────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000001');
SELECT ok((SELECT jsonb_agg(x ->> 'field' ORDER BY x ->> 'field') = '["avatar_url", "bio", "display_name"]'::jsonb
             AND (SELECT bool_and((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(y) k) = ARRAY['field', 'since'])
                    FROM jsonb_array_elements(public.my_profile_moderation() -> 'locked_fields') y)
           FROM jsonb_array_elements(public.my_profile_moderation() -> 'locked_fields') x),
  'owner contract: locked field names and dates only');
SELECT ok(public.my_profile_moderation()::text NOT LIKE '%pm abusive%' AND public.my_profile_moderation()::text NOT LIKE '%0000be000002%'
      AND public.my_profile_moderation()::text NOT LIKE '%0000be000005%' AND public.my_profile_moderation()::text NOT LIKE '%avatar.jpg%',
  'owner contract: no original, reporter or admin');
SELECT throws_ok($$ UPDATE public.profiles SET bio = 'pm abusive bio again' WHERE id = '00000000-0000-4000-8000-0000be000001' $$,
  '42501', 'profile_field_locked', 'owner: cannot rewrite the locked bio');
SELECT throws_ok($$ UPDATE public.profiles SET display_name = 'Sneaky' WHERE id = '00000000-0000-4000-8000-0000be000001' $$,
  '42501', 'profile_field_locked', 'owner: cannot rewrite the locked display name');
SELECT throws_ok($$ UPDATE public.profiles SET avatar_url = 'http://127.0.0.1:54321/storage/v1/object/public/avatars/00000000-0000-4000-8000-0000be000001/avatar.jpg' WHERE id = '00000000-0000-4000-8000-0000be000001' $$,
  '42501', 'profile_field_locked', 'owner: cannot re-point the locked avatar (republishing the image)');
SELECT throws_ok($$ INSERT INTO public.profiles (id, username, bio, account_number) VALUES ('00000000-0000-4000-8000-0000be000001', 'pm_p', 'upserted', 1)
                    ON CONFLICT (id) DO UPDATE SET bio = EXCLUDED.bio $$,
  '42501', 'profile_field_locked', 'owner: an upsert cannot rewrite it either');
SELECT lives_ok($$ UPDATE public.profiles SET location = 'pm new location', website = 'pm-new.example' WHERE id = '00000000-0000-4000-8000-0000be000001' $$,
  'owner: unrelated fields remain editable');
SELECT lives_ok($$ UPDATE public.profiles SET bio = '', display_name = NULL, avatar_url = NULL, hero_display_name = 'pm hero 2', tagline = 'pm tagline 2'
                    WHERE id = '00000000-0000-4000-8000-0000be000001' $$,
  'owner: a whole-profile save that re-sends the cleared fields blank succeeds');
RESET ROLE;
SELECT ok((SELECT bio IS NULL AND location = 'pm new location' AND hero_display_name = 'pm hero 2' AND tagline = 'pm tagline 2'
           FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001'), '… the blank re-send keeps the stored (cleared) value; the rest saved');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SET LOCAL cachecase.profile_moderation_write = 'on'; UPDATE public.profiles SET bio = 'flagged' WHERE id = '00000000-0000-4000-8000-0000be000001' $$,
  '42501', 'profile_field_locked', 'owner: setting the bypass flag themselves does nothing');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok($$ UPDATE public.profiles SET bio = 'by service' WHERE id = '00000000-0000-4000-8000-0000be000001' $$,
  '42501', 'profile_field_locked', 'service role: cannot rewrite it');
RESET ROLE;
SELECT throws_ok($$ UPDATE public.profiles SET bio = 'by postgres' WHERE id = '00000000-0000-4000-8000-0000be000001' $$,
  '42501', 'profile_field_locked', 'elevated SQL without the admin path: refused too');

-- ── 6. A second report on the same profile ──────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000006');
SELECT ok((SELECT x -> 'cleared' = '["location"]'::jsonb AND x -> 'already_locked' = '["bio"]'::jsonb
           FROM public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100002', ARRAY['bio', 'location'], 'harassment') x),
  'M2 clears location via a second report; bio is already locked (linked)');
RESET ROLE;
SELECT is((SELECT count(DISTINCT moderation_id)::int FROM public.content_reports
           WHERE id IN ('00000000-0000-4000-8000-0000be100001', '00000000-0000-4000-8000-0000be100002')), 1, 'both reports share one profile restriction');
SELECT is((SELECT count(*)::int FROM public.moderated_profile_fields WHERE user_id = '00000000-0000-4000-8000-0000be000001' AND field = 'bio'), 1,
  'no duplicate restriction for bio');
SET LOCAL ROLE authenticated;

-- ── 7. Restore, release ─────────────────────────────────────────────────
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000005');
SELECT throws_ok($$ SELECT public.admin_restore_content((SELECT moderation_id FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000be100001'), 'resolved_in_error', NULL, 'overturn') $$,
  '42501', NULL, 'admins cannot read report rows directly either (functions only)');
RESET ROLE;
CREATE TEMP TABLE pmid AS SELECT moderation_id AS id FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000be100001';
GRANT SELECT ON pmid TO authenticated;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_restore_content((SELECT id FROM pmid), 'resolved_in_error', NULL, 'overturn') $$,
  '22023', 'use_profile_restore', 'the content restore path refuses profile restrictions');
SELECT throws_ok($$ SELECT public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['bio'], 'resolved_in_error', NULL, 'overturn') $$,
  '22023', 'invalid_disposition', 'a disposition is only for restoring the LAST restricted field');
SELECT ok((SELECT (x ->> 'changed')::boolean AND x -> 'ended' = '["bio"]'::jsonb AND x ->> 'profile_restriction' = 'active'
           FROM public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['bio'], 'appeal_granted', 'context made it fine') x),
  'restore bio alone; the profile restriction stays for the other fields');
RESET ROLE;
SELECT is((SELECT bio FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001'), 'pm abusive bio', 'the original bio is written back');
SELECT is((SELECT status FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000be100001'), 'actioned',
  'reports stay actioned while other fields are still restricted');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000001');
SELECT lives_ok($$ UPDATE public.profiles SET bio = 'pm better bio' WHERE id = '00000000-0000-4000-8000-0000be000001' $$, 'owner: the restored field is editable again');
SELECT throws_ok($$ UPDATE public.profiles SET display_name = 'Still locked' WHERE id = '00000000-0000-4000-8000-0000be000001' $$,
  '42501', 'profile_field_locked', 'owner: other locked fields stay locked');
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000005');
SELECT is(public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['bio'], 'appeal_granted') -> 'changed', 'false'::jsonb,
  'restoring an already-restored field is a no-op');
SELECT ok((SELECT (x ->> 'changed')::boolean AND x -> 'ended' = '["location"]'::jsonb
           FROM public.admin_release_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['location'], 'owner_may_edit') x),
  'release location: lock lifted, original not restored');
RESET ROLE;
SELECT ok((SELECT location IS NULL FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001')
      AND (SELECT status = 'released' FROM public.moderated_profile_fields WHERE user_id = '00000000-0000-4000-8000-0000be000001' AND field = 'location'),
  'a released field stays cleared and is recorded as released (superseded), distinct from restored');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000001');
SELECT lives_ok($$ UPDATE public.profiles SET location = 'pm owner wrote this' WHERE id = '00000000-0000-4000-8000-0000be000001' $$, 'owner: may write a new value after release');
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000005');
SELECT is(public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['location'], 'resolved_in_error') -> 'not_restricted', '["location"]'::jsonb,
  'a released field can no longer be restored over the owner''s newer value');
RESET ROLE;
SELECT is((SELECT location FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001'), 'pm owner wrote this', '… the newer value is kept');

-- A locked field whose value changed anyway (elevated write) is never silently overwritten.
SET LOCAL cachecase.profile_moderation_write = 'on';
UPDATE public.profiles SET display_name = 'elevated write' WHERE id = '00000000-0000-4000-8000-0000be000001';
SET LOCAL cachecase.profile_moderation_write = 'off';
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['display_name', 'avatar_url'], 'appeal_granted', NULL, 'overturn') $$,
  'PT409', 'field_changed', 'restore refuses to overwrite a newer value');
RESET ROLE;
SET LOCAL cachecase.profile_moderation_write = 'on';
UPDATE public.profiles SET display_name = NULL WHERE id = '00000000-0000-4000-8000-0000be000001';
SET LOCAL cachecase.profile_moderation_write = 'off';
SET LOCAL storage.allow_delete_query = 'true';  -- fixture only: simulate the owner deleting their avatar object
DELETE FROM storage.objects WHERE bucket_id = 'avatars' AND name = '00000000-0000-4000-8000-0000be000001/avatar.jpg';
SET LOCAL storage.allow_delete_query = 'false';
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['display_name', 'avatar_url'], 'appeal_granted', NULL, 'overturn') $$,
  'PT409', 'original_media_missing', 'restore refuses to point at a deleted image');
RESET ROLE;
SELECT ok((SELECT display_name IS NULL FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001')
      AND (SELECT count(*) = 2 FROM public.moderated_profile_fields WHERE user_id = '00000000-0000-4000-8000-0000be000001' AND status = 'active'),
  '… and the failed restore changed nothing');
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('avatars', '00000000-0000-4000-8000-0000be000001/avatar.jpg', '00000000-0000-4000-8000-0000be000001', '00000000-0000-4000-8000-0000be000001');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['display_name', 'avatar_url'], 'appeal_granted') $$,
  '22023', 'invalid_disposition', 'restoring the last fields requires a disposition');
SELECT is((SELECT x - 'user_id' FROM public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['display_name', 'avatar_url'], 'appeal_granted', 'overturned on appeal', 'overturn') x),
  '{"changed": true, "ended": ["avatar_url", "display_name"], "not_restricted": [], "profile_restriction": "lifted",
    "reports": [{"id": "00000000-0000-4000-8000-0000be100001", "status": "dismissed"}, {"id": "00000000-0000-4000-8000-0000be100002", "status": "dismissed"}]}'::jsonb,
  'restoring the last fields lifts the restriction and overturns both reports');
RESET ROLE;
SELECT ok((SELECT display_name = 'PM Abusive Name' AND avatar_url LIKE '%/avatars/00000000-0000-4000-8000-0000be000001/avatar.jpg' FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000be000001'),
  'originals written back');
SELECT ok((SELECT lifted_at IS NOT NULL AND lift_reason = 'appeal_granted' FROM public.moderated_content WHERE target_type = 'profile' AND target_id = '00000000-0000-4000-8000-0000be000001'),
  'the profile restriction is lifted');
SELECT is((SELECT count(*)::int FROM public.content_reports WHERE moderation_id IN (SELECT id FROM pmid) AND status = 'actioned'), 0, 'no report left actioned over restored content');
SELECT is((SELECT array_agg(action ORDER BY created_at) FROM public.moderation_actions WHERE report_id = '00000000-0000-4000-8000-0000be100001'),
  ARRAY['clear_profile_fields', 'restore_profile_fields', 'release_profile_fields', 'restore_profile_fields'], 'audit: clear, restore, release, restore');
SET LOCAL ROLE authenticated;
SELECT is(public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000001', ARRAY['display_name'], 'appeal_granted') ->> 'profile_restriction', 'none',
  'nothing left to restore');
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000001');
SELECT is(public.my_profile_moderation(), '{"locked_fields": []}'::jsonb, 'the owner has no locked fields left');

-- Admin inspection.
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000005');
SELECT ok((SELECT g -> 'moderation' = 'null'::jsonb AND jsonb_array_length(g -> 'fields') = 4
             AND (SELECT bool_and(f -> 'original_value' = 'null'::jsonb) FROM jsonb_array_elements(g -> 'fields') f)
           FROM public.admin_profile_moderation_status('00000000-0000-4000-8000-0000be000001') g),
  'admin status: full history, originals shown only while active');

-- ── 8. Child safety ─────────────────────────────────────────────────────
SELECT ok((public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100003', ARRAY['bio'], 'child_safety') ->> 'changed')::boolean,
  'M1 clears a child-safety profile field');
SELECT ok((SELECT (g #>> '{moderation,child_safety}')::boolean AND g #>> '{fields,0,original_value}' = 'pm q bio'
           FROM public.admin_profile_moderation_status('00000000-0000-4000-8000-0000be000004') g), 'admin status: active original and the child-safety flag');
SELECT throws_ok($$ SELECT public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000004', ARRAY['bio'], 'child_safety_review_cleared', 'reviewed', 'overturn', true) $$,
  '42501', 'child_safety_second_admin_required', 'the clearing admin cannot restore it');
SELECT throws_ok($$ SELECT public.admin_release_profile_fields('00000000-0000-4000-8000-0000be000004', ARRAY['bio'], 'child_safety_review_cleared', 'reviewed', true) $$,
  '42501', 'child_safety_second_admin_required', '… nor release it');
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000006');
SELECT throws_ok($$ SELECT public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000004', ARRAY['bio'], 'child_safety_review_cleared', 'reviewed', 'overturn') $$,
  '42501', 'child_safety_confirmation_required', 'a second admin must confirm explicitly');
SELECT throws_ok($$ SELECT public.admin_release_profile_fields('00000000-0000-4000-8000-0000be000004', ARRAY['bio'], 'owner_may_edit', 'reviewed', true) $$,
  '42501', 'child_safety_confirmation_required', 'release needs the child-safety reason too');
SELECT throws_ok($$ SELECT public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000004', ARRAY['bio'], 'child_safety_review_cleared', NULL, 'overturn', true) $$,
  '42501', 'child_safety_confirmation_required', '… and a note');
SELECT ok((public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000004', ARRAY['bio'], 'child_safety_review_cleared', 'escalated, cleared', 'reopen', true) ->> 'changed')::boolean,
  'a second admin with confirmation, reason and note may restore');
RESET ROLE;
SELECT ok((SELECT status = 'open' FROM public.content_reports WHERE id = '00000000-0000-4000-8000-0000be100003'), 'reopen sends the report back to the queue');
SET LOCAL ROLE authenticated;
SELECT ok((public.admin_clear_profile_fields('00000000-0000-4000-8000-0000be100005', ARRAY['display_name'], 'spam') ->> 'changed')::boolean,
  'an ordinary restriction on Q');
SELECT throws_ok($$ SELECT public.admin_restore_profile_fields('00000000-0000-4000-8000-0000be000004', ARRAY['display_name'], 'child_safety_review_cleared', 'x', 'overturn', true) $$,
  '22023', 'invalid_reason_code', 'the child-safety reason is only for child-safety restrictions');

-- ── 9. History is tamper-resistant ──────────────────────────────────────
RESET ROLE;
SELECT throws_ok($$ UPDATE public.moderated_profile_fields SET original_value = 'rewritten' $$, '42501', 'moderated_profile_field_immutable', 'elevated: originals cannot be rewritten');
SELECT throws_ok($$ UPDATE public.moderated_profile_fields SET status = 'active', ended_at = NULL, end_reason = NULL, ended_by = NULL WHERE status <> 'active' $$,
  '42501', 'moderated_profile_field_immutable', 'elevated: an ended restriction cannot be re-activated');
SELECT throws_ok($$ DELETE FROM public.moderated_profile_fields $$, '42501', 'moderated_profile_field_immutable', 'elevated: restrictions cannot be deleted');
SELECT throws_ok($$ TRUNCATE public.moderated_profile_fields $$, '42501', 'moderated_profile_field_immutable', 'elevated: cannot truncate');

-- ── 10. Content moderation and deletion still work ──────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000006');
SELECT is(public.admin_remove_content('00000000-0000-4000-8000-0000be100004', 'spam') ->> 'state', 'removed', 'content removal still works alongside');
SELECT pg_temp.login('00000000-0000-4000-8000-0000be000002');
SELECT is((SELECT count(*)::int FROM public.posts WHERE id = '00000000-0000-4000-8000-0000bed00001'), 0, '… and is enforced');
RESET ROLE;
SELECT pg_temp.logout();
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000be000004';
SELECT ok(NOT EXISTS (SELECT 1 FROM public.moderated_profile_fields WHERE user_id = '00000000-0000-4000-8000-0000be000004'),
  'deleting a collector with an active field restriction works and deletes their originals');
SELECT ok((SELECT bool_and(owner_id IS NULL) FROM public.moderated_content WHERE target_type = 'profile' AND target_id = '00000000-0000-4000-8000-0000be000004'),
  'the restriction history stays, anonymised');
SELECT is((SELECT count(*)::int FROM public.content_reports WHERE target_id = '00000000-0000-4000-8000-0000be000004'), 2, 'the reports stay');
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000be000005';
SELECT ok((SELECT bool_and(created_by IS NULL) FROM public.moderated_profile_fields WHERE user_id = '00000000-0000-4000-8000-0000be000001' AND field = 'bio'),
  'deleting an admin anonymises the restrictions they created');

SELECT * FROM finish();
ROLLBACK;
