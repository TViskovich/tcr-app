-- Profile ordering backfill regression — step 3 of 3 (see run.sh).
-- Runs after 20261026120000_add_profile_ordering.sql has been applied on
-- top of seed.sql's data. Every order the app showed before the migration
-- must be exactly what the new order columns produce now; fails loudly
-- (non-zero exit) on any difference.

\set ON_ERROR_STOP on

DO $$
DECLARE
  r record;
  v_actual uuid[];
  v_checked integer := 0;
  v_failed integer := 0;
BEGIN
  FOR r IN SELECT * FROM ordering_check.expected ORDER BY kind, grp LOOP
    IF r.kind = 'folders' THEN
      SELECT array_agg(id ORDER BY sort_order) INTO v_actual
      FROM public.folders
      WHERE user_id::text || ':' || coalesce(parent_folder_id::text, 'top') = r.grp;
    ELSIF r.kind = 'profile_items' THEN
      SELECT array_agg(id ORDER BY profile_sort_order, id) INTO v_actual
      FROM public.collection_items
      WHERE user_id::text = r.grp AND collection_status = 'active';
    ELSE
      SELECT array_agg(id ORDER BY sort_order, id) INTO v_actual
      FROM public.collection_items
      WHERE folder_id::text = r.grp;
    END IF;

    v_checked := v_checked + 1;
    IF v_actual IS DISTINCT FROM r.ids THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'MISMATCH % %: expected % rows, got % rows', r.kind, r.grp,
        array_length(r.ids, 1), array_length(v_actual, 1);
    END IF;
  END LOOP;

  -- Positions are unique within every group (so the order is total).
  IF EXISTS (
    SELECT 1 FROM public.folders GROUP BY user_id, parent_folder_id, sort_order HAVING count(*) > 1
  ) THEN
    v_failed := v_failed + 1;
    RAISE WARNING 'MISMATCH folders: duplicate sort_order within a sibling group';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.collection_items GROUP BY user_id, profile_sort_order HAVING count(*) > 1
  ) THEN
    v_failed := v_failed + 1;
    RAISE WARNING 'MISMATCH profile_items: duplicate profile_sort_order for one owner';
  END IF;

  IF v_failed > 0 THEN
    RAISE EXCEPTION 'Backfill regression FAILED: % of % checks', v_failed, v_checked + 2;
  END IF;
  RAISE NOTICE 'Backfill regression PASSED: % order groups + 2 uniqueness checks', v_checked;
END;
$$;

DROP SCHEMA ordering_check CASCADE;
