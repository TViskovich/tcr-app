-- Item image signing: one set-based lookup for get-collection-item-image-signed-url.
--
-- Replaces that Edge Function's chain of separate lookups (image rows ->
-- items -> folders -> folder_effective_visibility_batch, plus a grail-slot
-- lookup) with ONE call returning, per requested image that resolves to an
-- existing item AND folder, exactly the fields its canViewItem() decision
-- reads. The DECISION stays in the Edge Function, unchanged:
--
--   owner (caller = folder owner)                         -> allowed
--   folder_effectively_visible AND item_is_public         -> allowed
--   grail_showcased (an item slot for this item, held by
--   the folder's owner)                                   -> allowed
--   anything else, or no row returned                     -> unavailable
--
-- Caller-independent on purpose, so the Edge Function can run this at the
-- same time as resolving the caller's token:
--   folder_effectively_visible is _folder_is_effectively_visible_for(folder,
--   NULL) — the canonical folder rule, reused, not re-implemented. That
--   function only uses its caller argument for the owner shortcut ("caller
--   = this folder's owner -> true"), and canViewItem only consults this
--   field AFTER its own owner check has failed, i.e. when caller != owner —
--   where the result is identical to passing NULL. So the effective rule is
--   exactly what the Edge Function enforced before.
--   grail_showcased is the same owner-cross-checked slot test the Edge
--   Function did (slot.user_id = folder.user_id), as a deterministic EXISTS.
--
-- Set-based: one statement over the requested ids; the folder rule is
-- evaluated once per DISTINCT folder (as folder_effective_visibility_batch
-- already did), never per image. Images whose item or folder no longer
-- exists produce no row (the Edge Function already reports those as
-- unavailable).
--
-- Returns storage paths, so it is callable ONLY by service_role (the Edge
-- Function's server-side client). EXECUTE is revoked from every client role;
-- no app client can call it. SECURITY DEFINER + empty search_path, matching
-- the existing folder-visibility functions.

CREATE OR REPLACE FUNCTION public.resolve_item_images_for_signing(p_image_ids uuid[])
RETURNS TABLE (
  image_id                   uuid,
  item_id                    uuid,
  storage_path               text,
  owner_id                   uuid,
  item_is_public             boolean,
  folder_effectively_visible boolean,
  grail_showcased            boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH resolved AS (
    SELECT
      img.id           AS image_id,
      img.item_id      AS item_id,
      img.storage_path AS storage_path,
      f.id             AS folder_id,
      f.user_id        AS owner_id,
      ci.is_public     AS item_is_public
    FROM public.collection_item_images img
    JOIN public.collection_items ci ON ci.id = img.item_id
    JOIN public.folders f ON f.id = ci.folder_id
    WHERE img.id = ANY (p_image_ids)
  ),
  folder_visibility AS (
    SELECT d.folder_id, public._folder_is_effectively_visible_for(d.folder_id, NULL) AS visible
    FROM (SELECT DISTINCT r.folder_id FROM resolved r) d
  )
  SELECT
    r.image_id,
    r.item_id,
    r.storage_path,
    r.owner_id,
    r.item_is_public,
    fv.visible,
    EXISTS (
      SELECT 1
      FROM public.profile_grail_slots gs
      WHERE gs.entry_type = 'item'
        AND gs.item_id = r.item_id
        AND gs.user_id = r.owner_id
    )
  FROM resolved r
  JOIN folder_visibility fv ON fv.folder_id = r.folder_id;
$$;

COMMENT ON FUNCTION public.resolve_item_images_for_signing(uuid[]) IS
  'Authorization facts + storage paths for get-collection-item-image-signed-url (service_role only). The allow/deny decision is made by that Edge Function''s canViewItem().';

REVOKE ALL ON FUNCTION public.resolve_item_images_for_signing(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_item_images_for_signing(uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';
