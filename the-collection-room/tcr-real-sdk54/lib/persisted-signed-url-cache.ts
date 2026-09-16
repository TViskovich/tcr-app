import AsyncStorage from '@react-native-async-storage/async-storage';

// Small, shared AsyncStorage plumbing for hooks/use-signed-item-images.ts
// and hooks/use-signed-folder-covers.ts's own persisted signed-URL cache
// (Phase 1 of the private-image caching upgrade). Deliberately just the
// storage plumbing — each hook keeps its own in-memory cache, in-flight
// dedupe, and retry/backoff logic (see use-signed-folder-covers.ts's own
// module comment for why those two stay duplicated rather than merged: the
// item-images hook's batch-fetch/retry logic is already runtime-validated,
// and folding an unvalidated caller into it isn't a size reduction worth
// that risk). Sharing only this file's genuinely-new, low-risk piece keeps
// that existing boundary intact.
//
// One JSON blob per (domain, identity) pair — never one AsyncStorage key
// per image id — since a single domain's entries for one identity are
// always small (batches are capped at 50) and are always read/written
// together.

export type PersistedSignedUrlEntry = {
  // null means a real, server-considered "unavailable" answer (not found,
  // or not authorized) — a genuine decision worth remembering across an app
  // kill, same as a resolved URL. A transient request-level failure is
  // NEVER represented here at all; callers must not persist those (see
  // FAILURE_TTL_MS in either hook) — an entry only exists in this store
  // once it has a real expiresAt.
  url: string | null;
  // Epoch ms — the same clock/shape as each hook's own in-memory
  // CacheEntry.expiresAt, so a value read back from here can be dropped
  // straight into the in-memory cache with no conversion.
  expiresAt: number;
};

type PersistedMap = Record<string, PersistedSignedUrlEntry>;

// The two domains currently backed by this cache — exported (rather than
// left as private string literals inside each hook) specifically so
// lib/auth.tsx can purge both on logout/account switch WITHOUT importing
// hooks/use-signed-item-images.ts or hooks/use-signed-folder-covers.ts
// directly: both of those hooks already import useAuth from lib/auth.tsx,
// so a reverse import (lib/auth.tsx pulling anything from either hook file)
// would create a circular module dependency. This file has no dependency
// on lib/auth.tsx at all, making it the one safe place both sides can
// import from. Each hook still owns its own CACHE_DOMAIN usage internally
// (reading these same constants) — nothing else outside this cache/auth
// pairing needs to know these strings exist.
export const ITEM_IMAGES_CACHE_DOMAIN = 'item-images';
export const FOLDER_COVERS_CACHE_DOMAIN = 'folder-covers';

const STORAGE_KEY_PREFIX = 'cachecase:signed-url-cache:v1';

function storageKey(domain: string, identity: string): string {
  return `${STORAGE_KEY_PREFIX}:${domain}:${identity}`;
}

function isValidEntry(value: unknown): value is PersistedSignedUrlEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as { url?: unknown; expiresAt?: unknown };
  return (v.url === null || typeof v.url === 'string') && typeof v.expiresAt === 'number';
}

// Best-effort — a read failure (corrupt JSON, storage unavailable) simply
// yields an empty map, which falls through to the caller's own normal
// missing/fetch path exactly as if nothing had ever been persisted. Never
// throws, never blocks rendering.
export async function readPersistedSignedUrlMap(domain: string, identity: string): Promise<PersistedMap> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(domain, identity));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: PersistedMap = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidEntry(entry)) out[id] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

// Read-modify-write merge of `patch` into the existing persisted map for
// this (domain, identity) — never a blind overwrite, so a merge for one
// batch's ids never clobbers other ids already persisted from an earlier
// batch. Fire-and-forget from the caller's perspective (best-effort,
// exactly like every other Storage/DB side effect in this codebase that
// must never block the in-memory cache it mirrors) — a write failure here
// only means the NEXT cold launch re-fetches over the network, never a
// correctness issue.
export async function mergePersistedSignedUrlEntries(
  domain: string,
  identity: string,
  patch: PersistedMap,
): Promise<void> {
  if (!Object.keys(patch).length) return;
  try {
    const key = storageKey(domain, identity);
    const existing = await readPersistedSignedUrlMap(domain, identity);
    await AsyncStorage.setItem(key, JSON.stringify({ ...existing, ...patch }));
  } catch {
    // best-effort — see module comment above
  }
}

// Removes exactly one id's persisted entry for one (domain, identity) pair
// — a read-modify-write, same as mergePersistedSignedUrlEntries above, just
// deleting instead of merging. Used by
// use-signed-folder-covers.ts's invalidateSignedFolderCover, which needs
// the persisted layer to stop returning a stale entry to some FUTURE cold
// launch once the owner has explicitly picked a new cover — the in-memory
// cache.delete + version bump it also does are what guarantee THIS running
// process refetches immediately; this call is a best-effort mirror of that
// onto AsyncStorage, never load-bearing for the current session's own
// correctness.
export async function removePersistedSignedUrlEntry(domain: string, identity: string, id: string): Promise<void> {
  try {
    const key = storageKey(domain, identity);
    const existing = await readPersistedSignedUrlMap(domain, identity);
    if (!(id in existing)) return;
    const next = { ...existing };
    delete next[id];
    await AsyncStorage.setItem(key, JSON.stringify(next));
  } catch {
    // best-effort — see module comment above
  }
}

// Drops every persisted entry for one (domain, identity) pair in a single
// call — used on logout/account switch (lib/auth.tsx) to purge the
// OUTGOING identity's signed-URL metadata. Identity-scoped by construction
// (the key itself is namespaced by identity), so this can never remove or
// expose a different identity's entries.
export async function purgePersistedSignedUrlCache(domain: string, identity: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(storageKey(domain, identity));
  } catch {
    // best-effort — a failed purge just means the outgoing identity's
    // entries linger until they expire naturally (still identity-scoped,
    // never readable by a different identity's key) rather than blocking
    // sign-out.
  }
}
