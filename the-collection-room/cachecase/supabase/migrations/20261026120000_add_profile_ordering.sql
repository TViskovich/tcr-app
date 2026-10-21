BEGIN;

-- ============================================================================
-- Persistent ordering for Profile V2's Collection and Items tabs (owner
-- Edit Mode drag-and-drop):
--
--   folders.sort_order                 — collections, ordered among their
--                                        SIBLINGS (same owner + same
--                                        parent; parent NULL = top level).
--   collection_items.profile_sort_order — the owner's profile-wide item
--                                        arrangement (the Items tab), kept
--                                        separate from collection_items.
--                                        sort_order, which stays the
--                                        per-collection order and is not
--                                        touched here.
--
-- Positions are read ascending. A backfill reproduces today's display
-- order exactly; BEFORE triggers place new rows first; SECURITY DEFINER
-- RPCs are the write paths and validate ownership themselves.
--
--   Collections (small sets): reorder_folders writes one whole sibling
--   group, validated as EXACTLY the group's current members — the same
--   design as reorder_collection_items
--   (20260912120000_add_collection_item_manual_ordering.sql).
--
--   Items (a profile can hold thousands — more than one PostgREST page):
--   move_profile_item moves ONE item to sit between two neighbours,
--   validated only by those neighbours still being adjacent. So a client
--   never needs (or sends) the whole set, an unrelated change elsewhere
--   (an item added on another device) never makes a correct move "stale",
--   and a move usually writes one row. Positions are kept unique per owner
--   (one per-owner advisory lock shared by the insert trigger and the
--   move), so the order is total — ties are broken by id everywhere.
--
-- BACKFILL — no visible reshuffle: every current UI shows these newest
-- first (created_at DESC, NULLs first — PostgREST's DESC default), so the
-- newest gets 0 and each older row the next integer up, per sibling group /
-- per owner. Unique within each group by construction. Runs before the new
-- triggers exist, so it fires none of them.
--
-- Nothing here changes a folder's parent or an item's folder: the RPCs
-- only ever write the order columns.
-- ============================================================================

-- ── folders.sort_order ──────────────────────────────────────────────────────
ALTER TABLE public.folders ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY user_id, parent_folder_id ORDER BY created_at DESC, id) - 1 AS rn
  FROM public.folders
)
UPDATE public.folders f
SET sort_order = ranked.rn
FROM ranked
WHERE f.id = ranked.id;

CREATE INDEX IF NOT EXISTS folders_user_parent_sort_order_idx
  ON public.folders (user_id, parent_folder_id, sort_order);

-- A new collection — and one moved under a different parent — goes first
-- among its (new) siblings, strictly below their current minimum, so
-- "newest shows first" keeps holding until the owner rearranges, and a
-- moved collection never carries a stale position from its old siblings.
-- No existing row is touched.
CREATE OR REPLACE FUNCTION public.assign_folder_sort_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_min integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_folder_id IS NOT DISTINCT FROM OLD.parent_folder_id THEN
    RETURN NEW;
  END IF;
  SELECT MIN(sort_order) INTO v_min
  FROM public.folders
  WHERE user_id = NEW.user_id
    AND parent_folder_id IS NOT DISTINCT FROM NEW.parent_folder_id
    AND id <> NEW.id;
  NEW.sort_order := COALESCE(v_min, 0) - 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_folder_sort_order ON public.folders;
CREATE TRIGGER trg_assign_folder_sort_order
  BEFORE INSERT OR UPDATE OF parent_folder_id ON public.folders
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_folder_sort_order();

-- folders keeps its table-wide UPDATE grant (existing client writes rely
-- on it), so without this a client could write sort_order directly. A
-- direct change is ignored instead — the row keeps its position — unless
-- it comes from reorder_folders (which sets a transaction-local flag that
-- clients can't set through the API) or from a parent change (the trigger
-- above has just placed the row among its new siblings). Ignored, not
-- rejected, so a client update that happens to echo back a stale
-- sort_order with other edits still saves those edits. Fires after
-- trg_assign_folder_sort_order (triggers run in name order).
CREATE OR REPLACE FUNCTION public.guard_folder_sort_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.sort_order IS DISTINCT FROM OLD.sort_order
     AND NEW.parent_folder_id IS NOT DISTINCT FROM OLD.parent_folder_id
     AND COALESCE(current_setting('cachecase.reordering_folders', true), '') <> 'on' THEN
    NEW.sort_order := OLD.sort_order;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_folder_sort_order ON public.folders;
CREATE TRIGGER trg_guard_folder_sort_order
  BEFORE UPDATE OF sort_order ON public.folders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_folder_sort_order();

-- ── collection_items.profile_sort_order ─────────────────────────────────────
ALTER TABLE public.collection_items ADD COLUMN IF NOT EXISTS profile_sort_order integer NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id) - 1 AS rn
  FROM public.collection_items
)
UPDATE public.collection_items ci
SET profile_sort_order = ranked.rn
FROM ranked
WHERE ci.id = ranked.id;

CREATE INDEX IF NOT EXISTS collection_items_user_profile_sort_order_idx
  ON public.collection_items (user_id, profile_sort_order);

-- A new item (Add Item, a claim, an accepted transfer — every INSERT) goes
-- first in its owner's profile-wide order. Its own trigger, separate from
-- trg_assign_collection_item_sort_order (the per-collection order), which
-- is unchanged. Moving an item between collections never changes this.
-- Clients can't set this column: collection_items has no UPDATE grant on
-- it, and this trigger overwrites whatever an INSERT supplies.
--
-- Takes the owner's profile-order lock (the same one move_profile_item
-- takes), so two simultaneous inserts can't both read the same minimum —
-- positions stay unique per owner and the order stays total.
CREATE OR REPLACE FUNCTION public.assign_collection_item_profile_sort_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_min integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cachecase.profile_item_order'), hashtext(NEW.user_id::text));
  SELECT MIN(profile_sort_order) INTO v_min
  FROM public.collection_items
  WHERE user_id = NEW.user_id;
  NEW.profile_sort_order := COALESCE(v_min, 0) - 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_collection_item_profile_sort_order ON public.collection_items;
CREATE TRIGGER trg_assign_collection_item_profile_sort_order
  BEFORE INSERT ON public.collection_items
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_collection_item_profile_sort_order();

-- ── reorder_folders — reorder one sibling group ─────────────────────────────
-- p_parent_folder_id NULL = the caller's top-level collections; otherwise
-- that collection's direct children. p_folder_ids must be EXACTLY the
-- group's current members (any order, no duplicates) — a stale list (a
-- collection added, deleted or moved since the client loaded it) fails
-- instead of silently reordering a partial set. The group is locked first
-- so a concurrent reorder of the same group can't interleave.
CREATE OR REPLACE FUNCTION public.reorder_folders(
  p_parent_folder_id uuid,
  p_folder_ids uuid[]
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

  IF p_parent_folder_id IS NOT NULL AND NOT public.folder_owned_by(p_parent_folder_id, v_caller) THEN
    RAISE EXCEPTION 'Parent collection not found or not owned by caller';
  END IF;

  v_expected_count := COALESCE(array_length(p_folder_ids, 1), 0);
  IF v_expected_count = 0 THEN
    RAISE EXCEPTION 'No collections supplied';
  END IF;

  IF array_position(p_folder_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Collection ids must not be null';
  END IF;

  SELECT COUNT(DISTINCT id) INTO v_distinct_count FROM unnest(p_folder_ids) AS id;
  IF v_distinct_count <> v_expected_count THEN
    RAISE EXCEPTION 'Duplicate collection ids are not allowed';
  END IF;

  PERFORM 1
  FROM public.folders
  WHERE user_id = v_caller
    AND parent_folder_id IS NOT DISTINCT FROM p_parent_folder_id
  FOR UPDATE;

  SELECT COUNT(*) INTO v_current_count
  FROM public.folders
  WHERE user_id = v_caller
    AND parent_folder_id IS NOT DISTINCT FROM p_parent_folder_id;

  IF v_current_count <> v_expected_count THEN
    RAISE EXCEPTION 'Collection list does not match the current collections';
  END IF;

  SELECT COUNT(*) INTO v_matched_count
  FROM public.folders
  WHERE id = ANY(p_folder_ids)
    AND user_id = v_caller
    AND parent_folder_id IS NOT DISTINCT FROM p_parent_folder_id;

  IF v_matched_count <> v_expected_count THEN
    RAISE EXCEPTION 'One or more collections are invalid, not yours, or not in this collection';
  END IF;

  -- The one sanctioned sort_order write (see guard_folder_sort_order).
  PERFORM set_config('cachecase.reordering_folders', 'on', true);
  UPDATE public.folders f
  SET sort_order = ordered.ord - 1
  FROM unnest(p_folder_ids) WITH ORDINALITY AS ordered(id, ord)
  WHERE f.id = ordered.id
    AND f.user_id = v_caller
    AND f.parent_folder_id IS NOT DISTINCT FROM p_parent_folder_id;
  PERFORM set_config('cachecase.reordering_folders', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_folders(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_folders(uuid, uuid[]) TO authenticated;

-- ── move_profile_item — move one item in the owner's profile-wide order ─────
-- Places p_item_id immediately after p_after_item_id (NULL = first) and
-- immediately before p_before_item_id (NULL = last). Those two must be
-- adjacent right now among the caller's active items (not counting the
-- moved item itself) — if anything is between them, or either is gone,
-- the request is stale and nothing changes. Nothing else is validated, so
-- a client needs only the neighbours it can see (never the whole set) and
-- unrelated changes elsewhere don't make a correct move fail.
--
-- The new position is the midpoint between the neighbours. Only when no
-- integer is left between them are the owner's active items respaced
-- (same order, gaps of 1024) first — rare, then many moves fit again.
-- Serialized per owner with the insert trigger (one advisory lock), so
-- positions stay unique. Never changes folder_id or the per-collection
-- sort_order.
CREATE OR REPLACE FUNCTION public.move_profile_item(
  p_item_id uuid,
  p_after_item_id uuid,
  p_before_item_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_lo integer;
  v_hi integer;
  v_next uuid;
  v_new integer;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_item_id IS NULL THEN
    RAISE EXCEPTION 'No item supplied';
  END IF;

  IF p_item_id = p_after_item_id OR p_item_id = p_before_item_id OR p_after_item_id = p_before_item_id THEN
    RAISE EXCEPTION 'An item can''t be placed next to itself';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cachecase.profile_item_order'), hashtext(v_caller::text));

  -- Stale and not-yours read the same on purpose: no hint about other
  -- users' items.
  PERFORM 1 FROM public.collection_items
  WHERE id = p_item_id AND user_id = v_caller AND collection_status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item list does not match your current items';
  END IF;

  IF p_after_item_id IS NOT NULL THEN
    SELECT profile_sort_order INTO v_lo FROM public.collection_items
    WHERE id = p_after_item_id AND user_id = v_caller AND collection_status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item list does not match your current items';
    END IF;
  END IF;

  -- What actually follows `after` (or comes first) right now, skipping the
  -- moved item. Ties (none expected — positions are unique) break by id,
  -- the same as every client query.
  SELECT id, profile_sort_order INTO v_next, v_hi
  FROM public.collection_items
  WHERE user_id = v_caller
    AND collection_status = 'active'
    AND id <> p_item_id
    AND (p_after_item_id IS NULL OR (profile_sort_order, id) > (v_lo, p_after_item_id))
  ORDER BY profile_sort_order, id
  LIMIT 1;

  IF v_next IS DISTINCT FROM p_before_item_id THEN
    RAISE EXCEPTION 'Item list does not match your current items';
  END IF;

  IF p_after_item_id IS NULL AND v_next IS NULL THEN
    RETURN; -- the only active item
  ELSIF p_after_item_id IS NULL THEN
    v_new := v_hi - 1;
  ELSIF v_next IS NULL THEN
    v_new := v_lo + 1;
  ELSE
    IF v_hi - v_lo < 2 THEN
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY profile_sort_order, id) AS rn
        FROM public.collection_items
        WHERE user_id = v_caller AND collection_status = 'active' AND id <> p_item_id
      )
      UPDATE public.collection_items ci
      SET profile_sort_order = ranked.rn * 1024
      FROM ranked
      WHERE ci.id = ranked.id;

      SELECT profile_sort_order INTO v_lo FROM public.collection_items WHERE id = p_after_item_id;
      SELECT profile_sort_order INTO v_hi FROM public.collection_items WHERE id = v_next;
    END IF;
    v_new := v_lo + (v_hi - v_lo) / 2;
  END IF;

  UPDATE public.collection_items
  SET profile_sort_order = v_new
  WHERE id = p_item_id;
END;
$$;

REVOKE ALL ON FUNCTION public.move_profile_item(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_profile_item(uuid, uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
