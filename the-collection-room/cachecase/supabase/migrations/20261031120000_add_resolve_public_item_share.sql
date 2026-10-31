BEGIN;

-- ============================================================================
-- Public item sharing — Phase 1 (backend foundation): the one database read
-- behind the get-public-item-share Edge Function, which will back the
-- public https://<public-domain>/item/<id> preview page and its link
-- preview image. Nothing calls it yet; no existing function, policy, table
-- or grant changes.
--
-- Unlike resolve_item_images_for_signing (which returns authorization FACTS
-- and leaves the decision to its Edge Function, because that function has
-- an owner branch that depends on the caller's verified JWT), this lookup
-- has no caller at all — every visitor gets the same answer — so the
-- DECISION is made here, in the WHERE clause. An item that isn't publicly
-- shareable produces no row, so the service-role Edge Function never even
-- receives data for it: a bug in the function's own code can't leak a
-- private item, because the only service-role path to item data for this
-- feature never returns one.
--
-- Publicly shareable means ALL of:
--   * collection_items.is_public = true                (item's own flag)
--   * the folder AND every ancestor folder is public   -> reuses the
--     canonical recursive rule, _folder_is_effectively_visible_for(folder,
--     NULL); NULL caller = no owner shortcut, i.e. the anonymous answer
--     (20260902120000_recursive_folder_hierarchy_privacy.sql)
--   * collection_status = 'active'                      (never transferred_out)
--   * the item's owner owns its folder                  (defence in depth;
--     always true for legitimately-created rows — items_insert_own)
-- Deliberately NOT included: the Grail-slot visibility exception
-- (20260910120000_grail_slot_visibility_exception.sql). Grail placement
-- publishes an item inside the app; it does not make a private item
-- shareable outside it. Deleted items have no row and so produce none.
--
-- Returns only display-ready, public-safe text (title, a short subtitle
-- built from category fields that are already readable wherever the item
-- is), the owner's public username/display name, and the primary image's
-- storage path — the last for the Edge Function to sign and stream
-- server-side; it is never sent to a client. Never returned: description,
-- estimated_value, serial_number, grade/grading data, purchase price
-- (collection_item_private_details), user/folder/image ids, or any
-- registry data.
--
-- service_role only (it returns a storage path). SECURITY DEFINER + empty
-- search_path, matching the existing folder-visibility functions; EXECUTE
-- is revoked from every client role explicitly (not just PUBLIC — see
-- 20261018120000_harden_function_execute_grants.sql).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_public_item_share(p_item_id uuid)
RETURNS TABLE (
  item_type          text,
  title              text,
  subtitle           text,
  owner_username     text,
  owner_display_name text,
  image_storage_path text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    ci.item_type,
    -- Sports cards lead with the player (the same precedence as the public
    -- registry's buildTitle); every other type stores its primary
    -- identifying field in title.
    CASE
      WHEN ci.item_type = 'sports_card'
        THEN COALESCE(NULLIF(btrim(ci.player), ''), NULLIF(btrim(ci.title), ''))
      ELSE NULLIF(btrim(ci.title), '')
    END,
    NULLIF(
      CASE ci.item_type
        WHEN 'pokemon' THEN concat_ws(' · ',
          NULLIF(btrim(pk.set_name), ''),
          '#' || NULLIF(btrim(pk.card_number), ''))
        WHEN 'trading_card' THEN concat_ws(' · ',
          NULLIF(btrim(tc.franchise), ''),
          NULLIF(btrim(tc.set_name), ''),
          '#' || NULLIF(btrim(tc.card_number), ''))
        WHEN 'comic_book' THEN concat_ws(' · ',
          '#' || NULLIF(btrim(cb.issue_number), ''),
          NULLIF(btrim(cb.publisher), ''))
        WHEN 'other' THEN concat_ws(' · ',
          CASE oi.category
            WHEN 'sneakers'   THEN 'Sneakers'
            WHEN 'watches'    THEN 'Watches'
            WHEN 'art_prints' THEN 'Art & Prints'
            WHEN 'toys'       THEN 'Toys'
            WHEN 'books'      THEN 'Books'
            WHEN 'pins'       THEN 'Pins'
            WHEN 'custom'     THEN oi.custom_category_name
          END,
          NULLIF(btrim(ci.brand), ''))
        -- sports_card, figurine
        ELSE concat_ws(' ', ci.year::text, NULLIF(btrim(ci.brand), ''))
      END,
      ''
    ),
    p.username,
    NULLIF(btrim(p.display_name), ''),
    img.storage_path
  FROM public.collection_items ci
  JOIN public.folders f ON f.id = ci.folder_id
  LEFT JOIN public.profiles p ON p.id = ci.user_id
  LEFT JOIN public.pokemon_card_details pk ON pk.item_id = ci.id AND ci.item_type = 'pokemon'
  LEFT JOIN public.trading_card_details tc ON tc.item_id = ci.id AND ci.item_type = 'trading_card'
  LEFT JOIN public.comic_book_details cb ON cb.item_id = ci.id AND ci.item_type = 'comic_book'
  LEFT JOIN public.other_item_details oi ON oi.item_id = ci.id AND ci.item_type = 'other'
  -- The primary image (else the first by the owner's order); none -> NULL.
  LEFT JOIN LATERAL (
    SELECT i.storage_path
    FROM public.collection_item_images i
    WHERE i.item_id = ci.id
      AND i.storage_path IS NOT NULL
    ORDER BY i.is_primary DESC, i.sort_order ASC, i.created_at ASC, i.id ASC
    LIMIT 1
  ) img ON true
  WHERE ci.id = p_item_id
    AND ci.is_public = true
    AND ci.collection_status = 'active'
    AND ci.user_id = f.user_id
    AND public._folder_is_effectively_visible_for(f.id, NULL);
$$;

COMMENT ON FUNCTION public.resolve_public_item_share(uuid) IS
  'Public share data for get-public-item-share (service_role only). Returns a row only for an active, public item whose folder chain is public; never Grail-only, private, transferred or deleted items.';

REVOKE ALL ON FUNCTION public.resolve_public_item_share(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_public_item_share(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
