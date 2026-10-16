-- ============================================================================
-- Collection tally for the collection-detail header ("69 items | 3
-- collections"): one call returning both numbers together, so they always
-- load and refresh as a pair.
--
-- folder_tally(p_folder_id) returns one row:
--   total_items       — active items in the folder AND every descendant
--                       gallery, at any depth (folders nest arbitrarily
--                       since 20260902120000_recursive_folder_hierarchy_
--                       privacy.sql), walked in one recursive CTE.
--   child_collections — DIRECT child folders only (the folder itself and
--                       grandchildren are not counted).
-- One round trip, no item rows or images leave the database, no per-gallery
-- (N+1) queries from the client.
--
-- Counting rules:
--   * Only active items (collection_status = 'active'), the same filter
--     useItems / queryChildFolders already apply — transferred-out items
--     are excluded.
--   * Each item has exactly one folder_id, and the CTE uses UNION (not
--     UNION ALL), so a folder is in the tree once and an item is counted
--     once. count(DISTINCT) is belt-and-braces on top of that. UNION also
--     guarantees termination even if a legacy row ever formed a cycle
--     (writes are already cycle-guarded by folder_would_create_cycle).
--
-- Access control: SECURITY INVOKER (deliberately NOT definer). The folder
-- walk, the child count and the item count all run through the caller's
-- own RLS (folders_select_public / items_select_public), so the tally
-- covers exactly the galleries and items this viewer could open
-- themselves — the same rows the collection screen's own grid queries
-- return: an owner counts everything in their tree; anyone else never
-- counts a private descendant gallery (folder_is_effectively_visible,
-- most-restrictive-ancestor-wins) or a private item. No visibility logic is
-- re-implemented here, so it can't drift from the policies.
--
-- Indexes used: folders_parent_folder_id_idx (descending the tree, child
-- count) and collection_items_folder_sort_order_idx (leading folder_id).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.folder_tally(p_folder_id uuid)
RETURNS TABLE (total_items bigint, child_collections bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH RECURSIVE tree(id) AS (
    SELECT f.id FROM public.folders f WHERE f.id = p_folder_id
    UNION
    SELECT c.id FROM public.folders c JOIN tree t ON c.parent_folder_id = t.id
  )
  SELECT
    (
      SELECT count(DISTINCT ci.id)
      FROM public.collection_items ci
      JOIN tree t ON ci.folder_id = t.id
      WHERE ci.collection_status = 'active'
    ) AS total_items,
    (
      SELECT count(*)
      FROM public.folders c
      WHERE c.parent_folder_id = p_folder_id
    ) AS child_collections;
$$;

-- Signed-in only, matching the other client-facing collection RPCs (see
-- 20261018120000_harden_function_execute_grants.sql for why anon is
-- revoked explicitly rather than only FROM PUBLIC).
REVOKE ALL ON FUNCTION public.folder_tally(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.folder_tally(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.folder_tally(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
