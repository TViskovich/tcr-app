-- Phase 3E (item-images beta privacy hardening — final pre-cutover
-- blockers): a dedicated, durable, always-public bucket for feed/share
-- snapshot images — posts.image_url ('item' posts), card_share_items.
-- snapshot_image_url, and rate_my_grail_cards.snapshot_image_url.
--
-- Why a new bucket rather than reusing item-images: those three columns
-- are meant to be independent durable snapshots ("what this card looked
-- like when it was shared"), not live references to the source item's
-- current, possibly-private, possibly-since-changed image. Today they
-- store a COPIED URL STRING pointing directly at the live item-images
-- object (confirmed via audit — create_card_share_post's own
-- `SELECT ..., ci.image_url, ...` and equivalent client-side copies), so
-- they break the moment item-images goes private, and were never actually
-- durable even before that (a source image edit or item deletion already
-- silently breaks a "snapshot" that's really just a live pointer).
--
-- Mirrors the existing registry-images bucket's own creation pattern
-- exactly (see supabase/migrations/20260729140000_add_registry_snapshot_image_tracking.sql)
-- — a bucket can be created directly via SQL, no dashboard step required.
-- Unlike registry-images, this bucket is PUBLIC: share/feed snapshots are
-- meant to be publicly viewable by design (posts/card_share_items/
-- rate_my_grail_cards all already carry "select using (true)" policies),
-- so there is no signed-delivery Edge Function for reads here — only for
-- the copy (write) path, which must never accept an arbitrary client-
-- supplied storage path or bytes (see copy-share-snapshot-image).
INSERT INTO storage.buckets (id, name, public)
VALUES ('share-snapshots', 'share-snapshots', true)
ON CONFLICT (id) DO NOTHING;

-- Public bucket reads bypass storage.objects SELECT policies entirely for
-- the /object/public/... URL path (same mechanism item-images/avatars
-- already rely on) — this policy exists only for parity/consistency with
-- those two buckets' own conventions for direct authenticated Storage API
-- reads, not because it's required for the public URLs themselves to
-- work.
DROP POLICY IF EXISTS "share_snapshots_select_public" ON storage.objects;
CREATE POLICY "share_snapshots_select_public"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'share-snapshots');

-- Deliberately NO INSERT/UPDATE/DELETE policies — same "absence of a
-- policy means denial" convention already used for registry-images.
-- Writes only ever happen via copy-share-snapshot-image's service-role
-- client, which bypasses RLS entirely; no client (authenticated or
-- anonymous) may write into this bucket directly, so arbitrary clients
-- can never choose their own storage path or upload an untrusted
-- "snapshot" identity.

NOTIFY pgrst, 'reload schema';
