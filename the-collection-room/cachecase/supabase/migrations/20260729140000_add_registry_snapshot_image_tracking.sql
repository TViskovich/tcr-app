-- ============================================================================
-- CacheCase Registry — durable snapshot image foundation (Phase S3, part 1
-- of 2): tracking columns on registered_cards + private registry-images
-- bucket. Schema/backfill only — no Edge Function or RPC change here (see
-- the companion 20260729141000 migration for register_card).
--
-- No Storage policy is created for anon or authenticated on this bucket —
-- absence of a policy means denial, the same "RPC/service-only" convention
-- already used for registered_cards / registry_events / ownership_transfers.
-- All access goes through two Edge Functions (copy-registry-snapshot-image,
-- get-registry-snapshot-image-url), which use the service_role key
-- server-side only and are never given to the app/client.
-- ============================================================================

ALTER TABLE public.registered_cards
  ADD COLUMN IF NOT EXISTS snapshot_image_status text,
  ADD COLUMN IF NOT EXISTS snapshot_image_storage_path text,
  ADD COLUMN IF NOT EXISTS snapshot_image_error_code text,
  ADD COLUMN IF NOT EXISTS snapshot_image_updated_at timestamptz;

-- Bundled into one statement so a failure partway rolls back atomically.
ALTER TABLE public.registered_cards
  ADD CONSTRAINT registered_cards_snapshot_image_status_check
    CHECK (snapshot_image_status IS NULL OR snapshot_image_status IN (
      'pending', 'ready', 'failed', 'unavailable'
    )),
  ADD CONSTRAINT registered_cards_snapshot_image_error_code_check
    CHECK (snapshot_image_error_code IS NULL OR snapshot_image_error_code IN (
      'source_missing',
      'source_unauthorized',
      'invalid_type',
      'file_too_large',
      'download_failed',
      'upload_failed',
      'database_update_failed',
      'state_changed'
    ));

-- Backfill — derives an initial status for every existing row purely from
-- whether a provisional snapshot_image_url already exists (set by the
-- Phase S2 register_card / the S1 backfill). Never fabricates a source.
-- Idempotent: the IS NULL guard means a retry of this file, or a status
-- already set by a later register_card call or a copy attempt, is never
-- overwritten.
UPDATE public.registered_cards
SET snapshot_image_status = CASE WHEN snapshot_image_url IS NOT NULL THEN 'pending' ELSE 'unavailable' END
WHERE snapshot_image_status IS NULL;

-- Private bucket. public:false — unlike item-images/avatars, this bucket
-- has no public read at all. Every read goes through
-- get-registry-snapshot-image-url's short-lived signed URLs, gated by the
-- same visibility rule as registered_cards_select_visible.
INSERT INTO storage.buckets (id, name, public)
VALUES ('registry-images', 'registry-images', false)
ON CONFLICT (id) DO NOTHING;

-- Deliberately no CREATE POLICY statements for storage.objects here. Only
-- service_role (used exclusively inside the two Edge Functions) can read
-- or write objects in this bucket — service_role bypasses RLS entirely by
-- definition, so no policy is needed or created for it either.

NOTIFY pgrst, 'reload schema';
