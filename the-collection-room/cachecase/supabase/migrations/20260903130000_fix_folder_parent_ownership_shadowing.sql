-- ============================================================================
-- Corrective migration: fix column-name shadowing in folders_insert_own /
-- folders_update_own's parent-ownership EXISTS clause.
--
-- Context: after 20260902120000_recursive_folder_hierarchy_privacy.sql
-- went live, the first real nested-folder creation failed with "new row
-- violates row-level security policy for table \"folders\"" even though the
-- client insert was correct — parent_folder_id was set to a folder genuinely
-- owned by the inserting user.
--
-- Root cause, confirmed by inspecting the live policy text: both
-- folders_insert_own and folders_update_own contain
--
--   EXISTS (
--     SELECT 1 FROM public.folders p
--     WHERE p.id = parent_folder_id AND p.user_id = auth.uid()
--   )
--
-- parent_folder_id inside this subquery is unqualified, and the subquery's
-- own FROM clause is the SAME table (public.folders, aliased p) — which
-- also has a column literally named parent_folder_id. Standard SQL name
-- resolution binds an unqualified column reference to the innermost scope
-- that has a matching column first, so `parent_folder_id` here resolved to
-- p.parent_folder_id (the CANDIDATE parent row's own parent), never to the
-- outer INSERT/UPDATE row's parent_folder_id as intended. The EXISTS
-- clause therefore silently degraded to "does a folder p exist such that
-- p.id = p.parent_folder_id" — true only for a folder that is somehow its
-- own parent, which never legitimately exists — so the whole ownership
-- branch was unsatisfiable for every real nested-folder insert/update,
-- regardless of correct ownership.
--
-- Fixed by qualifying the outer reference with the table's own (unaliased)
-- name, folders.parent_folder_id — the exact same disambiguation idiom
-- already used elsewhere in this codebase for same-table/cross-table
-- correlated subqueries inside RLS policies (e.g. items_select_public's
-- `WHERE f.id = collection_items.folder_id`, from
-- 20260819120000_enforce_collection_folder_privacy.sql).
--
-- Scope: replaces ONLY folders_insert_own and folders_update_own — the two
-- policies containing this exact subquery shape (confirmed by inspection;
-- no other policy in 20260902120000 has this pattern). No other policy,
-- function, Edge Function, or UI code is touched. 20260902120000 itself is
-- left as-is — this is purely a corrective follow-up under its own
-- timestamp.
--
-- Every other requirement is preserved unchanged: auth.uid() = user_id,
-- a null parent is allowed, a non-null parent must belong to the same
-- authenticated user, self-parenting is rejected
-- (parent_folder_id IS DISTINCT FROM id), update-time cycle prevention via
-- folder_would_create_cycle is retained exactly as before, and nothing
-- about recursive visibility (folders_select_public /
-- folder_is_effectively_visible) is touched or weakened.
-- ============================================================================

DROP POLICY IF EXISTS "folders_insert_own" ON public.folders;
CREATE POLICY "folders_insert_own" ON public.folders
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND (
      parent_folder_id IS NULL
      OR (
        parent_folder_id IS DISTINCT FROM id
        AND EXISTS (
          SELECT 1 FROM public.folders p
          WHERE p.id = folders.parent_folder_id AND p.user_id = auth.uid()
        )
      )
    )
  );

DROP POLICY IF EXISTS "folders_update_own" ON public.folders;
CREATE POLICY "folders_update_own" ON public.folders
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND (
      parent_folder_id IS NULL
      OR (
        parent_folder_id IS DISTINCT FROM id
        AND EXISTS (
          SELECT 1 FROM public.folders p
          WHERE p.id = folders.parent_folder_id AND p.user_id = auth.uid()
        )
        AND NOT public.folder_would_create_cycle(id, parent_folder_id)
      )
    )
  );

NOTIFY pgrst, 'reload schema';
