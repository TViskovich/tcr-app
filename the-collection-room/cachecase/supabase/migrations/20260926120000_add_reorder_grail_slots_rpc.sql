BEGIN;

-- ============================================================================
-- reorder_grail_slots — the one write path for a manual Grail reorder.
--
-- A Grail's "order" is its slot_index (0-8, UNIQUE per user). Reordering means
-- permuting which entry occupies which already-occupied slot_index. That
-- cannot be done with plain client UPDATEs: UNIQUE (user_id, slot_index) and
-- the partial UNIQUE (user_id, item_id / collection_id) indexes are checked
-- immediately, and slot_index's CHECK (0..8) leaves no free temporary value
-- when all 9 slots are full. So this function does it atomically: it
-- validates the supplied id list is exactly the caller's current slots, then
-- (in this single transaction) removes and re-inserts the same rows — SAME
-- id, entry, and created_at — at the re-assigned slot_index values.
--
-- Occupied slot indexes are reused in ascending order (gaps stay where they
-- are): p_slot_ids[1] gets the lowest occupied index, and so on.
-- SECURITY DEFINER because the delete/insert must not depend on the caller's
-- RLS (ownership is enforced explicitly below). No schema change.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reorder_grail_slots(p_slot_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_expected integer;
  v_distinct integer;
  v_current integer;
  v_matched integer;
  v_indexes smallint[];
  v_rows public.profile_grail_slots[];
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_expected := COALESCE(array_length(p_slot_ids, 1), 0);
  IF v_expected = 0 THEN
    RAISE EXCEPTION 'No slots supplied';
  END IF;

  SELECT COUNT(DISTINCT id) INTO v_distinct FROM unnest(p_slot_ids) AS id;
  IF v_distinct <> v_expected THEN
    RAISE EXCEPTION 'Duplicate slot ids are not allowed';
  END IF;

  -- Lock the caller's slot rows so a concurrent add/replace/remove can't slip
  -- between validation and the rewrite.
  PERFORM 1 FROM public.profile_grail_slots WHERE user_id = v_caller FOR UPDATE;

  SELECT COUNT(*) INTO v_current FROM public.profile_grail_slots WHERE user_id = v_caller;
  IF v_current <> v_expected THEN
    RAISE EXCEPTION 'Slot list does not match your current Grails';
  END IF;

  SELECT COUNT(*) INTO v_matched
  FROM public.profile_grail_slots
  WHERE user_id = v_caller AND id = ANY(p_slot_ids);
  IF v_matched <> v_expected THEN
    RAISE EXCEPTION 'One or more slots are invalid or not yours';
  END IF;

  SELECT array_agg(slot_index ORDER BY slot_index) INTO v_indexes
  FROM public.profile_grail_slots WHERE user_id = v_caller;

  -- The caller's rows, captured in the requested order (no temp table, so
  -- the function is also safe to call more than once in one transaction).
  SELECT array_agg(s ORDER BY t.ord) INTO v_rows
  FROM public.profile_grail_slots s
  JOIN unnest(p_slot_ids) WITH ORDINALITY AS t(id, ord) ON t.id = s.id
  WHERE s.user_id = v_caller;

  -- Every row is removed first, then re-inserted, so the unique constraints
  -- ((user_id, slot_index) and the per-item / per-collection partial
  -- indexes) never see two rows briefly holding the same value mid-swap.
  DELETE FROM public.profile_grail_slots WHERE user_id = v_caller;

  INSERT INTO public.profile_grail_slots (id, user_id, slot_index, entry_type, item_id, collection_id, created_at)
  SELECT (r).id, (r).user_id, v_indexes[ord], (r).entry_type, (r).item_id, (r).collection_id, (r).created_at
  FROM unnest(v_rows) WITH ORDINALITY AS u(r, ord);
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_grail_slots(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_grail_slots(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
