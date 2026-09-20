import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';

import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnUI, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FOLDER_COVER_ASPECT_RATIO } from '@/constants/folder-cover';
import { clampAxisTranslation, deriveFolderCoverCrop } from '@/lib/folder-cover-crop';
import type { FolderCoverCrop } from '@/types';

const MAX_SCALE = 6;
const GRID_FADE_DURATION = 220;

type Props = {
  visible: boolean;
  uri: string;
  onSave: (crop: FolderCoverCrop) => void;
  onCancel: () => void;
};

// Non-destructive companion to photo-adjuster.tsx for the folder-hero
// cover flow — shared by BOTH "Choose from Folder" (an already-stored
// item image) and "Choose from Library" (a freshly-picked, unedited local
// photo; native iOS/Android cropping is skipped so this is the only crop
// UI either path goes through): pan/zoom the selected image inside a
// viewport pinned to the exact hero aspect ratio, then hand back
// {x,y,scale} crop metadata (lib/folder-cover-crop.ts). For "Choose from
// Folder" this never touches Storage — only folders.cover_crop changes;
// for "Choose from Library" the caller (app/collection/[folderId].tsx)
// uploads the untouched local image first, then saves this same crop
// metadata alongside it.
//
// Simpler geometry than PhotoAdjuster: there's exactly one fixed aspect
// ratio, and the preview viewport IS the crop frame (no separate,
// letterboxed frame-within-a-taller-container) — so there's no mask
// overlay or aspect-ratio switcher here, just the shared clamped
// pinch/pan.
export function FolderCoverAdjuster({ visible, uri, onSave, onCancel }: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const containerW = windowWidth;
  const containerH = windowWidth / FOLDER_COVER_ASPECT_RATIO;

  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  // Mirrors PhotoAdjuster's own shared geometry values — synced from JS
  // whenever naturalSize resolves, read by the gesture worklets below.
  const minScale = useSharedValue(1);
  const imgOffX = useSharedValue(0);
  const imgOffY = useSharedValue(0);
  const dispW = useSharedValue(0);
  const dispH = useSharedValue(0);

  const gridOpacity = useSharedValue(0);
  const activeTouches = useSharedValue(0);

  // A new uri means a newly-selected item — start over rather than
  // carrying over the previous item's framing ("switching to another item
  // starts at a sensible default fit," per spec).
  useEffect(() => {
    setNaturalSize(null);
  }, [uri]);

  // Once the image's natural size is known (see onLoad below), compute the
  // "just covers the frame" baseline and snap straight to it — that
  // baseline (minScale, centered) IS the sensible default fit for a
  // freshly-selected item, no separate special-casing needed.
  useEffect(() => {
    if (!naturalSize || containerW === 0 || containerH === 0) return;
    const W_i = naturalSize.width;
    const H_i = naturalSize.height;
    const fitScale = Math.min(containerW / W_i, containerH / H_i);
    const W_d = W_i * fitScale;
    const H_d = H_i * fitScale;
    const offX = (containerW - W_d) / 2;
    const offY = (containerH - H_d) / 2;
    const newMinScale = Math.max(containerW / W_d, containerH / H_d);

    runOnUI(
      (oX: number, oY: number, dW: number, dH: number, minS: number) => {
        'worklet';
        imgOffX.value = oX;
        imgOffY.value = oY;
        dispW.value = dW;
        dispH.value = dH;
        minScale.value = minS;
        scale.value = minS;
        savedScale.value = minS;
        tx.value = 0;
        savedTx.value = 0;
        ty.value = 0;
        savedTy.value = 0;
      },
    )(offX, offY, W_d, H_d, newMinScale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naturalSize, containerW, containerH]);

  const pinch = Gesture.Pinch()
    .onBegin(() => {
      activeTouches.value += 1;
      gridOpacity.value = 1;
    })
    .onUpdate((e) => {
      const S = Math.min(Math.max(savedScale.value * e.scale, minScale.value), MAX_SCALE);
      scale.value = S;
      tx.value = clampAxisTranslation(S, tx.value, 0, containerW, imgOffX.value, dispW.value, containerW);
      ty.value = clampAxisTranslation(S, ty.value, 0, containerH, imgOffY.value, dispH.value, containerH);
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
      tx.value = clampAxisTranslation(S, savedTx.value + e.translationX, 0, containerW, imgOffX.value, dispW.value, containerW);
      ty.value = clampAxisTranslation(S, savedTy.value + e.translationY, 0, containerH, imgOffY.value, dispH.value, containerH);
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
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  const gridAnimStyle = useAnimatedStyle(() => ({
    opacity: gridOpacity.value,
  }));

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

  function handleSave() {
    if (!naturalSize) return;
    const crop = deriveFolderCoverCrop({
      scale: scale.value,
      tx: tx.value,
      ty: ty.value,
      containerW,
      containerH,
      imageW: naturalSize.width,
      imageH: naturalSize.height,
    });
    onSave(crop);
  }

  return (
    <Modal visible={visible} animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
      <View style={styles.container}>
        <SafeAreaView edges={['top']} style={styles.safeTop}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onCancel} style={styles.headerBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Adjust Cover</Text>
            <TouchableOpacity onPress={reset} style={styles.headerBtn} disabled={!naturalSize}>
              <Text style={styles.resetText}>Reset</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>

        {/* The preview viewport IS the crop frame — sized to the exact
            same width/aspectRatio as the real hero, so this is WYSIWYG by
            construction rather than by visual approximation. */}
        <View style={[styles.previewContainer, { width: containerW, height: containerH }]}>
          <GestureDetector gesture={composed}>
            <Animated.View style={[StyleSheet.absoluteFill, animStyle, !naturalSize && styles.hidden]}>
              <Image
                source={{ uri }}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
                onLoad={(e) => setNaturalSize({ width: e.source.width, height: e.source.height })}
              />
            </Animated.View>
          </GestureDetector>

          {!naturalSize && (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.loadingWrap]}>
              <ActivityIndicator color="#fff" />
            </View>
          )}

          {naturalSize && (
            <>
              <View pointerEvents="none" style={styles.frameBorder} />
              <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, gridAnimStyle]}>
                <View style={[styles.gridLineV, { left: containerW / 3 }]} />
                <View style={[styles.gridLineV, { left: (containerW / 3) * 2 }]} />
                <View style={[styles.gridLineH, { top: containerH / 3 }]} />
                <View style={[styles.gridLineH, { top: (containerH / 3) * 2 }]} />
              </Animated.View>
            </>
          )}
        </View>

        <SafeAreaView edges={['bottom']} style={styles.safeBottom}>
          <View style={styles.footer}>
            <Text style={styles.hint}>Pinch to zoom  ·  Drag to reposition</Text>
            <TouchableOpacity
              style={[styles.useBtn, !naturalSize && styles.useBtnBusy]}
              onPress={handleSave}
              activeOpacity={0.85}
              disabled={!naturalSize}>
              <Text style={styles.useBtnText}>Save</Text>
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
    alignSelf: 'center',
    marginTop: 24,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  hidden: {
    opacity: 0,
  },
  loadingWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameBorder: {
    ...StyleSheet.absoluteFill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
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
    paddingTop: 20,
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
