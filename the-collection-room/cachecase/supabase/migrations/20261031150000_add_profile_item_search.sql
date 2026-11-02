BEGIN;

-- ============================================================================
-- Item metadata search — Phase A (Profile Items).
--
-- Profile V2's Search Items sheet matched only the item's player/title,
-- client-side. This adds the profile-wide entry point over the SAME search
-- documents, normalization and matching rule as Collection Search
-- (20261031140000_add_collection_item_search.sql) — no second algorithm.
-- Requires 20261031145000_add_shared_search_matching.sql (the shared
-- search_document_matches rule and the view's is_public / sort_name
-- columns), which must be applied first.
--
-- Scope: one profile's ACTIVE items across all of its collections (nested
-- ones included) — exactly the set Profile V2's Items tab shows the viewer
-- (hooks/use-collection.ts useAllItems):
--   * the owner: every one of their active items, private ones included;
--   * anyone else: items that are public themselves AND whose folder and
--     every ancestor folder are public (folder_is_effectively_visible —
--     the canonical recursive rule, reused). This deliberately does NOT
--     include the Grail-slot exception that collection_items' RLS also
--     allows: a private item showcased in someone's Grails is visible
--     there, but it is not one of their searchable Items, the same as the
--     Items tab.
-- On top of that the view is SECURITY INVOKER and so is this function, so
-- the caller's RLS still applies to every row — this can only narrow what
-- RLS allows, never widen it.
--
-- Order: the name Profile V2 lists items by (player, else title), case-
-- insensitive, then id — so pages are stable and arrive in display order.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.search_profile_items(
  p_owner_id uuid,
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
  CROSS JOIN (SELECT public.search_query_terms(p_query) AS terms, (SELECT auth.uid()) AS caller) q
  WHERE d.user_id = p_owner_id
    AND d.collection_status = 'active'
    AND (
      q.caller = p_owner_id
      OR (d.is_public AND public.folder_is_effectively_visible(d.folder_id))
    )
    AND public.search_document_matches(d.document, q.terms)
  ORDER BY d.sort_name ASC, d.item_id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

COMMENT ON FUNCTION public.search_profile_items(uuid, text, integer, integer) IS
  'Profile item search: ids of a profile''s active items (owner: all; others: public items in effectively-public folders) whose metadata matches every query term, by name, paginated (SECURITY INVOKER — RLS applies).';

REVOKE ALL ON FUNCTION public.search_profile_items(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_profile_items(uuid, text, integer, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
