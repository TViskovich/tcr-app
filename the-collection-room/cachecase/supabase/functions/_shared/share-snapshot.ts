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

// reason is diagnostic-only — never returned verbatim to an untrusted
// caller as a detailed error (every Edge Function that surfaces this to
// its own client still only ever sends the generic 'unavailable' status;
// see copy-post-photo-to-share-snapshots), logged server-side (Supabase
// Edge Function logs) so a real failure here is never a silent, unlabeled
// `{ok:false}` again — the exact gap that made this take a multi-round
// investigation to trace instead of a single log line.
export type CopyFailureReason =
  | 'invalid_source' // sourcePath couldn't be parsed/validated against item-images
  | 'unauthorized' // caller doesn't own the source item/object
  | 'download_failed' // the source object doesn't exist or Storage download errored
  | 'file_too_large' // over MAX_IMAGE_BYTES
  | 'unsupported_type' // content-type not in ALLOWED_IMAGE_MIME_TYPES
  | 'upload_failed'; // share-snapshots upload itself errored

export type CopyItemImageResult =
  | { ok: true; publicUrl: string; storagePath: string }
  | { ok: false; reason: CopyFailureReason };

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
    console.error('[downloadValidateUpload] download_failed:', sourcePath, downloadError?.message);
    return { ok: false, reason: 'download_failed' };
  }

  if (downloaded.size > MAX_IMAGE_BYTES) {
    console.error('[downloadValidateUpload] file_too_large:', sourcePath, downloaded.size);
    return { ok: false, reason: 'file_too_large' };
  }

  const contentType = downloaded.type;
  const extension = ALLOWED_IMAGE_MIME_TYPES[contentType];
  if (!extension) {
    console.error('[downloadValidateUpload] unsupported_type:', sourcePath, contentType);
    return { ok: false, reason: 'unsupported_type' };
  }

  const finalPath = `${destinationPath}.${extension}`;

  const { error: uploadError } = await client.storage
    .from('share-snapshots')
    .upload(finalPath, downloaded, { contentType, upsert });

  if (uploadError) {
    console.error('[downloadValidateUpload] upload_failed:', finalPath, uploadError.message);
    return { ok: false, reason: 'upload_failed' };
  }

  const { data: publicUrlData } = client.storage.from('share-snapshots').getPublicUrl(finalPath);

  return { ok: true, publicUrl: publicUrlData.publicUrl, storagePath: finalPath };
}

// Copies `itemId`'s current primary gallery image into the durable
// share-snapshots bucket, scoped under
// {callerId}/{snapshotType}/{targetId}/{itemId}-{uuid}.{ext}. `client`
// must be the service-role client (both callers already construct one via
// serviceRoleClient()) — this function performs its OWN authorization
// (below) rather than trusting callers to have verified it first, since
// one of its two callers (copy-share-snapshot-image, the single-item
// 'post' path) now legitimately passes a non-owned item.
//
// AUTHORIZATION (Post to Feed / foreign public items — see this
// function's own PR): the caller may always snapshot their OWN item,
// regardless of its own privacy flags (unchanged — matches
// create_card_share_post's original rule). For an item the caller does
// NOT own, snapshotType MUST be 'post' (the single-item path) or
// 'folder_share' (a repost of another collector's public folder — its
// per-item calls are scoped to that folder owner's public items in
// create-snapshot-post; card_share/rate_my_grails pre-validate ownership
// themselves there before ever calling this), and the item must be
// genuinely public: active, collection_items.is_public, and its
// whole folder chain effectively visible to an anonymous viewer. That
// last check re-derives items_select_public's own RLS rule (this function
// runs under the service-role client, which bypasses RLS entirely) via
// folder_effective_visibility_batch(folder_ids, caller) — the same
// explicit-caller RPC handleFolderShare below already uses for its own
// folder-level check, called here with caller: null (an anonymous-
// viewer's view), since "genuinely public" must not depend on any
// relationship between the caller and the item's actual owner.
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
  snapshotType: 'post' | 'card_share' | 'rate_my_grails' | 'folder_share',
  targetId: string,
): Promise<CopyItemImageResult> {
  const { data: item, error: itemError } = await client
    .from('collection_items')
    .select('id, user_id, image_url, is_public, collection_status, folder_id')
    .eq('id', itemId)
    .maybeSingle();

  // TEMPORARY DIAGNOSTIC LOGGING (foreign-item repost investigation) — every
  // branch below that can produce the client's generic 'unauthorized' (and
  // therefore copy-share-snapshot-image's own generic {status:'unavailable'})
  // now logs exactly which one fired, since neither the item query's own
  // `error` nor the visibility RPC's own `error` were being surfaced
  // anywhere before this — a real Postgres/RPC failure was silently
  // indistinguishable from a legitimate "not visible" result. Non-sensitive
  // only: ids, booleans, and error MESSAGES (never tokens/signed URLs). Safe
  // to remove once the live failure path is confirmed; left in for now
  // since it costs nothing at the volumes this function runs at.
  console.log('[copyItemImageIntoShareSnapshots] start', { itemId, callerId, snapshotType });

  if (itemError) {
    console.error('[copyItemImageIntoShareSnapshots] item query failed:', itemError.message, { itemId });
  }

  if (!item) {
    console.error('[copyItemImageIntoShareSnapshots] unauthorized: item not found', { itemId, hadQueryError: !!itemError });
    return { ok: false, reason: 'unauthorized' };
  }

  console.log('[copyItemImageIntoShareSnapshots] item found', {
    itemId,
    ownerId: item.user_id,
    isOwner: item.user_id === callerId,
    isPublic: item.is_public,
    collectionStatus: item.collection_status,
    folderId: item.folder_id,
  });

  if (item.user_id !== callerId) {
    if (snapshotType !== 'post' && snapshotType !== 'folder_share') {
      console.error('[copyItemImageIntoShareSnapshots] unauthorized: non-owner + non-post snapshotType', { itemId, snapshotType });
      return { ok: false, reason: 'unauthorized' };
    }
    if (item.collection_status !== 'active') {
      console.error('[copyItemImageIntoShareSnapshots] unauthorized: non-owner + item not active', { itemId, collectionStatus: item.collection_status });
      return { ok: false, reason: 'unauthorized' };
    }
    if (!item.is_public) {
      console.error('[copyItemImageIntoShareSnapshots] unauthorized: non-owner + item not public', { itemId });
      return { ok: false, reason: 'unauthorized' };
    }
    const { data: visibility, error: visibilityError } = await client.rpc('folder_effective_visibility_batch', {
      folder_ids: [item.folder_id],
      caller: null,
    });
    if (visibilityError) {
      console.error(
        '[copyItemImageIntoShareSnapshots] folder_effective_visibility_batch RPC failed:',
        visibilityError.message,
        { itemId, folderId: item.folder_id },
      );
    }
    const visibilityRow = (visibility as { folder_id: string; visible: boolean }[] | null)?.[0];
    const isVisible = visibilityRow?.visible === true;
    console.log('[copyItemImageIntoShareSnapshots] folder visibility result', {
      itemId,
      folderId: item.folder_id,
      visibilityRow,
      isVisible,
      hadRpcError: !!visibilityError,
    });
    if (!isVisible) {
      console.error('[copyItemImageIntoShareSnapshots] unauthorized: non-owner + folder not effectively visible', {
        itemId,
        folderId: item.folder_id,
      });
      return { ok: false, reason: 'unauthorized' };
    }
  }

  const { data: primaryImage, error: primaryImageError } = await client
    .from('collection_item_images')
    .select('storage_path, image_url')
    .eq('item_id', itemId)
    .eq('is_primary', true)
    .maybeSingle();

  if (primaryImageError) {
    console.error('[copyItemImageIntoShareSnapshots] primary image query failed:', primaryImageError.message, { itemId });
  }

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

  console.log('[copyItemImageIntoShareSnapshots] source path resolution', {
    itemId,
    hadPrimaryImageRow: !!primaryImage,
    primaryImageHadStoragePath: !!primaryImage?.storage_path,
    primaryImageHadImageUrl: !!primaryImage?.image_url,
    itemHadImageUrl: !!item.image_url,
    resolvedSourcePath: !!sourcePath,
  });

  if (!sourcePath) {
    console.error('[copyItemImageIntoShareSnapshots] invalid_source: no resolvable image path', { itemId });
    return { ok: false, reason: 'invalid_source' };
  }

  const destinationPath = `${callerId}/${snapshotType}/${targetId}/${itemId}-${crypto.randomUUID()}`;
  const result = await downloadValidateUpload(client, sourcePath, destinationPath);
  console.log('[copyItemImageIntoShareSnapshots] downloadValidateUpload result', {
    itemId,
    ok: result.ok,
    reason: result.ok ? null : result.reason,
  });
  return result;
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
    return { ok: false, reason: 'invalid_source' };
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
    return { ok: false, reason: 'invalid_source' };
  }
  if (sourcePath.split('/')[0] !== callerId) {
    return { ok: false, reason: 'unauthorized' };
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

// Copies a folder's explicit UPLOADED cover (folders.cover_storage_path, an
// item-images object) into share-snapshots for a folder_share post. Callers
// must already have verified the caller owns the folder and that the folder
// is effectively public; the path itself is re-validated against this
// project's own item-images bucket shape here, never trusted as given.
export async function copyFolderCoverIntoShareSnapshots(
  client: SupabaseClient,
  callerId: string,
  coverStoragePath: string,
  targetId: string,
): Promise<CopyItemImageResult> {
  const sourcePath = validateItemImagesStoragePath(coverStoragePath);
  if (!sourcePath) {
    return { ok: false, reason: 'invalid_source' };
  }
  const destinationPath = `${callerId}/folder_share/${targetId}/cover-${crypto.randomUUID()}`;
  return downloadValidateUpload(client, sourcePath, destinationPath);
}
