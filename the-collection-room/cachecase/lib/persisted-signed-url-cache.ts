import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  classifyPersisted,
  persistablePatch,
  type InvalidationScope,
} from '@/lib/signed-image-cache-policy';

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
  // P2.3: only real signed URLs are ever persisted. A server "unavailable"
  // answer is short-lived and memory-only (lib/signed-image-cache-policy.ts —
  // persisting it is what kept unblocked images blank, B7c); null stays in
  // the type only so entries written by older builds still parse, and they
  // are ignored on read.
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
  void sweepLegacySignedUrlCaches();
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

// v2 (P2.3): v1 blobs may hold persisted "unavailable" answers from older
// builds, so they are dropped once (sweepLegacySignedUrlCaches) rather than
// read. An older build reinstalled over this one simply ignores v2 keys.
const STORAGE_KEY_PREFIX = 'cachecase:signed-url-cache:v2';
const LEGACY_KEY_PREFIXES = ['cachecase:signed-url-cache:v1:'];

let legacySwept = false;
export async function sweepLegacySignedUrlCaches(): Promise<void> {
  if (legacySwept) return;
  legacySwept = true;
  try {
    const keys = await AsyncStorage.getAllKeys();
    const legacy = keys.filter((k) => LEGACY_KEY_PREFIXES.some((p) => k.startsWith(p)));
    if (legacy.length) await AsyncStorage.multiRemove(legacy);
  } catch {
    // best-effort — legacy keys are never read either way
  }
}

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
      // A persisted negative (older build) is ignored, never revived.
      if (isValidEntry(entry) && classifyPersisted(entry, 0) !== 'ignore') out[id] = entry;
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
  // Never persist a negative answer, whatever the caller passes.
  patch = persistablePatch(patch);
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

// ── In-memory cache registry (P2.3) ─────────────────────────────────────────
// The signing hooks keep module-level in-memory caches. lib/auth.tsx and
// lib/user-blocks.ts must be able to clear or invalidate them without
// importing the hooks (circular dependency — see ITEM_IMAGES_CACHE_DOMAIN's
// comment), so each hook module registers itself here.
export type SignedImageMemoryCache = {
  // Drop everything held for this identity (account change / sign-out).
  clearIdentity(identity: string): void;
  // Drop the entries a permission change may have made wrong, for this
  // identity, and make mounted screens re-sign.
  invalidate(identity: string, scope: InvalidationScope): void;
};

const memoryCaches = new Set<SignedImageMemoryCache>();

export function registerSignedImageMemoryCache(c: SignedImageMemoryCache): () => void {
  memoryCaches.add(c);
  return () => {
    memoryCaches.delete(c);
  };
}

export function clearSignedImageMemory(identity: string): void {
  for (const c of memoryCaches) {
    try {
      c.clearIdentity(identity);
    } catch {
      // never let one cache block the others
    }
  }
}

const PERSISTED_DOMAINS = () => [ITEM_IMAGES_CACHE_DOMAIN, FOLDER_COVERS_CACHE_DOMAIN, DM_ATTACHMENTS_CACHE_DOMAIN];

// A known permission change for `identity` (a block or unblock made on this
// device). 'all' also drops that identity's persisted URLs, so nothing
// signed before the change is revived after a restart.
export function invalidateSignedImages(identity: string, scope: InvalidationScope): void {
  for (const c of memoryCaches) {
    try {
      c.invalidate(identity, scope);
    } catch {
      // never let one cache block the others
    }
  }
  if (scope === 'all') {
    for (const domain of PERSISTED_DOMAINS()) purgePersistedSignedUrlCache(domain, identity).catch(() => {});
  }
}

// An explicit refresh by the user (pull-to-refresh on a screen showing private
// images): drop the active identity's short-lived "unavailable" answers so they
// are re-checked now and their backoff restarts (review F3). Signed URLs are
// kept — nothing persisted is touched.
export function resetSignedImageNegatives(): void {
  if (activeSignedUrlIdentity === undefined) return;
  for (const c of memoryCaches) {
    try {
      c.invalidate(activeSignedUrlIdentity, 'negatives');
    } catch {
      // never let one cache block the others
    }
  }
}
