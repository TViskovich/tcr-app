import { useEffect, useState } from 'react';
import {
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { FittedRoundedImage } from '@/components/feed/fitted-rounded-image';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';

export type CarouselImage = {
  key: string;
  uri: string | null;
};

type Props = {
  images: CarouselImage[];
  // Same corner-radius contract as CardSharePostBody's own mediaBorderRadius
  // — applied to the per-page mask (see pageMask below), not the image or
  // Pressable directly.
  mediaBorderRadius?: number;
  // Every page calls this same handler regardless of index — matches
  // AttachmentImageGrid's previous whole-grid single TouchableOpacity
  // (onPostPress): tapping any image opens post detail, exactly as before.
  // There is no per-image full-screen viewer in this app to defer to
  // instead.
  onPress?: () => void;
};

// Feed-only multi-image carousel for a text post's 2-4 post_images (Phase:
// collage → carousel). AttachmentImageGrid (components/feed/
// attachment-image-grid.tsx) is NOT reused here — it's still shared with the
// composer's own preview (app/post/new.tsx), which genuinely needs the
// collage (the user must see/remove any of several selected photos at once,
// not swipe through them). This is a read-only Feed-display concern only.
//
// Modeled directly on components/feed/card-share-post-body.tsx — the same
// paging mechanics (horizontal FlatList, pagingEnabled, getItemLayout from a
// measured onLayout width, onMomentumScrollEnd-driven active index rather
// than per-onScroll-frame state) AND the same per-page corner-radius mask
// technique that file's own header comment documents as the one approach
// (of five tried) that actually keeps a swiped-to page's corners rounded.
// Not reinventing that fix here. contentFit is 'contain' (same as
// CardSharePostBody and the single-text-photo path) so a swiped-to page whose
// shape differs from the lead image's frame letterboxes instead of cropping.
//
// PostCard is responsible for NOT rendering this for a 1-image post (that
// case renders a plain image, no unnecessary FlatList) and for
// sizing/positioning the fixed-aspect-ratio box this fills —
// this component only ever fills 100%/100% of its own parent, same as
// CardSharePostBody.
export function PostImageCarousel({ images, mediaBorderRadius = 0, onPress }: Props) {
  const [pageWidth, setPageWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  // If the image list ever shrinks such that activeIndex points past the
  // end, clamp back into range rather than leaving the dot indicator
  // pointing at a nonexistent slide — same defensive effect as
  // CardSharePostBody's own.
  useEffect(() => {
    if (images.length === 0) return;
    if (activeIndex > images.length - 1) {
      setActiveIndex(images.length - 1);
    }
  }, [images.length, activeIndex]);

  function handleLayout(e: LayoutChangeEvent) {
    const nextWidth = e.nativeEvent.layout.width;
    if (nextWidth > 0 && nextWidth !== pageWidth) {
      setPageWidth(nextWidth);
    }
  }

  // Momentum-end only — never onScroll — so a swipe never drives per-frame
  // React state. Only commits a new activeIndex when it actually changed.
  function handleMomentumEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    if (!pageWidth) return;
    const index = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
    const clamped = Math.min(images.length - 1, Math.max(0, index));
    if (clamped !== activeIndex) setActiveIndex(clamped);
  }

  // Callers are responsible for not rendering this for an empty/1-image
  // list (see post-card.tsx) — this is just a defensive no-op.
  if (images.length === 0) return null;

  return (
    <View style={styles.wrap} onLayout={handleLayout}>
      <View style={[styles.viewport, { borderRadius: mediaBorderRadius, overflow: 'hidden' }]}>
        {pageWidth > 0 ? (
          <FlatList
            style={styles.flatList}
            data={images}
            keyExtractor={(img) => img.key}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            getItemLayout={(_, index) => ({ length: pageWidth, offset: pageWidth * index, index })}
            onMomentumScrollEnd={handleMomentumEnd}
            renderItem={({ item: img, index }) => (
              // Dedicated per-page mask carries the rounding — not the
              // FlatList, not the Pressable, not the Image. collapsable=false
              // keeps RN from flattening it (and dropping the clip with it)
              // on the re-render handleMomentumEnd's setActiveIndex triggers.
              <View
                collapsable={false}
                style={[
                  styles.pageMask,
                  { width: pageWidth, borderRadius: mediaBorderRadius, overflow: 'hidden' },
                ]}>
                <Pressable
                  style={styles.slide}
                  onPress={onPress}
                  accessibilityRole={onPress ? 'imagebutton' : undefined}
                  accessibilityLabel={`Image ${index + 1} of ${images.length}`}>
                  {img.uri ? (
                    // Each page rounds/clips its own photo rectangle — pages
                    // can differ in shape from the lead image the frame was
                    // sized from, so the letterboxed photo, not just the
                    // page, must carry the radius.
                    <FittedRoundedImage uri={img.uri} radius={mediaBorderRadius} transition={150} />
                  ) : (
                    <View style={[styles.image, styles.placeholder, { borderRadius: mediaBorderRadius }]} />
                  )}
                </Pressable>
              </View>
            )}
          />
        ) : null}
      </View>

      {images.length > 1 && (
        <View style={styles.dots} pointerEvents="none">
          {images.map((img, index) => (
            <View key={img.key} style={[styles.dot, index === activeIndex && styles.dotActive]} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
  },
  viewport: {
    width: '100%',
    height: '100%',
    backgroundColor: PV2.collectorPanelBg,
  },
  flatList: {
    width: '100%',
    height: '100%',
  },
  pageMask: {
    height: '100%',
  },
  slide: {
    flex: 1,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    backgroundColor: PV2.collectorPanelBg,
  },
  dots: {
    position: 'absolute',
    bottom: 8,
    left: 0,
    right: 0,
    flexDirection: 'row',
    gap: 5,
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
});
