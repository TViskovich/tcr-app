import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { getRegistrySnapshotImageUrl } from '@/lib/registry-images';

// Client-side companion to the get-registry-snapshot-image-url Edge
// Function — the registry/transfer-history equivalent of
// hooks/use-signed-item-images.ts. Resolves one or more registered_cards.id
// values to their short-lived signed registry-images URL, caches results in
// memory for the same TTL the backend issues (300s), and re-fetches only
// what's missing or stale. Never reads/derives a storage_path itself, never
// calls Storage's createSignedUrl() directly, and never persists a signed
// URL anywhere — all authorization happens server-side, every time, via
// lib/registry-images.ts's getRegistrySnapshotImageUrl() (never
// reimplemented here).
//
// The image this resolves is the card's own immutable snapshot
// (registered_cards.snapshot_image_storage_path), never derived from the
// current live collection_items row — that's what makes it correct for
// historical transfer records after ownership has moved on or the
// originating item has changed.
//
// One real difference from useSignedItemImages: get-registry-snapshot-
// image-url only ever signs a single registered_card_id per request (see
// its own module comment — no batch endpoint exists), so this hook fires
// one request per missing id (in parallel, not batched over the wire) from
// a single shared hook instance at the list level, rather than one HTTP
// call per row. That's still "one signing/cache path shared across every
// visible row," just not a single network round trip the way the
// item-images batch endpoint allows.
//
// A second real difference: getRegistrySnapshotImageUrl() already collapses
// every failure mode (a thrown invoke() error, a non-ok response, a
// genuine per-card authorization denial) into the same `{ status:
// 'unavailable' }` shape — unlike use-signed-item-images.ts's own direct
// fetch(), there is no HTTP status code available here to classify
// "transient network blip" apart from "considered denial," because
// reusing the existing helper (rather than recreating its request/response
// handling) means accepting its narrower return type. Retries below are
// therefore uniform rather than status-classified: bounded, and every
// post-retry 'unavailable' — whether a real denial or a blip — is cached
// for the same short FAILURE_TTL_MS. This is intentionally more
// conservative than the item-images hook's TTL_MS-for-genuine-denials
// behavior, trading a few extra re-checks of genuinely private/nonexistent
// cards (harmless — authorization is re-verified fresh every single call)
// for never needing to guess at a distinction the reused helper doesn't
// expose.

const TTL_MS = 300_000; // matches SIGNED_URL_TTL_SECONDS in the Edge Function
// Treat a cached entry as stale slightly before its real server-side
// expiry, so a render never hands out a URL Storage is about to reject.
const REFRESH_SKEW_MS = 15_000;

// Bounded retry/backoff — see the module comment above for why this is
// uniform rather than status-classified. Two retries, not indefinite: this
// exists to self-heal a transient blip, not to keep hammering a genuinely
// broken backend or a genuinely denied card.
const RETRY_DELAYS_MS = [750, 2000];

// Lifetime for any cache entry written as 'unavailable' after retries were
// exhausted — deliberately much shorter than TTL_MS, for the same reason
// documented in use-signed-item-images.ts's own FAILURE_TTL_MS: holding a
// blank result for the full 300s would turn a brief blip into several
// minutes of an incorrectly-blank image, and a screen that rarely
// remounts (a transfer list sitting open) should self-correct well before
// that.
const FAILURE_TTL_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SignedRegistryImageStatus = 'loading' | 'ready' | 'unavailable';

// url === null covers both a genuine per-card denial/not-ready answer and
// an exhausted retry chain — both are cached as 'unavailable' with the
// same short FAILURE_TTL_MS, per the module comment above.
type CacheEntry = { url: string | null; expiresAt: number };

// Module-level, in-memory only, shared across every hook instance/screen —
// never persisted to storage, AsyncStorage, SecureStore, or the database,
// cleared on app reload. Keyed by `${identity}:${registeredCardId}`, not
// just the card id — identity is the caller's user id, or the literal
// string 'anon' with no session. This keeps an anonymous or
// differently-authenticated denial from ever being read back as the
// answer for the same card once a session with real visibility (owner,
// creator) is available: it lands under a different cache key entirely.
const cache = new Map<string, CacheEntry>();

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && entry.expiresAt - REFRESH_SKEW_MS > Date.now();
}

// Single attempt + bounded retry for one registered_card_id, entirely via
// the existing getRegistrySnapshotImageUrl() helper — no signing logic of
// any kind lives in this function. isCancelled is checked after every
// await so a hook unmount mid-retry never causes a stale cache write.
async function resolveRegistryImageWithRetry(
  registeredCardId: string,
  isCancelled: () => boolean,
): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const result = await getRegistrySnapshotImageUrl(registeredCardId);
    if (isCancelled()) return null;
    if (result.status === 'ok') return result.signed_url;

    if (attempt >= RETRY_DELAYS_MS.length) return null;

    await delay(RETRY_DELAYS_MS[attempt]);
    if (isCancelled()) return null;
  }
}

// Accepts registered_cards.id values only (nulls/undefineds filtered out,
// safe to pass directly from a `.map(t => t.card?.registeredCardId)` over
// possibly-unresolved transfer rows). Returns a snapshot of the shared
// cache for exactly the requested ids, plus a per-id status so callers can
// distinguish "still resolving" from "the server said no" without falling
// back to any raw/legacy URL.
export function useSignedRegistryImages(registeredCardIds: (string | null | undefined)[]): {
  urls: Map<string, string>;
  statuses: Map<string, SignedRegistryImageStatus>;
} {
  // The existing app-wide auth subscription (lib/auth.tsx), not a second
  // one — lets this hook react to sign-in/sign-out without introducing its
  // own onAuthStateChange listener. getRegistrySnapshotImageUrl() reads
  // the current session itself (via supabase.functions.invoke()'s own
  // auto-attached Authorization header) on every call, so no access token
  // needs to be threaded through here manually.
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';

  const ids = Array.from(new Set(registeredCardIds.filter((id): id is string => !!id))).sort();
  const key = ids.join(',');

  // Forces a re-render once a resolution settles — the cache itself lives
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
      await Promise.all(
        missing.map(async (id) => {
          const url = await resolveRegistryImageWithRetry(id, isCancelled);
          if (cancelled) return;
          const now = Date.now();
          cache.set(`${identity}:${id}`, {
            url,
            expiresAt: now + (url ? TTL_MS : FAILURE_TTL_MS),
          });
        }),
      );
      if (!cancelled) bump((n) => n + 1);
    })();

    return () => {
      cancelled = true;
    };
    // `key` (a sorted/joined snapshot of `ids`) and `identity` are the
    // intentional, stable dependencies — depending on `registeredCardIds`/
    // `ids` directly would re-run this effect on every render, since a
    // fresh array is passed in each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, identity]);

  const urls = new Map<string, string>();
  const statuses = new Map<string, SignedRegistryImageStatus>();
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
