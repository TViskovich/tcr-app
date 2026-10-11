BEGIN;

-- ============================================================================
-- Align rate_my_grail_cards on fresh databases with production.
--
-- In production 20260711194000_rate_my_grails.sql never created this table
-- (see 20260712140200_create_rate_my_grail_cards.sql), so the live table is
-- 20260712140200's: snapshot_image_url NULLable and UNIQUE (post_id, item_id).
-- On a fresh database (supabase start / db reset) 20260711194000 does create
-- it — snapshot_image_url NOT NULL, no unique constraint — and 20260712140200's
-- CREATE TABLE IF NOT EXISTS is then a no-op.
--
-- Idempotent: on production both statements are no-ops (the column is
-- already NULLable and the constraint already exists). No RLS, grant or
-- data changes.
-- ============================================================================

ALTER TABLE public.rate_my_grail_cards
  ALTER COLUMN snapshot_image_url DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.rate_my_grail_cards'::regclass
      AND conname = 'rate_my_grail_cards_post_id_item_id_key'
  ) THEN
    ALTER TABLE public.rate_my_grail_cards
      ADD CONSTRAINT rate_my_grail_cards_post_id_item_id_key UNIQUE (post_id, item_id);
  END IF;
END $$;

COMMIT;
