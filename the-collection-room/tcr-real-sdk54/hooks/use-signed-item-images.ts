import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { supabase, supabaseAnonKey, supabaseUrl } from '@/lib/supabase';

// Client-side companion to the get-collection-item-image-signed-url Edge
// Function (item-images beta privacy hardening, Phase 3). Batches every
// distinct, currently-requested collection_item_images.id through that
// function, caches results in memory for the same TTL the backend issues
// (300s), and re-fetches only what's missing or stale. Never accepts or
// derives a storage_path, never calls Storage's createSignedUrl() directly,
// and never persists a signed URL anywhere — all authorization happens
// server-side, every time; this hook only owns caching/batching/refresh.
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
const MAX_BATCH_SIZE = 50;
const TTL_MS = 300_000;
// Treat a cached entry as stale slightly before its real server-side
// expiry, so a render never hands out a URL Storage is about to reject.
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
// after the outage clears, without requiring a remount.
const FAILURE_TTL_MS = 10_000;

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
// expected lifetimes.
type CacheEntry = { url: string | null; expiresAt: number; isTransientFailure?: boolean };

// Module-level, in-memory only, shared across every hook instance/screen —
// never persisted to storage or the database, cleared on app reload. Keyed
// by `${identity}:${imageId}`, not just imageId (Phase 3C fix) — identity is
// the caller's user id, or the literal string 'anon' with no session. This
// keeps an anonymous denial (e.g. a request that legitimately ran before
// session restoration finished) from ever being read back as the answer for
// the same image once the real owner's session is available: it lands under
// a different cache key entirely, so the authenticated read is always a
// fresh lookup rather than a stale 'unavailable' held over from an earlier,
// differently-authenticated request. It also prevents any cross-user reuse
// of a signed URL that was only ever authorized for one specific caller.
const cache = new Map<string, CacheEntry>();

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  if (!entry) return false;
  // REFRESH_SKEW_MS exists to preempt a real signed URL's own server-side
  // expiry — meaningless for a transient-failure placeholder, which isn't
  // a signed URL at all and already uses a much shorter FAILURE_TTL_MS.
  // Applying the skew on top of that would make an entry expire (10s -
  // 15s < 0) the instant it's written, immediately reporting 'loading'
  // again despite this hook's own retry policy already having been fully
  // exhausted for it — exactly the stuck/looping state this change exists
  // to prevent.
  if (entry.isTransientFailure) return entry.expiresAt > Date.now();
  return entry.expiresAt - REFRESH_SKEW_MS > Date.now();
}

type EdgeResult =
  | { id: string; status: 'ok'; signed_url: string; expires_in: number }
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
// request never got a response at all (fetch itself threw); any other
// status is the real HTTP status Supabase's gateway or the Edge Function
// returned.
async function fetchSignedImageBatchAttempt(
  imageIds: string[],
  accessToken: string | null,
): Promise<BatchAttempt> {
  const headers: Record<string, string> = {
    apikey: supabaseAnonKey,
    'Content-Type': 'application/json',
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  let res: Response;
  try {
    res = await fetch(`${supabaseUrl}/functions/v1/${EDGE_FUNCTION}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ image_ids: imageIds }),
    });
  } catch (e) {
    if (__DEV__) console.error('[useSignedItemImages] batch request threw:', e);
    return { ok: false, status: null };
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
): Promise<BatchAttempt> {
  let accessToken = initialAccessToken;
  let attempt = 0;

  for (;;) {
    const result = await fetchSignedImageBatchAttempt(imageIds, accessToken);
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
export function useSignedItemImages(imageIds: (string | null | undefined)[]): {
  urls: Map<string, string>;
  statuses: Map<string, SignedImageStatus>;
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

  // Forces a re-render once a batch resolves — the cache itself lives
  // outside React state (see `cache` above) so multiple hook instances
  // share it, but each instance still needs to know when to re-read it.
  const [, bump] = useState(0);

  useEffect(() => {
    if (!ids.length) return;
    const missing = ids.filter((id) => !isFresh(cache.get(`${identity}:${id}`)));
    if (!missing.length) return;

    let cancelled = false;
    const isCancelled = () => cancelled;

    (async () => {
      for (let i = 0; i < missing.length; i += MAX_BATCH_SIZE) {
        const batch = missing.slice(i, i + MAX_BATCH_SIZE);
        const outcome = await fetchSignedImageBatchWithRetry(batch, accessToken, isCancelled);
        if (cancelled) return;

        const now = Date.now();
        if (outcome.ok) {
          for (const r of outcome.results) {
            cache.set(`${identity}:${r.id}`, {
              url: r.status === 'ok' ? r.signed_url : null,
              expiresAt: now + TTL_MS,
            });
          }
        } else {
          // Every retry for this batch was exhausted (or the failure
          // wasn't retryable at all) — cache every id in it as
          // unavailable so status doesn't stay stuck at 'loading' forever,
          // but marked isTransientFailure and expired after the much
          // shorter FAILURE_TTL_MS rather than the normal TTL_MS (see that
          // constant's comment): this was never a real authorization
          // answer, just the last observation during what's most likely a
          // brief outage, and a screen that rarely remounts/re-requests
          // (Profile Grails' static whole-grid batch being the motivating
          // case) should self-correct within ~10s of the outage clearing,
          // not stay blank for several minutes.
          for (const id of batch) {
            cache.set(`${identity}:${id}`, { url: null, expiresAt: now + FAILURE_TTL_MS, isTransientFailure: true });
          }
        }
      }
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
  }, [key, identity]);

  const urls = new Map<string, string>();
  const statuses = new Map<string, SignedImageStatus>();
  for (const id of ids) {
    const entry = cache.get(`${identity}:${id}`);
    if (isFresh(entry)) {
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
