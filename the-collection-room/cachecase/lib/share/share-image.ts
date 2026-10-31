import { Directory, File, Paths } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Platform } from 'react-native';

import { peekCachedSignedFolderCover, prefetchSignedFolderCover } from '@/hooks/use-signed-folder-covers';
import { peekCachedSignedItemImage, prefetchSignedItemImages } from '@/hooks/use-signed-item-images';
import { COMPACT_IMAGE_TIER, DETAIL_IMAGE_TIER, type ImageTier } from '@/lib/image-tiers';
import { supabase } from '@/lib/supabase';

// Image attachments for "Share Elsewhere" (lib/share/share-target.ts): turns
// an item image or a folder cover into a LOCAL JPEG file the native share
// sheet can attach. Every image goes through the app's existing authorized
// signing (useSignedItemImages / useSignedFolderCovers' shared caches and
// Edge Functions), so a share can only ever attach an image the sharer is
// allowed to see right now. The signed URL is used once, here, to download
// the bytes and is never returned, shared or logged — the share sheet only
// ever receives a file:// path in the app's own cache directory.
//
// Re-encoded to JPEG every time: Storage transforms may serve WebP, which
// not every recipient app handles, and re-encoding also caps the size. The
// 'detail' tier (~1400px wide) is already about right for messaging; the
// long-edge cap only matters for an 'original' fallback.

const SHARE_DIR = new Directory(Paths.cache, 'share-images');
const MAX_LONG_EDGE = 1600;
const JPEG_QUALITY = 0.85;
const DOWNLOAD_TIMEOUT_MS = 8_000;

// Files written for the previous share — removed when the next one starts
// (not right after the sheet closes: the destination app may still be
// reading the file when Share.share() resolves).
let previousShareFiles: string[] = [];

export function clearPreviousShareImages(): void {
  for (const uri of previousShareFiles) deleteQuietly(uri);
  previousShareFiles = [];
}

function deleteQuietly(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // cache directory — the OS reclaims it eventually anyway
  }
}

async function cacheIdentity(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? 'anon';
}

async function signedItemImageUrl(imageId: string, tier: ImageTier): Promise<string | null> {
  await prefetchSignedItemImages([imageId], tier);
  return peekCachedSignedItemImage(await cacheIdentity(), imageId, tier)?.url ?? null;
}

async function signedFolderCoverUrl(folderId: string, tier: ImageTier): Promise<string | null> {
  await prefetchSignedFolderCover(folderId, tier);
  return peekCachedSignedFolderCover(await cacheIdentity(), folderId, tier)?.url ?? null;
}

// Downloads one signed image into the share cache and re-encodes it as a
// JPEG no larger than maxLongEdge. Returns the JPEG's file:// URI, or null
// on any failure (a share then falls back to text only).
async function toLocalJpeg(signedUrl: string, maxLongEdge: number): Promise<string | null> {
  let downloaded: File | null = null;
  try {
    SHARE_DIR.create({ intermediates: true, idempotent: true });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      downloaded = await File.downloadFileAsync(
        signedUrl,
        new File(SHARE_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}.download`),
        { idempotent: true, signal: controller.signal },
      );
    } finally {
      clearTimeout(timeout);
    }

    const encoded = await manipulateAsync(downloaded.uri, [], { compress: JPEG_QUALITY, format: SaveFormat.JPEG });
    const longEdge = Math.max(encoded.width, encoded.height);
    if (longEdge <= maxLongEdge) return encoded.uri;

    const scale = maxLongEdge / longEdge;
    const resized = await manipulateAsync(
      encoded.uri,
      [{ resize: { width: Math.round(encoded.width * scale), height: Math.round(encoded.height * scale) } }],
      { compress: JPEG_QUALITY, format: SaveFormat.JPEG },
    );
    deleteQuietly(encoded.uri);
    return resized.uri;
  } catch (e) {
    if (__DEV__) console.warn('[share-image] could not prepare image:', e instanceof Error ? e.message : 'unknown');
    return null;
  } finally {
    if (downloaded) deleteQuietly(downloaded.uri);
  }
}

// Registers a prepared file for cleanup at the next share.
function track(uri: string | null): string | null {
  if (uri) previousShareFiles.push(uri);
  return uri;
}

// Only iOS's share sheet can attach a file alongside text (React Native's
// Android Share ignores `url`), so nothing is downloaded elsewhere.
const canAttachImages = Platform.OS === 'ios';

// An item's primary image (pass the collection_item_images.id the screen is
// already showing first), at the 'detail' tier.
export async function prepareItemShareImage(imageId: string | null | undefined): Promise<string | null> {
  if (!canAttachImages || !imageId) return null;
  const url = await signedItemImageUrl(imageId, DETAIL_IMAGE_TIER);
  return url ? track(await toLocalJpeg(url, MAX_LONG_EDGE)) : null;
}

// A folder's cover as the server resolves it (its chosen cover, else its
// first card — the same image the folder header shows), falling back to a
// representative item image the screen already has (e.g. the first card's
// primary image) when the folder has no resolvable cover.
export async function prepareFolderShareImage(
  folderId: string,
  fallbackImageId: string | null | undefined,
): Promise<string | null> {
  if (!canAttachImages) return null;
  const coverUrl = await signedFolderCoverUrl(folderId, DETAIL_IMAGE_TIER);
  if (coverUrl) {
    const cover = await toLocalJpeg(coverUrl, MAX_LONG_EDGE);
    if (cover) return track(cover);
  }
  return prepareItemShareImage(fallbackImageId);
}

// Grails tiles: each tile's image at the small 'preview' tier (~500px wide —
// the grid's own tier, so it is usually already signed), as local JPEGs for
// the Grails share renderer. One entry per input id, null where an image
// isn't available; all tiles are prepared concurrently.
export async function prepareGrailsTileImages(imageIds: (string | null)[]): Promise<(string | null)[]> {
  if (!canAttachImages) return imageIds.map(() => null);
  const ids = imageIds.filter((id): id is string => !!id);
  if (ids.length) await prefetchSignedItemImages(ids, COMPACT_IMAGE_TIER);
  const identity = await cacheIdentity();
  return Promise.all(
    imageIds.map(async (id) => {
      if (!id) return null;
      const url = peekCachedSignedItemImage(identity, id, COMPACT_IMAGE_TIER)?.url;
      return url ? track(await toLocalJpeg(url, 700)) : null;
    }),
  );
}

// Saves a rendered PNG (base64, e.g. react-native-svg's toDataURL output) as
// a share-ready JPEG in the share cache. Null on failure.
export async function shareJpegFromPngBase64(base64: string): Promise<string | null> {
  const png = new File(SHARE_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    SHARE_DIR.create({ intermediates: true, idempotent: true });
    png.write(base64.replace(/\s/g, ''), { encoding: 'base64' });
    const encoded = await manipulateAsync(png.uri, [], { compress: 0.9, format: SaveFormat.JPEG });
    return track(encoded.uri);
  } catch (e) {
    if (__DEV__) console.warn('[share-image] could not save rendered image:', e instanceof Error ? e.message : 'unknown');
    return null;
  } finally {
    deleteQuietly(png.uri);
  }
}

export { canAttachImages };
