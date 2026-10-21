-- pgTAP test for 20261027120000_add_profile_grails_divider_glow.sql.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(8);

SELECT has_column('public', 'profiles', 'grails_divider_glow', 'profiles.grails_divider_glow exists');
SELECT col_type_is('public', 'profiles', 'grails_divider_glow', 'boolean', 'it is a boolean');
SELECT col_not_null('public', 'profiles', 'grails_divider_glow', 'it is never null');
SELECT col_default_is('public', 'profiles', 'grails_divider_glow', 'false', 'it defaults to off');

-- Owner O and another user X (profiles created by the auth trigger).
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000000d1', 'glow-o@example.invalid', '{"username":"glow_test_o"}'),
  ('00000000-0000-4000-8000-0000000000d2', 'glow-x@example.invalid', '{"username":"glow_test_x"}');

SELECT is((SELECT grails_divider_glow FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000d1'), false,
  'a new profile starts with the glow off');

-- The owner can turn their own on.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000d1', true);
UPDATE public.profiles SET grails_divider_glow = true WHERE id = '00000000-0000-4000-8000-0000000000d1';
SELECT is((SELECT grails_divider_glow FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000d1'), true,
  'the owner can turn their own glow on');

-- Another user can't change it, but can read it (visitors see the owner's choice).
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d2","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000d2', true);
UPDATE public.profiles SET grails_divider_glow = false WHERE id = '00000000-0000-4000-8000-0000000000d1';
SELECT is((SELECT grails_divider_glow FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000d1'), true,
  'another user can''t change it (RLS: the update matches no row)');

-- Signed out: still readable.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT is((SELECT grails_divider_glow FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000d1'), true,
  'the owner''s choice is readable to everyone');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
