import { useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import type { Folder } from '@/types';

// Kept in sync with folder-card.tsx's own palette by design, but duplicated
// rather than imported — this is a visually distinct card for the profile's
// horizontal Folders row, independent of folder-card.tsx (still used as-is
// by the Collection tab's grid).
const PLACEHOLDER_COLORS = [
  '#C8DFF5',
  '#DDD0F0',
  '#C6E8D3',
  '#F5E6C8',
  '#F5CDD0',
  '#C6E8E8',
];

function placeholderColor(name: string) {
  return PLACEHOLDER_COLORS[name.charCodeAt(0) % PLACEHOLDER_COLORS.length];
}

type Props = {
  folder: Folder;
  onPress: () => void;
  // Static tilt in degrees (e.g. -1.5 / 0 / 1.5) — the caller decides which
  // position in the row gets which value.
  rotationDeg?: number;
};

const CHIP_WIDTH = 104;
const CHIP_HEIGHT = 128;
const BORDER_COLOR_REST = 'rgba(215, 224, 238, 0.48)';
const BORDER_COLOR_PRESSED = 'rgba(215, 224, 238, 0.75)';

export function FolderChip({ folder, onPress, rotationDeg = 0 }: Props) {
  // Single driver for the whole press state — lift, scale, and border
  // opacity all interpolate off this one value so they stay in lockstep.
  // useNativeDriver: false because borderColor interpolation (a color, not
  // a transform) requires the JS driver; not a continuous/looping
  // animation, so the perf cost is negligible.
  const pressProgress = useRef(new Animated.Value(0)).current;

  function handlePressIn() {
    Animated.timing(pressProgress, {
      toValue: 1,
      duration: 160,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }

  function handlePressOut() {
    Animated.spring(pressProgress, {
      toValue: 0,
      useNativeDriver: false,
      speed: 18,
      bounciness: 6,
    }).start();
  }

  const translateY = pressProgress.interpolate({ inputRange: [0, 1], outputRange: [0, -4] });
  const scale = pressProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.025] });
  const borderColor = pressProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [BORDER_COLOR_REST, BORDER_COLOR_PRESSED],
  });

  return (
    <Pressable onPress={onPress} onPressIn={handlePressIn} onPressOut={handlePressOut}>
      {/* Shadow layer — separate from the clipped card below, since
          overflow:'hidden' (needed for the rounded image/gradient) would
          also clip a shadow applied on the same view. Carries the press
          transform so the shadow lifts together with the card. */}
      <Animated.View
        style={[
          styles.shadowWrap,
          { transform: [{ rotate: `${rotationDeg}deg` }, { translateY }, { scale }] },
        ]}>
        <Animated.View style={[styles.card, { borderColor }]}>
          <View style={[styles.fill, { backgroundColor: placeholderColor(folder.name) }]}>
            {folder.cover_image_url ? (
              <Image
                source={{ uri: folder.cover_image_url }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={200}
              />
            ) : (
              <Text style={styles.initial}>{folder.name.charAt(0).toUpperCase()}</Text>
            )}
          </View>

          {/* Faint white inner highlight, top-left edge only. */}
          <View style={styles.innerHighlight} pointerEvents="none" />

          {/* Restrained iridescent accent — a short section of the right
              edge only, not a full outline. */}
          <LinearGradient
            colors={['rgba(117,215,238,0)', 'rgba(117,215,238,0.5)', 'rgba(200,181,244,0.42)', 'rgba(240,175,203,0)']}
            locations={[0, 0.35, 0.65, 1]}
            style={styles.iridescentAccent}
            pointerEvents="none"
          />

          {/* Folder name, anchored at the bottom over the image. */}
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.25)', 'rgba(0,0,0,0.78)']}
            locations={[0, 0.5, 1]}
            style={styles.gradient}>
            <Text style={styles.name} numberOfLines={1}>
              {folder.name}
            </Text>
          </LinearGradient>
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  shadowWrap: {
    width: CHIP_WIDTH,
    height: CHIP_HEIGHT,
    borderRadius: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.26,
    shadowRadius: 12,
    elevation: 5,
  },
  card: {
    width: CHIP_WIDTH,
    height: CHIP_HEIGHT,
    borderRadius: 18,
    borderWidth: 1.25,
    overflow: 'hidden',
  },
  fill: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Faint highlight tracing the top-left edge only — a soft suggestion of a
  // glass surface catching light, not a full border treatment.
  innerHighlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: CHIP_WIDTH * 0.55,
    height: 1.5,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  // Short vertical strip along part of the right edge only.
  iridescentAccent: {
    position: 'absolute',
    right: 0,
    top: CHIP_HEIGHT * 0.16,
    width: 2,
    height: CHIP_HEIGHT * 0.34,
  },
  initial: {
    fontSize: 30,
    fontWeight: '800',
    color: 'rgba(0,0,0,0.16)',
  },
  gradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '32%',
    justifyContent: 'flex-end',
    paddingBottom: 10,
    paddingHorizontal: 12,
  },
  name: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
    textAlign: 'center',
  },
});
