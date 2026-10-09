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
  // Optional opaque image-identity token (folder covers only — see
  // get-folder-cover-signed-url's image_token). Absent on every older entry.
  token?: string;
};

type PersistedMap = Record<string, PersistedSignedUrlEntry>;

// The identity the app is currently acting as, as last reported by
// lib/auth.tsx's identity-change handler (undefined until the first
// observation). Lets a signing request that completes AFTER an account
// switch/sign-out be recognized as belonging to a departed identity, so its
// result is neither written back to memory by the hooks nor re-persisted
// here after that identity's caches were already purged. Defense-in-depth
// only: every entry is identity-keyed, so a departed identity's entries are
// never readable by another identity either way.
let activeSignedUrlIdentity: string | undefined;

export function setActiveSignedUrlIdentity(identity: string): void {
  activeSignedUrlIdentity = identity;
  // Start reading this identity's persisted maps now (app start / sign-in),
  // so the first grid that needs them — e.g. a cold Following open — finds
  // them already parsed instead of waiting on AsyncStorage before it can
  // even send its signing request. One read per map per identity per
  // session (see readPersistedSignedUrlMap).
  void readPersistedSignedUrlMap(ITEM_IMAGES_CACHE_DOMAIN, identity);
  void readPersistedSignedUrlMap(FOLDER_COVERS_CACHE_DOMAIN, identity);
}

// True until the first identity is observed, then only for that identity.
export function isActiveSignedUrlIdentity(identity: string): boolean {
  return activeSignedUrlIdentity === undefined || activeSignedUrlIdentity === identity;
}

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
// DM photo attachments (hooks/use-dm-image-url.ts) — keyed by dm-attachments
// storage path, never mixed with item-image ids.
export const DM_ATTACHMENTS_CACHE_DOMAIN = 'dm-attachments';

const STORAGE_KEY_PREFIX = 'cachecase:signed-url-cache:v1';

function storageKey(domain: string, identity: string): string {
  return `${STORAGE_KEY_PREFIX}:${domain}:${identity}`;
}

function isValidEntry(value: unknown): value is PersistedSignedUrlEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as { url?: unknown; expiresAt?: unknown; token?: unknown };
  return (
    (v.url === null || typeof v.url === 'string') &&
    typeof v.expiresAt === 'number' &&
    (v.token === undefined || typeof v.token === 'string')
  );
}

// The parsed contents of each (domain, identity) blob, read from
// AsyncStorage ONCE per session and then kept in step with every write
// below (merge / remove / purge) — not a second cache, just this store's
// own contents already parsed. Every signing hook used to re-read and
// re-parse the whole blob each time it had an id missing from memory,
// which sat in front of the signing request itself (e.g. both of the
// Following feed's batches on a cold open). Keyed by the same
// identity-namespaced storage key, so it can never cross identities.
const loadedMaps = new Map<string, PersistedMap>();
const loadingMaps = new Map<string, Promise<PersistedMap>>();

async function loadMap(key: string): Promise<PersistedMap> {
  try {
    const raw = await AsyncStorage.getItem(key);
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

// Best-effort — a read failure (corrupt JSON, storage unavailable) simply
// yields an empty map, which falls through to the caller's own normal
// missing/fetch path exactly as if nothing had ever been persisted. Never
// throws, never blocks rendering. The returned map is shared — read-only
// for callers.
export function readPersistedSignedUrlMap(domain: string, identity: string): Promise<Readonly<PersistedMap>> {
  const key = storageKey(domain, identity);
  const loaded = loadedMaps.get(key);
  if (loaded) return Promise.resolve(loaded);
  let loading = loadingMaps.get(key);
  if (!loading) {
    loading = loadMap(key).then((map) => {
      // A write that landed while this read was in flight already set the
      // newer contents — never replace them with the older read.
      if (loadingMaps.get(key) === loading && !loadedMaps.has(key)) loadedMaps.set(key, map);
      loadingMaps.delete(key);
      return loadedMaps.get(key) ?? map;
    });
    loadingMaps.set(key, loading);
  }
  return loading;
}

// Current parsed contents for a write: loads first if needed, then reads the
// latest map SYNCHRONOUSLY so overlapping writes each build on the previous
// one's result instead of an older snapshot.
async function currentMap(domain: string, identity: string): Promise<PersistedMap> {
  await readPersistedSignedUrlMap(domain, identity);
  return loadedMaps.get(storageKey(domain, identity)) ?? {};
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
  // Never re-persist a departed identity's entries after its purge.
  if (!isActiveSignedUrlIdentity(identity)) return;
  try {
    const key = storageKey(domain, identity);
    const next = { ...(await currentMap(domain, identity)), ...patch };
    // Re-checked after the await: a purge may have run meanwhile.
    if (!isActiveSignedUrlIdentity(identity)) return;
    loadedMaps.set(key, next);
    await AsyncStorage.setItem(key, JSON.stringify(next));
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
    const existing = await currentMap(domain, identity);
    if (!(id in existing)) return;
    const next = { ...existing };
    delete next[id];
    loadedMaps.set(key, next);
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
  const key = storageKey(domain, identity);
  loadedMaps.delete(key);
  loadingMaps.delete(key);
  try {
    await AsyncStorage.removeItem(storageKey(domain, identity));
  } catch {
    // best-effort — a failed purge just means the outgoing identity's
    // entries linger until they expire naturally (still identity-scoped,
    // never readable by a different identity's key) rather than blocking
    // sign-out.
  }
}
