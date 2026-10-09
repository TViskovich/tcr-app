import type { OwnProfileCachePayload } from '@/lib/own-profile-cache';

// Session-only memory of OTHER users' profiles the signed-in viewer has
// already loaded, so re-opening one (a fresh /user/[username] screen — e.g.
// tapping their name again after Back) shows it immediately instead of a
// cold, spinner-first load. Never persisted (unlike lib/own-profile-cache.ts),
// and never used without revalidation: the profile screen treats it as
// stale, so every visit still runs its normal full refresh on focus and
// overwrites this with whatever the viewer is currently allowed to see.
//
// Keyed by viewer AND profile, so one account's view of a profile is never
// shown to another account, and one profile's data is never shown under
// another profile. Cleared entirely on sign-out (lib/auth.tsx). Bounded so a
// long session of browsing can't grow it without limit.
const MAX_ENTRIES = 20;

const snapshots = new Map<string, OwnProfileCachePayload>();

function key(viewerId: string, profileUserId: string) {
  return `${viewerId}:${profileUserId}`;
}

export function peekVisitedProfile(viewerId: string, profileUserId: string): OwnProfileCachePayload | null {
  return snapshots.get(key(viewerId, profileUserId)) ?? null;
}

export function rememberVisitedProfile(viewerId: string, profileUserId: string, payload: OwnProfileCachePayload) {
  const k = key(viewerId, profileUserId);
  // Re-insert so the most recently visited profiles are the ones kept.
  snapshots.delete(k);
  snapshots.set(k, payload);
  while (snapshots.size > MAX_ENTRIES) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

// username -> profile id, so app/user/[username].tsx can render a known
// profile without first waiting on its id lookup. That route still re-checks
// the id every time and switches if the username now belongs to someone else.
// Public data (profiles are readable by everyone), so not viewer-scoped.
const userIdsByUsername = new Map<string, string>();

export function peekProfileUserId(username: string): string | undefined {
  return userIdsByUsername.get(username);
}

export function rememberProfileUserId(username: string, userId: string) {
  userIdsByUsername.set(username, userId);
}

export function clearVisitedProfiles() {
  snapshots.clear();
  userIdsByUsername.clear();
}
