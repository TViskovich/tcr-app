-- ============================================================================
-- Phase 2 bulk item move (app/collection/[folderId].tsx's new Select mode /
-- components/item-detail/move-item-modal.tsx's bulk mode): moves N items
-- from one folder to another as a single atomic operation.
--
-- WHY AN RPC, NOT N CLIENT UPDATES
-- ---------------------------------------------------------------------------
-- Phase 1's single-item move is one UPDATE ... WHERE id = :id, already
-- atomic by construction. Firing N of those from the client via
-- Promise.all() for a bulk move would NOT be atomic: any one of them can
-- fail independently (network blip, a row that changed between selection
-- and confirmation, etc.), leaving some items moved and others not, with no
-- transaction boundary tying them together and no way for the client to
-- undo the ones that already committed. This function wraps the whole
-- selection in one PL/pgSQL function body, which Postgres always executes
-- as a single transaction: either every row updates, or the function raises
-- and nothing does.
--
-- SECURITY DEFINER is required here (not just for convenience): the actual
-- UPDATE at the bottom needs to run with a role that already has
-- unconditional UPDATE on collection_items (the function owner, postgres),
-- rather than depending on `authenticated`'s own narrower column-level
-- grant (20260911170000 only opened folder_id, not blanket UPDATE). Every
-- authorization decision this function makes is therefore done EXPLICITLY
-- in its own body, in plain SQL, never delegated to RLS — see the
-- validation block below. This mirrors this schema's existing pattern for
-- other sensitive multi-row operations (register_card,
-- accept_ownership_transfer, etc.), all SECURITY DEFINER with their own
-- inline ownership checks.
--
-- VALIDATION (all inside one transaction, before any write):
--   - caller must be authenticated (auth.uid() IS NOT NULL)
--   - p_item_ids is de-duplicated up front (array_agg(DISTINCT ...)) so a
--     client-supplied duplicate can't inflate a count or be "matched"
--     twice — it also can't shrink the expected set, so passing the same
--     id 5 times behaves exactly like passing it once.
--   - destination folder must be owned by the caller (folder_owned_by —
--     the same SECURITY DEFINER helper added by 20260910130000_
--     fix_folders_rls_recursion.sql for folders_insert_own/
--     folders_update_own's own parent-ownership check, and reused again by
--     20260911170000's single-item-move trigger). Reusing it here keeps
--     "what counts as owning a folder" defined in exactly one place.
--   - EVERY supplied id must currently: exist, belong to the caller
--     (user_id = caller), be in the EXPECTED source folder
--     (p_source_folder_id), and be an active item (collection_status =
--     'active' — a transferred-out item is historical/frozen and was never
--     offered as selectable in the folder grid to begin with; rejecting it
--     here too is defense-in-depth against a forged call, not a UI-only
--     rule). If the matched count differs from the de-duplicated requested
--     count for ANY reason — a nonexistent id, someone else's item, an
--     item already moved out of this folder by something else, a
--     transferred-out item — the whole call is rejected and NOTHING is
--     updated. This is also this function's answer to "stale selection
--     races": if another device/tab moved one of these items out of
--     p_source_folder_id between the client's selection and this call,
--     that item's row no longer matches the source-folder condition, the
--     count check fails, and the entire bulk move is refused rather than
--     silently moving a partial, now-inconsistent subset.
--   - SELECT ... FOR UPDATE locks exactly these candidate rows before the
--     count check runs, so a second, concurrent call (or a plain
--     single-item move) touching any of the same ids has to wait for this
--     transaction to finish first — the check-then-move sequence can't be
--     interleaved by another writer.
--
-- The move itself is a single UPDATE ... WHERE id = ANY(validated ids),
-- unconditional at that point (every id already proven valid+owned+in the
-- expected folder), returning the actual row count via GET DIAGNOSTICS —
-- authoritative, not just echoing back array_length(p_item_ids).
--
-- 20260911170000's trg_enforce_collection_item_folder_move BEFORE UPDATE
-- trigger still fires on this internal UPDATE regardless of this
-- function's SECURITY DEFINER context (triggers always fire; auth.uid()
-- inside the trigger still reads the real caller's session, unaffected by
-- the function's owning role) — redundant with the destination check
-- above, deliberately: this function doesn't try to be the only layer of
-- defense against a mis-owned destination folder.
-- ============================================================================

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

  -- Lock candidates before validating so nothing else can change any of
  -- these rows between this check and the UPDATE below.
  PERFORM 1
  FROM public.collection_items
  WHERE id = ANY(v_ids)
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

  UPDATE public.collection_items
  SET folder_id = p_destination_folder_id
  WHERE id = ANY(v_ids);

  GET DIAGNOSTICS v_moved_count = ROW_COUNT;
  RETURN v_moved_count;
END;
$$;

REVOKE ALL ON FUNCTION public.move_collection_items(uuid[], uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.move_collection_items(uuid[], uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
