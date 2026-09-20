-- ============================================================================
-- Profile 2.0 — collector identity + preferences fields (infrastructure
-- only; no UI changes in this migration).
--
-- tagline / website / location are free-text and nullable. tagline is the
-- only one with a DB-level constraint (an 80-character ceiling) — website
-- and location get no format enforcement here by design: URL validation/
-- normalization and any geocoding are explicitly deferred to a future UI
-- pass, and location is intentionally free-text (e.g. "Las Vegas, NV"),
-- never coordinates.
--
-- favorite_sports / favorite_teams / collecting_categories / collector_tags
-- are plain text[], NOT PostgreSQL enums and with no lookup table — the
-- allowed values are still an open product question, so this stays purely
-- additive. All four are NOT NULL with an empty-array default so every
-- existing and future row has a real array to read/render without a
-- null-check at every call site.
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN tagline text,
  ADD COLUMN website text,
  ADD COLUMN location text,
  ADD COLUMN favorite_sports text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN favorite_teams text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN collecting_categories text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN collector_tags text[] NOT NULL DEFAULT '{}'::text[];

-- Named for identifiability in error messages and any future DROP
-- CONSTRAINT. Explicitly allows NULL (an unset tagline) — only enforces
-- the length ceiling once a value is present.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_tagline_length_check
  CHECK (tagline IS NULL OR char_length(tagline) <= 80);

-- No RLS policy change: profiles_select_public (USING true),
-- profiles_insert_own / profiles_update_own (auth.uid() = id) already
-- cover every column on the table, including these seven — RLS in this
-- schema is row-level, not column-level, so new columns need no policy
-- changes to be readable/writable exactly like every existing column.

NOTIFY pgrst, 'reload schema';
