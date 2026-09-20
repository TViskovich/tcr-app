-- Backs the profile-tab 9-slot "Grail" grid (components/profile-v2/
-- profile-v2-grid.tsx) — and, as of this migration, IS the canonical
-- Grails system for the whole app. Deliberately a NEW table rather than
-- altering public.profile_showcase_items in place:
--   1. profile_showcase_items has no CREATE TABLE anywhere in this repo
--      (schema.sql explicitly lists it as an undocumented live table) and
--      no real per-slot identity today (only display_order, i.e. array
--      position) — altering an unknown live shape in place is riskier
--      than creating a known-good new one and backfilling into it.
--   2. It's item-only; this feature needs polymorphic item-OR-collection
--      slots with a hard slot_index identity (0-8).
-- hooks/use-grails.ts is rewritten to read/write THIS table (filtered to
-- entry_type='item', translated back into its original ShowcaseItem
-- shape) so app/rate-my-grails/new.tsx, app/grails/[userId].tsx, and
-- app/item/[id].tsx's Add/Remove button all transparently move onto this
-- table with no code changes of their own. profile_showcase_items is left
-- in place (not dropped) but is no longer read or written by the app
-- after this migration.

CREATE TABLE IF NOT EXISTS public.profile_grail_slots (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  slot_index     smallint    NOT NULL CHECK (slot_index BETWEEN 0 AND 8),
  entry_type     text        NOT NULL CHECK (entry_type IN ('item', 'collection')),
  -- Deliberately ON DELETE CASCADE on both (not the SET NULL used by
  -- posts.item_id / rate_my_grail_cards.item_id / card_share_items.item_id,
  -- which are denormalized snapshots meant to survive their source's
  -- deletion). A grail slot row has no independent meaning once its
  -- source is gone — cascading the row itself away makes "deleted source"
  -- and "empty slot" the same state for free, reusing the already-built
  -- empty-slot render path. Closer to collection_item_images.item_id's
  -- CASCADE than to the SET NULL group.
  item_id        uuid        REFERENCES public.collection_items(id) ON DELETE CASCADE,
  collection_id  uuid        REFERENCES public.folders(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- One row per (owner, slot). Leading column user_id also serves as the
  -- whole-profile lookup index (same reasoning as grail_ratings' UNIQUE
  -- (post_id, rater_user_id) — see that migration's own comment) — no
  -- separate user_id index needed. Required for .upsert(...,
  -- { onConflict: 'user_id,slot_index' }) (Replace) to work. Also
  -- structurally caps every user at 9 rows with no separate trigger
  -- needed, unlike profile_showcase_items' undocumented cap trigger.
  UNIQUE (user_id, slot_index),
  -- First-of-its-kind shape in this schema: a CHECK enforcing "exactly one
  -- of two nullable FKs is set, matching a discriminator column." Every
  -- other polymorphic-ish reference in this schema is enforced via
  -- RLS/RPC EXISTS checks, not a table CHECK — introduced deliberately
  -- here because entry_type/item_id/collection_id integrity is a hard
  -- requirement, enforced atomically regardless of client code.
  CONSTRAINT profile_grail_slots_entry_shape CHECK (
    (entry_type = 'item' AND item_id IS NOT NULL AND collection_id IS NULL)
    OR
    (entry_type = 'collection' AND collection_id IS NOT NULL AND item_id IS NULL)
  )
);

-- The same item (or the same collection) can only occupy ONE slot per
-- user — without these, nothing stops a user from placing the same card
-- into all 9 slots. Partial (WHERE ... IS NOT NULL) since a row only ever
-- has one of the two columns set (enforced by the shape CHECK above), so a
-- plain UNIQUE(user_id, item_id) would otherwise treat every
-- entry_type='collection' row's NULL item_id as a conflict-free case
-- anyway (Postgres treats NULLs as distinct in unique indexes) — the
-- WHERE clause just makes that explicit rather than relying on NULL
-- semantics implicitly.
CREATE UNIQUE INDEX IF NOT EXISTS profile_grail_slots_unique_item
  ON public.profile_grail_slots (user_id, item_id)
  WHERE item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS profile_grail_slots_unique_collection
  ON public.profile_grail_slots (user_id, collection_id)
  WHERE collection_id IS NOT NULL;

-- BACKFILL — existing profile_showcase_items rows become slot_index 0..8
-- per user, deduplicated by (user_id, item_id) with a fully deterministic
-- winner (lowest display_order, then added_at, then id as a guaranteed-
-- unique final tie-breaker) so this can never trip the
-- profile_grail_slots_unique_item index created just above. Confirmed
-- live against public.profile_showcase_items before writing this: columns
-- id/user_id/item_id/display_order/added_at all exist as assumed
-- (display_order smallint NOT NULL default 0, added_at timestamptz NOT
-- NULL default now()), a live UNIQUE (user_id, item_id) constraint
-- (uq_showcase_user_item) already holds, and no duplicate (user_id,
-- item_id) rows currently exist — the DISTINCT ON below is kept anyway as
-- a defensive guarantee of this migration's own correctness, not as a fix
-- for a live data problem that was found.
--
-- Intended to run exactly once, as part of this migration. The
-- untargeted ON CONFLICT DO NOTHING (not ON CONFLICT (user_id,
-- slot_index)) makes this conflict-safe for a deployment retry by also
-- absorbing profile_grail_slots_unique_item / _unique_collection
-- violations, not just slot_index collisions, if the destination table
-- already ended up partially populated. It is NOT a general "safe to
-- re-run anytime" backfill: profile_showcase_items is left unchanged by
-- this migration, so re-running this INSERT later (e.g. months after
-- launch) could re-insert legacy items into slots a user has since
-- emptied on purpose, silently undoing their own removal. Does not
-- modify or delete anything in profile_showcase_items; that table is
-- simply not read or written by the app anymore after this migration.
INSERT INTO public.profile_grail_slots (user_id, slot_index, entry_type, item_id)
SELECT ranked.user_id, ranked.slot_index, 'item', ranked.item_id
FROM (
  SELECT
    deduped.user_id,
    deduped.item_id,
    (ROW_NUMBER() OVER (PARTITION BY deduped.user_id ORDER BY deduped.display_order, deduped.added_at, deduped.id) - 1) AS slot_index
  FROM (
    SELECT DISTINCT ON (psi.user_id, psi.item_id)
      psi.user_id, psi.item_id, psi.display_order, psi.added_at, psi.id
    FROM public.profile_showcase_items psi
    WHERE EXISTS (
      SELECT 1 FROM public.collection_items ci WHERE ci.id = psi.item_id AND ci.user_id = psi.user_id
    )
    ORDER BY psi.user_id, psi.item_id, psi.display_order, psi.added_at, psi.id
  ) deduped
) ranked
WHERE ranked.slot_index <= 8
ON CONFLICT DO NOTHING;

ALTER TABLE public.profile_grail_slots ENABLE ROW LEVEL SECURITY;

-- Matches every content table in this schema — privacy is enforced at the
-- app/query layer (see hooks/use-collection.ts's publicOnly), not via
-- RLS-level SELECT restriction.
DROP POLICY IF EXISTS "profile_grail_slots_select_public" ON public.profile_grail_slots;
CREATE POLICY "profile_grail_slots_select_public" ON public.profile_grail_slots
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "profile_grail_slots_insert_own" ON public.profile_grail_slots;
CREATE POLICY "profile_grail_slots_insert_own" ON public.profile_grail_slots
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND (
      (entry_type = 'item' AND EXISTS (
        SELECT 1 FROM public.collection_items ci WHERE ci.id = item_id AND ci.user_id = auth.uid()
      ))
      OR
      (entry_type = 'collection' AND EXISTS (
        SELECT 1 FROM public.folders f WHERE f.id = collection_id AND f.user_id = auth.uid()
      ))
    )
  );

-- Required for .upsert(..., { onConflict: 'user_id,slot_index' })'s
-- conflict-path (Replace) to work at all — USING gates which existing
-- rows the update may target, WITH CHECK re-validates ownership/shape
-- exactly as INSERT does. Mirrors grail_ratings_update_own's exact
-- USING+WITH CHECK pair.
DROP POLICY IF EXISTS "profile_grail_slots_update_own" ON public.profile_grail_slots;
CREATE POLICY "profile_grail_slots_update_own" ON public.profile_grail_slots
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND (
      (entry_type = 'item' AND EXISTS (
        SELECT 1 FROM public.collection_items ci WHERE ci.id = item_id AND ci.user_id = auth.uid()
      ))
      OR
      (entry_type = 'collection' AND EXISTS (
        SELECT 1 FROM public.folders f WHERE f.id = collection_id AND f.user_id = auth.uid()
      ))
    )
  );

DROP POLICY IF EXISTS "profile_grail_slots_delete_own" ON public.profile_grail_slots;
CREATE POLICY "profile_grail_slots_delete_own" ON public.profile_grail_slots
  FOR DELETE USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';
