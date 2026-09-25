import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { DEFAULT_IMAGE_TIER, imageTierCacheSuffix, type ImageTier } from '@/lib/image-tiers';
import {
  ITEM_IMAGES_CACHE_DOMAIN,
  mergePersistedSignedUrlEntries,
  readPersistedSignedUrlMap,
} from '@/lib/persisted-signed-url-cache';
import { supabase, supabaseAnonKey, supabaseUrl } from '@/lib/supabase';

// Client-side companion to the get-collection-item-image-signed-url Edge
// Function (item-images beta privacy hardening, Phase 3). Batches every
// distinct, currently-requested collection_item_images.id through that
// function, caches results in memory for the same TTL the backend issues
// (300s), and re-fetches only what's missing or stale. Never accepts or
// derives a storage_path, never calls Storage's createSignedUrl() directly,
// and never derives authorization client-side — all of that happens
// server-side, every time; this hook only owns caching/batching/refresh
// (now across both memory AND a persisted AsyncStorage layer — see the
// private-image caching upgrade, Phase 1 — and never the private bucket
// bytes themselves, still entirely expo-image's own concern).
//
// Uses a direct fetch() rather than supabase.functions.invoke() (Phase 3C
// auth-transport fix). @supabase/supabase-js's invoke() unconditionally
// attaches an Authorization header, falling back to the client's configured
// project key whenever auth.getSession() has no session — a documented SDK
// behavior, not a bug, but one this app's Edge Function side had no reliable
// way to distinguish from a genuinely invalid/expired user JWT (a prior fix
// attempting to match the incoming token against the platform's
// SUPABASE_ANON_KEY env var was deployed and failed at runtime: the client
// here is configured with a newer sb_publishable_... key, and there is no
// proof that value is ever mirrored into that legacy-named Edge Function
// env var). Sending the Authorization header ourselves — present only when
// a real session exists, absent otherwise — removes the ambiguity instead
// of trying to teach the backend every possible public-key representation.

const EDGE_FUNCTION = 'get-collection-item-image-signed-url';
// The persisted-cache domain for this hook (lib/persisted-signed-url-cache.ts)
// — exported from there, not declared locally, specifically so lib/auth.tsx
// can purge it on logout without importing this hook file (see that
// constant's own comment for the circular-import reason why).
const CACHE_DOMAIN = ITEM_IMAGES_CACHE_DOMAIN;
const MAX_BATCH_SIZE = 50;
const TTL_MS = 300_000;
// Treat a cached entry as due for a (background) refresh slightly before
// its real server-side expiry, so a request never goes out this close to
// Storage rejecting it. Does NOT gate whether a still-valid entry is
// SERVED — see isUsable below; this only gates whether the effect fires a
// quiet refetch for it.
const REFRESH_SKEW_MS = 15_000;

// Bounded retry/backoff for a REQUEST-level failure only (thrown network
// error, 5xx, 408, 429, or an auth-class 401/403) — never for a per-image
// 'unavailable' the Edge Function itself already resolved successfully,
// which is a real, final answer on the very first attempt regardless of
// how many ids in the batch came back that way. Two retries, not
// indefinite: this exists to self-heal a transient blip (the kind that
// left a still-mounted, rarely-remounted screen like the Profile Grails
// grid stuck at 'loading' forever with no natural retrigger), not to keep
// hammering a genuinely broken/offline backend.
const RETRY_DELAYS_MS = [750, 2000];
const RETRYABLE_STATUSES = new Set([408, 429]);

// Lifetime for a cache entry written after every retry above was exhausted
// (or the failure wasn't retryable at all) — deliberately much shorter than
// TTL_MS. A genuine 'unavailable' answer from the Edge Function is a
// considered authorization decision that's cheap to hold for the full
// signed-URL TTL; an exhausted request-level failure is not a decision at
// all, just the last thing this hook happened to observe during (most
// likely) a brief network/auth blip — holding it blank for the full 300s
// would turn that blip into several minutes of an incorrectly-blank image.
// 10s is long enough to avoid hammering a genuinely down backend on every
// render, short enough that the image corrects itself on its own soon
// after the outage clears, without requiring a remount. Entries marked
// isTransientFailure are NEVER written to the persisted AsyncStorage layer
// (see the runPass loop below) — only a real answer (success or a
// considered 'unavailable') is worth remembering across an app kill.
const FAILURE_TTL_MS = 10_000;

// Delay before the single bounded follow-up pass (see the fetch effect
// below) — shorter than FAILURE_TTL_MS on purpose: this only needs to give
// a brief cold-start network hiccup a moment to clear, not wait out the
// full cache lifetime of a transient-failure entry.
const FOLLOWUP_RETRY_DELAY_MS = 4_000;

function isRetryableStatus(status: number | null): boolean {
  return status === null || status >= 500 || RETRYABLE_STATUSES.has(status);
}

function isAuthStatus(status: number | null): boolean {
  return status === 401 || status === 403;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SignedImageStatus = 'loading' | 'ready' | 'unavailable';

// url === null means either the server explicitly returned `unavailable`
// for this id (not found, or not authorized — a genuine, considered answer,
// cached for the same TTL as a success) or every retry for a request-level
// failure was exhausted (isTransientFailure: true, cached for the much
// shorter FAILURE_TTL_MS instead — see that constant's own comment). The
// two are never conflated: a real authorization denial and "the request
// itself never got a real answer" are different facts with different
// expected lifetimes, and only the former is ever persisted to disk.
// servedTier is set ONLY when the server served a different tier than was
// requested (a transformed-URL fallback to the original) — such an entry is
// display-only: held in memory under the requested tier so the image still
// renders, never persisted, and always treated as not-fresh (see isFresh) so
// a later request for the requested tier retries the real transform instead
// of trusting the fallback.
type CacheEntry = {
  url: string | null;
  expiresAt: number;
  isTransientFailure?: boolean;
  servedTier?: ImageTier;
};

// Module-level, in-memory first-level cache, shared across every hook
// instance/screen — cleared on app reload, but now backed by a persisted
// AsyncStorage layer (see the fetch effect below) that survives one.
// Keyed by `${identity}:${imageId}`, not just imageId (Phase 3C fix) —
// identity is the caller's user id, or the literal string 'anon' with no
// session. This keeps an anonymous denial (e.g. a request that legitimately
// ran before session restoration finished) from ever being read back as the
// answer for the same image once the real owner's session is available: it
// lands under a different cache key entirely, so the authenticated read is
// always a fresh lookup rather than a stale 'unavailable' held over from an
// earlier, differently-authenticated request. It also prevents any
// cross-user reuse of a signed URL that was only ever authorized for one
// specific caller. The persisted layer mirrors this exact same
// identity-scoping (see lib/persisted-signed-url-cache.ts's storage key).
const cache = new Map<string, CacheEntry>();

// Separate from `cache` above on purpose (Phase 1 in-flight dedupe) — this
// tracks signing work currently IN PROGRESS, not completed results. Keyed
// identically (`${identity}:${imageId}`). Two components requesting the
// same id at nearly the same time (e.g. profile-v2-screen.tsx's own
// prewarm and a HorizontalCardPreview mounting moments later) both see the
// id as "missing" from `cache` before either request has resolved; without
// this, each would independently kick off its own Edge Function call for
// the same id. An id present here just awaits the existing promise instead
// of joining a new batch — see fetchDeduped below.
const inFlight = new Map<string, Promise<void>>();

// Gates whether the EFFECT below fires a (possibly background) refetch for
// an entry — unchanged from before Phase 1. Subtracts REFRESH_SKEW_MS for a
// real entry so a refresh starts slightly ahead of true expiry; a
// transient-failure placeholder ignores the skew entirely (see its own
// field comment) since it isn't a signed URL at all and already uses a much
// shorter FAILURE_TTL_MS.
function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  if (!entry) return false;
  if (entry.isTransientFailure) return entry.expiresAt > Date.now();
  // A tier-fallback entry is never "fresh": every effect pass (and the
  // single bounded follow-up pass) re-requests the real transform. It is
  // still SERVED meanwhile — isUsable ignores this flag.
  if (entry.servedTier) return false;
  return entry.expiresAt - REFRESH_SKEW_MS > Date.now();
}

// Gates whether the RENDER-time read below actually SERVES an entry — no
// skew subtracted, just real expiry. This is the Phase 1 near-expiry fix:
// an entry inside the refresh-skew window is still fully valid (Storage
// hasn't rejected it yet) and keeps rendering as 'ready'/'unavailable'
// exactly as it did a moment ago, while isFresh (above) independently tells
// the effect to quietly refresh it in the background — never a visible
// 'loading' flicker for an entry that's merely due for a refresh, only for
// one that's genuinely gone or never existed.
function isUsable(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && entry.expiresAt > Date.now();
}

type EdgeResult =
  // `tier` is what the server ACTUALLY served ('original' when a requested
  // transform fell back). Absent from a not-yet-redeployed function.
  | { id: string; status: 'ok'; signed_url: string; expires_in: number; tier?: ImageTier }
  | { id: string; status: 'unavailable' };

type BatchAttempt = { ok: true; results: EdgeResult[] } | { ok: false; status: number | null };

// Direct fetch, not supabase.functions.invoke() — see the module comment
// above for why. Mirrors invoke()'s request shape exactly (same URL
// convention, same body), but constructs the Authorization header itself:
// present (the real session token) only when a session exists, omitted
// entirely otherwise. apikey is always sent — it's what the Supabase
// gateway uses for project routing/rate-limiting, unrelated to per-request
// caller identity, and is already public-by-design (never a secret).
//
// A single attempt only — retry/backoff policy lives one level up, in
// fetchSignedImageBatchWithRetry, so this stays a plain "try once and
// report exactly what happened" primitive. `status: null` means the
// request never got a response at all (fetch itself threw, or it was
// aborted by FETCH_TIMEOUT_MS below); any other status is the real HTTP
// status Supabase's gateway or the Edge Function returned.
//
// FETCH_TIMEOUT_MS exists because a cold app launch can occasionally leave
// the very first fetch() issued hanging indefinitely at the native
// networking layer (DNS/TLS/radio not yet warmed up) — neither resolving
// nor rejecting. Without a timeout, that single stuck attempt silently
// stalls this whole hook forever for the affected ids: the fetch effect's
// deps ([key, identity]) never change on their own, so nothing ever
// retries it, and bump() (the only thing that would force a re-render once
// data arrives) never fires. The image only ever "fixes itself" if some
// OTHER, unrelated mount of this same hook (e.g. opening the item directly)
// happens to warm the shared module-level cache instead. Aborting after a
// bounded wait turns that permanent stall into an ordinary retryable
// failure (status: null, already handled by isRetryableStatus below) that
// fetchSignedImageBatchWithRetry's existing backoff can actually act on.
const FETCH_TIMEOUT_MS = 10_000;

async function fetchSignedImageBatchAttempt(
  imageIds: string[],
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
      // `tier` is only sent for non-original requests, so an 'original'
      // request body is byte-identical to what it was before tiers existed.
      body: JSON.stringify(tier === 'original' ? { image_ids: imageIds } : { image_ids: imageIds, tier }),
      signal: controller.signal,
    });
  } catch (e) {
    if (__DEV__) console.error('[useSignedItemImages] batch request threw:', e);
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
      console.error('[useSignedItemImages] batch request failed:', {
        status: res.status,
        body: bodyText,
        batchSize: imageIds.length,
      });
    }
    return { ok: false, status: res.status };
  }

  const json = await res.json().catch(() => null);
  if (!json?.results) return { ok: false, status: res.status };
  return { ok: true, results: json.results as EdgeResult[] };
}

// Wraps a single attempt with the bounded retry policy described above
// RETRY_DELAYS_MS. Only a request-level failure is ever retried — a
// successful response (however many of its ids came back 'unavailable')
// returns on the very first attempt, since that's the Edge Function's own
// considered authorization answer, not a failure of the request itself.
//
// 401/403 get their own handling rather than being retried with the exact
// token that was just rejected (which would just fail identically again):
// before that retry, this re-reads the CURRENT session via
// supabase.auth.getSession() — the same mechanism lib/auth.tsx's own
// AuthProvider already uses to seed session state on load, not a second/
// parallel auth path — so a retry after a stale-token 401 actually stands
// a chance of succeeding once Supabase's client-side auto-refresh has
// rotated the token, even if this hook's own `identity`/`accessToken`
// closure hasn't picked up the new session yet. Any other non-retryable
// status (e.g. a plain 400) is not retried at all.
//
// isCancelled is checked after every await so a hook unmount mid-retry
// never causes a state update once the retry chain finally settles — it
// simply returns `{ ok: false }` and the caller's own `if (cancelled)
// return;` (see the effect below) discards it.
async function fetchSignedImageBatchWithRetry(
  imageIds: string[],
  initialAccessToken: string | null,
  isCancelled: () => boolean,
  tier: ImageTier,
): Promise<BatchAttempt> {
  let accessToken = initialAccessToken;
  let attempt = 0;

  for (;;) {
    const result = await fetchSignedImageBatchAttempt(imageIds, accessToken, tier);
    if (isCancelled()) return { ok: false, status: null };
    if (result.ok) return result;

    const authFailure = isAuthStatus(result.status);
    const retryable = authFailure || isRetryableStatus(result.status);

    if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
      if (__DEV__) {
        console.error('[useSignedItemImages] batch request exhausted retries:', {
          lastStatus: result.status,
          attempts: attempt + 1,
          batchSize: imageIds.length,
          hadAccessToken: !!accessToken,
        });
      }
      return result;
    }

    if (authFailure) {
      const { data } = await supabase.auth.getSession();
      if (isCancelled()) return { ok: false, status: null };
      accessToken = data.session?.access_token ?? null;
    }

    await delay(RETRY_DELAYS_MS[attempt]);
    if (isCancelled()) return { ok: false, status: null };
    attempt += 1;
  }
}

// Accepts collection_item_images.id values only (nulls/undefineds filtered
// out, safe to pass directly from a `.map(img => img.id)` over
// possibly-incomplete data). Returns a snapshot of the shared cache for
// exactly the requested ids, plus a per-id status so callers can
// distinguish "still resolving" from "the server said no" without treating
// either as a reason to fall back to a raw public URL.
//
// `tier` (default 'original' — unchanged behavior for every existing caller)
// picks which server-approved representation of each image to sign: see
// lib/image-tiers.ts. The returned maps stay keyed by the plain image id; the
// tier only changes which cached/signed representation backs each entry, and
// is part of every cache identity below (in-memory, persisted, in-flight) so
// the same image at two tiers never collides.
export function useSignedItemImages(
  imageIds: (string | null | undefined)[],
  tier: ImageTier = DEFAULT_IMAGE_TIER,
): {
  urls: Map<string, string>;
  statuses: Map<string, SignedImageStatus>;
  // Only present for an id whose URL is a tier FALLBACK (requested tier
  // wasn't served — see CacheEntry.servedTier). Callers key expo-image's
  // byte cache on `servedTiers.get(id) ?? requestedTier` so fallback
  // original bytes never land under the requested tier's cacheKey.
  servedTiers: Map<string, ImageTier>;
} {
  // The existing app-wide auth subscription (lib/auth.tsx), not a second
  // one — reusing it is what lets this hook react to sign-in/sign-out
  // without introducing its own onAuthStateChange listener. session.user.id
  // (not the full session/token) is the effect dependency below, so a
  // background token refresh that keeps the same identity never triggers a
  // refetch of already-fresh cache entries.
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const accessToken = session?.access_token ?? null;

  const ids = Array.from(new Set(imageIds.filter((id): id is string => !!id))).sort();
  const key = ids.join(',');

  // Tier-qualified identity for one image in the module cache, in-flight map,
  // and persisted AsyncStorage map. 'original' has no suffix, so every
  // pre-tier cache entry (memory or persisted) keeps its exact old key.
  const tierSuffix = imageTierCacheSuffix(tier);
  const cacheIdOf = (id: string) => `${id}${tierSuffix}`;

  // Forces a re-render once a batch resolves — the cache itself lives
  // outside React state (see `cache` above) so multiple hook instances
  // share it, but each instance still needs to know when to re-read it.
  const [, bump] = useState(0);

  useEffect(() => {
    if (!ids.length) return;

    let cancelled = false;
    const isCancelled = () => cancelled;

    // One pass over `idsToTry`: ids already being fetched by another
    // in-flight call just await that shared promise (no new request); the
    // rest are grouped into fresh batches, each registered against its own
    // promise in `inFlight` for the duration of that request so a
    // concurrent caller for the same id attaches instead of starting a
    // second one. Writes a normal TTL_MS entry (persisted to AsyncStorage
    // too) for every id that actually resolved, or a short-lived
    // isTransientFailure entry (memory only, never persisted) for every id
    // in a batch whose retries were exhausted. Shared by the initial pass
    // and the single bounded follow-up pass below, so the two stay
    // identical rather than risking drift between two hand-written copies
    // of the same logic.
    async function runPass(idsToTry: string[]): Promise<void> {
      const alreadyInFlight = idsToTry.filter((id) => inFlight.has(`${identity}:${cacheIdOf(id)}`));
      const toBatch = idsToTry.filter((id) => !inFlight.has(`${identity}:${cacheIdOf(id)}`));

      const newBatchPromises: Promise<void>[] = [];
      for (let i = 0; i < toBatch.length; i += MAX_BATCH_SIZE) {
        const batch = toBatch.slice(i, i + MAX_BATCH_SIZE);
        const batchPromise: Promise<void> = (async () => {
          try {
            const outcome = await fetchSignedImageBatchWithRetry(batch, accessToken, isCancelled, tier);
            if (cancelled) return;

            const now = Date.now();
            if (outcome.ok) {
              const toPersist: Record<string, { url: string | null; expiresAt: number }> = {};
              for (const r of outcome.results) {
                // Fallback = a non-original tier was requested but the
                // server didn't confirm serving it (it fell back to the
                // original, or an older un-redeployed function ignored
                // `tier`). Display-only: memory cache only, tagged with
                // what was actually served, and NOT persisted.
                const isFallback = tier !== 'original' && r.status === 'ok' && r.tier !== tier;
                const entry: CacheEntry = {
                  url: r.status === 'ok' ? r.signed_url : null,
                  expiresAt: now + TTL_MS,
                  ...(isFallback ? { servedTier: r.tier ?? ('original' as const) } : {}),
                };
                cache.set(`${identity}:${cacheIdOf(r.id)}`, entry);
                if (!isFallback) toPersist[cacheIdOf(r.id)] = entry;
              }
              // Fire-and-forget — never blocks rendering; a write failure
              // here only costs a future cold-launch network round trip,
              // never a correctness issue (see the helper's own comment).
              mergePersistedSignedUrlEntries(CACHE_DOMAIN, identity, toPersist).catch(() => {});
            } else {
              // Every retry for this batch was exhausted (or the failure
              // wasn't retryable at all) — cache every id in it as
              // unavailable so status doesn't stay stuck at 'loading'
              // forever, but marked isTransientFailure and expired after
              // the much shorter FAILURE_TTL_MS rather than the normal
              // TTL_MS: this was never a real authorization answer, just
              // the last observation during what's most likely a brief
              // outage — and, per the type's own comment, NEVER persisted
              // to AsyncStorage. A persisted transient failure would
              // otherwise survive an app kill and block a legitimate
              // future fetch for up to FAILURE_TTL_MS after every cold
              // launch, which defeats the whole point of that short TTL.
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

    (async () => {
      // Layer 1, step 2: hydrate the in-memory cache from the persisted
      // AsyncStorage layer for any id this hook instance doesn't already
      // have in memory — before deciding what's actually missing. Only
      // ever fills a gap; never overwrites an already-present in-memory
      // entry (which, within one running process, is always at least as
      // fresh as whatever was last persisted). An expired-by-now persisted
      // entry is simply skipped here and falls through to the normal
      // missing/fetch path below, exactly as if nothing had been
      // persisted for it.
      const needsHydration = ids.filter((id) => !cache.has(`${identity}:${cacheIdOf(id)}`));
      if (needsHydration.length) {
        const persisted = await readPersistedSignedUrlMap(CACHE_DOMAIN, identity);
        if (cancelled) return;
        let hydratedAny = false;
        for (const id of needsHydration) {
          const entry = persisted[cacheIdOf(id)];
          if (entry && entry.expiresAt > Date.now()) {
            cache.set(`${identity}:${cacheIdOf(id)}`, { url: entry.url, expiresAt: entry.expiresAt });
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
      // after the pass above (i.e. every in-pass retry for it was
      // exhausted) — this is what lets a screen that rarely
      // remounts/re-requests (Profile's Collection/Items tabs, the
      // motivating case) self-correct on its own within a few seconds of a
      // transient outage clearing, instead of depending on some unrelated
      // screen happening to warm the shared cache first. Exactly one
      // follow-up, never a loop or a repeating timer, so a genuinely
      // down backend still gives up rather than retrying forever.
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
    // intentional, stable dependencies — depending on `imageIds`/`ids`
    // directly would re-run this effect on every render, since a fresh
    // array is passed in each time; `accessToken` is deliberately excluded
    // since it can rotate without `identity` changing, and any request that
    // actually fires after such a rotation already reads the latest token
    // via this closure once `key`/`identity` next change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, identity, tier]);

  const urls = new Map<string, string>();
  const statuses = new Map<string, SignedImageStatus>();
  const servedTiers = new Map<string, ImageTier>();
  for (const id of ids) {
    const entry = cache.get(`${identity}:${cacheIdOf(id)}`);
    if (isUsable(entry)) {
      if (entry.url) {
        urls.set(id, entry.url);
        statuses.set(id, 'ready');
        if (entry.servedTier) servedTiers.set(id, entry.servedTier);
      } else {
        statuses.set(id, 'unavailable');
      }
    } else {
      statuses.set(id, 'loading');
    }
  }

  return { urls, statuses, servedTiers };
}
