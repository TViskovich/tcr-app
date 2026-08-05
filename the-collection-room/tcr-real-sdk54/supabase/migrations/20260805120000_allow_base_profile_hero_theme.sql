-- Live profiles_hero_theme_check was never tracked in a migration in this
-- repo (confirmed via a repo-wide search that surfaced this gap — no file
-- under supabase/, including schema.sql, ever referenced hero_theme or
-- this constraint name; it was created directly against the live
-- database outside migration history). Adds 'base' (the new default
-- Hero Canvas theme — see components/profile/hero-canvas-themes.ts's
-- DEFAULT_HERO_CANVAS_THEME) to the allow-list. Drops 'spectra': a live
-- check confirmed zero profile rows currently use it, and it isn't a
-- real HeroCanvasThemeId in the app's theme registry (not a currently
-- active/selectable theme) — not re-added without a proven live app use.
-- DROP CONSTRAINT IF EXISTS makes this safe to run even if the
-- constraint's live name/definition ever drifts from what was captured
-- here. Does not touch the column's type, default, or any existing row —
-- purely a constraint replacement.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_hero_theme_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_hero_theme_check
  CHECK (
    hero_theme = ANY (
      ARRAY[
        'classic'::text,
        'foil'::text,
        'neonCosmic'::text,
        'blackIce'::text,
        'base'::text
      ]
    )
  );
