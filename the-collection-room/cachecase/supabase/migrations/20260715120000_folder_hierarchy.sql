-- Optional self-referencing parent so a top-level folder can act as a
-- "category" (e.g. Baseball) organizationally containing child folders
-- (e.g. Shohei Ohtani), which hold the actual collection_items. Only ever
-- one level deep as a child — enforced at the UI layer (see
-- components/collection/folder-parent-picker.tsx), not a DB constraint,
-- consistent with this schema's existing soft-invariant pattern (see
-- color's comment in 20260714120000_folder_binder_color.sql).
--
-- ON DELETE SET NULL: deleting a category detaches (never deletes) its
-- child folders — they become top-level again. Cards are never touched.
ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS parent_folder_id uuid REFERENCES public.folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS folders_parent_folder_id_idx ON public.folders(parent_folder_id);
NOTIFY pgrst, 'reload schema';
