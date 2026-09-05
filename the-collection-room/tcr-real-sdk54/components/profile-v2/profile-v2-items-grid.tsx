import { useEffect } from 'react';
import { Dimensions, StyleSheet, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { useSignedItemImages } from '@/hooks/use-signed-item-images';
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
  // One batched signing call for the whole visible grid, same convention as
  // ProfileV2Grid — never one request per tile.
  const { urls: signedImageUrls, statuses: signedImageStatuses } = useSignedItemImages(
    items.map((i) => i.primary_image_id),
  );

  // TEMP DIAGNOSTIC (Items tab black-screen investigation) — remove once
  // the root cause is confirmed and fixed. Confirms this component actually
  // mounted, how many items it received, and — for the first few — whether
  // each has a primary_image_id at all and whether that id's signed URL has
  // resolved yet ('ready'/'loading'/'unavailable', per useSignedItemImages).
  useEffect(() => {
    if (!__DEV__) return;
    const sample = items.slice(0, 5).map((item) => ({
      id: item.id,
      primary_image_id: item.primary_image_id,
      signedStatus: item.primary_image_id ? (signedImageStatuses.get(item.primary_image_id) ?? 'not-requested') : 'no-primary-image-id',
      hasResolvedUrl: item.primary_image_id ? signedImageUrls.has(item.primary_image_id) : false,
    }));
    console.log('[ProfileV3 DIAG] ProfileV2ItemsGrid mounted/updated', {
      itemCount: items.length,
      loading,
      sample,
    });
  }, [items, signedImageUrls, signedImageStatuses, loading]);

  // Same shared-prefetch warm-up as ProfileV2Grid, for the same reason: a
  // grid's worth of tiles resolving their signed URLs near-simultaneously
  // should also finish decoding together, not pop in one at a time.
  const resolvedUrlsKey = Array.from(signedImageUrls.values()).sort().join(',');
  useEffect(() => {
    if (!resolvedUrlsKey) return;
    Image.prefetch(resolvedUrlsKey.split(',')).catch(() => {});
  }, [resolvedUrlsKey]);

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
                source={{ uri }}
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
