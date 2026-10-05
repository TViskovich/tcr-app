import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { DM_ATTACHMENTS_BUCKET } from '@/lib/dm-images';
import {
  DM_ATTACHMENTS_CACHE_DOMAIN,
  mergePersistedSignedUrlEntries,
  readPersistedSignedUrlMap,
} from '@/lib/persisted-signed-url-cache';
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
// full TTL. A per-object error (missing/forbidden) is a real answer.
const FAILURE_TTL_MS = 10_000;
const BATCH_WINDOW_MS = 25;

export type DmImageUrlState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'unavailable' };

type Entry = { url: string | null; expiresAt: number };

const memory = new Map<string, Entry>(); // `${identity}:${path}`
const inFlight = new Map<string, Promise<void>>();
const hydrated = new Set<string>(); // identities whose persisted map was loaded

let pending: { identity: string; paths: Set<string>; waiters: (() => void)[] } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function dmImageCacheKey(identity: string, path: string) {
  return `${identity}:dm-image:${path}`;
}

function usable(entry: Entry | undefined) {
  return !!entry && entry.expiresAt - REFRESH_SKEW_MS > Date.now();
}

async function hydrate(identity: string) {
  if (hydrated.has(identity)) return;
  hydrated.add(identity);
  const persisted = await readPersistedSignedUrlMap(DM_ATTACHMENTS_CACHE_DOMAIN, identity);
  for (const [path, entry] of Object.entries(persisted)) {
    const key = `${identity}:${path}`;
    if (!memory.has(key)) memory.set(key, entry);
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
      for (const p of paths) memory.set(`${batch.identity}:${p}`, { url: null, expiresAt: now + FAILURE_TTL_MS });
    } else {
      const toPersist: Record<string, Entry> = {};
      const byPath = new Map(data.map((d) => [d.path, d]));
      for (const p of paths) {
        const r = byPath.get(p);
        const entry: Entry =
          r && !r.error && r.signedUrl
            ? { url: r.signedUrl, expiresAt: now + SIGNED_URL_TTL_S * 1000 }
            : { url: null, expiresAt: now + SIGNED_URL_TTL_S * 1000 };
        memory.set(`${batch.identity}:${p}`, entry);
        toPersist[p] = entry;
      }
      mergePersistedSignedUrlEntries(DM_ATTACHMENTS_CACHE_DOMAIN, batch.identity, toPersist).catch(() => {});
    }
  } catch {
    const now = Date.now();
    for (const p of paths) memory.set(`${batch.identity}:${p}`, { url: null, expiresAt: now + FAILURE_TTL_MS });
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
  return entry.url ? { status: 'ready', url: entry.url } : { status: 'unavailable' };
}

export function useDmImageUrl(path: string | null): DmImageUrlState {
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const key = path ? `${identity}:${path}` : null;
  const [, bump] = useState(0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    (async () => {
      await hydrate(identity);
      if (cancelled) return;
      if (!usable(memory.get(`${identity}:${path}`))) await request(identity, path);
      if (!cancelled) bump((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [identity, path]);

  if (!key) return { status: 'unavailable' };
  return stateFor(memory.get(key));
}
