import { useEffect, useMemo, useState } from 'react';
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
  withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { clampAxisTranslation } from '@/lib/folder-cover-crop';

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
const MAX_SCALE = 6;
// How long the rule-of-thirds grid takes to fade out once the user lets go
// (dragging/pinching fades it back in instantly — see the gesture
// onBegin/onFinalize handlers below).
const GRID_FADE_DURATION = 220;

type CropAspectRatioKey = '3:4' | '1:1';

// No freeform ratios in this pass — trading-card/item photography is
// portrait-first, so 3:4 is the default; 1:1 covers the square case.
const ASPECT_RATIOS: { key: CropAspectRatioKey; label: string; ratio: number }[] = [
  { key: '3:4', label: '3:4', ratio: 3 / 4 },
  { key: '1:1', label: '1:1', ratio: 1 },
];
const DEFAULT_ASPECT_RATIO: CropAspectRatioKey = '3:4';

// clampAxisTranslation (shared by the pinch and pan gesture handlers below)
// now lives in lib/folder-cover-crop.ts, alongside the folder-hero cover
// adjuster's own crop math — same geometry convention as cropToView()'s
// inverse-transform math below: the Animated.View's transform is [scale
// around center, then translate], so a screen-space point `screen_x` maps
// back to `(screen_x - tx - W_c/2)/S + W_c/2` in the image layer's own
// (untransformed) coordinate space. The image occupies
// `[imgOffX, imgOffX+dispW]` in that space; for the frame's screen-space
// edges (frameLeft/frameLeft+frameW) to stay covered by the image at scale
// S, tx must stay within the two bounds that function derives (symmetric
// for ty).

export function PhotoAdjuster({
  uri,
  imageWidth,
  imageHeight,
  onUse,
  onCancel,
}: Props) {
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [processing, setProcessing] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<CropAspectRatioKey>(DEFAULT_ASPECT_RATIO);

  // Gesture-driven transform state (UI thread)
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  // Crop-frame/image geometry, mirrored onto the UI thread so the gesture
  // worklets below can clamp against it without crossing threads. Kept in
  // sync with `frame`/`containerSize` via the effect further down —
  // whenever either changes (container laid out, aspect ratio switched),
  // these are recomputed and the current scale/tx/ty are re-clamped to fit.
  const minScale = useSharedValue(1);
  const frameLeft = useSharedValue(0);
  const frameTop = useSharedValue(0);
  const frameW = useSharedValue(0);
  const frameH = useSharedValue(0);
  const imgOffX = useSharedValue(0);
  const imgOffY = useSharedValue(0);
  const dispW = useSharedValue(0);
  const dispH = useSharedValue(0);
  const containerW = useSharedValue(0);
  const containerH = useSharedValue(0);

  // Rule-of-thirds grid visibility — 1 while a drag or pinch is active
  // (across either gesture, tracked via activeTouches so a two-finger
  // pinch-then-continue-panning gesture doesn't flicker the grid off
  // between the two), fades to 0 shortly after the last one ends.
  const gridOpacity = useSharedValue(0);
  const activeTouches = useSharedValue(0);

  // The crop frame's own on-screen rect — sized to use the available
  // width edge-to-edge for the current aspect ratio, capped to the
  // container's height so it never overflows vertically, then centered.
  // This exact rect is what the mask/grid overlay below is drawn against,
  // and what cropToView() reads to compute the exported crop — the same
  // geometry drives both, so the preview is WYSIWYG by construction.
  const frame = useMemo(() => {
    const ratioValue = ASPECT_RATIOS.find((r) => r.key === aspectRatio)!.ratio;
    const { width: cw, height: ch } = containerSize;
    if (cw === 0 || ch === 0) return { left: 0, top: 0, width: 0, height: 0 };
    let w = cw;
    let h = w / ratioValue;
    if (h > ch) {
      h = ch;
      w = h * ratioValue;
    }
    return { left: (cw - w) / 2, top: (ch - h) / 2, width: w, height: h };
  }, [containerSize, aspectRatio]);

  // Recomputes every piece of shared geometry the gesture worklets and
  // cropToView() depend on, then re-clamps the current scale/tx/ty against
  // it — runs on mount (once the container has a real size) and again
  // whenever the aspect ratio changes. Bumping scale up to the new
  // minimum (if needed) and re-centering tx/ty within the new bounds is
  // exactly "preserve position/zoom as sensibly as possible, but never
  // leave empty space inside the frame."
  useEffect(() => {
    const { width: W_c, height: H_c } = containerSize;
    if (W_c === 0 || H_c === 0 || frame.width === 0 || frame.height === 0) return;
    const W_i = imageWidth;
    const H_i = imageHeight;
    const fitScale = Math.min(W_c / W_i, H_c / H_i);
    const W_d = W_i * fitScale;
    const H_d = H_i * fitScale;
    const offX = (W_c - W_d) / 2;
    const offY = (H_c - H_d) / 2;
    const newMinScale = Math.max(frame.width / W_d, frame.height / H_d);

    runOnUI(
      (
        fLeft: number,
        fTop: number,
        fW: number,
        fH: number,
        oX: number,
        oY: number,
        dW: number,
        dH: number,
        minS: number,
        cW: number,
        cH: number,
      ) => {
        'worklet';
        frameLeft.value = fLeft;
        frameTop.value = fTop;
        frameW.value = fW;
        frameH.value = fH;
        imgOffX.value = oX;
        imgOffY.value = oY;
        dispW.value = dW;
        dispH.value = dH;
        containerW.value = cW;
        containerH.value = cH;
        minScale.value = minS;

        if (scale.value < minS) {
          scale.value = minS;
          savedScale.value = minS;
        }
        const S = scale.value;
        tx.value = clampAxisTranslation(S, tx.value, fLeft, fW, oX, dW, cW);
        ty.value = clampAxisTranslation(S, ty.value, fTop, fH, oY, dH, cH);
        savedTx.value = tx.value;
        savedTy.value = ty.value;
      },
    )(frame.left, frame.top, frame.width, frame.height, offX, offY, W_d, H_d, newMinScale, W_c, H_c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerSize.width, containerSize.height, aspectRatio, frame.left, frame.top, frame.width, frame.height]);

  const pinch = Gesture.Pinch()
    .onBegin(() => {
      activeTouches.value += 1;
      gridOpacity.value = 1;
    })
    .onUpdate((e) => {
      const S = Math.min(Math.max(savedScale.value * e.scale, minScale.value), MAX_SCALE);
      scale.value = S;
      // Zooming out can un-cover the frame even without a pan gesture in
      // flight — re-clamp translation against the new scale every update.
      tx.value = clampAxisTranslation(S, tx.value, frameLeft.value, frameW.value, imgOffX.value, dispW.value, containerW.value);
      ty.value = clampAxisTranslation(S, ty.value, frameTop.value, frameH.value, imgOffY.value, dispH.value, containerH.value);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    })
    .onFinalize(() => {
      activeTouches.value = Math.max(0, activeTouches.value - 1);
      if (activeTouches.value === 0) {
        gridOpacity.value = withTiming(0, { duration: GRID_FADE_DURATION });
      }
    });

  const pan = Gesture.Pan()
    .onBegin(() => {
      activeTouches.value += 1;
      gridOpacity.value = 1;
    })
    .onUpdate((e) => {
      const S = scale.value;
      tx.value = clampAxisTranslation(
        S,
        savedTx.value + e.translationX,
        frameLeft.value,
        frameW.value,
        imgOffX.value,
        dispW.value,
        containerW.value,
      );
      ty.value = clampAxisTranslation(
        S,
        savedTy.value + e.translationY,
        frameTop.value,
        frameH.value,
        imgOffY.value,
        dispH.value,
        containerH.value,
      );
    })
    .onEnd(() => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    })
    .onFinalize(() => {
      activeTouches.value = Math.max(0, activeTouches.value - 1);
      if (activeTouches.value === 0) {
        gridOpacity.value = withTiming(0, { duration: GRID_FADE_DURATION });
      }
    });

  const composed = Gesture.Simultaneous(pinch, pan);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  const gridAnimStyle = useAnimatedStyle(() => ({
    opacity: gridOpacity.value,
  }));

  // Reset runs entirely on the UI thread so all shared value
  // writes are atomic — prevents race conditions with gesture worklets.
  // Targets minScale (not a hardcoded 1) and tx/ty 0 — the frame-centered,
  // gap-free resting position for whatever the current aspect ratio is.
  function reset() {
    runOnUI(() => {
      'worklet';
      scale.value = withSpring(minScale.value);
      savedScale.value = minScale.value;
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
    const imgOffXVal = (W_c - W_d) / 2;
    const imgOffYVal = (H_c - H_d) / 2;

    // ── Step 2: inverse-transform the crop FRAME's screen-space edges ──
    // (not the full container's — the frame is the visible bright
    // rectangle the user composes inside; the mask outside it is
    // deliberately excluded from the export). The Animated.View
    // transform is applied in array order, which in React Native means
    // scale executes first (around the element center), then translate.
    //
    // Forward: screen_x = S * (view_x - W_c/2) + W_c/2 + tx
    // Inverse at a given screen_x:
    //   view_x = (screen_x - tx - W_c/2)/S + W_c/2
    const fLeft = frame.left;
    const fRight = frame.left + frame.width;
    const fTop = frame.top;
    const fBottom = frame.top + frame.height;

    const x0 = (fLeft - txVal - W_c / 2) / S + W_c / 2;
    const x1 = (fRight - txVal - W_c / 2) / S + W_c / 2;
    const y0 = (fTop - tyVal - H_c / 2) / S + H_c / 2;
    const y1 = (fBottom - tyVal - H_c / 2) / S + H_c / 2;

    // ── Step 3: convert view-space bounds to original image pixels ────
    const leftPx   = (x0 - imgOffXVal) / fitScale;
    const topPx    = (y0 - imgOffYVal) / fitScale;
    const rightPx  = (x1 - imgOffXVal) / fitScale;
    const bottomPx = (y1 - imgOffYVal) / fitScale;

    // Clamp to image bounds — defense in depth; the live gesture clamping
    // above should already guarantee this rect sits fully inside the
    // image, but pixel rounding gets the final say.
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
            the absoluteFill Animated.View; the mask/frame/grid overlay is
            layered on top with pointerEvents="none" so it never intercepts
            the drag/pinch gestures underneath it. */}
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

          {frame.width > 0 && (
            <>
              {/* Dims everything outside the crop frame — the exact
                  region cropToView() excludes from the export. */}
              <View pointerEvents="none" style={[styles.maskBar, { left: 0, top: 0, width: containerSize.width, height: frame.top }]} />
              <View
                pointerEvents="none"
                style={[
                  styles.maskBar,
                  { left: 0, top: frame.top + frame.height, width: containerSize.width, height: containerSize.height - frame.top - frame.height },
                ]}
              />
              <View pointerEvents="none" style={[styles.maskBar, { left: 0, top: frame.top, width: frame.left, height: frame.height }]} />
              <View
                pointerEvents="none"
                style={[
                  styles.maskBar,
                  { left: frame.left + frame.width, top: frame.top, width: containerSize.width - frame.left - frame.width, height: frame.height },
                ]}
              />

              {/* Clean square-cornered frame boundary — no borderRadius. */}
              <View
                pointerEvents="none"
                style={[styles.frameBorder, { left: frame.left, top: frame.top, width: frame.width, height: frame.height }]}
              />

              {/* Rule-of-thirds guide — 2 vertical + 2 horizontal lines,
                  purely visual (pointerEvents="none", never rendered into
                  the exported crop since it's UI overlay, not part of the
                  manipulateAsync() pipeline above). Visible while actively
                  dragging/pinching (see gridOpacity), fades out at rest. */}
              <Animated.View
                pointerEvents="none"
                style={[styles.gridWrap, { left: frame.left, top: frame.top, width: frame.width, height: frame.height }, gridAnimStyle]}>
                <View style={[styles.gridLineV, { left: frame.width / 3 }]} />
                <View style={[styles.gridLineV, { left: (frame.width / 3) * 2 }]} />
                <View style={[styles.gridLineH, { top: frame.height / 3 }]} />
                <View style={[styles.gridLineH, { top: (frame.height / 3) * 2 }]} />
              </Animated.View>
            </>
          )}
        </View>

        {/* Footer */}
        <SafeAreaView edges={['bottom']} style={styles.safeBottom}>
          <View style={styles.footer}>
            <View style={styles.ratioRow}>
              {ASPECT_RATIOS.map((r) => (
                <TouchableOpacity
                  key={r.key}
                  onPress={() => setAspectRatio(r.key)}
                  disabled={processing}
                  style={[styles.ratioBtn, aspectRatio === r.key && styles.ratioBtnActive]}
                  accessibilityRole="button"
                  accessibilityLabel={`${r.label} crop`}
                  accessibilityState={{ selected: aspectRatio === r.key }}>
                  <Text style={[styles.ratioBtnText, aspectRatio === r.key && styles.ratioBtnTextActive]}>
                    {r.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

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
  // Dimming layer outside the crop frame — same dark tone on all 4 sides.
  maskBar: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  // Square corners by design (no borderRadius) — the output frame has
  // clean boundaries, not a rounded crop.
  frameBorder: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
  },
  gridWrap: {
    position: 'absolute',
  },
  gridLineV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  gridLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 8,
    gap: 12,
  },
  ratioRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
  },
  ratioBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  ratioBtnActive: {
    backgroundColor: '#0a7ea4',
  },
  ratioBtnText: {
    color: 'rgba(255,255,255,0.70)',
    fontSize: 14,
    fontWeight: '600',
  },
  ratioBtnTextActive: {
    color: '#fff',
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
