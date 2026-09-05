// Shared core for the three share-snapshots write paths (Phase 3E, item-
// images beta privacy hardening — final pre-cutover blockers):
// copy-share-snapshot-image (single-item, client-orchestrated),
// create-snapshot-post (multi-item, server-orchestrated for card_share /
// rate_my_grails), and backfill-share-snapshots (one-time historical
// migration, admin-only). Extracted so all three share the exact same
// download / validation / upload tail rather than duplicating it — what
// differs between them is only how the SOURCE path is resolved (an
// item's current primary image vs. a row's already-persisted historical
// URL) and what happens before/after the copy, not the copy mechanics
// themselves.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  parseItemImagesStoragePath,
  validateItemImagesStoragePath,
} from './registry-image.ts';

export type CopyItemImageResult =
  | { ok: true; publicUrl: string; storagePath: string }
  | { ok: false };

// Downloads `sourcePath` from item-images via the given (service-role)
// client, validates size/MIME, and uploads it to `destinationPath` in
// share-snapshots. `upsert` defaults to false (every forward-going caller
// uses a fresh crypto.randomUUID() destination, so a collision would
// indicate a real bug, not an expected retry) — the historical backfill
// passes upsert: true, since its destination paths are deterministic
// per-row by design, making a re-upload of the same source bytes to the
// same path an expected, safe rerun outcome rather than a collision.
async function downloadValidateUpload(
  client: SupabaseClient,
  sourcePath: string,
  destinationPath: string,
  upsert = false,
): Promise<CopyItemImageResult> {
  const { data: downloaded, error: downloadError } = await client.storage
    .from('item-images')
    .download(sourcePath);

  if (downloadError || !downloaded) {
    return { ok: false };
  }

  if (downloaded.size > MAX_IMAGE_BYTES) {
    return { ok: false };
  }

  const contentType = downloaded.type;
  const extension = ALLOWED_IMAGE_MIME_TYPES[contentType];
  if (!extension) {
    return { ok: false };
  }

  const finalPath = `${destinationPath}.${extension}`;

  const { error: uploadError } = await client.storage
    .from('share-snapshots')
    .upload(finalPath, downloaded, { contentType, upsert });

  if (uploadError) {
    return { ok: false };
  }

  const { data: publicUrlData } = client.storage.from('share-snapshots').getPublicUrl(finalPath);

  return { ok: true, publicUrl: publicUrlData.publicUrl, storagePath: finalPath };
}

// Copies `itemId`'s current primary gallery image into the durable
// share-snapshots bucket, scoped under
// {callerId}/{snapshotType}/{targetId}/{itemId}-{uuid}.{ext}. `client`
// must be the service-role client (both callers already construct one via
// serviceRoleClient()) — this function performs no authorization itself,
// callers are responsible for verifying collection_items.user_id ===
// callerId (and any other precondition) before calling this.
//
// Source resolution mirrors copy-registry-snapshot-image's exact
// preference order (never trusts a client-supplied path):
//   1. the item's primary collection_item_images row's storage_path,
//   2. that row's image_url, tightly parsed against this project's own
//      item-images bucket,
//   3. collection_items.image_url, same tight parse.
export async function copyItemImageIntoShareSnapshots(
  client: SupabaseClient,
  callerId: string,
  itemId: string,
  snapshotType: 'post' | 'card_share' | 'rate_my_grails',
  targetId: string,
): Promise<CopyItemImageResult> {
  const { data: item } = await client
    .from('collection_items')
    .select('id, user_id, image_url')
    .eq('id', itemId)
    .maybeSingle();

  if (!item || item.user_id !== callerId) {
    return { ok: false };
  }

  const { data: primaryImage } = await client
    .from('collection_item_images')
    .select('storage_path, image_url')
    .eq('item_id', itemId)
    .eq('is_primary', true)
    .maybeSingle();

  const projectUrl = Deno.env.get('SUPABASE_URL') ?? '';
  let sourcePath: string | null = null;

  if (primaryImage?.storage_path) {
    sourcePath = validateItemImagesStoragePath(primaryImage.storage_path as string);
  }
  if (!sourcePath && primaryImage?.image_url) {
    sourcePath = parseItemImagesStoragePath(primaryImage.image_url as string, projectUrl);
  }
  if (!sourcePath && item.image_url) {
    sourcePath = parseItemImagesStoragePath(item.image_url as string, projectUrl);
  }

  if (!sourcePath) {
    return { ok: false };
  }

  const destinationPath = `${callerId}/${snapshotType}/${targetId}/${itemId}-${crypto.randomUUID()}`;
  return downloadValidateUpload(client, sourcePath, destinationPath);
}

// Copies the EXACT historical object a snapshot row's already-persisted
// item-images URL points to (never the item's current primary image —
// the whole point of a historical backfill is preserving what a snapshot
// looked like at share time, not what the source item looks like now).
// Used only by backfill-share-snapshots, the one-time admin migration for
// the 43 pre-Phase-3E snapshot rows.
//
// destinationPath is deterministic per row (callers pass a stable id —
// e.g. the row's own primary key — not a random UUID), and this function
// always upserts: re-running the backfill for a row whose upload
// succeeded on a prior run but whose DB UPDATE didn't is expected to
// re-upload the same bytes to the same path, not fail as a collision.
export async function copyHistoricalUrlIntoShareSnapshots(
  client: SupabaseClient,
  historicalUrl: string,
  destinationPath: string,
): Promise<CopyItemImageResult> {
  const projectUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const sourcePath = parseItemImagesStoragePath(historicalUrl, projectUrl);
  if (!sourcePath) {
    return { ok: false };
  }
  return downloadValidateUpload(client, sourcePath, destinationPath, true);
}

// Copies a freshly-uploaded, caller-owned item-images object into
// share-snapshots for a standard text post's optional single attached
// photo (app/post/new.tsx / copy-post-photo-to-share-snapshots). Unlike
// copyItemImageIntoShareSnapshots above, there is no collection_items row
// backing this photo at all — authorization is instead purely "the source
// object's own path lives inside the caller's own item-images/{userId}/
// namespace," the same path-prefix-ownership convention lib/storage.ts's
// pathMatchesOwnedKind already applies client-side, mirrored here as the
// actual server-side authorization boundary (callers must not trust a
// client-supplied path directly — parseItemImagesStoragePath both extracts
// and validates it against this project's own item-images bucket first).
//
// destinationPath is share-snapshots/{callerId}/post-upload/{uuid} (the
// download/upload tail below appends the real .{ext}) — its own namespace,
// distinct from copyItemImageIntoShareSnapshots' {snapshotType}/{targetId}/
// {itemId}-{uuid} shape, since there is no snapshotType/targetId/itemId
// here.
//
// On a successful copy, the source item-images object is deleted
// (best-effort, never fails the copy itself) — it was uploaded solely as a
// staging step for this one copy and is never referenced by any row, so
// removing it can never orphan anything else. Same "never throws on
// cleanup" convention as lib/storage.ts's deleteProfileImage/
// deleteFolderCover.
export async function copyOwnedItemImageIntoShareSnapshots(
  client: SupabaseClient,
  callerId: string,
  sourceUrl: string,
): Promise<CopyItemImageResult> {
  const projectUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const sourcePath = parseItemImagesStoragePath(sourceUrl, projectUrl);
  if (!sourcePath) {
    return { ok: false };
  }
  if (sourcePath.split('/')[0] !== callerId) {
    return { ok: false };
  }

  const destinationPath = `${callerId}/post-upload/${crypto.randomUUID()}`;
  const result = await downloadValidateUpload(client, sourcePath, destinationPath);

  if (result.ok) {
    const { error: removeError } = await client.storage.from('item-images').remove([sourcePath]);
    if (removeError) {
      console.error('[copyOwnedItemImageIntoShareSnapshots] source cleanup failed:', removeError.message);
    }
  }

  return result;
}
