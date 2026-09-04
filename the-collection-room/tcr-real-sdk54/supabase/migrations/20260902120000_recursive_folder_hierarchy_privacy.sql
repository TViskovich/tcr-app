-- ============================================================================
-- Recursive (arbitrary-depth) folder-hierarchy privacy + write-time integrity.
--
-- Context: parent_folder_id (20260715120000_folder_hierarchy.sql) has no DB
-- depth limit and never had one — its own header comment's "only ever one
-- level deep, enforced at the UI layer (see
-- components/collection/folder-parent-picker.tsx)" was aspirational and
-- describes UI that was never built (that file does not exist anywhere in
-- this repo). Folders are about to become genuinely, arbitrarily nestable
-- client-side, which makes the following pre-existing gap actually
-- reachable for the first time:
--
-- Every visibility policy touching folders (folders_select_public,
-- items_select_public, collection_item_images_select_public,
-- folder_comments_select_public, gallery_comments_select_public,
-- folder_likes_select_public — plus the equivalent checks inside
-- get-folder-cover-signed-url and get-collection-item-image-signed-url)
-- only ever inspected ONE folder row's own is_public/user_id. None of them
-- walked parent_folder_id. So a folder flagged is_public = true, nested
-- (at any depth) under a private folder owned by someone else, was fully
-- readable via a direct query/deep-link to its own id — the parent's
-- privacy was never actually inherited despite is_public being the
-- product's real, user-facing privacy toggle.
--
-- This migration extends the existing "most-restrictive-wins" model
-- (folder.is_public AND item.is_public, from
-- 20260819120000_enforce_collection_folder_privacy.sql /
-- 20260825120000_add_collection_item_privacy.sql) up the tree: a folder is
-- now visible to a non-owner only if it AND every ancestor up to the root
-- are public. Item/image-level privacy is unchanged and still ANDed on top
-- — this migration only replaces the folder leg of each check.
--
-- A second, independent gap is closed at the same time: folders_insert_own/
-- folders_update_own never verified that a client-supplied parent_folder_id
-- was actually owned by the same user, or that reparenting an existing
-- folder couldn't create a cycle. Both are now enforced declaratively.
--
-- ── Revision note (caller-spoofing fix) ──────────────────────────────────
-- An earlier draft of this migration exposed a single explicit-caller
-- SECURITY DEFINER function (public.folder_is_effectively_visible(uuid,
-- uuid)) with EXECUTE granted to anon AND authenticated. Because Postgres
-- functions in the `public` schema are auto-exposed by PostgREST as
-- /rest/v1/rpc/<name> for any role holding EXECUTE, that grant let ANY
-- client — including a fully unauthenticated one — call the function
-- directly with an arbitrary `caller` argument, not auth.uid(). Since the
-- function's very first branch was "IF caller = target_owner THEN RETURN
-- true", this turned it into an ownership oracle: for any folder id and any
-- guessed/known user id, a caller could learn whether that user owns the
-- folder, regardless of the folder's actual privacy — strictly more than
-- RLS itself ever reveals (a normal SELECT by a non-owner on a private
-- folder returns zero rows and reveals nothing about who owns it).
-- SECURITY DEFINER only governs what privileges the function body runs
-- with once entered; it says nothing about who may call it or what
-- arguments they may pass, and does not by itself make an explicit-caller
-- function safe to expose broadly.
--
-- Fixed by splitting into three tiers, none of which grant an
-- explicit-caller entry point to anon/authenticated:
--   1. _folder_is_effectively_visible_for(uuid, uuid) — the actual walk,
--      explicit caller, EXECUTE revoked from PUBLIC and never granted to
--      any role. Reachable only by functions that were created by (and are
--      therefore owned by) the same privileged migration role — Postgres
--      object owners always retain implicit access to objects they own,
--      regardless of REVOKE/GRANT to other roles, which is what lets the
--      two SECURITY DEFINER wrappers below call it without needing an
--      explicit grant of their own.
--   2. folder_is_effectively_visible(uuid) — the RLS-facing wrapper. Takes
--      NO caller argument at all; derives it internally as auth.uid(),
--      which is read from the session's verified-JWT claims set by
--      PostgREST and cannot be overridden by any RPC argument a client
--      supplies. Safe to grant to anon/authenticated because there is
--      structurally nothing to spoof.
--   3. folder_effective_visibility_batch(uuid[], uuid) — unchanged
--      signature (the two signed-URL Edge Functions run as service_role
--      and resolve caller identity themselves from a verified JWT via
--      resolveCaller(), independent of Postgres's own auth.uid(), so they
--      legitimately need to pass an explicit caller) but EXECUTE is now
--      restricted to service_role only — never anon, never authenticated.
--
-- No client/UI code changes ship in this migration (see the app-side
-- follow-up for child-folder rendering/creation) — this is schema/RLS/
-- Edge-Function-authorization only.
-- ============================================================================

-- ── 1. Internal explicit-caller walk — not exposed to any API role ──────
-- Iterative (not a recursive CTE) so the cycle/hop guard is a simple
-- visited-array check, not a WITH RECURSIVE termination condition to get
-- exactly right. SECURITY DEFINER is required, not just convenient: this
-- must be able to read a private ancestor's own is_public flag even when
-- that ancestor is owned by someone else and would otherwise be completely
-- invisible to the caller under folders_select_public — the whole point is
-- inspecting rows the caller isn't authorized to see the CONTENTS of, in
-- order to correctly say "no" without leaking anything beyond that boolean.
--
-- Deliberately has NO grant to anon, authenticated, or even service_role
-- below (see section 4) — this is pure internal plumbing for the two
-- wrapper functions in sections 2-3, both owned by the same role that
-- creates this one and therefore able to call it regardless. It must never
-- be reachable directly via /rest/v1/rpc/_folder_is_effectively_visible_for
-- by a client-supplied caller value.
CREATE OR REPLACE FUNCTION public._folder_is_effectively_visible_for(target_folder_id uuid, caller uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_is_public boolean;
  current_parent uuid;
  target_owner uuid;
  visited uuid[] := ARRAY[]::uuid[];
  hops integer := 0;
BEGIN
  IF target_folder_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT f.is_public, f.parent_folder_id, f.user_id
    INTO current_is_public, current_parent, target_owner
    FROM public.folders f
    WHERE f.id = target_folder_id;

  IF NOT FOUND THEN
    RETURN false; -- nonexistent folder — fail closed, never leak existence
  END IF;

  -- Owner of the target folder always sees their own tree, regardless of
  -- any ancestor's privacy. Checked against the TARGET's own owner only
  -- (not re-checked per ancestor) — a correctly-created tree has exactly
  -- one owner throughout (see the parent-ownership WITH CHECK below), and
  -- scoping the override to the leaf folder being asked about means a
  -- malformed/legacy cross-owner attachment can never silently grant
  -- access to a folder the caller doesn't actually own.
  IF caller IS NOT NULL AND caller = target_owner THEN
    RETURN true;
  END IF;

  LOOP
    IF NOT current_is_public THEN
      RETURN false; -- most-restrictive-wins: any non-public node blocks a non-owner
    END IF;

    IF current_parent IS NULL THEN
      RETURN true; -- reached the root; every node so far (incl. target) was public
    END IF;

    hops := hops + 1;
    IF hops > 100 OR current_parent = ANY(visited) THEN
      RETURN false; -- pathological/cyclic stored data — fail closed, never trust it
    END IF;
    visited := visited || current_parent;

    SELECT f.is_public, f.parent_folder_id
      INTO current_is_public, current_parent
      FROM public.folders f
      WHERE f.id = current_parent;

    IF NOT FOUND THEN
      RETURN false; -- broken ancestor chain (should be impossible under ON DELETE
                     -- SET NULL, but fail closed rather than assume) — never trust it
    END IF;
  END LOOP;
END;
$$;

-- Defensive/explicit: revoke the implicit default PUBLIC grant every new
-- function gets at CREATE time. No corresponding GRANT follows for this
-- function — see this section's own header comment for why.
REVOKE EXECUTE ON FUNCTION public._folder_is_effectively_visible_for(uuid, uuid) FROM PUBLIC;

-- ── 2. RLS-facing wrapper — no caller argument, nothing to spoof ────────
-- Takes only the folder id; derives identity as auth.uid() internally,
-- which a client cannot override via any RPC argument. This is the ONLY
-- visibility function RLS policies below should ever call. SECURITY
-- DEFINER so this wrapper's own call into the owner-only internal helper
-- above succeeds regardless of the invoking role's own grants (see this
-- migration's revision note).
CREATE OR REPLACE FUNCTION public.folder_is_effectively_visible(target_folder_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public._folder_is_effectively_visible_for(target_folder_id, auth.uid());
$$;

REVOKE EXECUTE ON FUNCTION public.folder_is_effectively_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.folder_is_effectively_visible(uuid) TO anon, authenticated, service_role;

-- ── 3. Edge-Function batch RPC — explicit caller, service_role only ─────
-- Signature unchanged from the original draft (folder_ids uuid[], caller
-- uuid) — get-folder-cover-signed-url and get-collection-item-image-signed-url
-- both run as service_role and resolve the real caller identity themselves
-- via resolveCaller()'s own JWT verification (independent of Postgres's
-- auth.uid(), since these functions use the service-role client, not the
-- caller's own session), so they legitimately need to pass an explicit
-- caller rather than relying on auth.uid(). SECURITY DEFINER so this can
-- call the owner-only internal helper above; EXECUTE is restricted to
-- service_role only below — never anon, never authenticated — so this
-- explicit-caller entry point is unreachable from any client-facing role.
CREATE OR REPLACE FUNCTION public.folder_effective_visibility_batch(folder_ids uuid[], caller uuid)
RETURNS TABLE(folder_id uuid, visible boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT fid, public._folder_is_effectively_visible_for(fid, caller)
  FROM unnest(folder_ids) AS fid;
$$;

REVOKE EXECUTE ON FUNCTION public.folder_effective_visibility_batch(uuid[], uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.folder_effective_visibility_batch(uuid[], uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.folder_effective_visibility_batch(uuid[], uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.folder_effective_visibility_batch(uuid[], uuid) TO service_role;

-- ── 4. Write-time cycle guard ────────────────────────────────────────────
-- Walks UP from the PROPOSED new parent toward the root; if that walk ever
-- reaches folder_id, then new_parent_id is currently a descendant of
-- folder_id, so assigning folder_id.parent_folder_id = new_parent_id would
-- close a cycle. SECURITY DEFINER for the same reason as section 1:
-- Postgres does not guarantee left-to-right evaluation of AND/OR operands,
-- so this must never depend on some other clause in the same policy having
-- already confirmed the caller owns every node in the chain — it has to
-- see the true chain itself and fail closed (treat an inconclusive walk as
-- "yes, a cycle" — i.e. reject the write) rather than risk silently
-- allowing one because RLS hid a row from a SECURITY INVOKER version of
-- this check.
--
-- Unlike the visibility helpers above, this does NOT take an identity
-- argument at all (both parameters are folder ids) — so it isn't subject
-- to the same caller-spoofing pattern. It is, however, still a residual
-- exposure: it's referenced directly (not through a wrapper) inside
-- folders_update_own's own WITH CHECK, which runs as the authenticated
-- caller's own session — so `authenticated` MUST retain direct EXECUTE on
-- it for ordinary folder updates to keep working at all. That also means
-- any authenticated user can call it directly via
-- /rest/v1/rpc/folder_would_create_cycle with arbitrary folder ids they
-- don't own, learning "is folder B nested somewhere under folder A" for
-- pairs they otherwise couldn't see — a narrow structural-disclosure
-- oracle across privacy boundaries, not a full content or ownership leak,
-- and it requires an authenticated session (never reachable by anon).
-- Closing this fully would require decoupling cycle-checking from a
-- directly-callable RLS-referenced function (e.g. a BEFORE UPDATE trigger
-- instead), which is out of scope for this pass — documented here as a
-- known, accepted residual rather than silently left unmentioned.
CREATE OR REPLACE FUNCTION public.folder_would_create_cycle(folder_id uuid, new_parent_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_id uuid;
  visited uuid[] := ARRAY[]::uuid[];
  hops integer := 0;
BEGIN
  IF folder_id IS NULL OR new_parent_id IS NULL THEN
    RETURN false;
  END IF;

  IF new_parent_id = folder_id THEN
    RETURN true; -- direct self-parenting
  END IF;

  current_id := new_parent_id;
  LOOP
    hops := hops + 1;
    IF hops > 100 OR current_id = ANY(visited) THEN
      RETURN true; -- pathologically long/cyclic existing chain — fail closed, block the write
    END IF;
    visited := visited || current_id;

    SELECT f.parent_folder_id INTO current_id
      FROM public.folders f
      WHERE f.id = current_id;

    IF NOT FOUND THEN
      RETURN false; -- walked off a broken chain before ever reaching folder_id — no cycle
    END IF;

    IF current_id IS NULL THEN
      RETURN false; -- reached the root without encountering folder_id — safe
    END IF;

    IF current_id = folder_id THEN
      RETURN true; -- new_parent_id is a descendant of folder_id — would create a cycle
    END IF;
  END LOOP;
END;
$$;

-- No PUBLIC, no anon — anon can never legitimately reach this (folders_
-- update_own's own USING (auth.uid() = user_id) can never be satisfied by
-- anon), so it gains nothing from a grant here. authenticated is the
-- minimum required for legitimate folder-reparenting updates to keep
-- working (see this function's own header comment for the residual this
-- accepts). service_role is not granted — nothing server-side calls this
-- function today, so it is intentionally not widened "for convenience."
REVOKE EXECUTE ON FUNCTION public.folder_would_create_cycle(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.folder_would_create_cycle(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.folder_would_create_cycle(uuid, uuid) TO authenticated;

-- ── 5. folders: SELECT becomes ancestor-aware (single-arg wrapper) ──────
DROP POLICY IF EXISTS "folders_select_public" ON public.folders;
CREATE POLICY "folders_select_public" ON public.folders
  FOR SELECT USING (
    public.folder_is_effectively_visible(id)
  );

-- ── 6. folders: INSERT/UPDATE require parent ownership + no cycle ──────
-- A brand-new row can't already have descendants, so only self-parenting
-- needs blocking at INSERT time (a longer cycle would require some OTHER
-- existing row to already point at this not-yet-existing id, which is
-- impossible). UPDATE additionally guards against reparenting into one of
-- the folder's own existing descendants.
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
          WHERE p.id = parent_folder_id AND p.user_id = auth.uid()
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
          WHERE p.id = parent_folder_id AND p.user_id = auth.uid()
        )
        AND NOT public.folder_would_create_cycle(id, parent_folder_id)
      )
    )
  );

-- ── 7. collection_items: SELECT folder leg becomes ancestor-aware ───────
-- Item-level privacy (collection_items.is_public / user_id) is unchanged —
-- only the folder-visibility leg of the existing AND is replaced.
DROP POLICY IF EXISTS "items_select_public" ON public.collection_items;
CREATE POLICY "items_select_public" ON public.collection_items
  FOR SELECT USING (
    public.folder_is_effectively_visible(collection_items.folder_id)
    AND (collection_items.is_public = true OR collection_items.user_id = auth.uid())
  );

-- ── 8. collection_item_images: same AND, one level down ─────────────────
DROP POLICY IF EXISTS "collection_item_images_select_public" ON public.collection_item_images;
CREATE POLICY "collection_item_images_select_public" ON public.collection_item_images
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = collection_item_images.item_id
        AND public.folder_is_effectively_visible(ci.folder_id)
        AND (ci.is_public = true OR ci.user_id = auth.uid())
    )
  );

-- ── 9. folder_comments: SELECT + INSERT become ancestor-aware ───────────
DROP POLICY IF EXISTS "folder_comments_select_public" ON public.folder_comments;
CREATE POLICY "folder_comments_select_public" ON public.folder_comments
  FOR SELECT USING (
    public.folder_is_effectively_visible(folder_comments.folder_id)
  );

DROP POLICY IF EXISTS "folder_comments_insert_own" ON public.folder_comments;
CREATE POLICY "folder_comments_insert_own" ON public.folder_comments
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND public.folder_is_effectively_visible(folder_id)
  );

-- ── 10. gallery_comments: same parent-folder rule ────────────────────────
DROP POLICY IF EXISTS "gallery_comments_select_public" ON public.gallery_comments;
CREATE POLICY "gallery_comments_select_public" ON public.gallery_comments
  FOR SELECT USING (
    public.folder_is_effectively_visible(gallery_comments.folder_id)
  );

DROP POLICY IF EXISTS "gallery_comments_insert_own" ON public.gallery_comments;
CREATE POLICY "gallery_comments_insert_own" ON public.gallery_comments
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND public.folder_is_effectively_visible(folder_id)
  );

-- ── 11. folder_likes: same gap found during this audit, not originally ──
-- named in scope but structurally identical (single-row is_public/user_id
-- check, see 20260824120000_harden_folder_likes_folder_privacy.sql) —
-- included here so nested-folder privacy doesn't leak sideways through
-- likes the moment folders/items/comments are fixed.
DROP POLICY IF EXISTS "folder_likes_select_public" ON public.folder_likes;
CREATE POLICY "folder_likes_select_public" ON public.folder_likes
  FOR SELECT USING (
    public.folder_is_effectively_visible(folder_likes.folder_id)
  );

DROP POLICY IF EXISTS "folder_likes_insert_own" ON public.folder_likes;
CREATE POLICY "folder_likes_insert_own" ON public.folder_likes
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND public.folder_is_effectively_visible(folder_id)
  );

NOTIFY pgrst, 'reload schema';
