import { useState } from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

const HERO_RADIUS = 16;
const WRAP_WIDTH_RATIO = 0.92;

// Builds a clean, ordered image list from whatever candidate URLs an item
// has — drops null/undefined/blank entries and de-dupes while preserving
// order, so the first non-empty candidate (the primary image) always stays
// first and is never repeated later in the list.
export function buildItemImageList(candidates: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const images: string[] = [];
  for (const candidate of candidates) {
    const url = candidate?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    images.push(url);
  }
  return images;
}

type Props = {
  images: string[];
  // Reserved for a future full-screen viewer — no implementation yet.
  // Receives the index of the page that was tapped so a future viewer can
  // open at the right spot.
  onPress?: (index: number) => void;
  initialIndex?: number;
};

// Portrait hero, horizontally swipeable across an item's real gallery (see
// hooks/use-item-images.ts / lib/item-images.ts, backed by the
// collection_item_images table) — images are always ordered primary-first.
// Single-image and legacy (no gallery rows yet) items fall through to the
// plain single-image path below with no dot indicator.
export function ItemImageCarousel({ images, onPress, initialIndex = 0 }: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const pageWidth = windowWidth * WRAP_WIDTH_RATIO;
  const clampedInitial = Math.min(Math.max(initialIndex, 0), Math.max(images.length - 1, 0));
  const [activeIndex, setActiveIndex] = useState(clampedInitial);

  const handleMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
    const clamped = Math.min(images.length - 1, Math.max(0, index));
    if (clamped !== activeIndex) setActiveIndex(clamped);
  };

  // 0 or 1 image — render the plain hero, no FlatList/paging overhead and
  // no dot indicator.
  if (images.length <= 1) {
    const uri = images[0];
    return (
      <View style={styles.wrap}>
        <Pressable
          style={styles.shadowBox}
          onPress={onPress ? () => onPress(0) : undefined}
          disabled={!onPress}
          accessibilityRole={onPress ? 'imagebutton' : undefined}
          accessibilityLabel="Card image">
          <View style={[styles.imageBox, { width: pageWidth }]}>
            {uri ? (
              <Image source={{ uri }} style={styles.image} contentFit="cover" transition={200} />
            ) : (
              <View style={[styles.image, styles.placeholder]}>
                <Text style={styles.placeholderText}>No image</Text>
              </View>
            )}
          </View>
        </Pressable>
        <LinearGradient colors={['rgba(0,0,0,0.22)', 'transparent']} style={styles.fade} pointerEvents="none" />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.shadowBox}>
        <FlatList
          data={images}
          keyExtractor={(uri, index) => `${uri}-${index}`}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={clampedInitial}
          getItemLayout={(_, index) => ({ length: pageWidth, offset: pageWidth * index, index })}
          onMomentumScrollEnd={handleMomentumEnd}
          renderItem={({ item, index }) => (
            <Pressable
              style={[styles.imageBox, { width: pageWidth }]}
              onPress={onPress ? () => onPress(index) : undefined}
              disabled={!onPress}
              accessibilityRole={onPress ? 'imagebutton' : undefined}
              accessibilityLabel={`Card image ${index + 1} of ${images.length}`}>
              <Image source={{ uri: item }} style={styles.image} contentFit="cover" transition={200} />
            </Pressable>
          )}
        />
      </View>

      {/* Same dot treatment as the profile rail's carousel indicator
          (components/profile-v2/profile-v2-selector.tsx) — reused here for
          visual consistency rather than a second, unrelated dot style. */}
      <View style={styles.dots}>
        {images.map((uri, index) => (
          <View key={`${uri}-${index}`} style={[styles.dot, index === activeIndex && styles.dotActive]} />
        ))}
      </View>

      <LinearGradient colors={['rgba(0,0,0,0.22)', 'transparent']} style={styles.fade} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '92%',
    alignSelf: 'center',
    marginTop: 12,
  },
  shadowBox: {
    borderRadius: HERO_RADIUS,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 6,
  },
  imageBox: {
    aspectRatio: 5 / 7,
    borderRadius: HERO_RADIUS,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    color: PV2.textTertiary,
    fontSize: 14,
  },
  dots: {
    flexDirection: 'row',
    gap: 5,
    marginTop: 10,
    justifyContent: 'center',
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  dotActive: {
    width: 16,
    backgroundColor: PV2.accent,
  },
  // Short decorative strip immediately below the hero — reads as the image
  // gently fading into the page rather than ending on a hard edge.
  fade: {
    height: 16,
    marginTop: 0,
  },
});
