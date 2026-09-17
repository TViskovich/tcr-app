import { StyleSheet, View } from 'react-native';

import { Image } from 'expo-image';

// Phase 3 of the private-image caching upgrade. `Image.prefetch(url)`
// (native, promise-based) has no `cacheKey` option in the installed
// expo-image version (~3.0.11) — it always writes into a cache bucket keyed
// by the URL string alone. Since Phase 2 moved every mounted private
// <Image> onto a stable cacheKey (lib/private-image-cache-key.ts), that
// URL-keyed prefetch bucket is no longer the one a visible image actually
// reads from — it's a wasted download into a bucket nothing looks at.
//
// This component is the documented workaround: mount a bounded set of
// zero-visual-impact <Image>s using the EXACT SAME `{ uri, cacheKey }`
// source shape (and cachePolicy) the real, visible images use, so expo-image
// populates the correct cache entries ahead of the real mount. It genuinely
// mounts real <Image> components — a completely unrendered/conditionally-
// skipped element would never trigger expo-image to do anything.
export type WarmupEntry = {
  // Used as the React key for this entry's hidden <Image> — callers pass
  // whatever stable id they already have (a collection_item_images.id, a
  // folder id, etc.); never derived from uri/cacheKey itself, which is
  // exactly the "don't key by the rotating thing" lesson this whole
  // upgrade is about.
  id: string;
  uri?: string;
  cacheKey?: string;
};

type Props = {
  entries: WarmupEntry[];
};

// Renders nothing itself if there's nothing left to warm after filtering —
// callers are expected to pass an already-bounded list (a preview-row cap,
// a fixed grid size, etc.); this component only dedupes/validates, it never
// imposes or removes a size limit of its own.
export function PrivateImageWarmup({ entries }: Props) {
  const seen = new Set<string>();
  const deduped: { id: string; uri: string; cacheKey: string }[] = [];
  for (const entry of entries) {
    if (!entry.uri || !entry.cacheKey) continue;
    if (seen.has(entry.cacheKey)) continue;
    seen.add(entry.cacheKey);
    deduped.push({ id: entry.id, uri: entry.uri, cacheKey: entry.cacheKey });
  }

  if (!deduped.length) return null;

  return (
    <View
      style={styles.hidden}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {deduped.map((entry) => (
        <Image
          key={entry.cacheKey}
          source={{ uri: entry.uri, cacheKey: entry.cacheKey }}
          style={styles.pixel}
          cachePolicy="memory-disk"
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // A genuine 1x1 mount, not 0x0 — a zero-sized <Image> risks the native
  // layer skipping layout/load entirely on some platforms, where 1x1
  // reliably still triggers a real decode while staying visually
  // imperceptible. opacity: 0 (not visibility/display tricks) so expo-image
  // still treats this as a normal, rendered, loadable view.
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
  },
  pixel: {
    width: 1,
    height: 1,
  },
});
