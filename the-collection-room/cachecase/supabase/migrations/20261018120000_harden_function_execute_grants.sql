BEGIN;

-- ============================================================================
-- Function EXECUTE hardening (security audit, 2026-10).
--
-- Supabase's default privileges grant EXECUTE on every new public function
-- DIRECTLY to anon and authenticated (and service_role). Several earlier
-- migrations only ran "REVOKE ... FROM PUBLIC", which does NOT remove those
-- direct grants — confirmed live: folder_owned_by and
-- _folder_is_effectively_visible_for both execute for an anonymous caller,
-- while functions whose migrations revoked anon explicitly are refused.
--
-- This migration ONLY removes grants. No function body, policy, trigger or
-- table changes; no new privileges. Explicit signatures throughout, so no
-- other overload is affected.
--
-- 1. Signed-in RPCs — anon removed, authenticated kept. Each already
--    refuses an anonymous caller internally (auth.uid() NULL -> raises, or
--    RLS blocks it), so this is defence in depth, not a behaviour change
--    for the app (which only calls them signed in):
--      create/update_pokemon_item, create/update_comic_book_item,
--      move_collection_items, reorder_collection_items,
--      remove_item_image, reorder_item_images, set_primary_item_image.
--
-- 2. folder_owned_by(folder, owner) — anon removed, authenticated KEPT:
--    it's evaluated by the folders insert/update RLS policies and the
--    collection_items folder-move trigger, which run as the signed-in user
--    (revoking it from authenticated would break folder creation/moves).
--    Anonymous callers could ask "does user X own folder F" for any folder
--    id; they no longer can.
--
-- 3. _folder_is_effectively_visible_for(folder, caller) — anon AND
--    authenticated removed. It takes the caller as an ARGUMENT, so any
--    client could ask "is folder F visible to user X" for someone else
--    (e.g. whether a given user owns a private folder). It is never called
--    by a client, a policy or an Edge Function directly: its only callers
--    are SECURITY DEFINER functions (folder_is_effectively_visible,
--    folder_effective_visibility_batch, _item_visible_to,
--    resolve_item_images_for_signing), which run with the owner's
--    privileges and are unaffected. folder_is_effectively_visible (which
--    uses auth.uid(), not an argument) stays callable by anon and
--    authenticated: public RLS policies need it.
--
-- Intentionally unchanged (see the audit report): folder_is_effectively_
-- visible / folder_is_grail_showcased / item_is_grail_showcased (needed by
-- public RLS policies, reveal only public visibility); every function whose
-- grants were already explicit; trigger functions (not callable as RPCs).
-- ============================================================================

-- ── 1. Signed-in RPCs ────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.create_pokemon_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pokemon_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.update_pokemon_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_pokemon_item(
  uuid, numeric, text, boolean, text, text, text, text, text, text, text, text, text
) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.create_comic_book_item(
  uuid, numeric, text, boolean, text, text, text, integer, text, text, text,
  text, text, text, text, text, text, text, boolean, text[], text, text,
  text, text, text, text, text, text, text, text, text, text, text, boolean,
  text, text, boolean, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_comic_book_item(
  uuid, numeric, text, boolean, text, text, text, integer, text, text, text,
  text, text, text, text, text, text, text, boolean, text[], text, text,
  text, text, text, text, text, text, text, text, text, text, text, boolean,
  text, text, boolean, text
) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.update_comic_book_item(
  uuid, numeric, text, boolean, text, text, text, integer, text, text, text,
  text, text, text, text, text, text, text, boolean, text[], text, text,
  text, text, text, text, text, text, text, text, text, text, text, boolean,
  text, text, boolean, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_comic_book_item(
  uuid, numeric, text, boolean, text, text, text, integer, text, text, text,
  text, text, text, text, text, text, text, boolean, text[], text, text,
  text, text, text, text, text, text, text, text, text, text, text, boolean,
  text, text, boolean, text
) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.move_collection_items(uuid[], uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_collection_items(uuid[], uuid, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.reorder_collection_items(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_collection_items(uuid, uuid[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.remove_item_image(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_item_image(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.reorder_item_images(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_item_images(uuid, uuid[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.set_primary_item_image(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_primary_item_image(uuid, uuid) TO authenticated;

-- ── 2. folder_owned_by: RLS/trigger helper for signed-in users ──────────────
REVOKE EXECUTE ON FUNCTION public.folder_owned_by(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.folder_owned_by(uuid, uuid) TO authenticated;

-- ── 3. _folder_is_effectively_visible_for: internal only ────────────────────
REVOKE EXECUTE ON FUNCTION public._folder_is_effectively_visible_for(uuid, uuid) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
