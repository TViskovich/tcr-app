-- Profile V2 Grails showcase: one appearance mode instead of an on/off glow.
--
--   'off'                — the grid exactly as before.
--   'animated_dividers'  — the existing Grails Divider Glow (light travelling
--                          through the gaps; components/profile-v2/grails-
--                          divider-glow.tsx).
--   'static_outlines'    — a thin, faint, motionless outline around each
--                          occupied Grail tile (components/profile-v2/grails-
--                          static-outlines.tsx).
--
-- Mutually exclusive, so it can't live in grails_divider_glow (a boolean
-- can't say which of two "on" treatments is meant). Requires
-- 20261027120000_add_profile_grails_divider_glow.sql.
--
-- grails_divider_glow is KEPT as a derived legacy mirror —
-- grails_divider_glow = (grails_showcase_effect = 'animated_dividers') — so
-- app builds that only know the boolean keep reading and writing it
-- correctly. A BEFORE trigger keeps the two in step: a write that changes
-- grails_showcase_effect wins and re-derives the boolean; a write that only
-- changes the boolean (an older build) maps true → 'animated_dividers',
-- false → 'off'. Current builds read and write grails_showcase_effect only.
--
-- Same access as the other profile display preferences: owners write it
-- through profiles_update_own; everyone reads it through
-- profiles_select_public. No new policy or grant.

-- 1. Every existing row gets 'off' from the default...
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS grails_showcase_effect text NOT NULL DEFAULT 'off';

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_grails_showcase_effect_check
  CHECK (grails_showcase_effect IN ('off', 'animated_dividers', 'static_outlines'));

-- 2. ...then anyone who already turned the glow on keeps it.
UPDATE public.profiles
  SET grails_showcase_effect = 'animated_dividers'
  WHERE grails_divider_glow;

-- 3. Keep the legacy boolean a pure mirror of the mode.
CREATE OR REPLACE FUNCTION public.profiles_sync_grails_showcase_effect()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.grails_showcase_effect IS NOT DISTINCT FROM OLD.grails_showcase_effect
     AND NEW.grails_divider_glow IS DISTINCT FROM OLD.grails_divider_glow THEN
    -- Only the boolean changed: an older build toggled the glow.
    NEW.grails_showcase_effect := CASE WHEN NEW.grails_divider_glow THEN 'animated_dividers' ELSE 'off' END;
  ELSIF TG_OP = 'INSERT'
     AND NEW.grails_divider_glow
     AND NEW.grails_showcase_effect = 'off' THEN
    NEW.grails_showcase_effect := 'animated_dividers';
  END IF;

  NEW.grails_divider_glow := NEW.grails_showcase_effect = 'animated_dividers';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_sync_grails_showcase_effect ON public.profiles;
CREATE TRIGGER profiles_sync_grails_showcase_effect
  BEFORE INSERT OR UPDATE OF grails_showcase_effect, grails_divider_glow ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_sync_grails_showcase_effect();

NOTIFY pgrst, 'reload schema';
