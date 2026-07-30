-- ============================================================================
-- CacheCase Registry — snapshot foundation (Phase S1: schema + backfill
-- only). Purely additive: nullable columns, no existing column/constraint/
-- RPC changes. register_card is updated separately in the Phase S2
-- migration to populate these going forward.
--
-- Product decisions (approved):
--   1. Snapshot fields are the canonical certificate identity — a linked
--      collection_item is an owner-specific organizational connection, not
--      the source of truth for what the registry displays.
--   2. Snapshot fields are set once, at registration, and are not directly
--      owner-editable. A future correction flow will use a separate
--      audited RPC/event — not built in this phase.
--   3. snapshot_set_name, snapshot_card_number, snapshot_variation stay
--      null for now — collection_items has no equivalent source fields.
-- ============================================================================

ALTER TABLE public.registered_cards
  ADD COLUMN IF NOT EXISTS snapshot_image_url  text,
  ADD COLUMN IF NOT EXISTS snapshot_title       text,
  ADD COLUMN IF NOT EXISTS snapshot_player      text,
  ADD COLUMN IF NOT EXISTS snapshot_year        integer,
  ADD COLUMN IF NOT EXISTS snapshot_brand       text,
  ADD COLUMN IF NOT EXISTS snapshot_set_name    text,
  ADD COLUMN IF NOT EXISTS snapshot_team        text,
  ADD COLUMN IF NOT EXISTS snapshot_card_number text,
  ADD COLUMN IF NOT EXISTS snapshot_variation   text;

-- Backfill — only for cards that currently still have a linked
-- collection_item. The WHERE ... IS NULL guard makes this idempotent
-- (safe to re-run, e.g. if this migration were retried after a partial
-- failure) and ensures it never overwrites a snapshot already populated by
-- register_card itself (once Phase S2 ships) or by a prior run of this
-- statement. Cards whose collection_item_id is already null (registered
-- without a link, or already unlinked via an ownership transfer) are left
-- with fully null snapshots — there is no source data to backfill from,
-- and none is fabricated.
UPDATE public.registered_cards rc
SET snapshot_image_url = ci.image_url,
    snapshot_title     = ci.title,
    snapshot_player    = ci.player,
    snapshot_year      = ci.year,
    snapshot_brand     = ci.brand,
    snapshot_team      = ci.team
FROM public.collection_items ci
WHERE rc.collection_item_id = ci.id
  AND rc.snapshot_title IS NULL
  AND rc.snapshot_player IS NULL;

NOTIFY pgrst, 'reload schema';
