-- Multi-image support for normal text posts (post_type = 'text') — up to 4
-- images, mixed source (device photo library or the user's own collection
-- items). Structurally mirrors public.card_share_items (see
-- supabase/migrations/20260722_create_card_share_items.sql): a separate
-- child table rather than image_url_1/_2/_3/_4 columns on posts, since a
-- post can have 0-4 images and card_share_items already establishes this
-- exact "post_id, item_id nullable, snapshot/image url, display_order"
-- shape for a different post_type. Deliberately a NEW table rather than
-- reusing card_share_items itself: that table's RLS/shape was written
-- specifically for the "2-5 REQUIRED items" card-share flow (see its own
-- INSERT policy), and text posts additionally need to record WHICH source
-- each image came from (library upload vs. an existing collection item) —
-- card_share_items has no such concept, every row there is item-sourced.
--
-- image_url here is always a durable, already-public share-snapshots URL
-- by the time a row is written — never an item-images signed/private URL.
-- The INSERT policy below doesn't (and can't) enforce that shape itself;
-- it's enforced by the client/RPC flow that populates this table (see
-- create_text_post below), which only ever calls this after every
-- attachment has already been copied into share-snapshots via the
-- existing copy-share-snapshot-image / copy-post-photo-to-share-snapshots
-- Edge Functions (lib/share-snapshots.ts) — the same durable-copy
-- pipeline every other post image type already goes through. This table
-- itself has no way to verify that server-side; it trusts its caller the
-- same way card_share_items trusts create-snapshot-post's Edge Function
-- output.

-- sort_order is deliberately bounded to exactly the 0-3 range a 4-image
-- post can ever use (security pass, pre-apply review) — combined with the
-- UNIQUE (post_id, sort_order) constraint below, this makes "at most 4
-- rows per post_id" a hard schema-level invariant, not just something
-- create_text_post's own jsonb_array_length check happens to enforce.
-- Without this, a client that skipped the RPC entirely and inserted
-- directly into post_images (the INSERT policy below only ever checks
-- per-row OWNERSHIP, never a per-post row count) could attach an
-- unbounded number of images to their own post — sort_order=4, 5, 6, ...
-- would each satisfy the UNIQUE constraint on its own, since uniqueness
-- alone doesn't cap the total row count. Capping the DOMAIN of sort_order
-- itself is what closes that: there are only 4 legal values, and UNIQUE
-- already forbids reusing one, so a 5th row for the same post_id can never
-- satisfy both constraints at once, regardless of which client/path wrote
-- it.
CREATE TABLE IF NOT EXISTS public.post_images (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       uuid        NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  item_id       uuid        REFERENCES public.collection_items(id) ON DELETE SET NULL,
  image_url     text        NOT NULL,
  source_type   text        NOT NULL CHECK (source_type IN ('library', 'item')),
  sort_order    smallint    NOT NULL DEFAULT 0 CHECK (sort_order >= 0 AND sort_order <= 3),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, sort_order)
);

ALTER TABLE public.post_images ENABLE ROW LEVEL SECURITY;

-- Visibility follows the PARENT post, not an independent "always public"
-- rule (security pass, pre-apply review — originally USING (true), which
-- happened to produce the same result today only because
-- posts_select_public is itself USING (true), but hardcoded that
-- coincidence as this table's own rule instead of deriving it). The
-- EXISTS subquery below runs against public.posts under the CALLING
-- role's own permissions, so it is automatically subject to whatever
-- posts' own SELECT policy (posts_select_public, schema.sql) currently
-- allows — if that policy ever becomes conditional (an owner-only/private
-- post feature, say), this policy inherits the change for free, with
-- nothing here to remember to update in lockstep. It also means a
-- post_images row can never outlive/outrank its own post's visibility:
-- there is no way for this table to expose an attachment for a post_id
-- the caller isn't otherwise allowed to see.
DROP POLICY IF EXISTS "post_images_select_public" ON public.post_images;
DROP POLICY IF EXISTS "post_images_select_visible" ON public.post_images;
CREATE POLICY "post_images_select_visible" ON public.post_images
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_images.post_id)
  );

-- Mirrors card_share_items_insert_own: the post this row attaches to must
-- already belong to the caller. item_id, when set, must also belong to the
-- caller — same defense-in-depth shape as card_share_items, even though in
-- practice item_id here is only ever set via create_text_post below (which
-- itself only runs after the source item's ownership was already verified
-- server-side by the copy step that produced image_url).
DROP POLICY IF EXISTS "post_images_insert_own" ON public.post_images;
CREATE POLICY "post_images_insert_own" ON public.post_images
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.user_id = auth.uid())
    AND (item_id IS NULL OR EXISTS (SELECT 1 FROM public.collection_items ci WHERE ci.id = item_id AND ci.user_id = auth.uid()))
  );

-- No update/delete policy — same as card_share_items, relies on posts' ON
-- DELETE CASCADE. supabase/functions/delete-post also does its own
-- best-effort share-snapshots storage cleanup for these rows before the
-- cascade removes them (see that function's own module comment).

-- Atomic create for a text post with 0-4 already-durable images. A single
-- plpgsql function body is one implicit transaction, so the posts row and
-- its post_images rows either both exist or neither does — mirrors
-- create_card_share_post's own rationale (supabase/migrations/
-- 20260722_create_card_share_items.sql). Unlike create_card_share_post,
-- this never touches Storage itself (no HTTP calls mid-transaction to
-- worry about): every attachment's image_url is ALREADY a durable
-- share-snapshots URL by the time this is called — the client resolves
-- each one first via the existing per-image copy functions
-- (copyShareSnapshotImage for an existing item's image,
-- copyPostPhotoToShareSnapshots for a freshly-picked library photo; see
-- lib/share-snapshots.ts), and only calls this RPC once every single copy
-- has already succeeded. That's what keeps this a plain SQL function
-- instead of needing its own Edge Function the way create-snapshot-post
-- did (create-snapshot-post's copies are of items it discovers server-side
-- in bulk from item_ids alone; here the two different source kinds are
-- already resolved to plain URLs before this is ever invoked).
--
-- p_attachments shape: jsonb array of
--   { "image_url": text, "source_type": "library" | "item", "item_id": text | null }
-- in the exact order they should be stored (sort_order is assigned from
-- array position, 0-indexed).
CREATE OR REPLACE FUNCTION public.create_text_post(p_content text, p_attachments jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post_id uuid;
  v_content text;
  v_count int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Rejects a modified client calling this RPC directly with, say, 20
  -- attachments — this check alone is what stops that (a >4-length array
  -- never reaches the INSERT below at all). Also belt-and-suspenders with
  -- post_images' own sort_order CHECK + UNIQUE(post_id, sort_order) pair
  -- above, which independently caps "how many post_images rows can ever
  -- exist for one post_id" at the schema level regardless of how a row
  -- gets there — this RAISE is the friendlier, earlier rejection for the
  -- normal (RPC-only) write path; that schema constraint is what still
  -- holds even for a client that skips this RPC and inserts directly.
  v_count := COALESCE(jsonb_array_length(p_attachments), 0);
  IF v_count > 4 THEN
    RAISE EXCEPTION 'A post can have at most 4 images';
  END IF;

  v_content := NULLIF(btrim(p_content), '');
  IF v_content IS NULL AND v_count = 0 THEN
    RAISE EXCEPTION 'A post needs text or at least one image';
  END IF;

  -- Defense in depth — the client's own picker/upload flow already only
  -- ever produces these two values; a malformed/unexpected source_type
  -- here indicates a caller bug, not valid input, and must never be
  -- silently accepted.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_attachments) AS elem
    WHERE (elem->>'source_type') NOT IN ('library', 'item')
       OR NULLIF(elem->>'image_url', '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Invalid attachment';
  END IF;

  INSERT INTO public.posts (user_id, post_type, content)
  VALUES (auth.uid(), 'text', v_content)
  RETURNING id INTO v_post_id;

  INSERT INTO public.post_images (post_id, item_id, image_url, source_type, sort_order)
  SELECT
    v_post_id,
    NULLIF(elem->>'item_id', '')::uuid,
    elem->>'image_url',
    elem->>'source_type',
    (ord - 1)::smallint
  FROM jsonb_array_elements(p_attachments) WITH ORDINALITY AS t(elem, ord);

  RETURN v_post_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_text_post(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_text_post(text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_text_post(text, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
