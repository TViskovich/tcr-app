import { useEffect, useState } from 'react';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';

// Natural pixel size of feed media images, keyed by image URL. Nothing in
// the schema stores width/height for post images (posts.image_url,
// post_images, card_share snapshots), so a feed card can only size its
// variable-ratio media frame once the image's real shape is known. This
// module makes that knowledge available BEFORE an image renders wherever
// possible, so a card never shows an image at one geometry and then snaps
// it into another:
//   - memory: every size measured this session (survives scroll recycling,
//     remounts, and feed refreshes);
//   - persisted (AsyncStorage, bounded): sizes seen on earlier launches, so
//     a cold-start feed of already-seen posts renders final frames from its
//     first frame.
// Feed image URLs here are durable public share-snapshot URLs (never
// signed/rotating), so the URL is a stable identity for the image's shape.
//
// Only shapes are stored — never image bytes. Images themselves stay on
// expo-image's existing cache.

export type MediaSize = { width: number; height: number };

// 'failed' = measurement attempted and failed this session (memory only,
// never persisted) — callers fall back to their default frame rather than
// waiting forever.
const memory = new Map<string, MediaSize | 'failed'>();
const inFlight = new Map<string, Promise<void>>();

const STORAGE_KEY = 'cachecase:feed-media-dims:v1';
const MAX_PERSISTED = 500;
const PERSIST_DEBOUNCE_MS = 1000;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const entries: [string, [number, number]][] = [];
    for (const [uri, size] of memory) {
      if (size !== 'failed') entries.push([uri, [size.width, size.height]]);
    }
    // Map iteration is insertion order — keep only the most recent entries.
    const recent = entries.slice(-MAX_PERSISTED);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(recent)).catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
}

// Started at import (app start), long before any feed data arrives over the
// network. Only fills gaps — never overwrites a size measured this session.
const hydration: Promise<void> = AsyncStorage.getItem(STORAGE_KEY)
  .then((raw) => {
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) continue;
      const [w, h] = entry[1] as unknown[];
      if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 && !memory.has(entry[0])) {
        memory.set(entry[0], { width: w, height: h });
      }
    }
  })
  .catch(() => {});

function recordMediaSize(uri: string, width: number, height: number) {
  if (!(width > 0 && height > 0)) return;
  const existing = memory.get(uri);
  if (existing && existing !== 'failed' && existing.width === width && existing.height === height) return;
  memory.delete(uri); // re-insert as most recent
  memory.set(uri, { width, height });
  schedulePersist();
}

// Measures through expo-image itself (Image.loadAsync), so the bytes it
// fetches land in the same image cache the feed's <Image> then renders
// from — not a second, separate download the way RN's Image.getSize was.
// Deduped per URL; never throws.
function measureMediaSize(uri: string): Promise<void> {
  const pending = inFlight.get(uri);
  if (pending) return pending;
  const promise = (async () => {
    try {
      await hydration;
      if (memory.has(uri)) return;
      const ref = await Image.loadAsync(uri);
      recordMediaSize(uri, ref.width, ref.height);
      ref.release?.();
    } catch {
      if (!memory.has(uri)) memory.set(uri, 'failed');
    } finally {
      inFlight.delete(uri);
    }
  })();
  inFlight.set(uri, promise);
  return promise;
}

// The shape of one feed image: `size` is its natural size when known;
// `settled` is true once there's nothing left to wait for (size known,
// measurement failed, or no uri). Reads the shared cache synchronously at
// render, so a known size is there on a card's very FIRST render — and since
// it's derived from `uri` every render, a recycled card can never show the
// previous post's shape. Unknown sizes are measured once, in the background.
export function useMediaSize(uri: string | null | undefined): { size: MediaSize | null; settled: boolean } {
  const [, bump] = useState(0);

  useEffect(() => {
    if (!uri || memory.has(uri)) return;
    let cancelled = false;
    measureMediaSize(uri).then(() => {
      if (!cancelled) bump((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  if (!uri) return { size: null, settled: true };
  const known = memory.get(uri);
  if (known === undefined) return { size: null, settled: false };
  return { size: known === 'failed' ? null : known, settled: true };
}

// For an <Image>'s own onLoad: records a size the renderer learned anyway,
// so later renders of the same image never need to measure it.
export function rememberMediaSize(uri: string, width: number, height: number) {
  recordMediaSize(uri, width, height);
}
