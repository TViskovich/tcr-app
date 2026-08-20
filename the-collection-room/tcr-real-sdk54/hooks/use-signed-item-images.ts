import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { supabaseAnonKey, supabaseUrl } from '@/lib/supabase';

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

export type SignedImageStatus = 'loading' | 'ready' | 'unavailable';

// url === null means the server explicitly returned `unavailable` for this
// id (not found, or not authorized) — cached for the same TTL as a success
// so an unauthorized id isn't re-requested on every render, while still
// being naturally re-checked after the TTL window (e.g. if the folder's
// visibility or the caller's own session changes in the meantime).
type CacheEntry = { url: string | null; expiresAt: number };

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
  return !!entry && entry.expiresAt - REFRESH_SKEW_MS > Date.now();
}

type EdgeResult =
  | { id: string; status: 'ok'; signed_url: string; expires_in: number }
  | { id: string; status: 'unavailable' };

// Direct fetch, not supabase.functions.invoke() — see the module comment
// above for why. Mirrors invoke()'s request shape exactly (same URL
// convention, same body), but constructs the Authorization header itself:
// present (the real session token) only when a session exists, omitted
// entirely otherwise. apikey is always sent — it's what the Supabase
// gateway uses for project routing/rate-limiting, unrelated to per-request
// caller identity, and is already public-by-design (never a secret).
async function fetchSignedImageBatch(
  imageIds: string[],
  accessToken: string | null,
): Promise<EdgeResult[] | null> {
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
    return null;
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
    return null;
  }

  const json = await res.json().catch(() => null);
  if (!json?.results) return null;
  return json.results as EdgeResult[];
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

    (async () => {
      for (let i = 0; i < missing.length; i += MAX_BATCH_SIZE) {
        const batch = missing.slice(i, i + MAX_BATCH_SIZE);
        const results = await fetchSignedImageBatch(batch, accessToken);
        if (cancelled) return;
        if (!results) continue;

        const now = Date.now();
        for (const r of results) {
          cache.set(`${identity}:${r.id}`, {
            url: r.status === 'ok' ? r.signed_url : null,
            expiresAt: now + TTL_MS,
          });
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
