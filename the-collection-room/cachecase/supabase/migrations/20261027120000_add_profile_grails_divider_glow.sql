-- Profile V2 Grails showcase: optional "Grails Divider Glow" — a soft light
-- that travels through the gaps between the nine Grail tiles, tinted with
-- the profile's own banner theme (components/profile-v2/grails-divider-
-- glow.tsx).
--
-- A per-profile display preference, so visitors see the owner's choice.
-- NOT NULL DEFAULT false: every existing profile (and every new one) stays
-- exactly as it looks today until its owner turns it on in Edit Profile.
--
-- Same access as the other profile display preferences (hero_theme,
-- banner_variant, profile_logo_variant): owners write it through the
-- existing profiles_update_own policy; everyone reads it through
-- profiles_select_public. No new policy, grant or function.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS grails_divider_glow boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
