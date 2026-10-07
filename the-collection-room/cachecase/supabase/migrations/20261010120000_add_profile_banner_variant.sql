-- Profile V2 identity card: per-profile banner (outer frame) color.
--
-- Banner color only. The CacheCase logo on the card is a separate concern;
-- a future, independent preference (e.g. profile_logo_variant) can be added
-- alongside this column without touching it — banner values deliberately
-- never encode a logo style.
--
-- NULL is meaningful: "the original production neon frame". Every profile
-- that exists when this runs keeps NULL, so it looks exactly as it did until
-- its owner picks a banner. Profiles created afterwards get 'black' from the
-- column default (handle_new_user inserts only id/username/display_name, so
-- the default applies). Deliberately nullable — never NOT NULL.
--
-- Allowed values mirror PROFILE_BANNER_VARIANTS in
-- components/profile-v2/profile-banner-variants.ts. Owners write it through
-- the existing profiles_update_own policy, the same way they write
-- hero_theme; everyone can read it through profiles_select_public, so
-- visitors see the owner's choice.

-- 1. Nullable, no default: existing rows stay NULL (legacy neon frame).
ALTER TABLE public.profiles
  ADD COLUMN banner_variant text;

-- 2. NULL or one of the seven selectable banners.
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
      'silver'
    )
  );

-- 3. Only rows inserted from now on get 'black'. SET DEFAULT never rewrites
--    existing rows.
ALTER TABLE public.profiles
  ALTER COLUMN banner_variant SET DEFAULT 'black';

NOTIFY pgrst, 'reload schema';
