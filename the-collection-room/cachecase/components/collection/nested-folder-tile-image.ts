import type { SignedImageStatus } from '@/hooks/use-signed-item-images';
import { COMPACT_IMAGE_TIER, type ImageTier } from '@/lib/image-tiers';
import { folderCoverCacheKey, itemImageCacheKey } from '@/lib/private-image-cache-key';
import type { Folder } from '@/types';

// What a child folder's tile shows when it appears INSIDE a parent
// collection (folder-detail grid, Collection/Profile preview rows). The
// folder's own page keeps its cover/banner; only these nested tiles change.
//
// Priority:
//   1. its first visible card's primary image (Folder.first_item_image_id),
//      at the same COMPACT preview tier and cache key the card tiles beside
//      it use — so a card already seen elsewhere is a warm cache hit;
//   2. otherwise (empty folder, first card has no image, that image is
//      unavailable, or first_item_image_id wasn't loaded) its existing
//      signed cover, exactly as before;
//   3. otherwise null — the caller's existing placeholder.
//
// While the first card's URL is still resolving this returns null (the
// placeholder) rather than the cover, so a tile never flashes the banner and
// then swaps to the card.
//
// The caller passes in maps from its own existing batched hooks
// (useSignedItemImages at COMPACT_IMAGE_TIER, with these folders'
// first_item_image_ids added to that same batch, and useSignedFolderCovers
// at COMPACT_IMAGE_TIER too) — no separate signing path.
export function getNestedFolderTileImage(
  folder: Folder,
  identity: string,
  item: {
    urls: Map<string, string>;
    statuses: Map<string, SignedImageStatus>;
    servedTiers: Map<string, ImageTier>;
  },
  cover: {
    urls: Map<string, string>;
    servedTiers: Map<string, ImageTier>;
    tokens: Map<string, string>;
  },
): { uri: string; cacheKey: string | undefined } | null {
  const imageId = folder.first_item_image_id;
  if (imageId) {
    const uri = item.urls.get(imageId);
    if (uri) {
      return { uri, cacheKey: itemImageCacheKey(identity, imageId, COMPACT_IMAGE_TIER, item.servedTiers) };
    }
    if (item.statuses.get(imageId) !== 'unavailable') return null;
  }
  const coverUri = cover.urls.get(folder.id);
  return coverUri
    ? {
        uri: coverUri,
        cacheKey: folderCoverCacheKey(
          identity,
          folder,
          cover.servedTiers.get(folder.id) ?? COMPACT_IMAGE_TIER,
          cover.tokens.get(folder.id),
        ),
      }
    : null;
}
