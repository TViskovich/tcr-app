-- pgTAP test for 20261028120000_add_profile_grails_showcase_effect.sql.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(18);

SELECT has_column('public', 'profiles', 'grails_showcase_effect', 'profiles.grails_showcase_effect exists');
SELECT col_type_is('public', 'profiles', 'grails_showcase_effect', 'text', 'it is text');
SELECT col_not_null('public', 'profiles', 'grails_showcase_effect', 'it is never null');
SELECT col_default_is('public', 'profiles', 'grails_showcase_effect', 'off', 'it defaults to off');
SELECT has_trigger('public', 'profiles', 'profiles_sync_grails_showcase_effect', 'the legacy-mirror trigger exists');

-- Owner O and another user X (profiles created by the auth trigger).
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000000e1', 'effect-o@example.invalid', '{"username":"effect_test_o"}'),
  ('00000000-0000-4000-8000-0000000000e2', 'effect-x@example.invalid', '{"username":"effect_test_x"}');

SELECT results_eq(
  $$SELECT grails_showcase_effect, grails_divider_glow FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'$$,
  $$VALUES ('off'::text, false)$$,
  'a new profile starts with no effect');

SELECT throws_ok(
  $$UPDATE public.profiles SET grails_showcase_effect = 'sparkles' WHERE id = '00000000-0000-4000-8000-0000000000e1'$$,
  '23514', NULL,
  'an unknown effect is rejected');

-- The owner, on a current build (writes the mode only).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000e1', true);

UPDATE public.profiles SET grails_showcase_effect = 'animated_dividers' WHERE id = '00000000-0000-4000-8000-0000000000e1';
SELECT results_eq(
  $$SELECT grails_showcase_effect, grails_divider_glow FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'$$,
  $$VALUES ('animated_dividers'::text, true)$$,
  'animated dividers mirrors to grails_divider_glow = true');

UPDATE public.profiles SET grails_showcase_effect = 'static_outlines' WHERE id = '00000000-0000-4000-8000-0000000000e1';
SELECT results_eq(
  $$SELECT grails_showcase_effect, grails_divider_glow FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'$$,
  $$VALUES ('static_outlines'::text, false)$$,
  'static outlines mirrors to grails_divider_glow = false');

-- Changing both at once: the mode change wins, the boolean is re-derived.
UPDATE public.profiles SET grails_showcase_effect = 'off', grails_divider_glow = true
  WHERE id = '00000000-0000-4000-8000-0000000000e1';
SELECT results_eq(
  $$SELECT grails_showcase_effect, grails_divider_glow FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'$$,
  $$VALUES ('off'::text, false)$$,
  'when both change, the mode wins');

-- Rewriting the SAME mode alongside a flipped boolean is indistinguishable
-- from an older build toggling the glow (a trigger can't tell "written
-- unchanged" from "not written"), so it's treated as one. Current builds
-- never write the boolean.
UPDATE public.profiles SET grails_showcase_effect = 'off', grails_divider_glow = true
  WHERE id = '00000000-0000-4000-8000-0000000000e1';
SELECT results_eq(
  $$SELECT grails_showcase_effect, grails_divider_glow FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'$$,
  $$VALUES ('animated_dividers'::text, true)$$,
  'an unchanged mode with a flipped boolean is a legacy toggle');

-- An older build re-saving the profile with its (unchanged) boolean leaves
-- the mode alone.
UPDATE public.profiles SET grails_showcase_effect = 'static_outlines' WHERE id = '00000000-0000-4000-8000-0000000000e1';
UPDATE public.profiles SET grails_divider_glow = false WHERE id = '00000000-0000-4000-8000-0000000000e1';
SELECT is((SELECT grails_showcase_effect FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'), 'static_outlines',
  'an unchanged legacy boolean doesn''t reset static outlines');

-- An older build toggling the glow on / off.
UPDATE public.profiles SET grails_divider_glow = true WHERE id = '00000000-0000-4000-8000-0000000000e1';
SELECT is((SELECT grails_showcase_effect FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'), 'animated_dividers',
  'legacy glow on → animated dividers');

UPDATE public.profiles SET grails_divider_glow = false WHERE id = '00000000-0000-4000-8000-0000000000e1';
SELECT is((SELECT grails_showcase_effect FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'), 'off',
  'legacy glow off → off');

UPDATE public.profiles SET grails_showcase_effect = 'static_outlines' WHERE id = '00000000-0000-4000-8000-0000000000e1';
SELECT is((SELECT grails_showcase_effect FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'), 'static_outlines',
  'the owner can choose static outlines');

-- Another user can't change it, but can read it (visitors see the owner's choice).
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e2","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000e2', true);
UPDATE public.profiles SET grails_showcase_effect = 'off' WHERE id = '00000000-0000-4000-8000-0000000000e1';
SELECT is((SELECT grails_showcase_effect FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'), 'static_outlines',
  'another user can''t change it (RLS: the update matches no row)');
UPDATE public.profiles SET grails_divider_glow = true WHERE id = '00000000-0000-4000-8000-0000000000e1';
SELECT is((SELECT grails_showcase_effect FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'), 'static_outlines',
  'nor through the legacy boolean');

-- Signed out: still readable.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT is((SELECT grails_showcase_effect FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000e1'), 'static_outlines',
  'the owner''s choice is readable to everyone');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
