import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { DETAIL_IMAGE_TIER, imageTierCacheSuffix, type ImageTier } from '@/lib/image-tiers';
import { folderCoverCacheKey } from '@/lib/private-image-cache-key';
import {
  FOLDER_COVERS_CACHE_DOMAIN,
  isActiveSignedUrlIdentity,
  mergePersistedSignedUrlEntries,
  readPersistedSignedUrlMap,
  removePersistedSignedUrlEntry,
} from '@/lib/persisted-signed-url-cache';
import { supabase, supabaseAnonKey, supabaseUrl } from '@/lib/supabase';

// Client-side companion to the get-folder-cover-signed-url Edge Function
// (item-images beta privacy hardening, Phase 3D). Batches every distinct,
// currently-requested folders.id through that function, caches results in
// memory for the same TTL the backend issues (300s), and re-fetches only
// what's missing or stale. Never accepts or derives a storage_path, never
// calls Storage's createSignedUrl() directly, and never reads/trusts
// folder.cover_image_url — all authorization and cover resolution happens
// server-side, every time; this hook only owns caching/batching/refresh
// (now across both memory AND a persisted AsyncStorage layer — see the
// private-image caching upgrade, Phase 1).
//
// Deliberately duplicates (rather than shares via a common internal
// module) the direct-fetch/identity-scoped-cache/in-flight-dedupe design
// from hooks/use-signed-item-images.ts: that hook is already
// runtime-validated against a proven auth-transport bug (Phase 3C), and
// this one resolves a different id space against a different table
// server-side — folding them into one shared abstraction now would mean
// touching validated code to support an unvalidated caller, not a size
// reduction worth that risk. Only the genuinely-new, low-risk AsyncStorage
// plumbing (lib/persisted-signed-url-cache.ts) is actually shared between
// the two.
//
// Uses a direct fetch(), not supabase.functions.invoke() — see
// use-signed-item-images.ts's module comment for the full rationale
// (invoke() unconditionally attaches an Authorization header, falling back
// to the client's configured project key when there's no session, which
// this endpoint's anonymous-caller support can't safely distinguish from a
// genuinely invalid user JWT).

const EDGE_FUNCTION = 'get-folder-cover-signed-url';
// The persisted-cache domain for this hook (lib/persisted-signed-url-cache.ts)
// — exported from there, not declared locally, specifically so lib/auth.tsx
// can purge it on logout without importing this hook file (see that
// constant's own comment for the circular-import reason why).
const CACHE_DOMAIN = FOLDER_COVERS_CACHE_DOMAIN;
const MAX_BATCH_SIZE = 50;
const TTL_MS = 300_000;
// Treat a cached entry as due for a (background) refresh slightly before
// its real server-side expiry — does NOT gate whether a still-valid entry
// is SERVED (see isUsable below), only whether the effect fires a quiet
// refetch for it.
const REFRESH_SKEW_MS = 15_000;

// Same reliability policy as use-signed-item-images.ts's own (see that
// file's matching constants for the full rationale) — added here because
// this hook previously had NO retry/timeout at all: a single failed or
// hung fetch just gave up silently with nothing cached, leaving the status
// stuck at 'loading' forever for a still-mounted, rarely-remounted screen
// (Profile's Collection tab folder previews, the motivating case) until
// some unrelated screen happened to warm the shared cache instead.
const RETRY_DELAYS_MS = [750, 2000];
const RETRYABLE_STATUSES = new Set([408, 429]);
const FAILURE_TTL_MS = 10_000;
const FOLLOWUP_RETRY_DELAY_MS = 4_000;
const FETCH_TIMEOUT_MS = 10_000;

function isRetryableStatus(status: number | null): boolean {
  return status === null || status >= 500 || RETRYABLE_STATUSES.has(status);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SignedCoverStatus = 'loading' | 'ready' | 'unavailable';

// url === null means either the server explicitly returned `unavailable`
// for this id (not found, not authorized, or no resolvable cover — a
// genuine, considered answer, cached for the same TTL as a success) or
// every retry for a request-level failure was exhausted (isTransientFailure:
// true, cached for the much shorter FAILURE_TTL_MS instead — see
// use-signed-item-images.ts's matching CacheEntry comment for the full
// rationale). The two are never conflated, and only the former is ever
// persisted to disk.
//
// servedTier is set only when a non-original tier was requested but the
// server didn't confirm serving it (an Edge Function deployed before tier
// support ignores `tier` and returns the original) — same display-only
// semantics as use-signed-item-images.ts's CacheEntry.servedTier: kept in
// memory so the cover still renders, never persisted, and reported via
// servedTiers so the caller keys expo-image's byte cache on what was really
// served. Unlike the item hook it still counts as fresh for its TTL, so a
// not-yet-redeployed function costs no extra requests.
//
// token is the server's opaque image identity for the resolved cover
// (image_token — same value across signed-URL rotations of the same image,
// new value when the resolved image changes). Persisted alongside the URL,
// and used by folderCoverCacheKey to give 'first_card' covers a stable
// expo-image cacheKey. Absent from older entries / an older Edge Function.
type CacheEntry = {
  url: string | null;
  expiresAt: number;
  isTransientFailure?: boolean;
  servedTier?: ImageTier;
  token?: string;
};

const ALL_TIERS: readonly ImageTier[] = ['original', 'preview', 'detail'];

// The folder fields folderCoverCacheKey reads — any loaded folders row has them.
type CoverKeyFolder = Parameters<typeof folderCoverCacheKey>[1];

// Module-level, in-memory first-level cache, shared across every hook
// instance/screen — cleared on app reload, but now backed by a persisted
// AsyncStorage layer (see the fetch effect below) that survives one.
// Keyed by `${identity}:${folderId}`, not just folderId — identity is the
// caller's user id, or the literal string 'anon' with no session. This is
// what keeps an anonymous denial (e.g. a request that legitimately ran
// before session restoration finished) from ever being read back as the
// answer for the same folder once the real owner's session is available,
// and prevents any cross-user reuse of a signed URL that was only ever
// authorized for one specific caller — same design and rationale as
// hooks/use-signed-item-images.ts's cache. The persisted layer mirrors this
// exact same identity-scoping (see lib/persisted-signed-url-cache.ts's
// storage key).
const cache = new Map<string, CacheEntry>();

// Separate from `cache` above on purpose (Phase 1 in-flight dedupe) —
// tracks signing work currently IN PROGRESS, not completed results. Same
// design/rationale as use-signed-item-images.ts's own `inFlight` map.
const inFlight = new Map<string, Promise<void>>();

// Gates whether the EFFECT below fires a (possibly background) refetch —
// unchanged from before Phase 1 (skew-subtracted for a real entry, ignored
// for a transient-failure placeholder — see use-signed-item-images.ts's
// matching isFresh comment for the full rationale).
function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  if (!entry) return false;
  if (entry.isTransientFailure) return entry.expiresAt > Date.now();
  return entry.expiresAt - REFRESH_SKEW_MS > Date.now();
}

// Gates whether the RENDER-time read below actually SERVES an entry — no
// skew subtracted, just real expiry. Phase 1 near-expiry fix: an entry
// inside the refresh-skew window keeps rendering exactly as it did a
// moment ago while isFresh (above) independently tells the effect to
// quietly refresh it in the background — see
// use-signed-item-images.ts's matching isUsable comment.
function isUsable(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && entry.expiresAt > Date.now();
}

// Read-only peek at the in-memory cache for one folder's cover at one tier
// — never fetches, never touches the persisted layer or any entry. Lets the
// folder header show a cover another surface already signed at the small
// preview tier while its own detail tier is still signing (same idea as
// use-signed-item-images.ts's peekCachedSignedItemImage). Identity-scoped
// key, so it can never return another account's URL.
export function peekCachedSignedFolderCover(
  identity: string,
  folderId: string,
  tier: ImageTier,
): { url: string; servedTier?: ImageTier; token?: string } | null {
  const entry = cache.get(`${identity}:${folderId}${imageTierCacheSuffix(tier)}`);
  if (!isUsable(entry) || !entry.url) return null;
  return { url: entry.url, servedTier: entry.servedTier, token: entry.token };
}

// Bumped by invalidateSignedFolderCover and read into each hook instance's
// fetch effect deps below — this is what actually makes an invalidation
// cause a re-fetch. Deleting a cache entry alone does NOT do this: the
// fetch effect's deps are [key, identity], and a cover-menu action changes
// neither (same folderId, same caller), so without this, React sees the
// same deps as last render and skips re-running the effect entirely — the
// hook would recompute a fresh 'loading'/'unavailable' status for the
// deleted entry on the next render (since the read side always reads the
// cache live), but no request would ever go out to replace it, leaving the
// hero stuck showing the reserved-but-empty state (or, once a later render
// happens to change some other dep, whatever the entry happened to resolve
// to) instead of the just-picked cover. Confirmed by tracing
// invalidateSignedFolderCover's previous body (a bare cache.delete with no
// other side effect) against useEffect's documented dependency-comparison
// semantics — not something a live Edge Function reproduction could have
// shown, since the function itself was never the problem.
let version = 0;
const versionListeners = new Set<() => void>();

// Drops one folder's cached entry (memory AND persisted) for one specific
// caller identity and notifies every mounted useSignedFolderCovers instance
// to re-check its fetch effect, so the next render treats it as missing
// and re-fetches immediately rather than serving a stale cached result (up
// to TTL_MS old) or getting stuck with none at all — see `version` above
// for why the cache.delete alone was never sufficient. Only ever meaningful
// for the owner's own identity — cover edits are owner-only, so `identity`
// here should always be the current user's own id, never 'anon' or another
// user's. Exported rather than folded into a "refresh" mutation on the hook
// itself, since the caller (a folder-detail screen) already knows exactly
// which folder just changed and doesn't need this hook's full batching
// machinery just to invalidate one entry. The persisted-cache deletion here
// is best-effort/fire-and-forget — the in-memory delete + version bump
// alone are what guarantee the next render/effect actually refetches;
// AsyncStorage merely needs to stop returning the stale entry to some
// FUTURE cold launch, not to this one.
export function invalidateSignedFolderCover(folderId: string, identity: string) {
  // Every tier this folder's cover may be cached under (the header signs
  // 'original', tiles/rows/pickers 'preview') — a changed cover must
  // refetch in all of them.
  for (const tier of ALL_TIERS) {
    const cacheId = `${folderId}${imageTierCacheSuffix(tier)}`;
    cache.delete(`${identity}:${cacheId}`);
    removePersistedSignedUrlEntry(CACHE_DOMAIN, identity, cacheId).catch(() => {});
  }
  version++;
  for (const listener of versionListeners) listener();
}

type EdgeResult =
  | { id: string; status: 'ok'; signed_url: string; expires_in: number; tier?: ImageTier; image_token?: string }
  | { id: string; status: 'unavailable' };

type BatchAttempt = { ok: true; results: EdgeResult[] } | { ok: false; status: number | null };

// A single attempt only — retry/backoff policy lives one level up, in
// fetchSignedCoverBatchWithRetry. `status: null` means the request never
// got a response at all (fetch itself threw, or it was aborted by
// FETCH_TIMEOUT_MS — see use-signed-item-images.ts's matching comment for
// why a timeout is needed at all: an untimed-out fetch can hang forever on
// a cold app launch, permanently stalling this hook for the affected ids
// with no natural retrigger).
async function fetchSignedCoverBatchAttempt(
  folderIds: string[],
  accessToken: string | null,
  tier: ImageTier,
): Promise<BatchAttempt> {
  const headers: Record<string, string> = {
    apikey: supabaseAnonKey,
    'Content-Type': 'application/json',
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${supabaseUrl}/functions/v1/${EDGE_FUNCTION}`, {
      method: 'POST',
      headers,
      // 'original' sends exactly the pre-tier body.
      body: JSON.stringify(tier === 'original' ? { folder_ids: folderIds } : { folder_ids: folderIds, tier }),
      signal: controller.signal,
    });
  } catch (e) {
    if (__DEV__) console.error('[useSignedFolderCovers] batch request threw:', e);
    return { ok: false, status: null };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    if (__DEV__) {
      // Temporary-by-nature diagnostic, kept minimal on purpose: status,
      // response body text, and batch size only. Never logs a token, the
      // Authorization header value, the apikey, or a signed URL.
      let bodyText = '<unreadable>';
      try {
        bodyText = await res.clone().text();
      } catch {
        // response body already consumed or unavailable — ignore
      }
      console.error('[useSignedFolderCovers] batch request failed:', {
        status: res.status,
        body: bodyText,
        batchSize: folderIds.length,
      });
    }
    return { ok: false, status: res.status };
  }

  const json = await res.json().catch(() => null);
  if (!json?.results) return { ok: false, status: res.status };
  return { ok: true, results: json.results as EdgeResult[] };
}

// Bounded retry/backoff for a request-level failure only — never for a
// per-folder 'unavailable' the Edge Function itself already resolved
// successfully, which is a real, final answer on the first attempt
// regardless of how many ids in the batch came back that way. No
// auth-specific (401/403) re-fetch-session handling here, unlike
// use-signed-item-images.ts's own retry wrapper — this endpoint already
// supports anonymous callers by design (see the module comment above), so
// a 401/403 here is far less likely to be a stale-token blip specifically;
// it still retries as an ordinary retryable-status failure via
// isRetryableStatus below if the status itself qualifies.
async function fetchSignedCoverBatchWithRetry(
  folderIds: string[],
  accessToken: string | null,
  isCancelled: () => boolean,
  tier: ImageTier,
): Promise<BatchAttempt> {
  let attempt = 0;

  for (;;) {
    const result = await fetchSignedCoverBatchAttempt(folderIds, accessToken, tier);
    // A successful answer is returned even if the requesting effect was
    // superseded meanwhile — it's still a valid, identity-scoped result
    // that another pass may be awaiting (see the batch write below).
    if (result.ok) return result;
    if (isCancelled()) return { ok: false, status: null };

    if (!isRetryableStatus(result.status) || attempt >= RETRY_DELAYS_MS.length) {
      if (__DEV__) {
        console.error('[useSignedFolderCovers] batch request exhausted retries:', {
          lastStatus: result.status,
          attempts: attempt + 1,
          batchSize: folderIds.length,
        });
      }
      return result;
    }

    await delay(RETRY_DELAYS_MS[attempt]);
    if (isCancelled()) return { ok: false, status: null };
    attempt += 1;
  }
}

// One signing pass over `idsToTry` at one tier, for one identity — shared by
// useSignedFolderCovers' effect and prefetchSignedFolderCover. Ids already
// being fetched (by any caller) just await that shared in-flight promise
// (no new request); the rest go out in MAX_BATCH_SIZE batches, each
// registered in `inFlight` while pending. Writes a normal TTL_MS entry
// (persisted too) for every id that resolved, or a short-lived
// isTransientFailure entry (memory only) for a batch whose retries were
// exhausted — unless the caller had cancelled (never a real answer).
async function signCoverIds(
  idsToTry: string[],
  tier: ImageTier,
  identity: string,
  accessToken: string | null,
  isCancelled: () => boolean,
): Promise<void> {
  const cacheIdOf = (id: string) => `${id}${imageTierCacheSuffix(tier)}`;
  const alreadyInFlight = idsToTry.filter((id) => inFlight.has(`${identity}:${cacheIdOf(id)}`));
  const toBatch = idsToTry.filter((id) => !inFlight.has(`${identity}:${cacheIdOf(id)}`));

  const newBatchPromises: Promise<void>[] = [];
  for (let i = 0; i < toBatch.length; i += MAX_BATCH_SIZE) {
    const batch = toBatch.slice(i, i + MAX_BATCH_SIZE);
    const batchPromise: Promise<void> = (async () => {
      try {
        const outcome = await fetchSignedCoverBatchWithRetry(batch, accessToken, isCancelled, tier);

        // A successful batch is ALWAYS cached, even if this effect run
        // was superseded while it was in flight (e.g. the requested id
        // list grew once child folders loaded). It used to be discarded
        // here — while the superseding run, seeing these ids in
        // `inFlight`, awaited this very promise instead of refetching —
        // so those covers sat at 'loading' until the 4s follow-up pass
        // re-requested them. Only a cancellation-induced failure is
        // skipped (it was never a real answer).
        const now = Date.now();
        if (outcome.ok) {
          // Never for an identity the app is no longer acting as
          // (account switch/sign-out mid-request).
          if (!isActiveSignedUrlIdentity(identity)) return;
          const toPersist: Record<string, { url: string | null; expiresAt: number; token?: string }> = {};
          for (const r of outcome.results) {
            const isFallback = tier !== 'original' && r.status === 'ok' && r.tier !== tier;
            const entry: CacheEntry = {
              url: r.status === 'ok' ? r.signed_url : null,
              expiresAt: now + TTL_MS,
              ...(isFallback && r.status === 'ok' ? { servedTier: r.tier ?? ('original' as const) } : {}),
              ...(r.status === 'ok' && r.image_token ? { token: r.image_token } : {}),
            };
            cache.set(`${identity}:${cacheIdOf(r.id)}`, entry);
            if (!isFallback) toPersist[cacheIdOf(r.id)] = entry;
          }
          mergePersistedSignedUrlEntries(CACHE_DOMAIN, identity, toPersist).catch(() => {});
        } else if (!isCancelled()) {
          // Every retry for this batch was exhausted (or the failure
          // wasn't retryable at all) — cache every id in it as
          // unavailable so status doesn't stay stuck at 'loading'
          // forever, but marked isTransientFailure and expired after
          // the much shorter FAILURE_TTL_MS: this was never a real "no
          // cover" answer, just the last observation during what's
          // most likely a brief outage — and, per the type's own
          // comment, NEVER persisted to AsyncStorage.
          for (const id of batch) {
            cache.set(`${identity}:${cacheIdOf(id)}`, {
              url: null,
              expiresAt: now + FAILURE_TTL_MS,
              isTransientFailure: true,
            });
          }
        }
      } finally {
        // Unconditional delete, not an identity-compare-then-delete —
        // by construction, no other pass can ever reassign one of
        // THIS batch's ids in `inFlight` while this batch is still
        // pending: a concurrent pass sees `inFlight.has(id)` already
        // true (set right after this promise was created, below) and
        // awaits this same promise instead of registering its own, so
        // nothing else can be sitting under these keys when this
        // batch settles.
        for (const id of batch) {
          inFlight.delete(`${identity}:${cacheIdOf(id)}`);
        }
      }
    })();
    newBatchPromises.push(batchPromise);
    for (const id of batch) inFlight.set(`${identity}:${cacheIdOf(id)}`, batchPromise);
  }

  await Promise.all([
    ...newBatchPromises,
    ...alreadyInFlight.map((id) => inFlight.get(`${identity}:${cacheIdOf(id)}`) ?? Promise.resolve()),
  ]);
}

// The tier the folder screen's full-width header signs
// (app/collection/[folderId].tsx) — shared with prefetchFolderHeaderCover so
// a prefetch warms exactly the cache entry that header reads.
export const FOLDER_HEADER_COVER_TIER: ImageTier = DETAIL_IMAGE_TIER;

// Starts signing ONE folder's header cover the moment the user taps to open
// it, instead of after the destination screen has mounted and run its first
// effect. Signing only — no image bytes are fetched, and only for the single
// folder being opened, never speculatively for every visible folder. The
// destination's own useSignedFolderCovers call then either reads the result
// from the shared cache or awaits this same in-flight request (never a
// duplicate). No-op when a fresh/persisted entry or an in-flight request
// already exists. Same identity scoping and active-account guard as the
// hook; fire-and-forget, never throws.
export function prefetchFolderHeaderCover(folderId: string): void {
  void (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const identity = data.session?.user?.id ?? 'anon';
      if (!isActiveSignedUrlIdentity(identity)) return;

      const cacheId = `${folderId}${imageTierCacheSuffix(FOLDER_HEADER_COVER_TIER)}`;
      const key = `${identity}:${cacheId}`;
      if (isFresh(cache.get(key)) || inFlight.has(key)) return;

      // Same gap-only hydration as the hook: a still-valid persisted entry
      // (e.g. after a cold start) needs no request at all.
      if (!cache.has(key)) {
        const persisted = (await readPersistedSignedUrlMap(CACHE_DOMAIN, identity))[cacheId];
        if (persisted && persisted.expiresAt > Date.now() && !cache.has(key)) {
          cache.set(key, {
            url: persisted.url,
            expiresAt: persisted.expiresAt,
            ...(persisted.token ? { token: persisted.token } : {}),
          });
        }
        if (isFresh(cache.get(key)) || inFlight.has(key)) return;
      }

      await signCoverIds([folderId], FOLDER_HEADER_COVER_TIER, identity, data.session?.access_token ?? null, () => false);
    } catch {
      // best-effort — the destination screen still requests it normally
    }
  })();
}

// Accepts folders.id values only (nulls/undefineds filtered out, safe to
// pass directly from a `.map(f => f.id)` over possibly-incomplete data).
// Returns a snapshot of the shared cache for exactly the requested ids,
// plus a per-id status so callers can distinguish "still resolving" from
// "the server said no" without treating either as a reason to fall back to
// folder.cover_image_url.
//
// tier: which server-approved transform to sign (see supabase/functions/
// _shared/image-tiers.ts). 'original' (the default) is byte-for-byte the
// pre-tier request and cache key; small cover surfaces (tiles, rows,
// pickers) pass COMPACT_IMAGE_TIER.
export function useSignedFolderCovers(
  folderIds: (string | null | undefined)[],
  tier: ImageTier = 'original',
): {
  urls: Map<string, string>;
  statuses: Map<string, SignedCoverStatus>;
  // Only for an id whose URL is a tier fallback — see CacheEntry.servedTier.
  servedTiers: Map<string, ImageTier>;
  // The resolved image's opaque identity, when the server sent one — see
  // CacheEntry.token. Pass to folderCoverCacheKey.
  tokens: Map<string, string>;
  // Image source (URL + stable cacheKey) for one folder — see below.
  coverSource: (folder: CoverKeyFolder) => { uri: string; cacheKey?: string } | null;
} {
  // The existing app-wide auth subscription (lib/auth.tsx), not a second
  // one. session.user.id (not the full session/token) is the effect
  // dependency below, so a background token refresh that keeps the same
  // identity never triggers a refetch of already-fresh cache entries.
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const accessToken = session?.access_token ?? null;

  const ids = Array.from(new Set(folderIds.filter((id): id is string => !!id))).sort();
  const key = ids.join(',');

  // Tier-qualified id for the memory cache, in-flight map and persisted map.
  // 'original' has no suffix, so every existing cache entry keeps its key.
  const tierSuffix = imageTierCacheSuffix(tier);
  const cacheIdOf = (id: string) => `${id}${tierSuffix}`;

  // Forces a re-render once a batch resolves — the cache itself lives
  // outside React state (see `cache` above) so multiple hook instances
  // share it, but each instance still needs to know when to re-read it.
  const [, bump] = useState(0);

  // Subscribes to invalidateSignedFolderCover's module-level notifications
  // for the lifetime of this hook instance, so an invalidation anywhere
  // (this screen's own cover change, in practice) forces a re-render here.
  // A re-render alone still wouldn't refetch anything by itself — that's
  // what capturing `version` into the effect below's deps is for — this
  // just makes sure a render actually happens soon after invalidation
  // rather than waiting on some unrelated state change (like setFolder) to
  // happen to coincide with it.
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    versionListeners.add(listener);
    return () => {
      versionListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!ids.length) return;

    let cancelled = false;
    const isCancelled = () => cancelled;

    // One pass over `idsToTry`: ids already being fetched by another
    // in-flight call just await that shared promise (no new request); the
    // rest are grouped into fresh batches, each registered against its own
    // promise in `inFlight` for the duration of that request. Writes a
    // normal TTL_MS entry (persisted to AsyncStorage too) for every id
    // that actually resolved, or a short-lived isTransientFailure entry
    // (memory only, never persisted) for every id in a batch whose
    // retries were exhausted. Shared by the initial pass and the single
    // bounded follow-up pass below (same structure as
    // use-signed-item-images.ts's own runPass).
    function runPass(idsToTry: string[]): Promise<void> {
      return signCoverIds(idsToTry, tier, identity, accessToken, isCancelled);
    }

    (async () => {
      // Layer 1, step 2: hydrate the in-memory cache from the persisted
      // AsyncStorage layer for any id this hook instance doesn't already
      // have in memory — before deciding what's actually missing. See
      // use-signed-item-images.ts's matching comment for the full
      // rationale (only ever fills a gap, never overwrites an in-memory
      // entry, skips an already-expired persisted entry entirely).
      const needsHydration = ids.filter((id) => !cache.has(`${identity}:${cacheIdOf(id)}`));
      if (needsHydration.length) {
        const persisted = await readPersistedSignedUrlMap(CACHE_DOMAIN, identity);
        if (cancelled) return;
        let hydratedAny = false;
        for (const id of needsHydration) {
          const entry = persisted[cacheIdOf(id)];
          if (entry && entry.expiresAt > Date.now()) {
            cache.set(`${identity}:${cacheIdOf(id)}`, {
              url: entry.url,
              expiresAt: entry.expiresAt,
              ...(entry.token ? { token: entry.token } : {}),
            });
            hydratedAny = true;
          }
        }
        if (hydratedAny) bump((n) => n + 1);
      }

      const missing = ids.filter((id) => !isFresh(cache.get(`${identity}:${cacheIdOf(id)}`)));
      if (!missing.length) return;

      await runPass(missing);
      if (cancelled) return;
      bump((n) => n + 1);

      // A single bounded follow-up pass for whatever's still not fresh
      // after the pass above — lets a screen that rarely remounts/
      // re-requests (Profile's Collection tab folder previews, the
      // motivating case) self-correct on its own within a few seconds of a
      // transient outage clearing. Exactly one follow-up, never a loop or
      // repeating timer.
      const stillMissing = missing.filter((id) => !isFresh(cache.get(`${identity}:${cacheIdOf(id)}`)));
      if (!stillMissing.length) return;
      await delay(FOLLOWUP_RETRY_DELAY_MS);
      if (cancelled) return;
      await runPass(stillMissing);
      if (!cancelled) bump((n) => n + 1);
    })();

    return () => {
      cancelled = true;
    };
    // `key` (a sorted/joined snapshot of `ids`) and `identity` are the
    // original stable dependencies (same rationale as
    // use-signed-item-images.ts's effect); `version` is read fresh on every
    // render (see the module-level `version` counter above) and added here
    // specifically so an invalidateSignedFolderCover() call — which changes
    // neither `key` nor `identity` — still causes this effect to actually
    // re-run and refetch the now-missing entry, instead of only updating
    // the *status* React reads on the next render while no new request
    // ever goes out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, identity, version, tier]);

  const urls = new Map<string, string>();
  const statuses = new Map<string, SignedCoverStatus>();
  const servedTiers = new Map<string, ImageTier>();
  const tokens = new Map<string, string>();
  for (const id of ids) {
    const entry = cache.get(`${identity}:${cacheIdOf(id)}`);
    if (isUsable(entry)) {
      if (entry.url) {
        urls.set(id, entry.url);
        statuses.set(id, 'ready');
        if (entry.servedTier) servedTiers.set(id, entry.servedTier);
        if (entry.token) tokens.set(id, entry.token);
      } else {
        statuses.set(id, 'unavailable');
      }
    } else {
      statuses.set(id, 'loading');
    }
  }

  // The one way a surface should turn a folder into an <Image> source: the
  // signed URL plus its stable expo-image cacheKey, built by the shared
  // folderCoverCacheKey from this account (identity), the tier actually
  // served, and the server's image_token — 'upload'/'item' covers get their
  // existing keys, 'first_card' covers a token-backed one, and a cover with
  // no stable identity (no token yet) gets cacheKey undefined, i.e. the
  // previous URL-keyed behavior. null = no URL (yet).
  const coverSource = (folder: CoverKeyFolder): { uri: string; cacheKey?: string } | null => {
    const uri = urls.get(folder.id);
    if (!uri) return null;
    return {
      uri,
      cacheKey: folderCoverCacheKey(identity, folder, servedTiers.get(folder.id) ?? tier, tokens.get(folder.id)),
    };
  };

  return { urls, statuses, servedTiers, tokens, coverSource };
}
