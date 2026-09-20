import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

const COLUMNS = 3;
const GRID_GAP = 6;
const GRID_HORIZONTAL_PADDING = 0;
// Tall portrait card proportions — height ends up ~1.43x the tile width.
const TILE_ASPECT_RATIO = 0.70;
const TILE_RADIUS = 14;

export type RelatedItem = {
  id: string;
  imageUrl: string | null;
  title?: string | null;
  subtitle?: string | null;
};

type Props = {
  title?: string;
  // Left undefined/empty today — the real "more from this folder / player /
  // collection" queries don't exist yet. No placeholder tiles are rendered
  // in their place (see the empty-items early return below) — an unbuilt
  // query is represented as "no related items," not faked card data.
  items?: RelatedItem[];
  onItemPress?: (item: RelatedItem) => void;
};

// Reusable 3-column grid of tall portrait tiles — layout only for now.
export function RelatedItemsGrid({ title = 'Related Items', items, onItemPress }: Props) {
  const { width: screenWidth } = useWindowDimensions();
  const tileWidth = (screenWidth - GRID_HORIZONTAL_PADDING * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS;

  // No reserved empty slots, no placeholder tiles, and no empty "Related
  // Items" header floating with nothing under it — the whole section
  // collapses to nothing when there's nothing real to show.
  if (!items || items.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.header}>{title}</Text>
      <View style={styles.grid}>
        {items.map((item) => (
          <Pressable
            key={item.id}
            style={[styles.relatedItemTile, { width: tileWidth }]}
            onPress={() => onItemPress?.(item)}
            accessibilityRole="button"
            accessibilityLabel={item.title ?? 'Related item'}>
            {item.imageUrl && (
              <Image
                source={{ uri: item.imageUrl }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
              />
            )}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 80,
  },
  header: {
    fontSize: 13,
    fontWeight: '700',
    color: PV2.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 12,
    paddingHorizontal: 20,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
    width: '100%',
    paddingHorizontal: GRID_HORIZONTAL_PADDING,
  },
  relatedItemTile: {
    aspectRatio: TILE_ASPECT_RATIO,
    borderRadius: TILE_RADIUS,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.collectorPanelBg,
  },
});
