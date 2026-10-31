BEGIN;

-- ============================================================================
-- Removes the public item-sharing resolver added by
-- 20261031120000_add_resolve_public_item_share.sql. The public HTTPS
-- item-preview feature it backed was cancelled before anything used it:
-- its only caller, the get-public-item-share Edge Function, is removed in
-- the same change, and no app, Registry, website or other function code
-- references it.
--
-- Forward-only: the original migration stays in history unchanged. Drops
-- exactly that one signature; nothing else it relied on is touched
-- (_folder_is_effectively_visible_for, the item/detail/image tables, and
-- every Registry and signed-image function stay as they are). It created
-- no tables, policies, triggers or types, so there is nothing else to undo.
-- ============================================================================

DROP FUNCTION IF EXISTS public.resolve_public_item_share(uuid);

NOTIFY pgrst, 'reload schema';

COMMIT;
