import { useMemo } from 'react';
import { Dimensions, StyleSheet, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { PrivateImageWarmup } from '@/components/images/private-image-warmup';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';
import type { CollectionItem } from '@/types';

import { PV2 } from './profile-v2-theme';

const COLS = 3;

// Same footprint as the existing "Top 9" Grails grid (profile-v2-grid.tsx /
// grail-slot-preview.tsx) — same horizontal inset, same inter-cell gap, same
// real trading-card proportion (2.5in x 3.5in, not square), same
// borderRadius: 0 flat-tile treatment. Deliberately not re-derived from
// scratch: this tab should look like the same grid language already used
// elsewhere in the app, not a new one.
const GRID_HORIZONTAL_MARGIN = 3;
const GRID_GAP = 2;

const GRID_WIDTH = Dimensions.get('window').width - GRID_HORIZONTAL_MARGIN * 2;
const CELL_WIDTH = (GRID_WIDTH - GRID_GAP * (COLS - 1)) / COLS;
// Explicit numeric height, not aspectRatio — aspectRatio on a flex child
// inside a flexWrap:'wrap' row collapsed to a thin horizontal strip
// on-device (confirmed via a temporary debug-bordered tile: the tile had
// real width but almost no height), even though CELL_WIDTH itself was
// correct. Computing height directly from CELL_WIDTH sidesteps whatever
// Yoga/RN-version-specific aspectRatio+flexWrap interaction caused that.
const CELL_HEIGHT = CELL_WIDTH * (3.5 / 2.5);

// Placeholder cell count while the initial batch is still loading — purely a
// skeleton, discarded the moment real items arrive (which may be more or
// fewer than this).
const LOADING_PLACEHOLDER_COUNT = 9;

// Bounded byte-cache warmup limit (Phase 3 of the private-image caching
// upgrade) — same "first screenful" heuristic as LOADING_PLACEHOLDER_COUNT
// above, not a coincidence: this tab's items are already rendered
// newest-first in a fixed COLS-wide grid, so the first 9 approximate
// what's on screen before any scrolling. This is a NEW bound: the prior
// Image.prefetch() call here had none at all — it warmed every item in
// `items` (Profile's full, unpaginated Items tab, potentially the user's
// entire collection). That was already wrong before Phase 3 (a real
// "preload the whole collection" bug, not something this upgrade
// introduced) — fixed here rather than carried forward into the new
// warmup mechanism.
const ITEMS_GRID_PREFETCH_LIMIT = 9;

type ItemWithImage = CollectionItem & { primary_image_id: string | null };

type Props = {
  items: ItemWithImage[];
  loading: boolean;
  onPressItem: (item: CollectionItem) => void;
};

// Dense, edge-to-edge 3-column item grid — Profile V3's Items tab body. No
// titles/metadata/counts/badges, no rounded tile containers, no section
// header: just tap-to-open tiles. Unlike ProfileV2Grid (a fixed 3x3 of
// addressable slots), this is a plain variable-length photo grid, so cells
// wrap rather than being chunked into fixed rows.
export function ProfileV2ItemsGrid({ items, loading, onPressItem }: Props) {
  // Same identity useSignedItemImages itself keys its cache by — reused
  // here only to build each tile's stable expo-image cacheKey (Phase 2 of
  // the private-image caching upgrade — see lib/private-image-cache-key.ts).
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';

  // One batched signing call for the whole visible grid, same convention as
  // ProfileV2Grid — never one request per tile.
  const { urls: signedImageUrls } = useSignedItemImages(
    items.map((i) => i.primary_image_id),
  );

  // Bounded byte-cache warmup for the first ITEMS_GRID_PREFETCH_LIMIT
  // tiles — order-preserving (items are already newest-first), so this
  // approximates "what's on screen before any scrolling" without real
  // viewport measurement, same convention as profile-v2-screen.tsx's own
  // Collection-preview warmup. Phase 3: this used to be an unbounded
  // Image.prefetch(url[]) covering every item, which had no cacheKey
  // option in the installed expo-image version anyway — it only ever
  // populated a cache entry keyed by the URL itself, which this grid's own
  // <Image> (Phase 2) no longer reads from (it reads by stable cacheKey).
  // PrivateImageWarmup below mounts hidden <Image>s with the exact {uri,
  // cacheKey} shape the real tiles use — and, unlike the old effect, is
  // now actually bounded (see ITEMS_GRID_PREFETCH_LIMIT's own comment).
  const warmupEntries = useMemo(
    () =>
      items.slice(0, ITEMS_GRID_PREFETCH_LIMIT).flatMap((item) => {
        const imageId = item.primary_image_id;
        const uri = imageId ? signedImageUrls.get(imageId) : undefined;
        if (!imageId || !uri) return [];
        return [{ id: imageId, uri, cacheKey: itemImageCacheKey(identity, imageId) }];
      }),
    [items, signedImageUrls, identity],
  );

  if (loading && items.length === 0) {
    return (
      <View style={styles.grid}>
        {Array.from({ length: LOADING_PLACEHOLDER_COUNT }, (_, i) => (
          <View key={`loading-${i}`} style={styles.cell} />
        ))}
      </View>
    );
  }

  return (
    <View style={styles.grid}>
      {/* Absolutely positioned/invisible (see PrivateImageWarmup itself) —
          never participates in this View's own flexWrap layout, safe as
          the first child regardless of position. */}
      <PrivateImageWarmup entries={warmupEntries} />
      {items.map((item) => {
        const uri = item.primary_image_id ? signedImageUrls.get(item.primary_image_id) : undefined;
        return (
          <TouchableOpacity
            key={item.id}
            style={styles.cell}
            activeOpacity={0.85}
            onPress={() => onPressItem(item)}>
            {uri ? (
              <Image
                source={{
                  uri,
                  cacheKey: item.primary_image_id ? itemImageCacheKey(identity, item.primary_image_id) : undefined,
                }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={150}
                cachePolicy="memory-disk"
              />
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // No top margin — the starting offset below the sticky tab row is now
  // owned entirely by profile-v2-screen.tsx's shared TAB_CONTENT_TOP_GAP
  // (tabBodyWrap), so every tab body begins at the same height.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: GRID_HORIZONTAL_MARGIN,
    gap: GRID_GAP,
  },
  cell: {
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: PV2.emptyCardBg,
  },
});
