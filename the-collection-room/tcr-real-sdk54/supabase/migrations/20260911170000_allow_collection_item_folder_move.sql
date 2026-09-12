-- ============================================================================
-- Phase 1 item move (app/item/[id].tsx's new "Move" action /
-- components/item-detail/move-item-modal.tsx): lets an owner change
-- collection_items.folder_id via the ordinary client UPDATE path, while
-- closing the ownership gap that would otherwise open.
--
-- Two independent gaps existed before this migration:
--
-- 1. Column privilege: 20260804120500_fix_collection_items_column_privileges.sql
--    deliberately excluded folder_id from authenticated's UPDATE grant
--    ("no move item feature" at the time). A move needs it.
--
-- 2. RLS: items_update_own is `FOR UPDATE USING (auth.uid() = user_id)` with
--    no WITH CHECK specified. Postgres defaults an omitted WITH CHECK to the
--    same USING clause, which only constrains which EXISTING row a caller
--    may touch (auth.uid() = user_id — true both before and after, since
--    user_id itself is never writable). It says nothing about which FOLDER
--    the row is moved into. Simply granting UPDATE (folder_id) without also
--    checking the destination would let any owner move their own item into
--    ANY other user's folder just by knowing its id — folder ids are not a
--    secret (folders_select_public is world-readable).
--
-- Fix shape: a BEFORE UPDATE trigger, not a WITH CHECK tightening on
-- items_update_own itself. A trigger has both OLD and NEW available, so it
-- can scope the ownership check to ONLY the case where folder_id is
-- actually changing. Tightening items_update_own's own WITH CHECK instead
-- would re-validate folder ownership on EVERY update (title, description,
-- is_public, ...), which risks breaking ordinary field edits on any item
-- whose folder_id/owner relationship predates 20260819120000_
-- enforce_collection_folder_privacy.sql (the migration that first required
-- folder ownership at INSERT time) — items_insert_own had no such check
-- before that date, so an old row COULD in principle already violate it.
-- Scoping to "only when folder_id changes" avoids retroactively breaking
-- any such row's unrelated edits.
--
-- Reuses folder_owned_by(uuid, uuid) (added by 20260910130000_
-- fix_folders_rls_recursion.sql, already GRANTed to authenticated) — the
-- same SECURITY DEFINER helper folders_insert_own/folders_update_own use
-- for their own parent-folder-ownership check, so this doesn't reintroduce
-- the recursive-RLS class of bug that migration fixed.
--
-- Column grant: extends the exact-allowlist convention from
-- 20260804120500/20260910140000 — folder_id is now a real, confirmed client
-- call site (the Move action), added individually. id/user_id/created_at
-- remain excluded, unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_collection_item_folder_move()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.folder_id IS DISTINCT FROM OLD.folder_id THEN
    IF NOT public.folder_owned_by(NEW.folder_id, auth.uid()) THEN
      RAISE EXCEPTION 'Cannot move item into a folder you do not own';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_collection_item_folder_move ON public.collection_items;
CREATE TRIGGER trg_enforce_collection_item_folder_move
  BEFORE UPDATE ON public.collection_items
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_collection_item_folder_move();

GRANT UPDATE (folder_id) ON public.collection_items TO authenticated;

NOTIFY pgrst, 'reload schema';
