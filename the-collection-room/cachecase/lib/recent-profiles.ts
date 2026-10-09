import AsyncStorage from '@react-native-async-storage/async-storage';

// Recently visited OTHER collectors, per signed-in account — the Find User
// dropdown's "Recent" list (long-press the Feed's CacheCase logo).
//
// Minimal, public-only metadata: id, username, display name and avatar.
// Avatars are public storage URLs (lib/storage.ts uses getPublicUrl for the
// avatars bucket) — never a signed URL. A visit is recorded only once a
// profile has actually loaded (ProfileV2Screen), most recent first,
// deduplicated by id, capped at MAX_RECENTS, never the viewer themselves.
//
// Account-scoped: one AsyncStorage key per viewer id, so one account never
// reads another's history. The in-memory mirror is cleared on every
// account change (lib/auth.tsx); the persisted list stays with its own
// account, so signing back into it restores that account's recents.
export type RecentProfile = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

const MAX_RECENTS = 5;
const STORAGE_KEY_PREFIX = 'cachecase:recent-profiles:v1';

const memory = new Map<string, RecentProfile[]>();
const listeners = new Set<() => void>();

function storageKey(viewerId: string) {
  return `${STORAGE_KEY_PREFIX}:${viewerId}`;
}

function notify() {
  for (const listener of [...listeners]) listener();
}

function isRecentProfile(value: unknown): value is RecentProfile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.username === 'string' &&
    (v.displayName === null || typeof v.displayName === 'string') &&
    (v.avatarUrl === null || typeof v.avatarUrl === 'string')
  );
}

// The viewer's recents, loading them from storage the first time this
// session. Never throws (a read failure is an empty list).
export async function loadRecentProfiles(viewerId: string): Promise<RecentProfile[]> {
  const known = memory.get(viewerId);
  if (known) return known;
  let list: RecentProfile[] = [];
  try {
    const raw = await AsyncStorage.getItem(storageKey(viewerId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.filter(isRecentProfile).slice(0, MAX_RECENTS);
  } catch {
    list = [];
  }
  // A visit recorded while this read was in flight wins.
  if (!memory.has(viewerId)) memory.set(viewerId, list);
  return memory.get(viewerId) ?? list;
}

function save(viewerId: string, list: RecentProfile[]) {
  memory.set(viewerId, list);
  notify();
  AsyncStorage.setItem(storageKey(viewerId), JSON.stringify(list)).catch(() => {});
}

// Records a successfully opened profile at the top (moving it if already
// present). The viewer's own profile is never recorded.
export async function recordRecentProfile(viewerId: string, profile: RecentProfile): Promise<void> {
  if (!viewerId || profile.id === viewerId) return;
  const current = await loadRecentProfiles(viewerId);
  const next = [profile, ...current.filter((p) => p.id !== profile.id)].slice(0, MAX_RECENTS);
  const unchanged =
    current.length === next.length &&
    current.every(
      (p, i) =>
        p.id === next[i].id &&
        p.username === next[i].username &&
        p.displayName === next[i].displayName &&
        p.avatarUrl === next[i].avatarUrl,
    );
  if (!unchanged) save(viewerId, next);
}

// Drops one entry — a recent whose profile no longer exists.
export async function removeRecentProfile(viewerId: string, profileId: string): Promise<void> {
  const current = await loadRecentProfiles(viewerId);
  if (current.some((p) => p.id === profileId)) save(viewerId, current.filter((p) => p.id !== profileId));
}

export function subscribeRecentProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Account change / sign-out (lib/auth.tsx): forget every account's
// in-memory list. Persisted lists stay keyed to their own account.
export function clearRecentProfilesMemory() {
  memory.clear();
  notify();
}
