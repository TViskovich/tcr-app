BEGIN;

-- ============================================================================
-- Item metadata search — Phase 1 (Collection Search).
--
-- Collection Search used to match only collection_items.title/player/team/
-- brand, client-side, so values entered in an item's category details
-- (a comic's characters or printing, a Pokémon card's set, a sneaker's
-- colorway, ...) were never found. This adds a database-side search over
-- every item's public metadata, built in three reusable layers so Profile
-- Items and the main Search screen can reuse it later with a different
-- scope:
--
--   1. search_normalize_text / search_document / search_query_terms — one
--      text normalization used for BOTH documents and queries.
--   2. collection_item_search_documents — a view with one searchable
--      document per item (SECURITY INVOKER: every underlying RLS policy
--      applies to whoever queries it).
--   3. search_collection_items — Collection Search's scoped, paginated
--      entry point (one folder's active items).
--
-- No item or detail table changes, no new data, no new index.
--
-- Normalization (both sides): lowercase; common accents folded (Pokémon ->
-- pokemon); every non-letter/digit becomes a word break; ordinal words
-- become their numeric form (first -> 1st ... tenth -> 10th) and
-- printing/printings/prints -> print. So "First Printing", "1st printing",
-- "1st Print" and "1st print" all normalize to "1st print".
--
-- Matching: each query term must match the START of a word in the item's
-- document (case-insensitive, partial: "jok" finds "Joker"; "oker" does
-- not), and every term must match (AND). An ordinal and the word after it
-- form one term matched as a phrase ("1st print"), so "first printing" does
-- not match an item that only has "1st Appearance" and "Later Printing",
-- and "1st" never matches "21st". Each field is its own segment
-- (" | "-separated), so a phrase never spans two fields. Words joined by a
-- hyphen/apostrophe/period are also indexed joined ("Spider-Man" is found
-- by "spider man" and "spiderman").
--
-- Privacy: the view and the search function are SECURITY INVOKER, so a
-- caller only ever searches rows collection_items' and each details
-- table's own RLS already let them read (owner: everything they own;
-- anyone else: public items in effectively-public folders, plus the
-- existing Grail-slot exception). Owner-only data is never included:
-- collection_item_private_details (purchase price) isn't joined at all, and
-- estimated_value isn't part of the document. Granted to authenticated
-- only — the app requires a signed-in session; anon gets nothing.
-- ============================================================================

-- ── 1. Normalization ────────────────────────────────────────────────────────
-- Pure text functions over built-ins only. Deliberately WITHOUT a
-- `SET search_path` clause: that clause makes Postgres save/restore a GUC
-- on every call, which measured ~20x slower here (these run once per item
-- per search), and these functions touch no tables — every built-in they
-- use is schema-qualified with pg_catalog, so search_path can't change what
-- they resolve to. The SECURITY INVOKER search function below, which does
-- read tables, keeps its pinned search_path.

-- Words of p_text, normalized (see the header). " | " segment markers in
-- the input are kept as "|" words (only search_document produces them —
-- search_query_terms strips "|" from user queries first).
CREATE OR REPLACE FUNCTION public.search_normalize_text(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(
    pg_catalog.string_agg(
      CASE w
        WHEN 'first' THEN '1st'
        WHEN 'second' THEN '2nd'
        WHEN 'third' THEN '3rd'
        WHEN 'fourth' THEN '4th'
        WHEN 'fifth' THEN '5th'
        WHEN 'sixth' THEN '6th'
        WHEN 'seventh' THEN '7th'
        WHEN 'eighth' THEN '8th'
        WHEN 'ninth' THEN '9th'
        WHEN 'tenth' THEN '10th'
        WHEN 'printing' THEN 'print'
        WHEN 'printings' THEN 'print'
        WHEN 'prints' THEN 'print'
        ELSE w
      END,
      ' ' ORDER BY ord
    ),
    ''
  )
  FROM pg_catalog.regexp_split_to_table(
    pg_catalog.translate(
      pg_catalog.lower(p_text),
      'áàâäãåāéèêëēíìîïīóòôöõøōúùûüūñçýÿ',
      'aaaaaaaeeeeeiiiiiooooooouuuuuncyy'
    ),
    '[^a-z0-9|]+'
  ) WITH ORDINALITY AS t(w, ord)
  WHERE w <> '';
$$;

-- An item's whole search document from its field values, in ONE call (so
-- one normalization pass per item, not one per field): each non-empty
-- field is its own " | "-separated segment, so a phrase never spans two
-- fields ("|" typed inside a value is treated as a space). When any field
-- has words joined by - ' ’ or ., the joined spelling is appended as a
-- second copy ("Spider-Man" -> "spider man | spiderman").
CREATE OR REPLACE FUNCTION public.search_document(p_fields text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH raw AS (
    SELECT pg_catalog.array_to_string(
      ARRAY(
        SELECT pg_catalog.replace(u.f, '|', ' ')
        FROM pg_catalog.unnest(p_fields) WITH ORDINALITY AS u(f, i)
        WHERE u.f IS NOT NULL AND pg_catalog.btrim(u.f) <> ''
        ORDER BY u.i
      ),
      ' | '
    ) AS r
  ),
  variants AS (
    SELECT r, pg_catalog.regexp_replace(r, '([[:alnum:]])[-''’.]+([[:alnum:]])', '\1\2', 'g') AS j
    FROM raw
  )
  SELECT public.search_normalize_text(CASE WHEN j <> r THEN r || ' | ' || j ELSE r END)
  FROM variants;
$$;

-- A query's terms, in order: a number-ordinal plus the word after it is one
-- phrase term ("1st print"); every other word is its own term. At most 8
-- terms from the first 100 characters; '{}' for an empty query.
CREATE OR REPLACE FUNCTION public.search_query_terms(p_query text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE((pg_catalog.array_agg(m[1] ORDER BY ord))[1:8], '{}')
  FROM pg_catalog.regexp_matches(
    COALESCE(public.search_normalize_text(pg_catalog.replace(pg_catalog.left(p_query, 100), '|', ' ')), ''),
    '([0-9]+(?:st|nd|rd|th) [a-z0-9]+|[a-z0-9]+)',
    'g'
  ) WITH ORDINALITY AS r(m, ord);
$$;

-- ── 2. One search document per item ───────────────────────────────────────
-- Every stored text field of the item and its category details, plus
-- human-readable labels for structured values (item type, Other category,
-- comic Raw/Graded, Key Issue / Signed / Restored flags) and every string
-- or number value in an Other item's details (those are stored as their
-- display labels, e.g. "Deadstock (DS)"). Each LEFT JOIN is gated on the
-- item's own type, so at most one details row (and one details RLS check)
-- applies per item.
CREATE OR REPLACE VIEW public.collection_item_search_documents
WITH (security_invoker = true)
AS
SELECT
  ci.id AS item_id,
  ci.user_id,
  ci.folder_id,
  ci.collection_status,
  ci.sort_order,
  -- One field per array element; search_document skips empty ones. Order
  -- doesn't affect matching (each element is its own segment).
  public.search_document(
    ARRAY[
      -- Shared columns (every type; the sports card fields live here).
      ci.title,
      ci.player,
      ci.team,
      ci.brand,
      ci.year::text,
      ci.grading_company,
      ci.grade,
      ci.serial_number,
      ci.description,
      CASE ci.item_type
        WHEN 'sports_card' THEN 'Sports Card'
        WHEN 'pokemon' THEN 'Pokémon'
        WHEN 'comic_book' THEN 'Comic Book'
        WHEN 'trading_card' THEN 'Trading Card'
        WHEN 'figurine' THEN 'Figurine'
      END,
      -- Pokémon
      pk.pokemon_name,
      pk.set_name,
      pk.card_number,
      pk.rarity,
      pk.language,
      pk.edition,
      pk.holo_type,
      pk.grading_company,
      pk.grade,
      -- Trading card
      tc.franchise,
      tc.card_name,
      tc.set_name,
      tc.card_number,
      tc.rarity,
      tc.language,
      tc.edition,
      tc.grading_company,
      tc.grade,
      -- Comic book (key_types is appended below)
      cb.series_title,
      cb.issue_number,
      cb.publisher,
      cb.publication_year::text,
      cb.volume,
      cb.cover_variant,
      cb.printing,
      CASE cb.condition_type WHEN 'graded' THEN 'Graded' WHEN 'raw' THEN 'Raw' END,
      cb.condition,
      cb.grading_company,
      cb.grade,
      cb.certification_number,
      cb.label_type,
      cb.page_quality,
      CASE WHEN cb.is_key_issue THEN 'Key Issue' END,
      cb.key_description,
      cb.characters,
      cb.story_arc,
      cb.writer,
      cb.interior_artist,
      cb.cover_artist,
      cb.edition,
      cb.variant_name,
      cb.variant_artist,
      cb.incentive_ratio,
      cb.retailer_exclusive,
      cb.special_cover_finish,
      cb.country_market,
      CASE WHEN cb.is_signed THEN 'Signed' END,
      cb.signed_by,
      cb.signature_authentication,
      CASE WHEN cb.is_restored THEN 'Restored' END,
      cb.restoration_notes,
      -- Other (Sneakers, Watches, Art & Prints, Toys, Books, Pins, custom);
      -- its details values are appended below.
      CASE oi.category
        WHEN 'sneakers' THEN 'Sneakers'
        WHEN 'watches' THEN 'Watches'
        WHEN 'art_prints' THEN 'Art & Prints'
        WHEN 'toys' THEN 'Toys'
        WHEN 'books' THEN 'Books'
        WHEN 'pins' THEN 'Pins'
        WHEN 'custom' THEN oi.custom_category_name
      END,
      oi.search_identifier
    ]::text[]
    -- Comic key types ('First Appearance', 'Origin', ...).
    || COALESCE(cb.key_types, '{}'::text[])
    -- Every string/number value (and list element) in an Other item's
    -- details; booleans have no readable text and are skipped.
    || ARRAY(
      SELECT v.value
      FROM jsonb_each(COALESCE(oi.details, '{}'::jsonb)) AS e(key, val)
      CROSS JOIN LATERAL (
        SELECT e.val #>> '{}' AS value WHERE jsonb_typeof(e.val) IN ('string', 'number')
        UNION ALL
        SELECT a.elem
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.val) = 'array' THEN e.val ELSE '[]'::jsonb END) AS a(elem)
      ) AS v
    )
  ) AS document
FROM public.collection_items ci
LEFT JOIN public.pokemon_card_details pk ON pk.item_id = ci.id AND ci.item_type = 'pokemon'
LEFT JOIN public.trading_card_details tc ON tc.item_id = ci.id AND ci.item_type = 'trading_card'
LEFT JOIN public.comic_book_details cb ON cb.item_id = ci.id AND ci.item_type = 'comic_book'
LEFT JOIN public.other_item_details oi ON oi.item_id = ci.id AND ci.item_type = 'other';

COMMENT ON VIEW public.collection_item_search_documents IS
  'One normalized search document per collection item (SECURITY INVOKER — the caller''s RLS applies). Shared base for item search; see search_collection_items.';

-- ── 3. Collection Search ───────────────────────────────────────────────────
-- Ids of one folder's ACTIVE, DIRECT items (exactly the set the folder
-- screen lists) matching every query term, in the folder's own order
-- (sort_order, as useItems orders it; id breaks ties), one page at a time.
-- p_limit is clamped to 1..200. An empty/blank query returns nothing.
CREATE OR REPLACE FUNCTION public.search_collection_items(
  p_folder_id uuid,
  p_query text,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (item_id uuid)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT d.item_id
  FROM public.collection_item_search_documents d
  CROSS JOIN (SELECT public.search_query_terms(p_query) AS terms) q
  WHERE d.folder_id = p_folder_id
    AND d.collection_status = 'active'
    AND cardinality(q.terms) > 0
    AND d.document IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM unnest(q.terms) AS term
      WHERE strpos(' ' || d.document, ' ' || term) = 0
    )
  ORDER BY d.sort_order ASC NULLS LAST, d.item_id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

COMMENT ON FUNCTION public.search_collection_items(uuid, text, integer, integer) IS
  'Collection Search: ids of a folder''s active items whose metadata matches every query term, paginated (SECURITY INVOKER — RLS applies).';

-- ── Grants: signed-in users only ───────────────────────────────────────────
REVOKE ALL ON public.collection_item_search_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.collection_item_search_documents TO authenticated;

REVOKE ALL ON FUNCTION public.search_normalize_text(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_document(text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_query_terms(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_normalize_text(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_document(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_query_terms(text) TO authenticated;

REVOKE ALL ON FUNCTION public.search_collection_items(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_collection_items(uuid, text, integer, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
