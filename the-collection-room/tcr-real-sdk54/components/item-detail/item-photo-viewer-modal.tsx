import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';

const MIN_SCALE = 1;
const MAX_SCALE = 5;

function clamp(value: number, min: number, max: number) {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

// Keeps a pan/pinch translation from ever revealing blank space at the
// viewport's edges — same convention as item-image-carousel.tsx's
// ZoomableItemImage (clampPanAxis), reused here rather than re-derived.
function clampPanAxis(value: number, scaleValue: number, viewportSize: number) {
  'worklet';
  const maxOffset = (viewportSize * (scaleValue - 1)) / 2;
  return clamp(value, -maxOffset, maxOffset);
}

type Props = {
  visible: boolean;
  uri: string | undefined;
  onClose: () => void;
};

// Simple full-screen "inspect this photo" viewer for Edit Item's large
// reference image (components/item-detail/item-image-gallery-manager.tsx)
// — CacheCase had no existing full-screen/persistent-zoom viewer to reuse
// (item-image-carousel.tsx's own ZoomableItemImage is deliberately
// ephemeral: an Instagram-style hold-to-inspect zoom that always snaps
// back to scale 1 the instant every touch lifts, which is the opposite of
// what a dedicated "look closely, then dismiss" viewer needs), so this is
// a small, purpose-built one, sharing the same clamp/pinch/pan math as
// that component rather than reinventing it. Deliberately minimal — no
// double-tap-to-zoom, no background-tap-to-dismiss, no multi-image
// paging. The Card Details form is what the user returns to; this is for
// looking, not editing.
export function ItemPhotoViewerModal({ visible, uri, onClose }: Props) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const pinchOriginX = useSharedValue(0);
  const pinchOriginY = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onStart((e) => {
      const S0 = scale.value;
      pinchOriginX.value = (e.focalX - translateX.value - windowWidth / 2) / S0 + windowWidth / 2;
      pinchOriginY.value = (e.focalY - translateY.value - windowHeight / 2) / S0 + windowHeight / 2;
    })
    .onUpdate((e) => {
      const newScale = clamp(savedScale.value * e.scale, MIN_SCALE, MAX_SCALE);
      scale.value = newScale;
      const rawTx = e.focalX - newScale * (pinchOriginX.value - windowWidth / 2) - windowWidth / 2;
      const rawTy = e.focalY - newScale * (pinchOriginY.value - windowHeight / 2) - windowHeight / 2;
      translateX.value = clampPanAxis(rawTx, newScale, windowWidth);
      translateY.value = clampPanAxis(rawTy, newScale, windowHeight);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  // No .enabled(scale > 1) gate — reading a shared value in the JS-thread
  // render body to configure a gesture is a stale snapshot (this
  // component never re-renders as scale changes, since scale is a
  // SharedValue, not React state — unlike item-image-carousel.tsx's own
  // ZoomableImage, which can afford that gate because pinch there also
  // flips a real useState). Instead this relies on clampPanAxis itself:
  // at scale 1, maxOffset is exactly 0, so any one-finger drag clamps
  // straight back to 0 regardless of translationX/Y — the gesture is
  // always "on" but genuinely inert until the image is actually zoomed.
  const pan = Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = clampPanAxis(savedTranslateX.value + e.translationX, scale.value, windowWidth);
      translateY.value = clampPanAxis(savedTranslateY.value + e.translationY, scale.value, windowHeight);
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const composed = Gesture.Simultaneous(pinch, pan);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  function handleClose() {
    // Reset so the next open always starts at rest, never picking up a
    // previous session's zoom/pan.
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <GestureDetector gesture={composed}>
          <Animated.View style={[styles.imageWrap, animStyle]}>
            {uri && <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="contain" transition={150} />}
          </Animated.View>
        </GestureDetector>

        <Pressable
          onPress={handleClose}
          hitSlop={10}
          style={[styles.closeBtn, { top: insets.top + 10 }]}
          accessibilityRole="button"
          accessibilityLabel="Close">
          <IconSymbol name="xmark" size={18} color="#fff" />
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#000',
  },
  // Fills the whole screen — contentFit="contain" is what actually keeps
  // the image's real aspect ratio and un-cropped, letterboxed within it,
  // same convention as the large reference photo one level up (see
  // item-image-gallery-manager.tsx's own largeImage style).
  imageWrap: {
    ...StyleSheet.absoluteFillObject,
  },
  closeBtn: {
    position: 'absolute',
    right: 14,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
