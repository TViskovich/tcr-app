-- ============================================================================
-- Grail-slot visibility exception ("Grail placement = implicit publish").
--
-- Context: components/profile-v2/grail-slot-preview.tsx renders a Grail
-- slot as "Unavailable" whenever hooks/use-grail-slots.ts's embedded
-- item:collection_items(*) / collection:folders(*) join comes back null —
-- which RLS makes unconditional for any item/folder a non-owner isn't
-- otherwise authorized to see (items_select_public / folders_select_public,
-- both ultimately gated on folder_is_effectively_visible() + is_public).
-- profile_grail_slots rows themselves have always been publicly SELECTable
-- (profile_grail_slots_select_public: USING (true)) — the row identifying
-- WHICH item/collection is showcased was never private — but nothing ever
-- authorized a non-owner to resolve what that row points at unless the
-- source happened to already be public under the completely separate
-- folder/item privacy model. Confirmed live: every existing Grail slot on
-- both current test accounts resolved item: null for a non-owner, because
-- new folders default to private (components/collection/
-- create-folder-modal.tsx) and neither account had ever made one public.
--
-- Product intent (explicit instruction): placing an item or collection into
-- a Grail slot is itself an explicit act of showcasing that SPECIFIC object
-- publicly — independent of whatever privacy its containing folder happens
-- to have. It must NOT make the containing folder public, and must NOT
-- change the visibility of anything else inside it (sibling items, child/
-- parent folders, folder contents broadly).
--
-- Design: three independent, narrowly-scoped additional OR branches — NOT a
-- change to folder_is_effectively_visible()/_folder_is_effectively_visible_for()
-- itself. That shared function is relied on by items_select_public,
-- collection_item_images_select_public, folder_comments_select_public,
-- gallery_comments_select_public, and folder_likes_select_public — widening
-- IT to treat a Grail-referenced folder as "effectively visible" would leak
-- every sibling item in that folder whose own is_public happens to be true
-- (the column's own default — see 20260825120000_add_collection_item_privacy.sql),
-- i.e. exactly the "folder contents broadly" leak this must avoid. Instead:
--
--   1. items_select_public gets its own additional OR EXISTS branch: an
--      item is visible if IT SPECIFICALLY is referenced by an
--      entry_type='item' Grail slot for its own owner. The folder-chain
--      branch is untouched.
--   2. collection_item_images_select_public gets the equivalent branch,
--      scoped through the same per-item EXISTS check — an image is visible
--      only if its own item is either normally visible OR Grail-referenced.
--   3. folders_select_public gets its own additional OR EXISTS branch: a
--      folder ROW (name/cover fields/etc — not its contents) is visible if
--      IT SPECIFICALLY is referenced by an entry_type='collection' Grail
--      slot for its own owner. items_select_public's folder leg still calls
--      the ORIGINAL, unmodified folder_is_effectively_visible() — so this
--      does NOT make any item inside that folder newly visible via the
--      folder-chain branch; only branch #1, one item at a time, can do
--      that.
--
-- Every EXISTS below additionally pins gs.user_id to the target row's own
-- owner column — logically redundant given profile_grail_slots_insert_own
-- already requires a slot's item_id/collection_id to be owned by the same
-- auth.uid() that becomes gs.user_id (a cross-owner slot can never be
-- created), but kept explicit as defense-in-depth against any future,
-- differently-constrained write path, matching this schema's convention of
-- not relying solely on one write-time constraint for a read-time
-- authorization decision.
--
-- No recursive RLS risk, so no SECURITY DEFINER wrapper is introduced here:
-- profile_grail_slots_select_public is unconditionally USING (true) and
-- this EXISTS never queries back into collection_items/folders from inside
-- profile_grail_slots' own policy — there is nothing a wrapper would guard
-- against that a normal correlated subquery under RLS doesn't already
-- handle safely.
--
-- Removing a Grail slot (or replacing its target) removes this exception
-- automatically and immediately, since it is a live EXISTS over
-- profile_grail_slots, never a copied/mutated privacy flag —
-- folders.is_public and collection_items.is_public are untouched by this
-- migration and remain the only persisted privacy state for either table.
-- ============================================================================

-- ── 1. collection_items: add the item-level Grail exception ────────────────
DROP POLICY IF EXISTS "items_select_public" ON public.collection_items;
CREATE POLICY "items_select_public" ON public.collection_items
  FOR SELECT USING (
    (
      public.folder_is_effectively_visible(collection_items.folder_id)
      AND (collection_items.is_public = true OR collection_items.user_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.profile_grail_slots gs
      WHERE gs.entry_type = 'item'
        AND gs.item_id = collection_items.id
        AND gs.user_id = collection_items.user_id
    )
  );

-- ── 2. collection_item_images: same exception, one level down ──────────────
DROP POLICY IF EXISTS "collection_item_images_select_public" ON public.collection_item_images;
CREATE POLICY "collection_item_images_select_public" ON public.collection_item_images
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = collection_item_images.item_id
        AND (
          (
            public.folder_is_effectively_visible(ci.folder_id)
            AND (ci.is_public = true OR ci.user_id = auth.uid())
          )
          OR EXISTS (
            SELECT 1 FROM public.profile_grail_slots gs
            WHERE gs.entry_type = 'item'
              AND gs.item_id = ci.id
              AND gs.user_id = ci.user_id
          )
        )
    )
  );

-- ── 3. folders: add the collection-level Grail exception (row only) ────────
-- Deliberately does NOT change what items_select_public / folder_comments /
-- gallery_comments / folder_likes consider visible for this folder — every
-- one of those calls folder_is_effectively_visible() directly, unchanged by
-- this migration. This branch only lets the folder's OWN row (name, cover
-- fields, etc.) resolve when it's the exact object a Grail slot points at;
-- it grants no visibility into the folder's contents.
DROP POLICY IF EXISTS "folders_select_public" ON public.folders;
CREATE POLICY "folders_select_public" ON public.folders
  FOR SELECT USING (
    public.folder_is_effectively_visible(id)
    OR EXISTS (
      SELECT 1 FROM public.profile_grail_slots gs
      WHERE gs.entry_type = 'collection'
        AND gs.collection_id = folders.id
        AND gs.user_id = folders.user_id
    )
  );

NOTIFY pgrst, 'reload schema';
