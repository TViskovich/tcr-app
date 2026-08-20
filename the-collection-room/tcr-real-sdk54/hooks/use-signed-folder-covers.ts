import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { supabaseAnonKey, supabaseUrl } from '@/lib/supabase';

// Client-side companion to the get-folder-cover-signed-url Edge Function
// (item-images beta privacy hardening, Phase 3D). Batches every distinct,
// currently-requested folders.id through that function, caches results in
// memory for the same TTL the backend issues (300s), and re-fetches only
// what's missing or stale. Never accepts or derives a storage_path, never
// calls Storage's createSignedUrl() directly, never persists a signed URL,
// and never reads/trusts folder.cover_image_url — all authorization and
// cover resolution happens server-side, every time; this hook only owns
// caching/batching/refresh.
//
// Deliberately duplicates (rather than shares via a common internal
// module) the direct-fetch/identity-scoped-cache design from
// hooks/use-signed-item-images.ts: that hook is already runtime-validated
// against a proven auth-transport bug (Phase 3C), and this one resolves a
// different id space against a different table server-side — folding them
// into one shared abstraction now would mean touching validated code to
// support an unvalidated caller, not a size reduction worth that risk.
//
// Uses a direct fetch(), not supabase.functions.invoke() — see
// use-signed-item-images.ts's module comment for the full rationale
// (invoke() unconditionally attaches an Authorization header, falling back
// to the client's configured project key when there's no session, which
// this endpoint's anonymous-caller support can't safely distinguish from a
// genuinely invalid user JWT).

const EDGE_FUNCTION = 'get-folder-cover-signed-url';
const MAX_BATCH_SIZE = 50;
const TTL_MS = 300_000;
// Treat a cached entry as stale slightly before its real server-side
// expiry, so a render never hands out a URL Storage is about to reject.
const REFRESH_SKEW_MS = 15_000;

export type SignedCoverStatus = 'loading' | 'ready' | 'unavailable';

// url === null means the server explicitly returned `unavailable` for this
// id (not found, not authorized, or no resolvable cover) — cached for the
// same TTL as a success so an unauthorized/coverless folder isn't
// re-requested on every render, while still being naturally re-checked
// after the TTL window.
type CacheEntry = { url: string | null; expiresAt: number };

// Module-level, in-memory only, shared across every hook instance/screen —
// never persisted to storage or the database, cleared on app reload. Keyed
// by `${identity}:${folderId}`, not just folderId — identity is the
// caller's user id, or the literal string 'anon' with no session. This is
// what keeps an anonymous denial (e.g. a request that legitimately ran
// before session restoration finished) from ever being read back as the
// answer for the same folder once the real owner's session is available,
// and prevents any cross-user reuse of a signed URL that was only ever
// authorized for one specific caller — same design and rationale as
// hooks/use-signed-item-images.ts's cache.
const cache = new Map<string, CacheEntry>();

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && entry.expiresAt - REFRESH_SKEW_MS > Date.now();
}

type EdgeResult =
  | { id: string; status: 'ok'; signed_url: string; expires_in: number }
  | { id: string; status: 'unavailable' };

async function fetchSignedCoverBatch(
  folderIds: string[],
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
      body: JSON.stringify({ folder_ids: folderIds }),
    });
  } catch (e) {
    if (__DEV__) console.error('[useSignedFolderCovers] batch request threw:', e);
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
      console.error('[useSignedFolderCovers] batch request failed:', {
        status: res.status,
        body: bodyText,
        batchSize: folderIds.length,
      });
    }
    return null;
  }

  const json = await res.json().catch(() => null);
  if (!json?.results) return null;
  return json.results as EdgeResult[];
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

  useEffect(() => {
    if (!ids.length) return;
    const missing = ids.filter((id) => !isFresh(cache.get(`${identity}:${id}`)));
    if (!missing.length) return;

    let cancelled = false;

    (async () => {
      for (let i = 0; i < missing.length; i += MAX_BATCH_SIZE) {
        const batch = missing.slice(i, i + MAX_BATCH_SIZE);
        const results = await fetchSignedCoverBatch(batch, accessToken);
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
    // intentional, stable dependencies — same rationale as
    // use-signed-item-images.ts's effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, identity]);

  const urls = new Map<string, string>();
  const statuses = new Map<string, SignedCoverStatus>();
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
