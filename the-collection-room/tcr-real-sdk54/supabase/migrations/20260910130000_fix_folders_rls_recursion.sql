-- ============================================================================
-- Corrective migration: fix "infinite recursion detected in policy for
-- relation \"folders\"" introduced by 20260910120000_
-- grail_slot_visibility_exception.sql.
--
-- Confirmed live (via direct anon REST calls against the production
-- project, both before and after this fix):
--   - Any INSERT or UPDATE on folders — including a plain top-level folder
--     with parent_folder_id IS NULL — fails with 42P17.
--   - A plain SELECT on folders does NOT fail.
--   - An INSERT on collection_items (items_insert_own), whose WITH CHECK
--     also queries folders via `EXISTS (SELECT 1 FROM folders f WHERE
--     f.id = collection_items.folder_id AND f.user_id = auth.uid())`, does
--     NOT fail (still a normal 42501 permission denial). An UPDATE on
--     collection_items (items_update_own) doesn't touch folders at all and
--     is unaffected either way.
--
-- Root cause: folders_insert_own and folders_update_own (established by
-- 20260902120000_recursive_folder_hierarchy_privacy.sql, column-shadowing
-- fixed but NOT otherwise changed by 20260903130000_
-- fix_folder_parent_ownership_shadowing.sql) each contain a raw,
-- unwrapped self-referential subquery on their own table:
--
--   EXISTS (SELECT 1 FROM public.folders p
--           WHERE p.id = folders.parent_folder_id AND p.user_id = auth.uid())
--
-- Evaluating this for an INSERT/UPDATE on folders requires applying
-- folders' own SELECT policy (folders_select_public) to `p`. Before
-- 20260910120000, folders_select_public's USING clause was a single scalar
-- function call (folder_is_effectively_visible(id)) — no literal subquery
-- in the policy text itself, so Postgres did not need to build a
-- security-barrier subplan for `p`, and the self-join above evidently
-- resolved without tripping the recursion guard. 20260910120000 added an
-- inline `OR EXISTS (SELECT 1 FROM profile_grail_slots gs WHERE ...)`
-- branch directly in folders_select_public's policy text — a real, bare
-- SubLink, not hidden behind a function call. That forces Postgres to
-- build a security-barrier subplan when folders_select_public is applied
-- to `p`, and doing so *while already expanding* folders_insert_own/
-- folders_update_own's WITH CHECK for the outer folders row (itself
-- self-referencing the same relation) is what the planner's recursion
-- guard now correctly refuses as "infinite recursion detected in policy
-- for relation \"folders\"" — confirmed empirically: this exact self-join
-- shape, applied to a DIFFERENT table's policy (items_insert_own
-- referencing folders, not self-referencing collection_items) does NOT
-- recurse, so the problem is specifically folders' OWN insert/update
-- policies self-referencing folders, combined with folders_select_public
-- no longer being a bare function call.
--
-- Fix: eliminate every raw, unwrapped subquery from folders' own policy
-- text, on both sides of the self-join, by moving each one behind a
-- SECURITY DEFINER function — the exact pattern this schema already uses
-- for folder_is_effectively_visible/_folder_is_effectively_visible_for and
-- folder_would_create_cycle. A SECURITY DEFINER function's internal reads
-- run as its owning (RLS-bypassing) role, so they never re-invoke
-- folders_select_public at all, and from the calling policy's own text the
-- whole check is once again a single opaque scalar function call — no
-- bare SubLink, no security-barrier subplan, no self-join for the planner
-- to trip over.
--
--   1. folder_owned_by(target_folder_id, owner) replaces folders_insert_own/
--      folders_update_own's raw parent-ownership EXISTS.
--   2. folder_is_grail_showcased(target_folder_id) replaces
--      folders_select_public's raw Grail-collection EXISTS.
--   3. item_is_grail_showcased(target_item_id) replaces the equivalent raw
--      EXISTS in items_select_public and collection_item_images_select_public
--      — collection_items/collection_item_images were never actually
--      recursion-affected (confirmed above), but this closes the same
--      class of risk defensively and consistently, matching the "avoid
--      recursive RLS patterns; use a SECURITY DEFINER helper" guidance
--      this migration is itself a response to.
--
-- These three functions deliberately do NOT re-verify ownership by joining
-- back to folders/collection_items inside their own bodies (which would be
-- safe — SECURITY DEFINER already bypasses RLS for that — but is simply
-- unnecessary complexity to reintroduce): a profile_grail_slots row's
-- item_id/collection_id is already guaranteed, at write time, to belong to
-- that same row's own user_id (profile_grail_slots_insert_own /
-- profile_grail_slots_update_own both require
-- auth.uid() = user_id AND the referenced item/collection is owned by
-- auth.uid()), so checking profile_grail_slots alone is sufficient and
-- keeps every function's own body a single, trivial, non-recursive query.
--
-- No table, column, or index changes. No privacy semantics change: every
-- condition below is byte-for-byte the same logic as
-- 20260910120000_grail_slot_visibility_exception.sql and
-- 20260903130000_fix_folder_parent_ownership_shadowing.sql, just moved
-- behind function calls. Owner behavior, public-read behavior, and the
-- Grail visibility exception itself are all unchanged in substance.
-- ============================================================================

-- ── 1. Parent-folder-ownership check, as a SECURITY DEFINER function ───────
CREATE OR REPLACE FUNCTION public.folder_owned_by(target_folder_id uuid, owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.folders p
    WHERE p.id = target_folder_id AND p.user_id = owner
  );
$$;

REVOKE EXECUTE ON FUNCTION public.folder_owned_by(uuid, uuid) FROM PUBLIC;
-- authenticated only (matches folder_would_create_cycle's own grant,
-- referenced directly inside these same two policies) — never anon, since
-- folders_insert_own/folders_update_own both already require
-- auth.uid() = user_id, which anon can never satisfy.
GRANT EXECUTE ON FUNCTION public.folder_owned_by(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS "folders_insert_own" ON public.folders;
CREATE POLICY "folders_insert_own" ON public.folders
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND (
      parent_folder_id IS NULL
      OR (
        parent_folder_id IS DISTINCT FROM id
        AND public.folder_owned_by(folders.parent_folder_id, auth.uid())
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
        AND public.folder_owned_by(folders.parent_folder_id, auth.uid())
        AND NOT public.folder_would_create_cycle(id, parent_folder_id)
      )
    )
  );

-- ── 2. Grail-collection-exception check, as a SECURITY DEFINER function ────
CREATE OR REPLACE FUNCTION public.folder_is_grail_showcased(target_folder_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profile_grail_slots gs
    WHERE gs.entry_type = 'collection' AND gs.collection_id = target_folder_id
  );
$$;

REVOKE EXECUTE ON FUNCTION public.folder_is_grail_showcased(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.folder_is_grail_showcased(uuid) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "folders_select_public" ON public.folders;
CREATE POLICY "folders_select_public" ON public.folders
  FOR SELECT USING (
    public.folder_is_effectively_visible(id)
    OR public.folder_is_grail_showcased(id)
  );

-- ── 3. Grail-item-exception check, as a SECURITY DEFINER function ──────────
CREATE OR REPLACE FUNCTION public.item_is_grail_showcased(target_item_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profile_grail_slots gs
    WHERE gs.entry_type = 'item' AND gs.item_id = target_item_id
  );
$$;

REVOKE EXECUTE ON FUNCTION public.item_is_grail_showcased(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.item_is_grail_showcased(uuid) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "items_select_public" ON public.collection_items;
CREATE POLICY "items_select_public" ON public.collection_items
  FOR SELECT USING (
    (
      public.folder_is_effectively_visible(collection_items.folder_id)
      AND (collection_items.is_public = true OR collection_items.user_id = auth.uid())
    )
    OR public.item_is_grail_showcased(collection_items.id)
  );

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
          OR public.item_is_grail_showcased(ci.id)
        )
    )
  );

NOTIFY pgrst, 'reload schema';
