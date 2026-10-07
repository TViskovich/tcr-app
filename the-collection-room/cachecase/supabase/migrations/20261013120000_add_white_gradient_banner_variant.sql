-- Profile V2 identity card: add the 'white_gradient' banner.
--
-- Widens profiles_banner_variant_check (created in
-- 20261010120000_add_profile_banner_variant.sql) from seven selectable
-- banners to eight. Nothing else changes: NULL still means the original
-- neon frame, the column default stays 'black', and no existing row is
-- rewritten.
--
-- Idempotent: DROP ... IF EXISTS + recreate is safe to run more than once.
-- Re-adding the CHECK validates existing rows but modifies none of them —
-- every current value is in the new list, so validation can't fail.
--
-- Allowed values mirror PROFILE_BANNER_VARIANTS in
-- components/profile-v2/profile-banner-variants.ts.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_banner_variant_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_banner_variant_check
  CHECK (
    banner_variant IS NULL
    OR banner_variant IN (
      'black',
      'blue_gradient',
      'brand_gradient',
      'gold',
      'gold_silver',
      'red_gradient',
      'silver',
      'white_gradient'
    )
  );

NOTIFY pgrst, 'reload schema';
