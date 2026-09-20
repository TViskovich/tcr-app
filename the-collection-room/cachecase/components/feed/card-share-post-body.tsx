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
  // Corner radius applied to THIS component's own outer viewport AND to
  // each individual page's own dedicated mask View (see pageMask below) —
  // on top of whatever radius/clipping the caller's own container already
  // applies. Defaults to 0 (no rounding, this component's original
  // behavior) so the other two callers (app/post/[id].tsx's imageWrap,
  // share-post-preview.tsx's mediaWrap — neither currently rounds its
  // corners) are unaffected. PostCard (components/feed/post-card.tsx)
  // passes its own MEDIA_CORNER_RADIUS here so the carousel is clipped to
  // the exact same radius as a single-photo Feed post.
  mediaBorderRadius?: number;
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
// CORNER-ROUNDING ARCHITECTURE (history, for whoever touches this next):
// 1) Radius directly on the per-page Pressable/Image — page 1 stayed
//    rounded, but any page reached by swiping went square again once the
//    swipe settled.
// 2) collapsable={false} + explicit longhand corner radii added on top of
//    (1) — did not fix it either.
// 3) A stationary `viewport` View wrapping the whole FlatList, with its own
//    borderRadius + overflow: 'hidden', never depending on activeIndex —
//    also did not hold; settled pages still went square. `viewport`'s own
//    radius/overflow is kept below as a harmless, cheap safety net, but it
//    is not what's relied on for the visible rounding.
// 4) An absolutely-positioned Svg corner-mask overlay painted on top of the
//    FlatList (react-native-svg was already installed;
//    @react-native-masked-view/masked-view — the more direct tool for a
//    true native view mask — is not) — this broke swipe gestures entirely
//    and was reverted.
// 5) CURRENT: a dedicated, non-interactive, per-page mask View — pageMask
//    below — sits between the FlatList's cell and the Pressable/Image
//    content. It carries pageWidth, mediaBorderRadius, overflow: 'hidden',
//    and collapsable={false} (so RN's view-flattening optimization can't
//    remove it from the native tree on a later re-render). The Pressable
//    and Image are plain, unrounded content that simply fills it — the
//    clip is owned by this one dedicated node per page, not by anything
//    that handles touch or image content itself.
//
// Always renders from denormalized snapshot fields, never a live item
// lookup — the source collection_item can be edited or deleted after the
// post is made (item_id goes null via ON DELETE SET NULL when that
// happens). A slide with a null item_id still renders its snapshot content
// in full, it just isn't tappable.
export function CardSharePostBody({ cards, mediaBorderRadius = 0 }: Props) {
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
      {/* Stationary outer mask — kept as a harmless safety net (see this
          file's own top-of-file history comment); the real per-page clip
          now lives on pageMask below, not here. Sized to 100%/100% of
          `wrap`, the same box handleLayout measures pageWidth from, never
          re-rendered based on activeIndex. */}
      <View
        style={[
          styles.viewport,
          { borderRadius: mediaBorderRadius, overflow: 'hidden' },
        ]}>
        {pageWidth > 0 ? (
          <FlatList
            style={styles.flatList}
            data={cards}
            keyExtractor={(card) => card.id}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            getItemLayout={(_, index) => ({ length: pageWidth, offset: pageWidth * index, index })}
            onMomentumScrollEnd={handleMomentumEnd}
            renderItem={({ item: card, index }) => (
              // Dedicated per-page mask — the ONE thing in this render tree
              // that carries the rounding. Not the FlatList, not the
              // Pressable, not the Image. collapsable={false} keeps RN from
              // flattening it out of the native tree (and dropping its clip
              // with it) on a later re-render, e.g. the one handleMomentumEnd
              // triggers via setActiveIndex on every swipe-settle.
              <View
                collapsable={false}
                style={[
                  styles.pageMask,
                  { width: pageWidth, borderRadius: mediaBorderRadius, overflow: 'hidden' },
                ]}>
                <Pressable
                  style={styles.slide}
                  disabled={!card.item_id}
                  onPress={() =>
                    card.item_id && router.push({ pathname: '/item/[id]', params: { id: card.item_id } })
                  }
                  accessibilityRole={card.item_id ? 'imagebutton' : undefined}
                  accessibilityLabel={`Card ${index + 1} of ${cards.length}${card.snapshot_title ? `: ${card.snapshot_title}` : ''}`}>
                  {card.snapshot_image_url ? (
                    // 'contain' (was 'cover') — matches PostCard's single-photo
                    // path, and this carousel's own frame is a fixed 5/7 ratio
                    // shared across every card (see post-card.tsx's cardImageWrap
                    // comment) rather than measured per-image, so a card whose
                    // real photo isn't exactly 5/7 now letterboxes instead of
                    // being cropped, keeping the full card visible without
                    // resizing the shared frame while swiping. No borderRadius
                    // here — correctness comes from pageMask above, not from
                    // this Image's own styling.
                    <Image source={{ uri: card.snapshot_image_url }} style={styles.image} contentFit="contain" transition={200} />
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
              </View>
            )}
          />
        ) : null}
      </View>

      {/* Positioned near the very bottom edge, below the title/subtitle
          text block (which the gradient's extra paddingBottom keeps clear
          of this band) — the two never overlap. Sibling of `viewport`
          (not inside it) but still a direct child of `wrap`, so its
          position: 'absolute' coordinates resolve against the exact same
          box as before. */}
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
  // Stationary outer safety-net mask — see this file's top-of-file history
  // comment. width/height 100% of `wrap` — the exact same box handleLayout
  // measures pageWidth from.
  viewport: {
    width: '100%',
    height: '100%',
    backgroundColor: PV2.collectorPanelBg,
  },
  // Constrained to exactly fill `viewport` — never lets FlatList's own
  // content define or expand its outer geometry.
  flatList: {
    width: '100%',
    height: '100%',
  },
  // Dedicated per-page clip — width set inline (pageWidth) alongside
  // borderRadius/overflow at the JSX call site; height fills the FlatList's
  // own cross-axis (100%) via the default row cross-axis stretch behavior
  // combined with this box having no explicit height of its own, same as
  // `slide` did before this pass.
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
