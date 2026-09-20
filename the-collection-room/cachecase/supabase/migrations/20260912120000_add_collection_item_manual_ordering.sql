-- ============================================================================
-- Manual item reordering within a folder — adds the persisted ordering
-- column collection_items has never had, a reorder RPC, and extends the
-- Phase 2 bulk-move RPC (move_collection_items,
-- 20260911180000_create_move_collection_items_rpc.sql) to keep that
-- ordering valid across moves. There is deliberately ONE ordering column,
-- read by every UI that shows a folder's items "in folder order" (grid,
-- Collections-tab preview row, Grail-slot collection showcase) — no
-- separate "hero order."
--
-- BACKFILL — preserves today's visible order exactly, so nothing visually
-- reshuffles the moment this ships. Every current UI orders items newest-
-- first (created_at DESC); ordering ASCENDING by sort_order must reproduce
-- that same sequence, so the newest item in each folder gets sort_order 0
-- and each older item gets the next integer up.
-- ============================================================================

ALTER TABLE public.collection_items ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY folder_id ORDER BY created_at DESC, id) - 1 AS rn
  FROM public.collection_items
)
UPDATE public.collection_items ci
SET sort_order = ranked.rn
FROM ranked
WHERE ci.id = ranked.id;

CREATE INDEX IF NOT EXISTS collection_items_folder_sort_order_idx ON public.collection_items(folder_id, sort_order);

-- ── New-item placement — a BEFORE INSERT trigger, not an app-code change ───
-- app/item/new.tsx's plain client INSERT never sets sort_order; the column's
-- own DEFAULT 0 would otherwise put every new item in a arbitrary tie with
-- whatever else already has 0. Assigning strictly BELOW the folder's
-- current minimum on every insert keeps today's "newest item shows first"
-- behavior unchanged after this ships, with zero call-site changes and
-- with no need to touch/shift any existing row.
CREATE OR REPLACE FUNCTION public.assign_collection_item_sort_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_min integer;
BEGIN
  SELECT MIN(sort_order) INTO v_min FROM public.collection_items WHERE folder_id = NEW.folder_id;
  NEW.sort_order := COALESCE(v_min, 0) - 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_collection_item_sort_order ON public.collection_items;
CREATE TRIGGER trg_assign_collection_item_sort_order
  BEFORE INSERT ON public.collection_items
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_collection_item_sort_order();

-- ── reorder_collection_items — the one write path for a manual reorder ─────
-- Mirrors reorder_item_images's own shape (supabase/migrations/
-- 20260721120000_create_collection_item_images.sql): validate the supplied
-- id list represents exactly the folder's current eligible items, then one
-- single-statement UPDATE assigns dense 0-based positions from the array's
-- order. SECURITY DEFINER (not INVOKER, unlike reorder_item_images) because
-- authenticated has no UPDATE grant on sort_order at all — every write to
-- this column goes through this RPC or move_collection_items below, never
-- a direct client PATCH; the ownership/membership checks in this function
-- body are what stand in for RLS here, the same design already chosen for
-- move_collection_items.
CREATE OR REPLACE FUNCTION public.reorder_collection_items(
  p_folder_id uuid,
  p_item_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_expected_count integer;
  v_distinct_count integer;
  v_current_count integer;
  v_matched_count integer;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.folder_owned_by(p_folder_id, v_caller) THEN
    RAISE EXCEPTION 'Folder not found or not owned by caller';
  END IF;

  v_expected_count := COALESCE(array_length(p_item_ids, 1), 0);
  IF v_expected_count = 0 THEN
    RAISE EXCEPTION 'No items supplied';
  END IF;

  SELECT COUNT(DISTINCT id) INTO v_distinct_count FROM unnest(p_item_ids) AS id;
  IF v_distinct_count <> v_expected_count THEN
    RAISE EXCEPTION 'Duplicate item ids are not allowed';
  END IF;

  -- Locks the folder's whole current active-item set before validating
  -- "exactly the current eligible items" below, so a concurrent add/move/
  -- delete can't be invisibly reconciled away between this check and the
  -- UPDATE — a stale client-supplied list fails the count/membership
  -- checks atomically rather than silently reordering a partial set.
  PERFORM 1 FROM public.collection_items
  WHERE folder_id = p_folder_id AND collection_status = 'active'
  FOR UPDATE;

  SELECT COUNT(*) INTO v_current_count
  FROM public.collection_items
  WHERE folder_id = p_folder_id AND collection_status = 'active';

  IF v_current_count <> v_expected_count THEN
    RAISE EXCEPTION 'Item list does not match the folder''s current items';
  END IF;

  SELECT COUNT(*) INTO v_matched_count
  FROM public.collection_items
  WHERE id = ANY(p_item_ids)
    AND folder_id = p_folder_id
    AND user_id = v_caller
    AND collection_status = 'active';

  IF v_matched_count <> v_expected_count THEN
    RAISE EXCEPTION 'One or more items are invalid, not yours, or not in this folder';
  END IF;

  UPDATE public.collection_items ci
  SET sort_order = ordered.new_order
  FROM (
    SELECT id, ord - 1 AS new_order
    FROM unnest(p_item_ids) WITH ORDINALITY AS t(id, ord)
  ) ordered
  WHERE ci.id = ordered.id AND ci.folder_id = p_folder_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_collection_items(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reorder_collection_items(uuid, uuid[]) TO authenticated;

-- ── move_collection_items — extended to also assign end-of-destination
-- sort_order, atomically, in the same UPDATE that changes folder_id ───────
-- Phase 1's single-item move (previously a raw client
-- `.update({ folder_id })`) now also calls this RPC with a 1-element array
-- instead — see components/item-detail/move-item-modal.tsx. It had no safe
-- way to compute "end of destination folder" from the client without a
-- read-then-write race; routing it through this already-atomic,
-- already-validated RPC (which handles N>=1 uniformly) avoids inventing a
-- second sort-order-assignment mechanism for what is otherwise identical
-- logic. The bulk-move validation this function already performed
-- (destination ownership, source-folder membership, row locking) is
-- entirely unchanged below — only the trailing UPDATE and its supporting
-- base-offset lookup are new.
CREATE OR REPLACE FUNCTION public.move_collection_items(
  p_item_ids uuid[],
  p_source_folder_id uuid,
  p_destination_folder_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_ids uuid[];
  v_expected_count integer;
  v_matched_count integer;
  v_moved_count integer;
  v_base_order integer;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT array_agg(DISTINCT id) INTO v_ids FROM unnest(p_item_ids) AS id;
  v_expected_count := coalesce(array_length(v_ids, 1), 0);

  IF v_expected_count = 0 THEN
    RAISE EXCEPTION 'No items supplied';
  END IF;

  IF p_source_folder_id IS NULL OR p_destination_folder_id IS NULL THEN
    RAISE EXCEPTION 'Source and destination folder are required';
  END IF;

  IF p_destination_folder_id = p_source_folder_id THEN
    RAISE EXCEPTION 'Destination folder must be different from the source folder';
  END IF;

  IF NOT public.folder_owned_by(p_destination_folder_id, v_caller) THEN
    RAISE EXCEPTION 'Destination folder not found or not owned by caller';
  END IF;

  -- Lock candidates AND every row already in the destination folder before
  -- computing the append base offset below — a second, concurrent move (or
  -- reorder) into the same destination can't observe or produce a
  -- colliding base while this transaction is still open.
  PERFORM 1
  FROM public.collection_items
  WHERE id = ANY(v_ids)
  FOR UPDATE;

  PERFORM 1
  FROM public.collection_items
  WHERE folder_id = p_destination_folder_id
  FOR UPDATE;

  SELECT count(*) INTO v_matched_count
  FROM public.collection_items
  WHERE id = ANY(v_ids)
    AND user_id = v_caller
    AND folder_id = p_source_folder_id
    AND collection_status = 'active';

  IF v_matched_count IS DISTINCT FROM v_expected_count THEN
    RAISE EXCEPTION 'One or more selected items are invalid, not yours, or no longer in the expected folder';
  END IF;

  SELECT COALESCE(MAX(sort_order), -1) + 1 INTO v_base_order
  FROM public.collection_items
  WHERE folder_id = p_destination_folder_id;

  -- Appended in exactly the order the CALLER supplied p_item_ids (its
  -- first occurrence of each id — duplicates collapse to their earliest
  -- position, matching v_ids' own dedup above), not v_ids' unspecified
  -- array_agg(DISTINCT ...) order, which test case "bulk move appended in
  -- deterministic order" depends on.
  UPDATE public.collection_items ci
  SET folder_id = p_destination_folder_id,
      sort_order = v_base_order + seq.rn - 1
  FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY first_ord) AS rn
    FROM (
      SELECT id, MIN(ord) AS first_ord
      FROM unnest(p_item_ids) WITH ORDINALITY AS t(id, ord)
      GROUP BY id
    ) firsts
  ) seq
  WHERE ci.id = seq.id;

  GET DIAGNOSTICS v_moved_count = ROW_COUNT;
  RETURN v_moved_count;
END;
$$;

REVOKE ALL ON FUNCTION public.move_collection_items(uuid[], uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.move_collection_items(uuid[], uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
