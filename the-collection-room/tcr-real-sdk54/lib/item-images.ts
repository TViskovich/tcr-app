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

// Uploads each picked photo, then inserts one gallery row per successful
// upload in a single batch insert. A failed upload is skipped rather than
// aborting the whole call, so a partial failure still leaves the
// successful uploads in place — `failed` tells the caller how many to
// report as failed. The very first image ever added to an item (starting
// gallery count of 0) is automatically marked primary and synced onto
// collection_items.image_url.
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

  const { data, error } = await supabase.from('collection_item_images').insert(rows).select();
  if (error) throw new Error(error.message);

  if (startCount === 0 && data?.[0]) {
    const { error: syncError } = await supabase
      .from('collection_items')
      .update({ image_url: data[0].image_url })
      .eq('id', itemId);
    if (syncError) throw new Error(syncError.message);
  }

  return { added: (data ?? []) as CollectionItemImage[], failed };
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
    await supabase.storage.from('item-images').remove([storagePath as string]);
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
