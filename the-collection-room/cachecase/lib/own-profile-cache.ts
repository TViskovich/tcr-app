import AsyncStorage from '@react-native-async-storage/async-storage';

import type { FeedPost } from '@/components/feed/post-card';
import type { CollectionGridEntry, CollectionItemWithFolderVisibility } from '@/hooks/use-collection';
import type { ProfileStats } from '@/hooks/use-profile';
import type { Folder, GrailSlot, Profile } from '@/types';

// Stale-while-revalidate local cache for the SIGNED-IN USER'S OWN Profile V2
// screen only (never another user's profile — see profile-v2-screen.tsx's
// own call site, gated on isOwnProfile). Supabase stays authoritative: this
// only lets the screen paint immediately from what it showed last time
// instead of a blank/full-screen loading state, then quietly refetches in
// the background the same way it always has (each underlying hook's own
// load()/refresh(), unchanged). Metadata only — every image renders through
// the existing signed-image hooks/expo-image disk cache, never through this
// store.
//
// One JSON blob per user id (mirrors lib/persisted-signed-url-cache.ts's
// one-blob-per-identity convention), versioned so an incompatible future
// shape is simply treated as a miss rather than crashing on read.

export type OwnProfileCachePayload = {
  profile: Profile;
  stats: ProfileStats;
  grailSlots: GrailSlot[];
  folders: Folder[];
  folderItemCounts: Record<string, number>;
  folderPreviewEntries: Record<string, CollectionGridEntry[]>;
  items: CollectionItemWithFolderVisibility[];
  posts: FeedPost[];
};

type StoredCache = {
  v: 1;
  cachedAt: number;
  payload: OwnProfileCachePayload;
};

const STORAGE_KEY_PREFIX = 'profile-v2-cache:v1';
// How long a cached payload is treated as fresh enough that the screen can
// skip an otherwise-redundant background refresh entirely (see
// profile-v2-screen.tsx's own use of this) — same 30-60s window every other
// session-freshness check in this app (e.g. Following's own
// FOLLOWING_FEED_FRESHNESS_MS) uses. A stale cache still renders
// immediately either way; this only controls whether a network refresh
// follows it.
export const OWN_PROFILE_CACHE_FRESHNESS_MS = 45_000;

function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}:${userId}`;
}

// In-memory mirror, populated the first time this session actually reads or
// writes a given user's cache — makes "leave profile and come back" within
// the same app session instant (no AsyncStorage round trip at all), while a
// genuinely cold launch still falls through to readOwnProfileCache below.
// Never trusted across a user id change; always read by the exact id asked
// for.
const memoryMirror = new Map<string, StoredCache>();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Minimal shape validation only (never a full schema check) — corrupt or
// unrecognized-version data is treated as a miss, same "never throws, never
// blocks rendering" contract as readPersistedSignedUrlMap.
function isValidStoredCache(value: unknown): value is StoredCache {
  if (!isPlainObject(value)) return false;
  if (value.v !== 1 || typeof value.cachedAt !== 'number') return false;
  const payload = value.payload;
  if (!isPlainObject(payload)) return false;
  return (
    isPlainObject(payload.profile) &&
    isPlainObject(payload.stats) &&
    Array.isArray(payload.grailSlots) &&
    Array.isArray(payload.folders) &&
    isPlainObject(payload.folderItemCounts) &&
    isPlainObject(payload.folderPreviewEntries) &&
    Array.isArray(payload.items) &&
    Array.isArray(payload.posts)
  );
}

export type ReadOwnProfileCacheResult = { payload: OwnProfileCachePayload; cachedAt: number; fresh: boolean } | null;

// Synchronous, memory-mirror-only read — returns immediately with whatever
// this session already knows (nothing if it hasn't read/written this user's
// cache yet). Used by Profile V2's own useState lazy initializers (and the
// hooks it seeds — see hooks/use-profile.ts etc.), which must have a value
// at the very first render, before any async AsyncStorage read could ever
// resolve. lib/auth.tsx fires an early, best-effort readOwnProfileCache()
// for the current identity as soon as a session is known — well before the
// user could possibly navigate to Profile — specifically so this sync path
// is warm even on a cold launch, not just on a same-session return visit.
export function peekOwnProfileCacheSync(userId: string): ReadOwnProfileCacheResult {
  const mirrored = memoryMirror.get(userId);
  if (!mirrored) return null;
  return { payload: mirrored.payload, cachedAt: mirrored.cachedAt, fresh: isFresh(mirrored.cachedAt) };
}

export async function readOwnProfileCache(userId: string): Promise<ReadOwnProfileCacheResult> {
  const mirrored = memoryMirror.get(userId);
  if (mirrored) {
    return { payload: mirrored.payload, cachedAt: mirrored.cachedAt, fresh: isFresh(mirrored.cachedAt) };
  }
  try {
    const raw = await AsyncStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidStoredCache(parsed)) return null;
    memoryMirror.set(userId, parsed);
    return { payload: parsed.payload, cachedAt: parsed.cachedAt, fresh: isFresh(parsed.cachedAt) };
  } catch {
    return null;
  }
}

function isFresh(cachedAt: number): boolean {
  return Date.now() - cachedAt < OWN_PROFILE_CACHE_FRESHNESS_MS;
}

// Best-effort, fire-and-forget from every call site — a write failure here
// only means the next cold launch re-fetches over the network, never a
// correctness issue. Always a full replace (never a partial merge): callers
// only ever write once they already hold the complete current payload.
export async function writeOwnProfileCache(userId: string, payload: OwnProfileCachePayload): Promise<void> {
  const stored: StoredCache = { v: 1, cachedAt: Date.now(), payload };
  memoryMirror.set(userId, stored);
  try {
    await AsyncStorage.setItem(storageKey(userId), JSON.stringify(stored));
  } catch {
    // Non-fatal — the in-memory mirror above still serves this session.
  }
}

// Logout / account switch — purges the departing identity's own cache so it
// can never be read back under a different signed-in user (every read above
// is already scoped by userId, so this is defense in depth / bounded
// storage growth, same posture as purgePersistedSignedUrlCache).
export async function purgeOwnProfileCache(userId: string): Promise<void> {
  memoryMirror.delete(userId);
  try {
    await AsyncStorage.removeItem(storageKey(userId));
  } catch {
    // Best-effort.
  }
}

// Mutation call sites (edit profile, add/edit/delete/move item, folder
// create/delete/reorder, cover change, grail add/remove/reorder, post
// create/delete) don't hand-maintain this cache themselves — that would be
// brittle (many scattered call sites, easy to miss one). Instead they just
// mark the current user's cached snapshot stale, which is enough to force
// the NEXT own-profile mount/focus to treat it as stale and re-render from a
// fresh network load once it lands (see profile-v2-screen.tsx's own
// isOwnProfileCacheStillFresh, which reads this same module's mirror
// directly, and its many invalidateOwnProfileCache call sites) — simpler and
// safer than partially patching a cached payload that might not match what
// the mutation actually changed.
//
// Deliberately does NOT delete the entry (an earlier version of this
// function did): Profile V2's own freshness check reads straight from this
// module's memory mirror, so deleting it here would also delete the
// instant-render seed for whatever mounts/remounts next (a cold relaunch
// shortly after this mutation, or a second Profile screen instance) —
// exactly the "mutation -> return to Profile -> blank screen" regression
// this cache exists to avoid. Zeroing cachedAt instead keeps the last-known
// snapshot available for an immediate paint while making isFresh() false
// unconditionally, so the very next read forces a real refresh.
export function invalidateOwnProfileCache(userId: string): void {
  const existing = memoryMirror.get(userId);
  // Nothing cached yet for this user — there's nothing to mark stale, and a
  // later real write (once something does load) establishes the entry
  // fresh, correctly, on its own.
  if (!existing) return;
  const stale: StoredCache = { ...existing, cachedAt: 0 };
  memoryMirror.set(userId, stale);
  // Best-effort mirror onto the persisted copy too — otherwise a cold
  // relaunch shortly after this mutation would read back AsyncStorage's OLD
  // (still within-window) cachedAt and wrongly treat it as fresh again (see
  // readOwnProfileCache, which only consults the memory mirror once this
  // session has already populated it).
  AsyncStorage.setItem(storageKey(userId), JSON.stringify(stale)).catch(() => {
    // Non-fatal — see this file's other best-effort AsyncStorage writes.
  });
}
