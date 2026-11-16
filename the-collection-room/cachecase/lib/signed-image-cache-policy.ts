// Shared cache policy for PRIVATE, signed images (P2.3 Issue 2) — used by
// hooks/use-signed-item-images.ts, hooks/use-signed-folder-covers.ts and
// hooks/use-dm-image-url.ts. Pure (no React Native imports) so it is unit
// tested directly: node --test lib/signed-image-cache-policy.test.ts
//
// The bug this fixes (B7c): a server "unavailable" answer (not authorized —
// e.g. a block, a moderation restriction, a private item) used to be cached
// exactly like a signed URL, for the full signed-URL TTL (5 minutes; 1 hour
// for DM photos), AND persisted to AsyncStorage. After the permission was
// restored (unblock), the image stayed blank until that entry expired, even
// across an app restart.
//
// Policy (owner decisions, P2.3):
//   * Negative answers are short-lived (NEGATIVE_TTL_MS) and MEMORY ONLY —
//     never persisted, and any persisted negative written by an older build is
//     ignored on read.
//   * A permission failure is never treated as a cacheable success.
//   * An expired authorization is not indefinite permission to display: the
//     last good image may stay on screen only for STALE_DISPLAY_GRACE_MS after
//     its signed URL expired (covers a brief network blip / renewal), never
//     longer. Revalidation keeps being attempted (transient-failure entries
//     re-sign every TRANSIENT_FAILURE_TTL_MS and on every return to the
//     foreground), so images come back as soon as connectivity does.
//   * Caches are keyed by identity and cleared on account change (see
//     lib/persisted-signed-url-cache.ts's memory-cache registry).
//
// Unavoidable limitations (documented, not solvable client-side):
//   * Bytes already downloaded can stay in expo-image's OS-level disk/memory
//     caches. They are keyed per identity (lib/private-image-cache-key.ts) and
//     only shown when a hook hands out a URL for them; both caches are cleared
//     on sign-out / account switch (lib/auth.tsx).
//   * A pixel already rendered on screen stays until the view re-renders.
//   * A signed URL already issued stays valid at Storage until it expires
//     (≤ 5 min items/covers, ≤ 1 h DM photos); another collector's device is
//     never notified of a block/moderation change and converges by these TTLs.

export const NEGATIVE_TTL_MS = 20_000;
// P2.3 review F3: repeated "unavailable" answers for the same image back off,
// so a permanently unavailable image (an empty folder's cover, by design the
// same answer as "not authorized") is not re-signed every 20 s forever:
// 20 → 40 → 80 → 160 → 300 s (cap). The ladder restarts whenever the entry is
// dropped — a block/unblock, an account change, an app restart, or an explicit
// refresh (resetSignedImageNegatives in lib/persisted-signed-url-cache.ts) —
// so the FIRST re-check after a permission change is still 20 s.
export const NEGATIVE_BACKOFF_MS = [20_000, 40_000, 80_000, 160_000, 300_000] as const;
export const TRANSIENT_FAILURE_TTL_MS = 10_000;
export const STALE_DISPLAY_GRACE_MS = 5 * 60_000;

export type PolicyEntry = {
  url: string | null;
  expiresAt: number;
  isTransientFailure?: boolean;
  servedTier?: unknown;
  // Consecutive "unavailable" answers for this key (F3).
  negatives?: number;
};

export type PersistedEntry = { url: string | null; expiresAt: number; token?: string };

// Expiry for a definitive server answer: the signed URL's TTL for a URL, the
// short negative TTL for "unavailable".
export function expiryForAnswer(url: string | null, now: number, signedTtlMs: number, consecutiveNegatives = 1): number {
  return now + (url ? signedTtlMs : negativeTtlMs(consecutiveNegatives));
}

// TTL of the n-th consecutive negative answer (n ≥ 1).
export function negativeTtlMs(consecutiveNegatives: number): number {
  const i = Math.min(Math.max(Math.floor(consecutiveNegatives), 1), NEGATIVE_BACKOFF_MS.length) - 1;
  return NEGATIVE_BACKOFF_MS[i];
}

// The count a new negative answer gets, given the entry it replaces: one more
// than a previous (non-transient) negative, otherwise 1.
export function nextNegativeCount(previous: PolicyEntry | undefined): number {
  if (previous && previous.url === null && !previous.isTransientFailure) return (previous.negatives ?? 1) + 1;
  return 1;
}

// Whether a last-good image may be shown NOW (render-time helper: the clock is
// read here, never in a component body — review F5).
export function canDisplayStaleNow(authExpiresAt: number | undefined): boolean {
  return canDisplayStale(authExpiresAt, Date.now());
}

// Only real, requested-tier signed URLs are worth remembering across an app
// restart. Never a negative answer, a transient failure or a tier fallback.
export function shouldPersist(entry: PolicyEntry): boolean {
  return typeof entry.url === 'string' && entry.url.length > 0 && !entry.isTransientFailure && entry.servedTier === undefined;
}

// What a persisted entry may become when read back into memory:
//   'usable'   — a still-valid signed URL
//   'expired'  — an expired URL, usable only as a short stale-display handle
//   'ignore'   — a negative (from an older build) or malformed entry
export function classifyPersisted(entry: PersistedEntry | undefined, now: number): 'usable' | 'expired' | 'ignore' {
  if (!entry || typeof entry.url !== 'string' || !entry.url || typeof entry.expiresAt !== 'number') return 'ignore';
  return entry.expiresAt > now ? 'usable' : 'expired';
}

// Whether a last-good image whose signed URL expired at `authExpiresAt` may
// still be shown at `now` (while its renewal is in flight or failing).
export function canDisplayStale(authExpiresAt: number | undefined, now: number): boolean {
  return typeof authExpiresAt === 'number' && now < authExpiresAt + STALE_DISPLAY_GRACE_MS;
}

// Keep only entries that may be persisted from a map about to be written.
export function persistablePatch<T extends PersistedEntry>(patch: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v.url === 'string' && v.url.length > 0) out[k] = v;
  }
  return out;
}

// Which in-memory entries a permission change invalidates for one identity.
//   'all'       — every entry (a block: positives may now be revoked)
//   'negatives' — only "unavailable" answers (an unblock: they may now be allowed)
export type InvalidationScope = 'all' | 'negatives';

export function shouldInvalidate(entry: PolicyEntry, scope: InvalidationScope): boolean {
  if (scope === 'all') return true;
  return entry.url === null;
}

// Cache keys are `${identity}:${rest}` everywhere in these hooks.
export function keyBelongsTo(key: string, identity: string): boolean {
  return key.startsWith(`${identity}:`);
}
