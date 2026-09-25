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
export function itemImageCacheKey(identity: string, imageId: string, tier: ImageTier = 'original'): string {
  return `${identity}:item-image:${imageId}${imageTierCacheSuffix(tier)}`;
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
//   - 'first_card': no client-visible signal exists at all. The resolved
//     image is "whichever active item is currently newest," which the
//     Edge Function can silently re-resolve to a DIFFERENT item (a new
//     item added) with zero change to the folders row — there is no field
//     here that would ever reflect that. Returns undefined for this case
//     ON PURPOSE: a stable-looking key built from nothing but folderId
//     would risk freezing stale cover bytes on screen even after the
//     resolved image has genuinely moved on, which is worse than today's
//     "always redownloads because the URL always rotates" behavior. The
//     caller omits `cacheKey` entirely when this returns undefined, so
//     expo-image falls back to its own default (keying on the signed URL
//     itself) — safe, just not byte-cache-stable across a URL rotation,
//     exactly like every private image before Phase 2. See the Phase 2
//     report for the full first_card discussion; closing this gap for
//     real would need a backend change (an Edge Function response field
//     identifying the resolved item), out of scope here.
export function folderCoverCacheKey(
  identity: string,
  folder: { id: string; cover_source: string; cover_storage_path: string | null; cover_item_id: string | null },
): string | undefined {
  if (folder.cover_source === 'upload' && folder.cover_storage_path) {
    return `${identity}:folder-cover:${folder.id}:upload:${folder.cover_storage_path}`;
  }
  if (folder.cover_source === 'item' && folder.cover_item_id) {
    return `${identity}:folder-cover:${folder.id}:item:${folder.cover_item_id}`;
  }
  return undefined;
}
