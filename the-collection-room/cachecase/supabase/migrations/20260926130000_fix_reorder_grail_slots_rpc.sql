BEGIN;

-- Corrective migration for 20260926120000_add_reorder_grail_slots_rpc.sql
-- (already applied remotely, so it is replaced here rather than edited).
--
-- Bug: the re-insert did `FROM unnest(v_rows) WITH ORDINALITY AS u(r, ord)`
-- and then read `(r).id`. Unnesting an array of a COMPOSITE type expands each
-- element into its columns, so the alias list u(r, ord) bound `r` to the
-- FIRST column (the uuid `id`) and `ord` to the second — and `(r).id` failed
-- with 42809 "column notation .id applied to type uuid, which is not a
-- composite type". Fix: leave the expanded columns under their own names
-- (u.id, u.user_id, ...) and use the built-in ordinality column
-- (u.ordinality) for the slot position. Semantics are unchanged.

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
  SELECT u.id, u.user_id, v_indexes[u.ordinality], u.entry_type, u.item_id, u.collection_id, u.created_at
  FROM unnest(v_rows) WITH ORDINALITY AS u;
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_grail_slots(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_grail_slots(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
