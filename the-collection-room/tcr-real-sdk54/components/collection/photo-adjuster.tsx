import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import Animated, {
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

type Props = {
  uri: string;
  imageWidth: number;
  imageHeight: number;
  onUse: (uri: string) => void;
  onCancel: () => void;
};

// Only downscale if the cropped region exceeds this on either side.
// At 2000px the longest dimension is already large enough to read
// card text and serial numbers at full zoom.
const MAX_OUTPUT_PX = 2000;

export function PhotoAdjuster({
  uri,
  imageWidth,
  imageHeight,
  onUse,
  onCancel,
}: Props) {
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [processing, setProcessing] = useState(false);

  // Gesture-driven transform state (UI thread)
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(Math.max(savedScale.value * e.scale, 0.5), 6);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    });

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd(() => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const composed = Gesture.Simultaneous(pinch, pan);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  // Reset runs entirely on the UI thread so all shared value
  // writes are atomic — prevents race conditions with gesture worklets.
  function reset() {
    runOnUI(() => {
      'worklet';
      scale.value = withSpring(1);
      savedScale.value = 1;
      tx.value = withSpring(0);
      savedTx.value = 0;
      ty.value = withSpring(0);
      savedTy.value = 0;
    })();
  }

  async function handleUse() {
    if (processing || containerSize.width === 0) return;
    setProcessing(true);
    try {
      const exportedUri = await cropToView();
      onUse(exportedUri);
    } catch {
      Alert.alert('Export failed', 'Could not process the image. Please try again.');
    } finally {
      setProcessing(false);
    }
  }

  async function cropToView(): Promise<string> {
    // Read gesture values from JS thread — safe because no gesture is
    // active when the user taps "Use Photo".
    const S = scale.value;
    const txVal = tx.value;
    const tyVal = ty.value;
    const { width: W_c, height: H_c } = containerSize;
    const W_i = imageWidth;
    const H_i = imageHeight;

    // ── Step 1: how contentFit="contain" places the image ────────────
    // The image is scaled to fit the container while preserving aspect
    // ratio, then centered. fitScale converts image pixels ↔ view pixels.
    const fitScale = Math.min(W_c / W_i, H_c / H_i);
    const W_d = W_i * fitScale;
    const H_d = H_i * fitScale;
    const imgOffX = (W_c - W_d) / 2;
    const imgOffY = (H_c - H_d) / 2;

    // ── Step 2: inverse-transform the container's top-left corner ────
    // The Animated.View transform is applied in array order, which in
    // React Native means scale executes first (around the element center),
    // then translate.
    //
    // Forward: screen_x = S * (view_x - W_c/2) + W_c/2 + tx
    // Inverse at screen_x = 0:
    //   view_x = W_c/2 - W_c/(2*S) - tx/S
    const x0 = W_c / 2 - W_c / (2 * S) - txVal / S;
    const y0 = H_c / 2 - H_c / (2 * S) - tyVal / S;

    // The visible region in view-space is x0..x0+W_c/S, y0..y0+H_c/S

    // ── Step 3: convert view-space bounds to original image pixels ────
    const leftPx   = (x0           - imgOffX) / fitScale;
    const topPx    = (y0           - imgOffY) / fitScale;
    const rightPx  = (x0 + W_c / S - imgOffX) / fitScale;
    const bottomPx = (y0 + H_c / S - imgOffY) / fitScale;

    // Clamp to image bounds
    const cropX      = Math.max(0, Math.floor(leftPx));
    const cropY      = Math.max(0, Math.floor(topPx));
    const cropRight  = Math.min(W_i, Math.ceil(rightPx));
    const cropBottom = Math.min(H_i, Math.ceil(bottomPx));
    const cropW = cropRight - cropX;
    const cropH = cropBottom - cropY;

    // Safety: if math produced an empty or inverted rect, return original.
    if (cropW <= 0 || cropH <= 0) return uri;

    // ── Step 4: build manipulator action list ─────────────────────────
    const actions: (
      | { crop: { originX: number; originY: number; width: number; height: number } }
      | { resize: { width: number; height: number } }
    )[] = [
      { crop: { originX: cropX, originY: cropY, width: cropW, height: cropH } },
    ];

    // Only downscale if the crop exceeds MAX_OUTPUT_PX. This preserves
    // original resolution for most use cases; downscaling only kicks in
    // for very large source images (12 MP+ at S ≈ 1).
    if (cropW > MAX_OUTPUT_PX || cropH > MAX_OUTPUT_PX) {
      const ratio = Math.min(MAX_OUTPUT_PX / cropW, MAX_OUTPUT_PX / cropH);
      actions.push({
        resize: {
          width: Math.round(cropW * ratio),
          height: Math.round(cropH * ratio),
        },
      });
    }

    // compress: 0.95 — near-lossless JPEG; preserves card text and slab
    // labels without producing unnecessarily large files.
    const result = await manipulateAsync(uri, actions as any, {
      compress: 0.95,
      format: SaveFormat.JPEG,
    });

    return result.uri;
  }

  return (
    <Modal visible animationType="fade" statusBarTranslucent>
      <View style={styles.container}>
        {/* Header */}
        <SafeAreaView edges={['top']} style={styles.safeTop}>
          <View style={styles.header}>
            <TouchableOpacity
              onPress={onCancel}
              style={styles.headerBtn}
              disabled={processing}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Adjust Photo</Text>
            <TouchableOpacity
              onPress={reset}
              style={styles.headerBtn}
              disabled={processing}>
              <Text style={styles.resetText}>Reset</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>

        {/* Gesture preview — onLayout captures the exact container dimensions
            used by the crop math. GestureDetector covers the full area via
            the absoluteFill Animated.View. */}
        <View
          style={styles.previewContainer}
          onLayout={(e) =>
            setContainerSize({
              width: e.nativeEvent.layout.width,
              height: e.nativeEvent.layout.height,
            })
          }>
          <GestureDetector gesture={composed}>
            <Animated.View style={[StyleSheet.absoluteFill, animStyle]}>
              <Image
                source={{ uri }}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
              />
            </Animated.View>
          </GestureDetector>
        </View>

        {/* Footer */}
        <SafeAreaView edges={['bottom']} style={styles.safeBottom}>
          <View style={styles.footer}>
            <Text style={styles.hint}>Pinch to zoom  ·  Drag to reposition</Text>
            <TouchableOpacity
              style={[styles.useBtn, processing && styles.useBtnBusy]}
              onPress={handleUse}
              activeOpacity={0.85}
              disabled={processing}>
              {processing ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.useBtnText}>Use Photo</Text>
              )}
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  safeTop: {
    backgroundColor: '#000',
  },
  safeBottom: {
    backgroundColor: '#111',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  headerBtn: {
    minWidth: 70,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelText: {
    color: 'rgba(255,255,255,0.60)',
    fontSize: 16,
  },
  resetText: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'right',
  },
  previewContainer: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 8,
    gap: 12,
  },
  hint: {
    color: 'rgba(255,255,255,0.38)',
    fontSize: 13,
    textAlign: 'center',
  },
  useBtn: {
    backgroundColor: '#0a7ea4',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  useBtnBusy: {
    backgroundColor: 'rgba(10,126,164,0.60)',
  },
  useBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
});
