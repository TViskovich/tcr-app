BEGIN;

-- ============================================================================
-- Collection search — Phase B (Profile Collections).
--
-- Profile V2's Search Collections sheet and the owner's Add menu used to
-- load a collector's ENTIRE folder tree client-side (components/collection/
-- collection-search.tsx) and match collection names by substring. This
-- moves both the traversal and the matching into the database: only the
-- matching collections (with their parent path labels) come back, one page
-- at a time.
--
-- Matches a collection's name, description and genre (folders' own
-- columns — 20261021120000_add_folder_metadata.sql) with the SAME
-- normalization and matching rule as item search
-- (20261031140000_add_collection_item_search.sql: search_document +
-- search_query_terms + search_document_matches). Collection results only —
-- no item metadata. Requires 20261031140000 and 20261031145000 (which adds
-- search_document_matches), applied first.
--
-- Visibility — identical to the client rules it replaces:
--   * the owner with p_include_private (the Add menu): every one of their
--     collections, private and nested ones included;
--   * everyone else: a collection is searchable only when it AND every
--     ancestor is public. The walk starts at the owner's root collections
--     and never descends into a private one, so nothing under a private
--     ancestor is reached and no private name can appear in a result or a
--     path. A private collection that's only visible through the Grail-slot
--     exception is therefore NOT searchable, the same as the public
--     Collection tab.
-- p_include_private is honoured only for the owner themself
-- (auth.uid() = p_owner_id); a visitor passing true still gets the visitor
-- view. SECURITY INVOKER, so folders' RLS applies to every row on top.
--
-- Path: ancestor names, root first (the result's own name is separate).
-- Order: path then name, case-insensitive — the order the sheet always
-- listed results in — then id, so pages are stable.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.search_profile_collections(
  p_owner_id uuid,
  p_query text,
  p_include_private boolean DEFAULT false,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (folder_id uuid, name text, path text[])
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH RECURSIVE
  params AS (
    SELECT
      public.search_query_terms(p_query) AS terms,
      (COALESCE(p_include_private, false) AND (SELECT auth.uid()) = p_owner_id) AS include_private
  ),
  tree AS (
    SELECT f.id, f.name, f.description, f.genre, ARRAY[]::text[] AS path, ARRAY[f.id] AS seen
    FROM public.folders f, params p
    WHERE f.user_id = p_owner_id
      AND f.parent_folder_id IS NULL
      AND (p.include_private OR f.is_public)
    UNION ALL
    SELECT c.id, c.name, c.description, c.genre, t.path || t.name, t.seen || c.id
    FROM tree t
    JOIN public.folders c ON c.parent_folder_id = t.id
    CROSS JOIN params p
    WHERE c.user_id = p_owner_id
      AND (p.include_private OR c.is_public)
      AND NOT c.id = ANY (t.seen)            -- cycle guard
      AND pg_catalog.cardinality(t.seen) < 64 -- depth guard
  )
  SELECT t.id, t.name, t.path
  FROM tree t, params p
  WHERE public.search_document_matches(public.search_document(ARRAY[t.name, t.description, t.genre]), p.terms)
  ORDER BY pg_catalog.lower(pg_catalog.array_to_string(t.path || t.name, E'\x01')) ASC, t.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

COMMENT ON FUNCTION public.search_profile_collections(uuid, text, boolean, integer, integer) IS
  'Profile collection search: a collector''s collections (owner + include_private: all; others: public collections under public ancestors) whose name/description/genre match every query term, with parent path labels, paginated (SECURITY INVOKER — RLS applies).';

REVOKE ALL ON FUNCTION public.search_profile_collections(uuid, text, boolean, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_profile_collections(uuid, text, boolean, integer, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
