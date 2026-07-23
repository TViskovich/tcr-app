-- Backs the "Share Card" feature (Create menu → pick 1-5 of your own cards
-- → post to the feed). A single selected card still uses the existing
-- post_type = 'item' insert path (app/item/new.tsx's own shape) — this
-- table/post_type only exists for the 2-5 card "carousel" case.
--
-- Structurally mirrors public.rate_my_grail_cards (see
-- supabase/migrations/20260712_create_rate_my_grail_cards.sql) —
-- deliberately a SEPARATE table/post_type rather than reusing that one:
-- Rate My Grails carries rating-specific UI/branding that doesn't apply to
-- a plain "sharing some of my cards" post.

CREATE TABLE IF NOT EXISTS public.card_share_items (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id             uuid        NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  item_id             uuid        REFERENCES public.collection_items(id) ON DELETE SET NULL,
  snapshot_image_url  text,
  snapshot_title      text,
  snapshot_subtitle   text,
  display_order       smallint    NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, item_id)
);

ALTER TABLE public.card_share_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "card_share_items_select_public" ON public.card_share_items;
CREATE POLICY "card_share_items_select_public" ON public.card_share_items FOR SELECT USING (true);

DROP POLICY IF EXISTS "card_share_items_insert_own" ON public.card_share_items;
CREATE POLICY "card_share_items_insert_own" ON public.card_share_items
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.user_id = auth.uid())
    AND (item_id IS NULL OR EXISTS (SELECT 1 FROM public.collection_items ci WHERE ci.id = item_id AND ci.user_id = auth.uid()))
  );

-- No update/delete policy — same as rate_my_grail_cards, relies on posts'
-- ON DELETE CASCADE.

-- Extend the post_type check constraint to allow the new value. Verified
-- against the only migration that has ever touched this constraint
-- (20260711193000_fix_posts_post_type_check.sql) before writing this —
-- preserves all three existing values, adds one.
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_post_type_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_post_type_check
  CHECK (post_type IN ('item', 'text', 'rate_my_grails', 'card_share'));

-- posts.image_url's original CREATE TABLE (schema.sql) declares it NOT
-- NULL, and no tracked migration has ever altered that — but two already-
-- shipped post types ('text', 'rate_my_grails') already insert into posts
-- with no image_url at all, which would be impossible if that constraint
-- were still enforced live. Strong evidence it was already dropped live,
-- undocumented (schema.sql itself admits several live columns/tables
-- predate it). This statement is idempotent either way: a no-op if
-- already nullable, the actual fix if it somehow isn't. card_share posts
-- also never set a top-level image_url (their images live in
-- card_share_items instead), so this needs to hold for them too.
ALTER TABLE public.posts ALTER COLUMN image_url DROP NOT NULL;

-- Atomic create for the 2-5 card path: a single plpgsql function body is
-- one implicit transaction, so the posts row and its card_share_items rows
-- either both exist or neither does — two sequential client-side inserts
-- couldn't guarantee that (a failed second insert would otherwise leave an
-- orphaned, cardless post). SECURITY INVOKER (default) so RLS still
-- applies to both inserts under the caller's own identity; every check
-- below produces a clear error instead of a silent partial failure or an
-- opaque constraint violation. Snapshot fields (image_url/title/brand) are
-- derived server-side from the live collection_items row at insert time
-- rather than trusted from client input.
CREATE OR REPLACE FUNCTION public.create_card_share_post(p_caption text, p_item_ids uuid[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post_id uuid;
  v_count int;
  v_distinct_count int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  v_count := COALESCE(array_length(p_item_ids, 1), 0);
  IF v_count < 2 OR v_count > 5 THEN
    RAISE EXCEPTION 'A card share post requires between 2 and 5 items';
  END IF;

  -- unnest(...) AS selected(item_id) throughout — an explicit column alias,
  -- not a bare row/table alias, so `selected.item_id` unambiguously refers
  -- to the uuid value rather than being readable as a whole-record alias.
  SELECT COUNT(DISTINCT selected.item_id)
  INTO v_distinct_count
  FROM unnest(p_item_ids) AS selected(item_id);
  IF v_distinct_count <> v_count THEN
    RAISE EXCEPTION 'Duplicate item in card share selection';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_item_ids) AS selected(item_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.collection_items ci
      WHERE ci.id = selected.item_id
        AND ci.user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to share one or more of these items';
  END IF;

  -- Defense in depth — the picker's client-side "has an image" filter is
  -- UX only, never a security/integrity boundary. Whitespace-only counts
  -- as missing.
  IF EXISTS (
    SELECT 1
    FROM unnest(p_item_ids) AS selected(item_id)
    JOIN public.collection_items ci
      ON ci.id = selected.item_id
    WHERE ci.image_url IS NULL
       OR btrim(ci.image_url) = ''
  ) THEN
    RAISE EXCEPTION 'Every shared item must have an image';
  END IF;

  INSERT INTO public.posts (user_id, post_type, caption)
  VALUES (auth.uid(), 'card_share', p_caption)
  RETURNING id INTO v_post_id;

  -- WITH ORDINALITY preserves p_item_ids' original order into
  -- display_order (1-indexed ord, stored 0-indexed) — this is what makes
  -- the carousel's slide order match the order the user selected cards in
  -- the picker.
  INSERT INTO public.card_share_items (post_id, item_id, snapshot_image_url, snapshot_title, snapshot_subtitle, display_order)
  SELECT v_post_id, ci.id, ci.image_url, ci.title, ci.brand, t.ord - 1
  FROM unnest(p_item_ids) WITH ORDINALITY AS t(id, ord)
  JOIN public.collection_items ci ON ci.id = t.id;

  RETURN v_post_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_card_share_post(text, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_card_share_post(text, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_card_share_post(text, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
