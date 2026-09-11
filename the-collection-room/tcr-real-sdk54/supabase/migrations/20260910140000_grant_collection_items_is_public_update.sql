-- ============================================================================
-- Corrective migration: grant `authenticated` UPDATE on
-- collection_items.is_public — a distinct, unrelated bug from the folders
-- RLS recursion fixed by 20260910130000, found while investigating the
-- same "public/private toggle fails" symptom report.
--
-- 20260804120500_fix_collection_items_column_privileges.sql deliberately
-- narrowed `authenticated`'s UPDATE grant on collection_items to an exact
-- allowlist of columns with a confirmed client call site AT THE TIME:
-- title, player, team, year, brand, grade, grading_company,
-- serial_number, estimated_value, image_url, description.
--
-- collection_items.is_public did not exist yet — it was added three weeks
-- later by 20260825120000_add_collection_item_privacy.sql, which added the
-- column and the RLS policies that depend on it, but never touched this
-- column-level GRANT. app/item/[id].tsx's handleSave has been sending
-- `is_public: editItemIsPublic` in its UPDATE payload since privacy
-- editing shipped, but every such request has been silently rejected by
-- Postgres's column-privilege check (`permission denied for table
-- collection_items`, PostgREST surfaces this the same as any other
-- write failure) — confirmed live: even a real owner, correctly scoped by
-- RLS (items_update_own: USING auth.uid() = user_id, satisfied), cannot
-- currently UPDATE is_public at all, regardless of RLS. This is a
-- privilege-grant gap, not a visibility/privacy-model change — nothing
-- about WHO can see WHAT is altered here, only that the column's owner can
-- now actually write the flag they already owned and could already toggle
-- through the UI.
--
-- collection_items.folder_id/id/user_id/created_at remain deliberately
-- excluded, unchanged from 20260804120500's own reasoning (no "move item"
-- feature, no legitimate client update path for those columns).
-- ============================================================================

GRANT UPDATE (is_public) ON public.collection_items TO authenticated;

NOTIFY pgrst, 'reload schema';
