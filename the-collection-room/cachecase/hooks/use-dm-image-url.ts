import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { useForegroundGeneration } from '@/lib/app-foreground';
import { useAuth } from '@/lib/auth';
import { DM_ATTACHMENTS_BUCKET } from '@/lib/dm-images';
import {
  DM_ATTACHMENTS_CACHE_DOMAIN,
  mergePersistedSignedUrlEntries,
  readPersistedSignedUrlMap,
  registerSignedImageMemoryCache,
} from '@/lib/persisted-signed-url-cache';
import {
  classifyPersisted,
  expiryForAnswer,
  keyBelongsTo,
  nextNegativeCount,
  shouldInvalidate,
  TRANSIENT_FAILURE_TTL_MS,
} from '@/lib/signed-image-cache-policy';
import { supabase } from '@/lib/supabase';

// Signed-URL resolver for private DM photos. Authorization is Storage RLS
// itself (dm_attachments_select_participant): createSignedUrls only signs
// objects the caller can SELECT, i.e. conversation participants — no Edge
// Function. Signed URLs are a cache, never source-of-truth data: held in
// memory and in the persisted cache (DM_ATTACHMENTS_CACHE_DOMAIN, purged on
// logout by lib/auth.tsx), keyed per identity + storage path. The rendered
// image's expo-image cacheKey is the storage path (dmImageCacheKey), so disk
// caching survives URL rotation.

const SIGNED_URL_TTL_S = 3600;
// Re-sign once an entry is this close to expiry.
const REFRESH_SKEW_MS = 5 * 60_000;
// A request-level failure (network) is retried after this, not held for the
// full TTL. A per-object error (missing/forbidden) is a real answer — but
// (P2.3) a short-lived, memory-only one: NEGATIVE_TTL_MS, never persisted and
// never the 1-hour signed-URL TTL it used to get.
const FAILURE_TTL_MS = TRANSIENT_FAILURE_TTL_MS;
const BATCH_WINDOW_MS = 25;

export type DmImageUrlState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'unavailable' };

type Entry = { url: string | null; expiresAt: number; negatives?: number };

const memory = new Map<string, Entry>(); // `${identity}:${path}`
const inFlight = new Map<string, Promise<void>>();
const hydrated = new Set<string>(); // identities whose persisted map was loaded
// Mounted consumers per memory key. Every write to `memory` goes through
// setEntry, which notifies them, so a hook instance re-renders (via
// useSyncExternalStore) the moment its URL is signed, fails, or is
// hydrated from the persisted cache — however that write happened.
const listeners = new Map<string, Set<() => void>>();

function setEntry(key: string, entry: Entry) {
  memory.set(key, entry);
  // Notified on a microtask, never synchronously, so a write can never
  // re-render a subscriber mid-render (same as lib/feed-media-dimensions).
  queueMicrotask(() => {
    const subs = listeners.get(key);
    if (subs) for (const notify of [...subs]) notify();
  });
}

function deleteEntry(key: string) {
  if (!memory.delete(key)) return;
  queueMicrotask(() => {
    const subs = listeners.get(key);
    if (subs) for (const notify of [...subs]) notify();
  });
}

// Account change / known permission change (lib/persisted-signed-url-cache.ts).
registerSignedImageMemoryCache({
  clearIdentity(identity) {
    for (const k of [...memory.keys()]) if (keyBelongsTo(k, identity)) deleteEntry(k);
    hydrated.delete(identity);
  },
  invalidate(identity, scope) {
    for (const [k, e] of [...memory.entries()]) if (keyBelongsTo(k, identity) && shouldInvalidate(e, scope)) deleteEntry(k);
    if (scope === 'all') hydrated.delete(identity);
  },
});

let pending: { identity: string; paths: Set<string>; waiters: (() => void)[] } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function dmImageCacheKey(identity: string, path: string) {
  return `${identity}:dm-image:${path}`;
}

// A signed URL is renewed REFRESH_SKEW_MS early; a negative/failed answer
// simply lapses at its own (short) expiry — no skew, or it would never count
// as usable and be re-requested in a loop.
function usable(entry: Entry | undefined) {
  if (!entry) return false;
  return entry.url ? entry.expiresAt - REFRESH_SKEW_MS > Date.now() : entry.expiresAt > Date.now();
}

async function hydrate(identity: string) {
  if (hydrated.has(identity)) return;
  hydrated.add(identity);
  const persisted = await readPersistedSignedUrlMap(DM_ATTACHMENTS_CACHE_DOMAIN, identity);
  const now = Date.now();
  for (const [path, entry] of Object.entries(persisted)) {
    const key = `${identity}:${path}`;
    // Only still-valid signed URLs; an expired one or an old persisted
    // negative is never revived (it is simply re-signed).
    if (!memory.has(key) && classifyPersisted(entry, now) === 'usable') setEntry(key, entry);
  }
}

async function flush(batch: { identity: string; paths: Set<string>; waiters: (() => void)[] }) {
  const paths = Array.from(batch.paths);
  try {
    const { data, error } = await supabase.storage
      .from(DM_ATTACHMENTS_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_S);
    const now = Date.now();
    if (error || !data) {
      for (const p of paths) setEntry(`${batch.identity}:${p}`, { url: null, expiresAt: now + FAILURE_TTL_MS });
    } else {
      const toPersist: Record<string, Entry> = {};
      const byPath = new Map(data.map((d) => [d.path, d]));
      for (const p of paths) {
        const r = byPath.get(p);
        const url = r && !r.error && r.signedUrl ? r.signedUrl : null;
        // Review F3: repeated "unavailable" answers back off (20 → … → 300 s).
        const negatives = url ? undefined : nextNegativeCount(memory.get(`${batch.identity}:${p}`));
        const entry: Entry = {
          url,
          expiresAt: expiryForAnswer(url, now, SIGNED_URL_TTL_S * 1000, negatives),
          ...(negatives ? { negatives } : {}),
        };
        setEntry(`${batch.identity}:${p}`, entry);
        if (url) toPersist[p] = entry;
      }
      mergePersistedSignedUrlEntries(DM_ATTACHMENTS_CACHE_DOMAIN, batch.identity, toPersist).catch(() => {});
    }
  } catch {
    const now = Date.now();
    for (const p of paths) setEntry(`${batch.identity}:${p}`, { url: null, expiresAt: now + FAILURE_TTL_MS });
  } finally {
    for (const p of paths) inFlight.delete(`${batch.identity}:${p}`);
    batch.waiters.forEach((w) => w());
  }
}

// Coalesces every path requested within BATCH_WINDOW_MS into one
// createSignedUrls call (a conversation can render many photos at once).
function request(identity: string, path: string): Promise<void> {
  const key = `${identity}:${path}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  if (!pending || pending.identity !== identity) {
    if (pending && timer) {
      clearTimeout(timer);
      const prev = pending;
      pending = null;
      flush(prev);
    }
    pending = { identity, paths: new Set(), waiters: [] };
  }
  const batch = pending;
  batch.paths.add(path);
  const promise = new Promise<void>((resolve) => batch.waiters.push(resolve));
  inFlight.set(key, promise);
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      const b = pending;
      pending = null;
      if (b) flush(b);
    }, BATCH_WINDOW_MS);
  }
  return promise;
}

function stateFor(entry: Entry | undefined): DmImageUrlState {
  if (!entry) return { status: 'loading' };
  if (entry.url) {
    // An expired authorization is never displayed (P2.3); it is re-signed.
    return entry.expiresAt > Date.now() ? { status: 'ready', url: entry.url } : { status: 'loading' };
  }
  return { status: 'unavailable' };
}

export function useDmImageUrl(path: string | null): DmImageUrlState {
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const key = path ? `${identity}:${path}` : null;
  // The cache entry is read through useSyncExternalStore, not directly from
  // `memory` during render: React Compiler treats module state as constant,
  // so a direct read was memoized on `key` alone and the first render's
  // { status: 'loading' } stuck after signing succeeded (the black DM photo
  // frame). As a store snapshot the entry is a real render input, and
  // setEntry's notification re-renders this instance when it changes.
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!key) return () => {};
      let subs = listeners.get(key);
      if (!subs) {
        subs = new Set();
        listeners.set(key, subs);
      }
      subs.add(onChange);
      return () => {
        subs.delete(onChange);
        if (!subs.size && listeners.get(key) === subs) listeners.delete(key);
      };
    },
    [key],
  );
  const entry = useSyncExternalStore(subscribe, () => (key ? memory.get(key) : undefined));
  const foregroundGeneration = useForegroundGeneration();

  // Re-runs on mount, on return to the foreground, and whenever the entry
  // changes — so a short-lived negative or failed answer (or an entry dropped
  // by an invalidation) is re-signed when it lapses instead of staying blank
  // until the screen remounts.
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      await hydrate(identity);
      if (cancelled) return;
      const current = memory.get(`${identity}:${path}`);
      if (!usable(current)) {
        await request(identity, path);
        return;
      }
      if (current && !current.url) {
        timer = setTimeout(() => {
          if (!cancelled) void request(identity, path);
        }, Math.max(current.expiresAt - Date.now(), 1_000));
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [identity, path, entry, foregroundGeneration]);

  if (!key) return { status: 'unavailable' };
  return stateFor(entry);
}
