import { File } from 'expo-file-system';

import { supabase } from './supabase';
import type { CollectionItemImage } from '@/types';

export const MAX_ITEM_IMAGES = 10;
export const SUPPORTED_ITEM_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function extFromUri(uri: string): string {
  return uri.split('.').pop()?.toLowerCase() ?? 'jpg';
}

function mimeFromExt(ext: string): string {
  return MIME[ext] ?? 'image/jpeg';
}

// Legacy/gallery uploads are both public URLs of the form
// .../object/public/<bucket>/<path> — recovers <path> when the URL matches
// that shape, so a row can still be deleted cleanly from Storage later.
// Returns null (never guesses) for anything that doesn't match.
export function deriveStoragePathFromPublicUrl(
  url: string | null | undefined,
  bucket: string,
): string | null {
  if (!url) return null;
  const marker = `/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  try {
    return decodeURIComponent(url.slice(idx + marker.length));
  } catch {
    return null;
  }
}

// Attaches each item's primary_image_id (the collection_item_images.id the
// signed-delivery Edge Function requires — see hooks/use-signed-item-images.ts)
// via ONE batched query, never one per item. Items with no primary gallery
// row yet (a legacy gap Phase 1A's backfill closes for anything with a real
// image_url) get primary_image_id: null, not omitted.
//
// previousIds (optional) is a fallback ONLY for the query-failure branch
// below — a caller that re-runs this on every refocus/refresh (e.g.
// hooks/use-collection.ts's useItems) can pass a map of each item's last
// known-good primary_image_id, keyed by item id. This fixes a real folder-
// detail regression: a transient failure of this one, un-retried query used
// to null out EVERY item's primary_image_id on the very next refetch, which
// blanked already-loaded grid tiles even though nothing about the actual
// image or its cached signed URL had changed (the tile's own render
// condition just stopped being true — see app/collection/[folderId].tsx's
// grid tile). A query FAILURE is not an authoritative "no primary image"
// answer, so it must never overwrite a previously-known value; a query
// SUCCESS with zero matching rows still correctly writes null below (a
// genuine deletion must still clear the tile).
export async function attachPrimaryImageIds<T extends { id: string }>(
  items: T[],
  previousIds?: Map<string, string | null>,
): Promise<(T & { primary_image_id: string | null })[]> {
  if (!items.length) return [];
  const { data, error } = await supabase
    .from('collection_item_images')
    .select('id, item_id')
    .eq('is_primary', true)
    .in('item_id', items.map((i) => i.id));

  if (error) {
    // Never block rendering of the items themselves over this — every item
    // falls back to whatever was already known for it (if anything), same
    // as "no primary row yet" for one truly seen for the first time. A
    // later refetch (e.g. pull-to-refresh, or the next focus) tries again.
    if (__DEV__) console.error('[attachPrimaryImageIds] query failed:', error.message, error);
    return items.map((i) => ({ ...i, primary_image_id: previousIds?.get(i.id) ?? null }));
  }

  const byItemId = new Map((data ?? []).map((r) => [r.item_id as string, r.id as string]));
  return items.map((i) => ({ ...i, primary_image_id: byItemId.get(i.id) ?? null }));
}

export async function getItemImages(itemId: string): Promise<CollectionItemImage[]> {
  const { data, error } = await supabase
    .from('collection_item_images')
    .select('*')
    .eq('item_id', itemId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as CollectionItemImage[];
}

async function uploadItemGalleryImage(
  uri: string,
  userId: string,
  itemId: string,
): Promise<{ url: string; path: string }> {
  const ext = extFromUri(uri);
  const contentType = mimeFromExt(ext);
  if (!(SUPPORTED_ITEM_IMAGE_TYPES as readonly string[]).includes(contentType)) {
    throw new Error(`Unsupported image type: ${contentType}`);
  }

  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const path = `${userId}/${itemId}/${fileName}`;

  // expo-file-system v19 File class reads the local file:// URI correctly —
  // same approach as lib/storage.ts's uploadItemImage.
  const buffer = await new File(uri).arrayBuffer();

  const { error } = await supabase.storage.from('item-images').upload(path, buffer, { contentType });
  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from('item-images').getPublicUrl(path);
  return { url: data.publicUrl, path };
}

export type AddItemImagesResult = {
  added: CollectionItemImage[];
  failed: number;
};

// Best-effort Storage cleanup for item-images objects uploaded by
// addItemImages but proven to have no corresponding collection_item_images
// row — either because the batch INSERT was definitively rejected, or
// because post-ambiguity reconciliation (see addItemImages below) confirmed
// a given path's row never committed. Never throws — a cleanup failure here
// must never replace or mask the original insert failure the caller is
// already being told about. Same never-throws, __DEV__-only-logging
// convention as removeItemImage's own Storage cleanup above; kept as its
// own small helper (not merged into that one) to keep this slice scoped to
// addItemImages only.
export async function cleanupOrphanedItemImages(paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    const { error } = await supabase.storage.from('item-images').remove(paths);
    if (error && __DEV__) {
      console.warn(
        `[addItemImages] failed to clean up ${paths.length} orphaned storage object(s):`,
        paths,
        error.message,
      );
    }
  } catch (e) {
    if (__DEV__) {
      console.warn(
        `[addItemImages] unexpected error cleaning up ${paths.length} orphaned storage object(s):`,
        paths,
        e,
      );
    }
  }
}

// Best-effort parent-sync for the first-ever gallery image added to an
// item. By the time this is called, the collection_item_images INSERT has
// already been authoritatively established as successful (see addItemImages
// below) — so a failure here must never retroactively turn that success
// into a reported "Upload failed." Uses the existing set_primary_item_image
// RPC (already proven, via the Slice 2 design audit, to leave sort_order/
// is_primary unchanged for an already-correct first-ever batch — its only
// real effect here is the collection_items.image_url sync) rather than a
// raw UPDATE, because the RPC's own RAISE EXCEPTION preconditions eliminate
// the raw UPDATE's silent-zero-row-success risk, and its single-transaction
// body means "committed" always implies is_primary and image_url are
// synchronized together — never throws; always resolves.
async function syncPrimaryItemImage(itemId: string, row: CollectionItemImage): Promise<void> {
  try {
    const { error, status } = await supabase.rpc('set_primary_item_image', {
      p_item_id: itemId,
      p_image_id: row.id,
    });
    if (!error) return;

    if (status >= 400) {
      // Definitive rejection — already authoritative, nothing to reconcile.
      // Retrying the identical call would almost certainly fail identically
      // (the RPC's own preconditions are what rejected it), so this is
      // logged, not retried.
      if (__DEV__) {
        console.warn(
          `[addItemImages] set_primary_item_image rejected for item ${itemId}, image ${row.id}:`,
          error.message,
        );
      }
      return;
    }

    // Ambiguous outcome (status 0 / non-authoritative) — the RPC may have
    // actually committed before the response was lost. Reconcile against
    // an authoritative re-read before ever retrying.
    const { data: reread, error: rereadError } = await supabase
      .from('collection_items')
      .select('image_url')
      .eq('id', itemId)
      .maybeSingle();

    if (rereadError) {
      // Commit status remains genuinely unknown — do not blindly retry.
      if (__DEV__) {
        console.warn(
          `[addItemImages] could not confirm parent image_url sync for item ${itemId}, image ${row.id} after an ambiguous set_primary_item_image response:`,
          rereadError.message,
        );
      }
      return;
    }

    if (reread?.image_url === row.image_url) {
      // Response was merely lost — the RPC actually committed.
      return;
    }

    // Confirmed not yet synced — safe to retry exactly once (the RPC is
    // idempotent: re-clearing/re-setting is_primary and recomputing
    // sort_order from current state is a pure function of that state).
    const { error: retryError } = await supabase.rpc('set_primary_item_image', {
      p_item_id: itemId,
      p_image_id: row.id,
    });
    if (retryError && __DEV__) {
      console.warn(
        `[addItemImages] parent image_url sync unresolved for item ${itemId}, image ${row.id} after one retry:`,
        retryError.message,
      );
    }
  } catch (e) {
    if (__DEV__) {
      console.warn(
        `[addItemImages] unexpected error syncing parent image_url for item ${itemId}, image ${row.id}:`,
        e,
      );
    }
  }
}

// Uploads each picked photo, then inserts one gallery row per successful
// upload in a single batch insert. A failed upload is skipped rather than
// aborting the whole call, so a partial failure still leaves the
// successful uploads in place — `failed` tells the caller how many to
// report as failed. The very first image ever added to an item (starting
// gallery count of 0) is automatically marked primary and synced onto
// collection_items.image_url.
//
// The batch INSERT's outcome is handled in three ways, distinguished by the
// resolved response's own `status` (this codebase never calls
// .throwOnError(), so postgrest-js resolves every outcome — including a lost
// network response — as {data, error, status} rather than throwing; see
// hooks/use-profile.ts's own comment for the same finding):
//
//   - success (no error): unchanged from before.
//   - a real, definitive non-2xx `status` from PostgREST: the whole batch
//     INSERT is one transaction, so a genuine rejection proves every row in
//     `rows` was rolled back — every uploaded object in this batch is safe
//     to clean up unconditionally before rethrowing.
//   - `status === 0` (or any other non-authoritative outcome, e.g. a 2xx
//     whose body failed to parse): postgrest-js's own sentinel for "no HTTP
//     response was ever received" — the request may have reached Postgres
//     and committed before the response was lost, so this can NOT be
//     treated as proof of rejection. Reconciled against an authoritative
//     re-read (collection_item_images_select_public is USING (true), so
//     this SELECT is authoritative regardless of RLS) before anything is
//     ever deleted: confirmed-present paths are kept untouched, only
//     confirmed-absent paths are cleaned up, and if the reconciliation read
//     itself fails, nothing is deleted at all — unknown DB state never
//     triggers a delete. The reconciliation read is ordered by sort_order
//     ascending — the same order getItemImages/the normal insert response
//     both produce — so insertedRows[0] below is still the intended
//     first/primary row on this path, not an arbitrary one.
export async function addItemImages(
  itemId: string,
  userId: string,
  uris: string[],
): Promise<AddItemImagesResult> {
  if (!uris.length) return { added: [], failed: 0 };

  const { count, error: countError } = await supabase
    .from('collection_item_images')
    .select('id', { count: 'exact', head: true })
    .eq('item_id', itemId);
  if (countError) throw new Error(countError.message);
  const startCount = count ?? 0;

  const uploads = await Promise.all(
    uris.map(async (uri) => {
      try {
        return await uploadItemGalleryImage(uri, userId, itemId);
      } catch {
        return null;
      }
    }),
  );

  const successes = uploads.filter((u): u is { url: string; path: string } => u !== null);
  const failed = uploads.length - successes.length;
  if (!successes.length) return { added: [], failed };

  const rows = successes.map((u, i) => ({
    item_id: itemId,
    user_id: userId,
    image_url: u.url,
    storage_path: u.path,
    sort_order: startCount + i,
    is_primary: startCount === 0 && i === 0,
  }));

  const { data, error, status } = await supabase.from('collection_item_images').insert(rows).select();

  let insertedRows: CollectionItemImage[];
  let extraFailed = 0;

  if (error) {
    if (status >= 400) {
      // Definitive rejection — none of `rows` committed. Original failure
      // is preserved regardless of whether cleanup itself succeeds.
      await cleanupOrphanedItemImages(successes.map((s) => s.path));
      throw new Error(error.message);
    }

    // Ambiguous outcome — reconcile before touching any Storage object.
    // Ordered by sort_order ascending so insertedRows[0] below is still
    // the intended first/primary row, matching the normal-success shape.
    const paths = successes.map((s) => s.path);
    let reconciled: CollectionItemImage[];
    try {
      const { data: existing, error: reconcileError } = await supabase
        .from('collection_item_images')
        .select('*')
        .eq('item_id', itemId)
        .in('storage_path', paths)
        .order('sort_order', { ascending: true });
      if (reconcileError) throw new Error(reconcileError.message);
      reconciled = (existing ?? []) as CollectionItemImage[];
    } catch (reconcileErr) {
      // Reconciliation itself failed — commit status remains genuinely
      // unknown for every path in this batch. Never delete under
      // uncertainty; the original insert failure is still what's surfaced,
      // never replaced by the reconciliation failure.
      if (__DEV__) {
        console.warn(
          '[addItemImages] reconciliation read failed after an ambiguous insert outcome; leaving all uploaded objects untouched:',
          reconcileErr,
        );
      }
      throw new Error(error.message);
    }

    const confirmedPaths = new Set(reconciled.map((r) => r.storage_path));
    const missingPaths = successes.filter((s) => !confirmedPaths.has(s.path)).map((s) => s.path);
    if (missingPaths.length) {
      await cleanupOrphanedItemImages(missingPaths);
    }

    if (!reconciled.length) {
      // Reconciliation proves nothing from this batch committed.
      throw new Error(error.message);
    }

    // Some/all rows actually committed despite the ambiguous response — the
    // reconciled rows are the authoritative inserted rows; anything
    // confirmed-absent counts as an additional failure.
    insertedRows = reconciled;
    extraFailed = missingPaths.length;
  } else {
    insertedRows = (data ?? []) as CollectionItemImage[];
  }

  if (startCount === 0 && insertedRows[0]) {
    await syncPrimaryItemImage(itemId, insertedRows[0]);
  }

  return { added: insertedRows, failed: failed + extraFailed };
}

// Deletes the gallery row (via the remove_item_image RPC, which also
// promotes a new primary and syncs collection_items.image_url atomically —
// see the migration), then deletes the underlying Storage object so
// nothing is left orphaned. Storage cleanup runs after the DB row is
// already gone; if it fails, the row is still correctly gone and the
// object is merely an orphaned file rather than a dangling reference.
export async function removeItemImage(imageId: string): Promise<void> {
  const { data: storagePath, error } = await supabase.rpc('remove_item_image', {
    p_image_id: imageId,
  });
  if (error) throw new Error(error.message);
  if (storagePath) {
    // Best-effort only — the RPC above already committed the authoritative
    // DB deletion, so a failure removing the underlying object (resolved
    // {error} or a thrown exception) must never surface to the caller as a
    // failed removeItemImage(); it's an orphaned Storage object, not a
    // failed delete. Same never-throws convention as lib/storage.ts's
    // deleteProfileImage.
    try {
      const { error: storageError } = await supabase.storage
        .from('item-images')
        .remove([storagePath as string]);
      if (storageError && __DEV__) {
        console.warn(
          `[removeItemImage] failed to remove storage object ${storagePath}:`,
          storageError.message,
        );
      }
    } catch (e) {
      if (__DEV__) {
        console.warn(`[removeItemImage] unexpected error removing storage object ${storagePath}:`, e);
      }
    }
  }
}

export async function setPrimaryItemImage(itemId: string, imageId: string): Promise<void> {
  const { error } = await supabase.rpc('set_primary_item_image', {
    p_item_id: itemId,
    p_image_id: imageId,
  });
  if (error) throw new Error(error.message);
}

export async function reorderItemImages(itemId: string, orderedIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('reorder_item_images', {
    p_item_id: itemId,
    p_ordered_ids: orderedIds,
  });
  if (error) throw new Error(error.message);
}

// Inserts a gallery row for an item that predates this feature and still
// only has collection_items.image_url — self-healing so edit mode's
// gallery manager always has a real row to operate on (add a second photo,
// remove, reorder) instead of a display-only synthesized entry. The
// migration's backfill already does this in bulk at deploy time; this
// covers the rare gap (e.g. an item created between deploy and migration).
export async function materializeLegacyItemImage(
  itemId: string,
  userId: string,
  imageUrl: string,
): Promise<CollectionItemImage> {
  const { data, error } = await supabase
    .from('collection_item_images')
    .insert({
      item_id: itemId,
      user_id: userId,
      image_url: imageUrl,
      storage_path: deriveStoragePathFromPublicUrl(imageUrl, 'item-images'),
      sort_order: 0,
      is_primary: true,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as CollectionItemImage;
}
