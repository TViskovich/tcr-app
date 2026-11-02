BEGIN;

-- ============================================================================
-- Item search — shared matching + profile-search view columns.
--
-- Compatibility migration between the already-deployed
-- 20261031140000_add_collection_item_search.sql and the pending
-- 20261031150000_add_profile_item_search.sql /
-- 20261031160000_add_profile_collection_search.sql. Those two need three
-- things 20261031140000 (as deployed) doesn't define — SQL function bodies
-- are validated at CREATE time, so without this they would fail to apply:
--
--   1. search_document_matches(text, text[]) — the one term-matching rule
--      every item/collection search uses (150000 and 160000 both call it).
--   2. collection_item_search_documents.is_public and .sort_name — profile
--      item search's visibility filter and name order (150000).
--   3. search_collection_items rewritten onto search_document_matches, so
--      Collection Search and the new searches share one rule. Same
--      behaviour as the deployed body (same predicate, same order).
--
-- Must run BEFORE 20261031150000 (its timestamp sits between the two). Safe
-- whichever version of 20261031140000 a database actually ran: the view is
-- dropped and recreated (CREATE OR REPLACE VIEW can't reorder or insert
-- columns), and every function is CREATE OR REPLACE. Re-running it is a
-- no-op. Nothing depends on the view at this point except
-- search_collection_items, whose SQL body isn't a tracked dependency and is
-- replaced below in the same transaction; DROP VIEW has no CASCADE, so an
-- unexpected dependent makes this fail loudly instead of dropping it.
--
-- The view's document definition is copied verbatim from 20261031140000 —
-- search documents (and so results) are unchanged. Grants match it:
-- authenticated only, anon nothing.
-- ============================================================================

-- ── 1. The shared matching rule ────────────────────────────────────────────
-- True when every term matches the start of a word (or, for a phrase term,
-- a run of words) in the document. False for no terms or no document. Pure
-- text over built-ins, so no SET search_path (see 20261031140000's
-- normalization section for why), schema-qualified throughout.
CREATE OR REPLACE FUNCTION public.search_document_matches(p_document text, p_terms text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_document IS NOT NULL
    AND pg_catalog.cardinality(p_terms) > 0
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(p_terms) AS term
      WHERE pg_catalog.strpos(' ' || p_document, ' ' || term) = 0
    );
$$;

REVOKE ALL ON FUNCTION public.search_document_matches(text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_document_matches(text, text[]) TO authenticated;

-- ── 2. Search documents view, with the profile-search columns ──────────────
DROP VIEW IF EXISTS public.collection_item_search_documents;

CREATE VIEW public.collection_item_search_documents
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
  ) AS document,
  -- ── Added by this migration (appended after the deployed columns) ──
  ci.is_public,
  -- Profile item search's order: the name Profile V2 shows (player, else
  -- title — profile-v2-item-row.tsx's itemName), case-insensitively.
  pg_catalog.lower(COALESCE(NULLIF(pg_catalog.btrim(ci.player), ''), NULLIF(pg_catalog.btrim(ci.title), ''), 'untitled')) AS sort_name
FROM public.collection_items ci
LEFT JOIN public.pokemon_card_details pk ON pk.item_id = ci.id AND ci.item_type = 'pokemon'
LEFT JOIN public.trading_card_details tc ON tc.item_id = ci.id AND ci.item_type = 'trading_card'
LEFT JOIN public.comic_book_details cb ON cb.item_id = ci.id AND ci.item_type = 'comic_book'
LEFT JOIN public.other_item_details oi ON oi.item_id = ci.id AND ci.item_type = 'other';

COMMENT ON VIEW public.collection_item_search_documents IS
  'One normalized search document per collection item (SECURITY INVOKER — the caller''s RLS applies). Shared base for item search; see search_collection_items / search_profile_items.';

REVOKE ALL ON public.collection_item_search_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.collection_item_search_documents TO authenticated;

-- ── 3. Collection Search on the shared rule (behaviour unchanged) ──────────
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
    AND public.search_document_matches(d.document, q.terms)
  ORDER BY d.sort_order ASC NULLS LAST, d.item_id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

REVOKE ALL ON FUNCTION public.search_collection_items(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_collection_items(uuid, text, integer, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
