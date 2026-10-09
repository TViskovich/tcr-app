import { useCallback, useEffect, useSyncExternalStore } from 'react';

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
// Feed image URLs here are durable public share-snapshot URLs, so the URL
// is a stable identity for the image's shape (Share Card's local preview
// also passes short-lived signed URLs through here — each still names one
// fixed image).
//
// Only shapes are stored — never image bytes. Images themselves stay on
// expo-image's existing cache.

export type MediaSize = { width: number; height: number };

// 'failed' = measurement attempted and failed this session (memory only,
// never persisted) — callers fall back to their default frame rather than
// waiting forever.
const memory = new Map<string, MediaSize | 'failed'>();
const inFlight = new Map<string, Promise<void>>();

// Subscribers per uri (useMediaSize instances). EVERY write to `memory`
// goes through setEntry, which notifies them — so an instance re-renders
// whenever its uri settles, however it settled: its own measurement,
// another instance's, the image's own onLoad (rememberMediaSize), or
// hydration. (It used to hear only about its OWN effect's measurement
// promise, so a uri settled any other way — or between an instance's
// render and its effect — left that instance's media unmounted until a
// remount re-read memory.)
const listeners = new Map<string, Set<() => void>>();

function setEntry(uri: string, entry: MediaSize | 'failed') {
  memory.delete(uri); // re-insert as most recent
  memory.set(uri, entry);
  // Notified on a microtask, never synchronously: a write can happen while
  // some component is rendering (Share Card's preview seeds a size during
  // its render), and a subscriber update mid-render is a React error.
  // useSyncExternalStore still reads the current value at every render.
  queueMicrotask(() => {
    const subs = listeners.get(uri);
    if (subs) for (const notify of [...subs]) notify();
  });
}

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
        setEntry(entry[0], { width: w, height: h });
      }
    }
  })
  .catch(() => {});

function recordMediaSize(uri: string, width: number, height: number) {
  if (!(width > 0 && height > 0)) return;
  const existing = memory.get(uri);
  if (existing && existing !== 'failed' && existing.width === width && existing.height === height) return;
  setEntry(uri, { width, height });
  schedulePersist();
}

// Bound on how long a card's media may wait for its measurement. Callers
// keep the media unmounted until the size is settled, so a measurement
// that never answers must not leave the frame empty forever.
const MEASURE_TIMEOUT_MS = 4000;

// Measures through expo-image itself (Image.loadAsync), so the bytes it
// fetches land in the same image cache the feed's <Image> then renders
// from — not a second, separate download the way RN's Image.getSize was.
// Deduped per URL; never throws.
//
// ALWAYS settles the uri: a usable size is recorded, and anything else —
// an error, a load that resolves without a usable size (Android reports
// the decoded drawable's intrinsic size, which can be -1), or no answer
// within MEASURE_TIMEOUT_MS — marks it 'failed', so the caller renders its
// media in the default frame instead of waiting on a size that will never
// arrive. A load that finishes after the timeout still records its size
// for later renders.
function measureMediaSize(uri: string): Promise<void> {
  const pending = inFlight.get(uri);
  if (pending) return pending;
  const promise = (async () => {
    try {
      await hydration;
      if (memory.has(uri)) return;
      const load = Image.loadAsync(uri).then((ref) => {
        recordMediaSize(uri, ref.width, ref.height);
        ref.release?.();
      });
      load.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MEASURE_TIMEOUT_MS);
      });
      try {
        await Promise.race([load, timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (!memory.has(uri)) setEntry(uri, 'failed');
    } catch {
      if (!memory.has(uri)) setEntry(uri, 'failed');
    } finally {
      inFlight.delete(uri);
    }
  })();
  inFlight.set(uri, promise);
  return promise;
}

// The shape of one feed image: `size` is its natural size when known;
// `settled` is true once there's nothing left to wait for (size known,
// measurement failed, or no uri). A subscription to the shared store
// (useSyncExternalStore), so a known size is there on a card's very FIRST
// render, and the instance re-renders the moment its uri settles by any
// path. Derived from `uri` every render, so a recycled card can never show
// the previous post's shape. Unknown sizes are measured once, in the
// background (deduped across instances).
export function useMediaSize(uri: string | null | undefined): { size: MediaSize | null; settled: boolean } {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!uri) return () => {};
      let subs = listeners.get(uri);
      if (!subs) {
        subs = new Set();
        listeners.set(uri, subs);
      }
      subs.add(onChange);
      return () => {
        subs.delete(onChange);
        if (!subs.size && listeners.get(uri) === subs) listeners.delete(uri);
      };
    },
    [uri],
  );
  const known = useSyncExternalStore(subscribe, () => (uri ? memory.get(uri) : undefined));

  useEffect(() => {
    if (uri && !memory.has(uri)) void measureMediaSize(uri);
  }, [uri]);

  if (!uri) return { size: null, settled: true };
  if (known === undefined) return { size: null, settled: false };
  return { size: known === 'failed' ? null : known, settled: true };
}

// For an <Image>'s own onLoad: records a size the renderer learned anyway,
// so later renders of the same image never need to measure it.
export function rememberMediaSize(uri: string, width: number, height: number) {
  recordMediaSize(uri, width, height);
}
