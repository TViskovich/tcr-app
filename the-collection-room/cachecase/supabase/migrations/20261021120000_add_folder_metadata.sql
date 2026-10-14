-- Collection / Gallery metadata: optional descriptive fields on folders.
--
-- Collections (top-level) and Galleries (nested, parent_folder_id set) are
-- both rows of public.folders, so one set of columns covers both. There is
-- no structural folder-type column today; collection_type below is purely
-- descriptive (the subject of the collection) and never decides how a
-- folder behaves.
--
--   description      — free text shown under the folder title.
--   collection_year  — a year relevant to the collection (e.g. a set year).
--                      Same 1860–2100 range the Registry already uses for
--                      card years (registered_cards.year).
--   collection_type  — subject category. Values reuse the existing
--                      collection_items.item_type slugs where they overlap,
--                      plus 'mixed' and 'other'. Display labels live in
--                      lib/folder-metadata.ts.
--   genre            — free text (Basketball, Superheroes, Anime, ...).
--
-- All four are nullable with no default: every existing folder keeps
-- exactly its current state (NULL = not provided), and nothing is
-- backfilled. Blank strings are rejected so "cleared" is always NULL.
--
-- No RLS or grant changes: folders already has table-level grants, and
-- folders_insert_own / folders_update_own (auth.uid() = user_id) already
-- restrict who may write any column of a row, these included. Reads follow
-- folders_select_public's existing visibility rules unchanged.
ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS collection_year smallint,
  ADD COLUMN IF NOT EXISTS collection_type text,
  ADD COLUMN IF NOT EXISTS genre text;

ALTER TABLE public.folders
  DROP CONSTRAINT IF EXISTS folders_description_check,
  ADD CONSTRAINT folders_description_check
    CHECK (description IS NULL OR (char_length(description) BETWEEN 1 AND 500 AND btrim(description) <> '')),
  DROP CONSTRAINT IF EXISTS folders_collection_year_check,
  ADD CONSTRAINT folders_collection_year_check
    CHECK (collection_year IS NULL OR collection_year BETWEEN 1860 AND 2100),
  DROP CONSTRAINT IF EXISTS folders_collection_type_check,
  ADD CONSTRAINT folders_collection_type_check
    CHECK (
      collection_type IS NULL
      OR collection_type IN ('sports_card', 'pokemon', 'trading_card', 'comic_book', 'figurine', 'mixed', 'other')
    ),
  DROP CONSTRAINT IF EXISTS folders_genre_check,
  ADD CONSTRAINT folders_genre_check
    CHECK (genre IS NULL OR (char_length(genre) BETWEEN 1 AND 60 AND btrim(genre) <> ''));

NOTIFY pgrst, 'reload schema';
