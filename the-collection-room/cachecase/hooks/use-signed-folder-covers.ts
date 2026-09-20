import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import {
  FOLDER_COVERS_CACHE_DOMAIN,
  mergePersistedSignedUrlEntries,
  readPersistedSignedUrlMap,
  removePersistedSignedUrlEntry,
} from '@/lib/persisted-signed-url-cache';
import { supabaseAnonKey, supabaseUrl } from '@/lib/supabase';

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
type CacheEntry = { url: string | null; expiresAt: number; isTransientFailure?: boolean };

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
  cache.delete(`${identity}:${folderId}`);
  removePersistedSignedUrlEntry(CACHE_DOMAIN, identity, folderId).catch(() => {});
  version++;
  for (const listener of versionListeners) listener();
}

type EdgeResult =
  | { id: string; status: 'ok'; signed_url: string; expires_in: number }
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
      body: JSON.stringify({ folder_ids: folderIds }),
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
): Promise<BatchAttempt> {
  let attempt = 0;

  for (;;) {
    const result = await fetchSignedCoverBatchAttempt(folderIds, accessToken);
    if (isCancelled()) return { ok: false, status: null };
    if (result.ok) return result;

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

// Accepts folders.id values only (nulls/undefineds filtered out, safe to
// pass directly from a `.map(f => f.id)` over possibly-incomplete data).
// Returns a snapshot of the shared cache for exactly the requested ids,
// plus a per-id status so callers can distinguish "still resolving" from
// "the server said no" without treating either as a reason to fall back to
// folder.cover_image_url.
export function useSignedFolderCovers(folderIds: (string | null | undefined)[]): {
  urls: Map<string, string>;
  statuses: Map<string, SignedCoverStatus>;
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
    async function runPass(idsToTry: string[]): Promise<void> {
      const alreadyInFlight = idsToTry.filter((id) => inFlight.has(`${identity}:${id}`));
      const toBatch = idsToTry.filter((id) => !inFlight.has(`${identity}:${id}`));

      const newBatchPromises: Promise<void>[] = [];
      for (let i = 0; i < toBatch.length; i += MAX_BATCH_SIZE) {
        const batch = toBatch.slice(i, i + MAX_BATCH_SIZE);
        const batchPromise: Promise<void> = (async () => {
          try {
            const outcome = await fetchSignedCoverBatchWithRetry(batch, accessToken, isCancelled);
            if (cancelled) return;

            const now = Date.now();
            if (outcome.ok) {
              const toPersist: Record<string, { url: string | null; expiresAt: number }> = {};
              for (const r of outcome.results) {
                const entry: CacheEntry = {
                  url: r.status === 'ok' ? r.signed_url : null,
                  expiresAt: now + TTL_MS,
                };
                cache.set(`${identity}:${r.id}`, entry);
                toPersist[r.id] = entry;
              }
              mergePersistedSignedUrlEntries(CACHE_DOMAIN, identity, toPersist).catch(() => {});
            } else {
              // Every retry for this batch was exhausted (or the failure
              // wasn't retryable at all) — cache every id in it as
              // unavailable so status doesn't stay stuck at 'loading'
              // forever, but marked isTransientFailure and expired after
              // the much shorter FAILURE_TTL_MS: this was never a real "no
              // cover" answer, just the last observation during what's
              // most likely a brief outage — and, per the type's own
              // comment, NEVER persisted to AsyncStorage.
              for (const id of batch) {
                cache.set(`${identity}:${id}`, { url: null, expiresAt: now + FAILURE_TTL_MS, isTransientFailure: true });
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
              inFlight.delete(`${identity}:${id}`);
            }
          }
        })();
        newBatchPromises.push(batchPromise);
        for (const id of batch) inFlight.set(`${identity}:${id}`, batchPromise);
      }

      await Promise.all([
        ...newBatchPromises,
        ...alreadyInFlight.map((id) => inFlight.get(`${identity}:${id}`) ?? Promise.resolve()),
      ]);
    }

    (async () => {
      // Layer 1, step 2: hydrate the in-memory cache from the persisted
      // AsyncStorage layer for any id this hook instance doesn't already
      // have in memory — before deciding what's actually missing. See
      // use-signed-item-images.ts's matching comment for the full
      // rationale (only ever fills a gap, never overwrites an in-memory
      // entry, skips an already-expired persisted entry entirely).
      const needsHydration = ids.filter((id) => !cache.has(`${identity}:${id}`));
      if (needsHydration.length) {
        const persisted = await readPersistedSignedUrlMap(CACHE_DOMAIN, identity);
        if (cancelled) return;
        let hydratedAny = false;
        for (const id of needsHydration) {
          const entry = persisted[id];
          if (entry && entry.expiresAt > Date.now()) {
            cache.set(`${identity}:${id}`, { url: entry.url, expiresAt: entry.expiresAt });
            hydratedAny = true;
          }
        }
        if (hydratedAny) bump((n) => n + 1);
      }

      const missing = ids.filter((id) => !isFresh(cache.get(`${identity}:${id}`)));
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
      const stillMissing = missing.filter((id) => !isFresh(cache.get(`${identity}:${id}`)));
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
  }, [key, identity, version]);

  const urls = new Map<string, string>();
  const statuses = new Map<string, SignedCoverStatus>();
  for (const id of ids) {
    const entry = cache.get(`${identity}:${id}`);
    if (isUsable(entry)) {
      if (entry.url) {
        urls.set(id, entry.url);
        statuses.set(id, 'ready');
      } else {
        statuses.set(id, 'unavailable');
      }
    } else {
      statuses.set(id, 'loading');
    }
  }

  return { urls, statuses };
}
