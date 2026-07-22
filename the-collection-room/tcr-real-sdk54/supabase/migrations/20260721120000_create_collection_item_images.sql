-- Expands a collection_item from a single collection_items.image_url into
-- a proper multi-photo gallery. collection_items.image_url is kept — not
-- dropped — as the synchronized cache of whichever gallery row is currently
-- primary, so every existing consumer (folder previews, feed/card shell,
-- related items, the CacheCase ID sheet thumbnail) keeps working unchanged.
--
-- Deviation from a typical "user_id references auth.users" pattern: every
-- other user-owned table in this schema (folders, collection_items, posts,
-- ...) references public.profiles(id), not auth.users(id) directly, so
-- this table follows that same established convention instead.
--
-- IF NOT EXISTS / DROP POLICY IF EXISTS everywhere so this is safe to run
-- again if it was already applied once before.

CREATE TABLE IF NOT EXISTS public.collection_item_images (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        uuid        NOT NULL REFERENCES public.collection_items(id) ON DELETE CASCADE,
  user_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  image_url      text        NOT NULL,
  storage_path   text,
  sort_order     integer     NOT NULL DEFAULT 0,
  is_primary     boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collection_item_images_item_id_idx
  ON public.collection_item_images (item_id);

CREATE INDEX IF NOT EXISTS collection_item_images_user_id_idx
  ON public.collection_item_images (user_id);

CREATE INDEX IF NOT EXISTS collection_item_images_item_sort_idx
  ON public.collection_item_images (item_id, sort_order);

-- Only one row per item may be primary. A partial unique index (rather than
-- a plain UNIQUE(item_id, is_primary)) so any number of non-primary rows
-- can coexist for the same item — it only restricts is_primary = true.
CREATE UNIQUE INDEX IF NOT EXISTS collection_item_images_one_primary
  ON public.collection_item_images (item_id)
  WHERE is_primary = true;

-- BACKFILL --------------------------------------------------------
-- One gallery row per existing item that has a legacy image_url, as the
-- primary/sort_order-0 image. The NOT EXISTS guard makes this safe to
-- re-run — items that already have a gallery row (from a prior run of this
-- migration, or created after this migration shipped) are skipped, so
-- re-running never duplicates rows.
INSERT INTO public.collection_item_images (item_id, user_id, image_url, storage_path, sort_order, is_primary)
SELECT
  ci.id,
  ci.user_id,
  ci.image_url,
  CASE
    -- Legacy uploads are Supabase Storage public URLs of the form
    -- .../object/public/item-images/<path> — recover <path> when possible
    -- so the backfilled row still supports clean removal later; leave it
    -- null (rather than guess) for anything that doesn't match, per "derive
    -- storage_path only if it can be done safely."
    WHEN ci.image_url LIKE '%/object/public/item-images/%'
      THEN substring(ci.image_url FROM '/object/public/item-images/(.*)$')
    ELSE NULL
  END,
  0,
  true
FROM public.collection_items ci
WHERE ci.image_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.collection_item_images cii WHERE cii.item_id = ci.id
  );

-- ROW LEVEL SECURITY ------------------------------------------------

ALTER TABLE public.collection_item_images ENABLE ROW LEVEL SECURITY;

-- Anyone allowed to view an item can view its images — matches
-- items_select_public (collection_items itself has no private-item
-- concept today; USING (true) there too).
DROP POLICY IF EXISTS "collection_item_images_select_public" ON public.collection_item_images;
CREATE POLICY "collection_item_images_select_public" ON public.collection_item_images
  FOR SELECT USING (true);

-- Ownership is always re-validated against the parent collection_items row,
-- not just the client-supplied user_id column — a client can't insert a
-- gallery row against someone else's item even if it claims its own
-- user_id honestly.
DROP POLICY IF EXISTS "collection_item_images_insert_own" ON public.collection_item_images;
CREATE POLICY "collection_item_images_insert_own" ON public.collection_item_images
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = item_id AND ci.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "collection_item_images_update_own" ON public.collection_item_images;
CREATE POLICY "collection_item_images_update_own" ON public.collection_item_images
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = item_id AND ci.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "collection_item_images_delete_own" ON public.collection_item_images;
CREATE POLICY "collection_item_images_delete_own" ON public.collection_item_images
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = item_id AND ci.user_id = auth.uid()
    )
  );

-- RPC HELPERS ---------------------------------------------------------
-- Primary-image changes touch multiple rows (and collection_items.image_url)
-- at once, so they're done as a single plpgsql function body (one implicit
-- transaction) rather than several sequential client round-trips, which
-- could leave things half-applied on a dropped connection. SECURITY INVOKER
-- (the default) so every statement inside still runs under the caller's own
-- RLS — ownership is enforced by both an explicit check up front (for a
-- clear error instead of a silent no-op) and by RLS itself underneath.

CREATE OR REPLACE FUNCTION public.set_primary_item_image(p_item_id uuid, p_image_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_url text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.collection_items WHERE id = p_item_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to modify this item''s images';
  END IF;

  SELECT image_url INTO v_url
  FROM public.collection_item_images
  WHERE id = p_image_id AND item_id = p_item_id;

  IF v_url IS NULL THEN
    RAISE EXCEPTION 'Image not found for this item';
  END IF;

  -- Clear every row's primary flag first — after this statement zero rows
  -- are primary, which collection_item_images_one_primary always allows,
  -- so this two-step order can never collide with it.
  UPDATE public.collection_item_images SET is_primary = false
  WHERE item_id = p_item_id AND is_primary = true;

  UPDATE public.collection_item_images SET is_primary = true
  WHERE id = p_image_id;

  -- Renumber so the primary image is always sort_order 0 and everything
  -- else keeps its relative order after it — "ORDER BY sort_order ASC"
  -- alone is then always sufficient to surface the primary image first.
  UPDATE public.collection_item_images cii
  SET sort_order = ranked.new_order
  FROM (
    SELECT id,
      ROW_NUMBER() OVER (ORDER BY (id = p_image_id) DESC, sort_order ASC, created_at ASC) - 1 AS new_order
    FROM public.collection_item_images
    WHERE item_id = p_item_id
  ) ranked
  WHERE cii.id = ranked.id;

  UPDATE public.collection_items SET image_url = v_url WHERE id = p_item_id;
END;
$$;

-- Deletes one gallery row, promotes a new primary if the removed one was
-- primary (or clears collection_items.image_url if none remain), and
-- returns the removed row's storage_path so the caller can delete the
-- underlying Storage object (Storage deletion has to happen client-side —
-- plain SQL can't reach into a Storage bucket).
CREATE OR REPLACE FUNCTION public.remove_item_image(p_image_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_item_id uuid;
  v_was_primary boolean;
  v_storage_path text;
  v_next_id uuid;
  v_next_url text;
BEGIN
  SELECT item_id, is_primary, storage_path INTO v_item_id, v_was_primary, v_storage_path
  FROM public.collection_item_images
  WHERE id = p_image_id;

  IF v_item_id IS NULL THEN
    RAISE EXCEPTION 'Image not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.collection_items WHERE id = v_item_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to modify this item''s images';
  END IF;

  DELETE FROM public.collection_item_images WHERE id = p_image_id;

  IF v_was_primary THEN
    SELECT id, image_url INTO v_next_id, v_next_url
    FROM public.collection_item_images
    WHERE item_id = v_item_id
    ORDER BY sort_order ASC, created_at ASC
    LIMIT 1;

    IF v_next_id IS NOT NULL THEN
      UPDATE public.collection_item_images SET is_primary = true WHERE id = v_next_id;
      UPDATE public.collection_items SET image_url = v_next_url WHERE id = v_item_id;
    ELSE
      UPDATE public.collection_items SET image_url = NULL WHERE id = v_item_id;
    END IF;
  END IF;

  -- Renumber remaining rows to close the gap left by the deleted one and
  -- keep the (possibly newly-promoted) primary at sort_order 0.
  UPDATE public.collection_item_images cii
  SET sort_order = ranked.new_order
  FROM (
    SELECT id,
      ROW_NUMBER() OVER (ORDER BY is_primary DESC, sort_order ASC, created_at ASC) - 1 AS new_order
    FROM public.collection_item_images
    WHERE item_id = v_item_id
  ) ranked
  WHERE cii.id = ranked.id;

  RETURN v_storage_path;
END;
$$;

-- Persists a full new sort_order for an item's images in one statement
-- (sort_order has no uniqueness constraint, so this carries no collision
-- risk regardless of row processing order), then applies the same
-- clear-then-set primary pattern as set_primary_item_image to keep
-- is_primary/collection_items.image_url pointed at whichever image now
-- sits first.
CREATE OR REPLACE FUNCTION public.reorder_item_images(p_item_id uuid, p_ordered_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_primary_id uuid;
  v_primary_url text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.collection_items WHERE id = p_item_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to modify this item''s images';
  END IF;

  IF (SELECT COUNT(*) FROM public.collection_item_images WHERE item_id = p_item_id)
     <> COALESCE(array_length(p_ordered_ids, 1), 0) THEN
    RAISE EXCEPTION 'Ordered id list does not match the item''s image set';
  END IF;

  UPDATE public.collection_item_images cii
  SET sort_order = ordered.new_order
  FROM (
    SELECT id, ord - 1 AS new_order
    FROM unnest(p_ordered_ids) WITH ORDINALITY AS t(id, ord)
  ) ordered
  WHERE cii.id = ordered.id AND cii.item_id = p_item_id;

  v_primary_id := p_ordered_ids[1];

  UPDATE public.collection_item_images SET is_primary = false
  WHERE item_id = p_item_id AND is_primary = true;

  UPDATE public.collection_item_images SET is_primary = true
  WHERE id = v_primary_id;

  SELECT image_url INTO v_primary_url FROM public.collection_item_images WHERE id = v_primary_id;

  UPDATE public.collection_items SET image_url = v_primary_url WHERE id = p_item_id;
END;
$$;

-- No storage.objects policy changes needed: gallery files live under
-- <userId>/<itemId>/<fileName> in the existing item-images bucket, and the
-- existing item_images_* policies already authorize by first path segment
-- (= userId) only, which an itemId subfolder doesn't affect.

NOTIFY pgrst, 'reload schema';
