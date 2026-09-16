import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
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
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import type { SignedImageStatus } from '@/hooks/use-signed-item-images';

// Edge-to-edge, square-cornered Instagram-post-style presentation — no
// outer horizontal padding, no radius, no frame border/shadow. Named
// (rather than left as bare 0s) so intent reads the same way the folder
// grid's GRID_PAGE_PADDING/GRID_CARD_RADIUS do (see
// app/collection/[folderId].tsx), and so pageWidth below stays correct if
// either is ever reintroduced.
const HERO_OUTER_PADDING = 0;
const HERO_CARD_RADIUS = 0;
// Matches the trading-card portrait proportions used everywhere else in
// this app (see PREVIEW_CARD_ASPECT_RATIO) — both the box's own layout
// aspect ratio and pageHeight (the pinch/pan clamp math's viewport height)
// are derived from this one constant, so they can't drift apart.
const IMAGE_ASPECT_RATIO = 5 / 7;

// Pinch-to-zoom-and-inspect (ZoomableItemImage below) — Instagram-style
// hold-to-inspect, not a persistent full-screen zoom: it always snaps back
// to scale 1 / translate 0,0 the moment every touch lifts.
const MIN_SCALE = 1;
const MAX_SCALE = 4;
const ZOOM_RESET_DURATION = 220;
const ZOOM_RESET_EASING = Easing.out(Easing.cubic);

function clamp(value: number, min: number, max: number) {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

// Keeps a pan/pinch translation from ever revealing blank space at the
// viewport's edges — at scale 1 this always clamps to exactly 0 (no
// slack), and grows symmetrically as scale increases, matching the
// standard "image always fills its frame" pinch-zoom convention.
function clampPanAxis(value: number, scaleValue: number, viewportSize: number) {
  'worklet';
  const maxOffset = (viewportSize * (scaleValue - 1)) / 2;
  return clamp(value, -maxOffset, maxOffset);
}

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

// One carousel slide. `uri` is intentionally optional/absent-able — a slide
// exists (and is counted, keyed, and paged to) the moment its gallery row is
// known, independent of whether its signed URL has resolved yet. `id` is
// the immutable collection_item_images.id (or a stable synthetic id for the
// legacy single-image fallback — see app/item/[id].tsx's own carouselImages
// memo), used as the FlatList/dot key so a slide's `uri` resolving in place
// never changes its React key — that's what keeps page position/scroll
// state intact instead of the list treating a newly-resolved image as a
// brand-new item.
export type CarouselImage = {
  id: string;
  uri?: string;
  // hooks/use-signed-item-images.ts's own SignedImageStatus, reused
  // directly (not a redeclared subset) so this can never drift from what
  // that hook's `statuses` map actually returns. Only 'loading' changes
  // rendering here — it's the one value that shows a spinner placeholder
  // instead of "No image" (see ZoomableItemImageProps' own status comment
  // below); 'ready' never actually reaches that decision in practice since
  // it only ever accompanies a truthy `uri`, which is checked first.
  // Meaningless once `uri` itself is set. Omit it (or pass 'unavailable')
  // for anything that was never going through signing in the first place —
  // e.g. the legacy single-image fallback in app/item/[id].tsx's own
  // carouselImages memo, which has no pending async state to represent: it
  // either already has a real uri or it never will.
  status?: SignedImageStatus;
};

type ZoomableItemImageProps = {
  uri: string | undefined;
  // See CarouselImage's own comment above — 'loading' is the only value
  // that renders the spinner placeholder; anything else ('ready',
  // 'unavailable', or simply omitted) renders "No image". Defaulting a
  // missing status to "No image" rather than a spinner is deliberate: this
  // is never allowed to show a fake, permanently-spinning loading state
  // for a slide that was never actually going to resolve.
  status?: SignedImageStatus;
  pageWidth: number;
  index: number;
  totalImages: number;
  // Reserved for a future full-screen viewer — no implementation yet.
  onPress?: (index: number) => void;
  // Lets the parent (a FlatList, when there's more than one photo) disable
  // its own horizontal scroll while this page is actively zoomed, so a
  // one-finger reposition drag can never be mistaken for a page-change
  // swipe. No-op wiring for the single-image case, which has no sibling
  // scroll to protect.
  onZoomChange: (zoomed: boolean) => void;
};

// One carousel page's image, pinch-to-zoom-and-inspect enabled. Owns its
// own scale/translate shared values (not lifted to the carousel), so
// zooming one page never affects another and nothing persists once this
// instance's gesture ends or it unmounts (navigating away, or — since the
// parent FlatList's scroll is disabled for the whole duration a page is
// zoomed — there's no way to swipe to another page mid-zoom in the first
// place; scrolling only re-enables once this has already snapped back).
//
// Structure: an outer, never-transformed View owns the fixed aspect-ratio
// box, the square corners, and overflow:hidden — the actual crop/clip
// boundary. An inner Animated.View, absolutely filling that box, carries
// only the pinch/pan transform. Clipping has to live on the untransformed
// outer layer: putting overflow:hidden on the same view being scaled would
// scale the clip boundary right along with the content, letting a zoomed
// image spill past the card's edges instead of staying contained by it.
function ZoomableItemImage({
  uri,
  status,
  pageWidth,
  index,
  totalImages,
  onPress,
  onZoomChange,
}: ZoomableItemImageProps) {
  const pageHeight = pageWidth / IMAGE_ASPECT_RATIO;

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  // The view-space point under the fingers at the start of the current
  // pinch, computed once per gesture — lets onUpdate solve for whatever
  // translation keeps that exact point under the live focal point as
  // scale changes, i.e. zoom anchored to the pinch focal point rather
  // than the image center.
  const pinchOriginX = useSharedValue(0);
  const pinchOriginY = useSharedValue(0);
  // Counts concurrently-active gestures (pinch and/or pan) so the
  // snap-back only fires once every finger has actually lifted, not the
  // instant either individual gesture recognizer finishes.
  const activeTouches = useSharedValue(0);

  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    onZoomChange(zoomed);
  }, [zoomed, onZoomChange]);

  // Smooth, controlled ease-out back to the exact resting transform — no
  // spring, no overshoot. Only the scale animation's completion drives
  // `zoomed` back to false (all three run with the same duration/easing,
  // so they settle together; one callback is enough).
  function snapBack() {
    'worklet';
    scale.value = withTiming(1, { duration: ZOOM_RESET_DURATION, easing: ZOOM_RESET_EASING }, (finished) => {
      if (finished) runOnJS(setZoomed)(false);
    });
    savedScale.value = 1;
    translateX.value = withTiming(0, { duration: ZOOM_RESET_DURATION, easing: ZOOM_RESET_EASING });
    savedTranslateX.value = 0;
    translateY.value = withTiming(0, { duration: ZOOM_RESET_DURATION, easing: ZOOM_RESET_EASING });
    savedTranslateY.value = 0;
  }

  // Two-finger only — never competes with the FlatList's own one-finger
  // horizontal swipe for gesture-arena priority, so normal page-swiping at
  // rest needs no other special handling.
  const pinch = Gesture.Pinch()
    .onStart((e) => {
      activeTouches.value += 1;
      runOnJS(setZoomed)(true);
      const S0 = scale.value;
      pinchOriginX.value = (e.focalX - translateX.value - pageWidth / 2) / S0 + pageWidth / 2;
      pinchOriginY.value = (e.focalY - translateY.value - pageHeight / 2) / S0 + pageHeight / 2;
    })
    .onUpdate((e) => {
      const newScale = clamp(savedScale.value * e.scale, MIN_SCALE, MAX_SCALE);
      scale.value = newScale;
      const rawTx = e.focalX - newScale * (pinchOriginX.value - pageWidth / 2) - pageWidth / 2;
      const rawTy = e.focalY - newScale * (pinchOriginY.value - pageHeight / 2) - pageHeight / 2;
      translateX.value = clampPanAxis(rawTx, newScale, pageWidth);
      translateY.value = clampPanAxis(rawTy, newScale, pageHeight);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    })
    .onFinalize(() => {
      activeTouches.value = Math.max(0, activeTouches.value - 1);
      if (activeTouches.value === 0) snapBack();
    });

  // Only reachable while already zoomed (enabled(zoomed)) — at rest this
  // gesture is fully disabled, so it never enters the gesture arena at
  // all and a plain one-finger swipe reaches the FlatList's own scroll
  // exactly as it did before this component existed.
  const pan = Gesture.Pan()
    .enabled(zoomed)
    .onStart(() => {
      activeTouches.value += 1;
    })
    .onUpdate((e) => {
      const S = scale.value;
      translateX.value = clampPanAxis(savedTranslateX.value + e.translationX, S, pageWidth);
      translateY.value = clampPanAxis(savedTranslateY.value + e.translationY, S, pageHeight);
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    })
    .onFinalize(() => {
      activeTouches.value = Math.max(0, activeTouches.value - 1);
      if (activeTouches.value === 0) snapBack();
    });

  const composed = Gesture.Simultaneous(pinch, pan);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const accessibilityLabel = totalImages > 1 ? `Card image ${index + 1} of ${totalImages}` : 'Card image';

  return (
    <GestureDetector gesture={composed}>
      <View style={[styles.imageBox, { width: pageWidth }]}>
        <Animated.View style={[styles.zoomLayer, animStyle]}>
          <Pressable
            style={styles.pressFill}
            onPress={onPress ? () => onPress(index) : undefined}
            disabled={!onPress}
            accessibilityRole={onPress ? 'imagebutton' : undefined}
            accessibilityLabel={accessibilityLabel}>
            {uri ? (
              <Image source={{ uri }} style={styles.image} contentFit="cover" transition={200} />
            ) : status === 'loading' ? (
              <View style={[styles.image, styles.placeholder]}>
                <ActivityIndicator size="small" color={PV2.textTertiary} />
              </View>
            ) : (
              <View style={[styles.image, styles.placeholder]}>
                <Text style={styles.placeholderText}>No image</Text>
              </View>
            )}
          </Pressable>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

type Props = {
  images: CarouselImage[];
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
//
// `images` reflects gallery STRUCTURE, not URL availability — the caller
// (app/item/[id].tsx) includes one entry per gallery row immediately, even
// before that row's own signed URL has resolved (see CarouselImage's own
// comment above). This component never waits for every `uri` to be ready
// before deciding how many pages/dots to render; an entry with no `uri` yet
// simply renders ZoomableItemImage's existing placeholder until one arrives
// on a later render, in place, under the same `id` key.
export function ItemImageCarousel({ images, onPress, initialIndex = 0 }: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const pageWidth = windowWidth - HERO_OUTER_PADDING * 2;
  const clampedInitial = Math.min(Math.max(initialIndex, 0), Math.max(images.length - 1, 0));
  const [activeIndex, setActiveIndex] = useState(clampedInitial);
  // Whether the currently-visible page is mid pinch/pan-zoom — disables
  // the FlatList's own horizontal scroll for that whole duration (belt
  // and braces alongside the per-page pan gesture's own enabled(zoomed)
  // gate) so zoom interaction can never be mistaken for a page swipe, and
  // re-enables the instant that page has fully snapped back.
  const [zoomedActive, setZoomedActive] = useState(false);

  const handleMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
    const clamped = Math.min(images.length - 1, Math.max(0, index));
    if (clamped !== activeIndex) setActiveIndex(clamped);
  };

  // 0 or 1 image — render the plain hero, no FlatList/paging overhead and
  // no dot indicator.
  if (images.length <= 1) {
    return (
      <View style={styles.wrap}>
        <ZoomableItemImage
          uri={images[0]?.uri}
          status={images[0]?.status}
          pageWidth={pageWidth}
          index={0}
          totalImages={images.length}
          onPress={onPress}
          onZoomChange={setZoomedActive}
        />
        <LinearGradient colors={['rgba(0,0,0,0.22)', 'transparent']} style={styles.fade} pointerEvents="none" />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <FlatList
        data={images}
        // Keyed by the immutable gallery-row id, NOT by uri/index — a
        // slide's `uri` resolving from undefined to a real signed URL must
        // never change its key, or React (and the FlatList's own scroll/
        // page-position bookkeeping) would treat the resolved slide as a
        // brand-new list item instead of the same one filling in.
        keyExtractor={(image) => image.id}
        horizontal
        pagingEnabled
        scrollEnabled={!zoomedActive}
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={clampedInitial}
        getItemLayout={(_, index) => ({ length: pageWidth, offset: pageWidth * index, index })}
        onMomentumScrollEnd={handleMomentumEnd}
        // Bounded adjacent-slide render window — current + next (+
        // previous once scrolled) — rather than relying on FlatList's own
        // much larger default (initialNumToRender: 10, windowSize: 21
        // "screens"). That default happens to render this app's entire
        // gallery today only because MAX_ITEM_IMAGES (lib/item-images.ts)
        // is capped at 10, not because anything here actually bounds it.
        // windowSize is measured in "screens" of the list's own viewport
        // (here, one page = one screen-width, since paging is enabled), so
        // 3 covers roughly one page each side of whichever is current —
        // exactly "current, next, optionally previous" — without eagerly
        // mounting a much larger gallery in one pass if the cap ever
        // changes. This guarantees the next (and, once scrolled, previous)
        // slide's own <Image> is already mounted — and so already
        // downloading its bytes the instant its signed URL resolves —
        // without requiring the user to swipe there first.
        initialNumToRender={3}
        windowSize={3}
        renderItem={({ item, index }) => (
          <ZoomableItemImage
            uri={item.uri}
            status={item.status}
            pageWidth={pageWidth}
            index={index}
            totalImages={images.length}
            onPress={onPress}
            onZoomChange={setZoomedActive}
          />
        )}
      />

      {/* Same dot treatment as the profile rail's carousel indicator
          (components/profile-v2/profile-v2-selector.tsx) — reused here for
          visual consistency rather than a second, unrelated dot style. */}
      <View style={styles.dots}>
        {images.map((image, index) => (
          <View key={image.id} style={[styles.dot, index === activeIndex && styles.dotActive]} />
        ))}
      </View>

      <LinearGradient colors={['rgba(0,0,0,0.22)', 'transparent']} style={styles.fade} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  // marginTop was 12 — breathing room below the native header from when
  // this carousel was the first element on the screen. app/item/[id].tsx's
  // ItemOwnerRow now renders directly above it and already establishes
  // that separation itself, so this would only double it up; 0 lets the
  // image start immediately below the row, per the current design.
  wrap: {
    paddingHorizontal: HERO_OUTER_PADDING,
    marginTop: 0,
  },
  // Square-cornered (HERO_CARD_RADIUS = 0), borderless, shadowless — flush
  // with the page like an Instagram post, not a floating rounded card. No
  // borderWidth: the Image below only fills this box's padding-box (inside
  // any border), so a border here would sit outside the photo and read as
  // a frame around it, the exact "floating card" look this is replacing.
  // Never itself transformed (see ZoomableItemImage) — this is the fixed
  // clip boundary a pinch-zoomed image can never visually escape.
  imageBox: {
    aspectRatio: IMAGE_ASPECT_RATIO,
    borderRadius: HERO_CARD_RADIUS,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  // Absolutely fills imageBox — the layer the pinch/pan transform is
  // applied to, one level inside the untransformed clip boundary above.
  zoomLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  pressFill: {
    flex: 1,
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
