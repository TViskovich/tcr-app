-- Profile V2 identity card: per-profile CacheCase logo style.
--
-- Independent of banner_variant (20261010120000_add_profile_banner_variant.sql):
-- any banner pairs with any logo, and the two are stored separately — never
-- as combined "banner + logo" values — so new banners or logos can be added
-- later without multiplying ids.
--
-- NULL is meaningful: "the original production logo" — the CacheCase
-- wordmark (assets/brand/cachecase-primary.png) the card has always shown.
-- The new options are a different mark (the CC monogram), so every profile
-- that exists when this runs keeps NULL and looks exactly as it did until its
-- owner picks a logo. Profiles created afterwards get 'color' from the column
-- default (handle_new_user inserts only id/username/display_name, so the
-- default applies). Deliberately nullable — never NOT NULL.
--
-- Allowed values mirror PROFILE_LOGO_VARIANTS in
-- components/profile-v2/profile-logo-variants.ts. Owners write it through
-- the existing profiles_update_own policy, the same way they write
-- banner_variant; everyone can read it through profiles_select_public, so
-- visitors see the owner's choice.

-- 1. Nullable, no default: existing rows stay NULL (legacy wordmark).
ALTER TABLE public.profiles
  ADD COLUMN profile_logo_variant text;

-- 2. NULL or one of the two selectable logos.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_profile_logo_variant_check
  CHECK (
    profile_logo_variant IS NULL
    OR profile_logo_variant IN (
      'color',
      'silver'
    )
  );

-- 3. Only rows inserted from now on get 'color'. SET DEFAULT never rewrites
--    existing rows.
ALTER TABLE public.profiles
  ALTER COLUMN profile_logo_variant SET DEFAULT 'color';

NOTIFY pgrst, 'reload schema';
