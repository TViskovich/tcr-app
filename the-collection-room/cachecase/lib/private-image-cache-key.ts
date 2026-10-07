// Stable expo-image cacheKey builders for PRIVATE item-images bucket
// content (Phase 2 of the private-image caching upgrade — sits on top of
// Phase 1's persisted signed-URL layer, lib/persisted-signed-url-cache.ts).
// Decouples expo-image's own byte-cache identity from the signed URL
// itself, which rotates on every re-sign (Phase 1's near-expiry background
// refresh, or a plain cold re-fetch) even when the underlying image is
// completely unchanged — without a stable cacheKey, expo-image (which
// defaults to keying on the URI itself, per ImageSource.cacheKey's own
// doc comment) treats every rotation as a brand-new image and re-downloads
// it from scratch.
//
// `identity` is always the SAME value the two signed-image hooks
// (hooks/use-signed-item-images.ts, hooks/use-signed-folder-covers.ts) key
// their own caches by: session.user.id, or the literal string 'anon' with
// no session — never a separate identity concept. Callers get it from
// useAuth() exactly like those hooks do (`session?.user?.id ?? 'anon'`).
// Prefixing every key with identity mirrors those hooks' own cross-user
// isolation: two different callers (e.g. a Grail-showcase viewer vs. the
// owner) never collide on the same cache entry even for the same
// underlying image id.
//
// Feed/share-snapshot/public images are OUT OF SCOPE — they use permanent
// public URLs with no rotation problem to solve, so nothing there should
// ever call into this file.

import { imageTierCacheSuffix, type ImageTier } from '@/lib/image-tiers';

// Item images (collection_item_images) — the id itself is immutable per
// upload: lib/item-images.ts's addItemImages only ever INSERTs a new row
// with a freshly-generated storage path, and removeItemImage only ever
// DELETEs; there is no "update storage_path in place" code path anywhere
// in this codebase. A replaced/re-ordered/re-primaried image is therefore
// always a genuinely different id, so the id alone is already a complete,
// collision-free version signal — no updated_at/revision field needed.
//
// `tier` (default 'original') keeps the same image's tiers from colliding in
// expo-image's byte cache: a 500px preview and the full-resolution original
// are different bytes under the same image id, so they must never share a
// key. 'original' has no suffix — every pre-tier caller and every already-
// cached original keeps its exact existing key.
//
// `servedTiers` (optional) is the map useSignedItemImages returns for ids
// whose URL is a tier FALLBACK (requested tier wasn't served): when present
// for this image, its tier wins, so fallback original bytes are keyed as
// original and never land under the requested tier's key.
export function itemImageCacheKey(
  identity: string,
  imageId: string,
  tier: ImageTier = 'original',
  servedTiers?: Map<string, ImageTier>,
): string {
  return `${identity}:item-image:${imageId}${imageTierCacheSuffix(servedTiers?.get(imageId) ?? tier)}`;
}

// Folder covers — trickier, because the RESOLVED underlying image for a
// folder id is never exposed to the client at all (get-folder-cover-
// signed-url deliberately never returns storage_path or the resolved item
// id, for privacy — see that Edge Function's own module comment). What the
// client DOES already have, on the folder row itself, is enough to build a
// correct key for two of the three cover_source values:
//   - 'upload': cover_storage_path changes on every re-upload
//     (lib/storage.ts's uploadFolderCover always generates a fresh
//     ${userId}/covers/${Date.now()}.${ext} path) — immutable per upload,
//     same reasoning as item images above.
//   - 'item': cover_item_id changes the instant the owner repoints the
//     cover to a different existing item, even with no new upload.
//   - 'first_card' (and an 'upload'/'item' folder missing its backing
//     reference, which the Edge Function resolves the same way): nothing on
//     the folders row reflects WHICH item is currently resolved — it can
//     silently move to a different item with zero change to the row. So
//     this needs the Edge Function's image_token (useSignedFolderCovers'
//     tokens map): an opaque, keyed hash of the resolved image's identity,
//     identical across signed-URL rotations of the same image and different
//     the moment the resolved image changes (new first card, new primary
//     image). Without a token (an older Edge Function, or an entry cached
//     before it existed) this still returns undefined ON PURPOSE — a key
//     built from folderId alone could freeze stale bytes once the resolved
//     image moves on — and the caller omits `cacheKey`, so expo-image keys
//     on the signed URL itself (safe, just not stable across rotation).
//
// tier: the tier whose bytes the URL actually serves (the caller passes
// useSignedFolderCovers' servedTiers.get(id) ?? the tier it requested) —
// same suffix scheme as itemImageCacheKey, so preview/detail cover bytes
// never share a key with original-tier ones. 'original' (the default) adds
// no suffix, leaving every existing 'upload'/'item' key unchanged.
export function folderCoverCacheKey(
  identity: string,
  folder: { id: string; cover_source: string; cover_storage_path: string | null; cover_item_id: string | null },
  tier: ImageTier = 'original',
  token?: string,
): string | undefined {
  if (folder.cover_source === 'upload' && folder.cover_storage_path) {
    return `${identity}:folder-cover:${folder.id}:upload:${folder.cover_storage_path}${imageTierCacheSuffix(tier)}`;
  }
  if (folder.cover_source === 'item' && folder.cover_item_id) {
    return `${identity}:folder-cover:${folder.id}:item:${folder.cover_item_id}${imageTierCacheSuffix(tier)}`;
  }
  if (token) {
    return `${identity}:folder-cover:${folder.id}:first_card:${token}${imageTierCacheSuffix(tier)}`;
  }
  return undefined;
}
