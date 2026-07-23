import { useEffect, useState } from 'react';
import {
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import type { CardShareItem } from '@/types';

type Props = {
  cards: CardShareItem[];
};

// Renders a "Share Card" carousel post's body — a true swipeable carousel
// (unlike GrailsPostBody's static flexWrap grid), reusing the same FlatList
// paging mechanics as components/item-detail/item-image-carousel.tsx
// (pagingEnabled + onMomentumScrollEnd-driven active index) and the same
// dot styling as components/profile-v2/profile-v2-selector.tsx. Fills
// whatever fixed-aspect-ratio container the caller wraps it in (PostCard's
// cardImageWrap / post/[id].tsx's imageWrap — both aspectRatio 5/7), rather
// than declaring its own size like ItemImageCarousel's floating 92%-inset
// hero does.
//
// pageWidth is measured via onLayout, not assumed from useWindowDimensions
// — the container's actual rendered width isn't guaranteed to equal the
// full device width (card padding/margins), and using the wrong width
// would misalign paging offsets and corrupt the active-index calculation.
//
// Always renders from denormalized snapshot fields, never a live item
// lookup — the source collection_item can be edited or deleted after the
// post is made (item_id goes null via ON DELETE SET NULL when that
// happens). A slide with a null item_id still renders its snapshot content
// in full, it just isn't tappable.
export function CardSharePostBody({ cards }: Props) {
  const router = useRouter();
  const [pageWidth, setPageWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  // If the card list ever shrinks (or is replaced) such that activeIndex
  // points past the end, clamp it back into range rather than leaving the
  // dot indicator pointing at a nonexistent slide.
  useEffect(() => {
    if (cards.length === 0) return;
    if (activeIndex > cards.length - 1) {
      setActiveIndex(cards.length - 1);
    }
  }, [cards.length, activeIndex]);

  function handleLayout(e: LayoutChangeEvent) {
    const nextWidth = e.nativeEvent.layout.width;
    if (nextWidth > 0 && nextWidth !== pageWidth) {
      setPageWidth(nextWidth);
    }
  }

  function handleMomentumEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    if (!pageWidth) return;
    const index = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
    const clamped = Math.min(cards.length - 1, Math.max(0, index));
    if (clamped !== activeIndex) setActiveIndex(clamped);
  }

  // Callers are responsible for not rendering this component at all when
  // cards is empty (see the isCardShare branches in post-card.tsx /
  // app/post/[id].tsx) — this is just a defensive no-op, not the primary
  // empty-state handling.
  if (cards.length === 0) return null;

  return (
    <View style={styles.wrap} onLayout={handleLayout}>
      {pageWidth > 0 ? (
        <FlatList
          data={cards}
          keyExtractor={(card) => card.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          getItemLayout={(_, index) => ({ length: pageWidth, offset: pageWidth * index, index })}
          onMomentumScrollEnd={handleMomentumEnd}
          renderItem={({ item: card, index }) => (
            <Pressable
              style={[styles.slide, { width: pageWidth }]}
              disabled={!card.item_id}
              onPress={() =>
                card.item_id && router.push({ pathname: '/item/[id]', params: { id: card.item_id } })
              }
              accessibilityRole={card.item_id ? 'imagebutton' : undefined}
              accessibilityLabel={`Card ${index + 1} of ${cards.length}${card.snapshot_title ? `: ${card.snapshot_title}` : ''}`}>
              {card.snapshot_image_url ? (
                <Image source={{ uri: card.snapshot_image_url }} style={styles.image} contentFit="cover" transition={200} />
              ) : (
                <View style={[styles.image, styles.placeholder]}>
                  <Text style={styles.placeholderText}>No image</Text>
                </View>
              )}

              {(card.snapshot_title || card.snapshot_subtitle) && (
                <LinearGradient
                  colors={['transparent', 'rgba(0,0,0,0.75)']}
                  style={styles.titleGradient}
                  pointerEvents="none">
                  {card.snapshot_title ? (
                    <Text style={styles.titleText} numberOfLines={1}>
                      {card.snapshot_title}
                    </Text>
                  ) : null}
                  {card.snapshot_subtitle ? (
                    <Text style={styles.subtitleText} numberOfLines={1}>
                      {card.snapshot_subtitle}
                    </Text>
                  ) : null}
                </LinearGradient>
              )}
            </Pressable>
          )}
        />
      ) : null}

      {/* Positioned near the very bottom edge, below the title/subtitle
          text block (which the gradient's extra paddingBottom keeps clear
          of this band) — the two never overlap. */}
      {cards.length > 1 && (
        <View style={styles.dots} pointerEvents="none">
          {cards.map((card, index) => (
            <View key={card.id} style={[styles.dot, index === activeIndex && styles.dotActive]} />
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
  slide: {
    flex: 1,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.collectorPanelBg,
  },
  placeholderText: {
    color: PV2.textTertiary,
    fontSize: 14,
  },
  titleGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 14,
    paddingTop: 30,
    // Extra bottom padding reserves a clear band below the text for the
    // dot indicator (positioned separately, bottom: 8) — text never
    // extends into that band.
    paddingBottom: 26,
  },
  titleText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  subtitleText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 12,
    marginTop: 2,
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
