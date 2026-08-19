-- ============================================================================
-- Enforce collection-folder privacy and parent ownership — beta RLS sweep.
--
-- Problem (confirmed via the beta RLS/security sweep and a follow-up
-- read-only live audit): folders.is_public is a real, user-facing privacy
-- toggle (see components/collection/folder-edit-modal.tsx and
-- app/collection/[folderId].tsx's isPrivate UI gate) that RLS never actually
-- enforced. folders_select_public / items_select_public /
-- collection_item_images_select_public / folder_comments_select_public /
-- gallery_comments_select_public were all `USING (true)` — any client
-- holding the app's public anon/publishable key could read every user's
-- private folders, items, item images, and comments directly via the
-- Supabase API, completely bypassing the client-side privacy gate.
--
-- A second, independent hole existed on the write side: items_insert_own /
-- folder_comments_insert_own / gallery_comments_insert_own only checked
-- `auth.uid() = user_id`, never that the target folder_id belonged to (or,
-- for comments, was visible to) the caller. This allowed cross-user content
-- injection into ANY folder — public or private — since
-- hooks/use-collection.ts's item query trusts folder_id alone with no
-- owner cross-check, and the victim could not remove an attacker's planted
-- item themselves (items_delete_own is owner-of-row-scoped, and the
-- attacker owns the row they inserted).
--
-- The collection_items UPDATE path (moving an existing item into another
-- user's folder by changing folder_id) was independently audited and found
-- already closed: supabase/migrations/20260804120500_fix_collection_items_
-- column_privileges.sql column-scoped the `authenticated` UPDATE grant to
-- a list that excludes folder_id/id/user_id/created_at entirely, so no
-- client can UPDATE folder_id via the API regardless of RLS. Not touched
-- here.
--
-- A read-only live data-integrity audit (prior to this migration) confirmed
-- zero existing collection_items/collection_item_images ownership
-- mismatches, zero existing comments on currently-private folders, and zero
-- child-folder/parent-folder is_public mismatches — the write-side hole
-- above was never actually exploited against live data, so this migration
-- carries no cleanup or backfill.
--
-- Privacy remains strictly PER-FOLDER, not inherited via parent_folder_id —
-- confirmed by 20260715120000_folder_hierarchy.sql's own header comment
-- (parent_folder_id is a purely organizational one-level "category"
-- grouping, "enforced at the UI layer, not a DB constraint," with no
-- privacy relationship to is_public anywhere in schema or app code). None
-- of the policies below walk parent_folder_id.
--
-- Role semantics are deliberately unchanged: no policy below adds a `TO`
-- clause. is_public = true is the product's own definition of "public," and
-- no evidence exists in this repo of an intentional anon-only restriction —
-- narrowing to `TO authenticated` would be a silent scope change beyond
-- this fix's purpose, not something this migration decides.
--
-- All eight policies below are replaced by their existing audited names
-- using DROP POLICY IF EXISTS followed by CREATE POLICY. Only SELECT and
-- INSERT policies on these five tables are touched — UPDATE, DELETE,
-- schema, column privileges, RPCs, and every other table are unaffected.
-- ============================================================================

-- --- 1. folders: owner-or-public read ---
DROP POLICY IF EXISTS "folders_select_public" ON public.folders;
CREATE POLICY "folders_select_public" ON public.folders
  FOR SELECT USING (
    is_public = true OR auth.uid() = user_id
  );

-- --- 2. collection_items: visibility derived from parent folder only ---
-- Deliberately does not also check collection_items.user_id — folders is
-- the sole authoritative privacy boundary in this product (no shared-folder
-- concept exists), and cross-checking user_id here would silently mask any
-- future ownership-mismatch anomaly instead of surfacing it. The INSERT fix
-- below (#6) is what actually prevents new cross-owner rows; this SELECT
-- policy only governs visibility of whatever legitimately exists.
DROP POLICY IF EXISTS "items_select_public" ON public.collection_items;
CREATE POLICY "items_select_public" ON public.collection_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.id = collection_items.folder_id
        AND (f.is_public = true OR f.user_id = auth.uid())
    )
  );

-- --- 3. collection_item_images: visibility derived from item -> folder ---
DROP POLICY IF EXISTS "collection_item_images_select_public" ON public.collection_item_images;
CREATE POLICY "collection_item_images_select_public" ON public.collection_item_images
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      JOIN public.folders f ON f.id = ci.folder_id
      WHERE ci.id = collection_item_images.item_id
        AND (f.is_public = true OR f.user_id = auth.uid())
    )
  );

-- --- 4. folder_comments: visibility derived from parent folder ---
DROP POLICY IF EXISTS "folder_comments_select_public" ON public.folder_comments;
CREATE POLICY "folder_comments_select_public" ON public.folder_comments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.id = folder_comments.folder_id
        AND (f.is_public = true OR f.user_id = auth.uid())
    )
  );

-- --- 5. gallery_comments: same parent-folder visibility rule ---
DROP POLICY IF EXISTS "gallery_comments_select_public" ON public.gallery_comments;
CREATE POLICY "gallery_comments_select_public" ON public.gallery_comments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.id = gallery_comments.folder_id
        AND (f.is_public = true OR f.user_id = auth.uid())
    )
  );

-- --- 6. collection_items: INSERT requires owning the target folder ---
-- Matches actual product semantics exactly: the app has no "add item to a
-- folder you don't own" feature (confirmed against app/item/new.tsx's only
-- insert call site), so requiring folder ownership — not merely
-- public-or-owned — is correct here, unlike the comment policies below.
DROP POLICY IF EXISTS "items_insert_own" ON public.collection_items;
CREATE POLICY "items_insert_own" ON public.collection_items
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.id = folder_id AND f.user_id = auth.uid()
    )
  );

-- --- 7. folder_comments: INSERT requires the folder be public or owned ---
DROP POLICY IF EXISTS "folder_comments_insert_own" ON public.folder_comments;
CREATE POLICY "folder_comments_insert_own" ON public.folder_comments
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.id = folder_id
        AND (f.is_public = true OR f.user_id = auth.uid())
    )
  );

-- --- 8. gallery_comments: same public-or-owned parent-folder rule ---
DROP POLICY IF EXISTS "gallery_comments_insert_own" ON public.gallery_comments;
CREATE POLICY "gallery_comments_insert_own" ON public.gallery_comments
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.id = folder_id
        AND (f.is_public = true OR f.user_id = auth.uid())
    )
  );

-- --- 9. Supporting index ---
-- collection_items.folder_id had no dedicated index despite being both the
-- app's primary item-listing filter (hooks/use-collection.ts) and now the
-- join column driving policy #2's correlated EXISTS on every row-visibility
-- check.
CREATE INDEX IF NOT EXISTS collection_items_folder_id_idx
  ON public.collection_items (folder_id);

NOTIFY pgrst, 'reload schema';
