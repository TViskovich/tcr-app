import { useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { AVATAR_SIZE, IDENTITY_TOP_PADDING } from './hero-constants';
import type { HeroCanvasThemeId } from './hero-canvas-themes';
import {
  SPECTRA_BASE,
  SPECTRA_CENTER_DARKENING,
  SPECTRA_CONTACT_SHADOW,
  SPECTRA_EDGE_BOTTOM,
  SPECTRA_EDGE_LEFT,
  SPECTRA_EDGE_RIGHT,
  SPECTRA_EDGE_TOP,
  SPECTRA_GRAIN,
  SPECTRA_MOTION,
  SPECTRA_RIM_BEZEL,
  SPECTRA_RIM_GLOW,
  SPECTRA_STREAK_AXIS,
  SPECTRA_STREAKS,
} from './spectra-config';

type Props = {
  theme?: HeroCanvasThemeId;
  scrollY?: Animated.Value;
};

export function HeroCanvasTheme({ theme = 'classic', scrollY }: Props) {
  // TEMP(M2): 'spectra' isn't a registered HeroCanvasThemeId yet (Milestone 3
  // adds it to the registry). Cast to string so this temporary branch can be
  // reached via the hardcoded test path in profile-hero.tsx. Remove this cast
  // and fold the comparison into the normal theme switch once Milestone 3 lands.
  const isSpectra = (theme as string) === 'spectra';

  // Fallback keeps the component usable if a future caller doesn't wire
  // scrollY through — resolves to a static 0 (no motion), never undefined.
  const fallbackScrollY = useRef(new Animated.Value(0)).current;
  const activeScrollY = scrollY ?? fallbackScrollY;

  const streaksX = activeScrollY.interpolate({
    inputRange: [...SPECTRA_MOTION.inputRange],
    outputRange: [...SPECTRA_MOTION.streaksX],
    extrapolate: 'clamp',
  });
  const streaksY = activeScrollY.interpolate({
    inputRange: [...SPECTRA_MOTION.inputRange],
    outputRange: [...SPECTRA_MOTION.streaksY],
    extrapolate: 'clamp',
  });

  if (isSpectra) {
    const overscan = SPECTRA_MOTION.overscan;
    const avatarTop = IDENTITY_TOP_PADDING;

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {/* 1. Base graphite material — the display surface itself, fully opaque,
            static (it's the substrate, not the lighting). */}
        <LinearGradient
          colors={SPECTRA_BASE.colors}
          locations={SPECTRA_BASE.locations}
          start={SPECTRA_BASE.start}
          end={SPECTRA_BASE.end}
          style={StyleSheet.absoluteFill}
        />

        {/* 2. Metallic grain — quiet, full-bleed texture pass */}
        <Image
          source={SPECTRA_GRAIN.source}
          style={[StyleSheet.absoluteFill, { opacity: SPECTRA_GRAIN.opacity }]}
          contentFit="cover"
        />

        {/* 3. Streak system — five clearly-visible colored diagonal lines
            sharing one axis, standing in for reflection, specular, and
            optical coating as one lighting event rather than separate
            effects. Moves together (parallax), oversized so translation
            never reveals an edge. */}
        <Animated.View
          style={[
            styles.overscanFill(overscan),
            { transform: [{ translateX: streaksX }, { translateY: streaksY }] },
          ]}
        >
          {SPECTRA_STREAKS.map((streak, i) => (
            <LinearGradient
              key={i}
              colors={streak.colors}
              locations={streak.locations}
              start={SPECTRA_STREAK_AXIS.start}
              end={SPECTRA_STREAK_AXIS.end}
              style={StyleSheet.absoluteFill}
            />
          ))}
        </Animated.View>

        {/* 5. Center darkening — keeps the band behind the showcase circle
            calm so the circle stays the focal point; static, anchored. */}
        <LinearGradient
          colors={SPECTRA_CENTER_DARKENING.colors}
          locations={SPECTRA_CENTER_DARKENING.locations}
          style={{
            position: 'absolute',
            top: avatarTop - 40,
            left: 0,
            right: 0,
            height: AVATAR_SIZE + 80,
          }}
        />

        {/* 6. Edge lighting — thin beveled-edge catch-lights, not glows */}
        <LinearGradient
          colors={SPECTRA_EDGE_TOP.colors}
          locations={SPECTRA_EDGE_TOP.locations}
          start={SPECTRA_EDGE_TOP.start}
          end={SPECTRA_EDGE_TOP.end}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: SPECTRA_EDGE_TOP.height }}
        />
        <LinearGradient
          colors={SPECTRA_EDGE_BOTTOM.colors}
          locations={SPECTRA_EDGE_BOTTOM.locations}
          start={SPECTRA_EDGE_BOTTOM.start}
          end={SPECTRA_EDGE_BOTTOM.end}
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: SPECTRA_EDGE_BOTTOM.height }}
        />
        <LinearGradient
          colors={SPECTRA_EDGE_LEFT.colors}
          locations={SPECTRA_EDGE_LEFT.locations}
          start={SPECTRA_EDGE_LEFT.start}
          end={SPECTRA_EDGE_LEFT.end}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: SPECTRA_EDGE_LEFT.width }}
        />
        <LinearGradient
          colors={SPECTRA_EDGE_RIGHT.colors}
          locations={SPECTRA_EDGE_RIGHT.locations}
          start={SPECTRA_EDGE_RIGHT.start}
          end={SPECTRA_EDGE_RIGHT.end}
          style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: SPECTRA_EDGE_RIGHT.width }}
        />

        {/* 7. Showcase integration — contact shadow + a vivid chrome bezel
            ring, sized/positioned from the real avatar geometry so the circle
            reads as physically mounted on the material. Static — showcase and
            UI stay anchored; only the streak layer above moves. The bezel and
            its outer glow are a few px larger than the avatar; since the
            (unmodified) avatar renders on top of this in the real tree, only
            the ring around its edge shows through, like a bezel. */}
        <View
          style={{
            position: 'absolute',
            top: avatarTop,
            left: 0,
            right: 0,
            height: AVATAR_SIZE,
            alignItems: 'center',
          }}
        >
          <View
            style={{
              position: 'absolute',
              top: -SPECTRA_RIM_GLOW.extraSize / 2,
              width: AVATAR_SIZE + SPECTRA_RIM_GLOW.extraSize,
              height: AVATAR_SIZE + SPECTRA_RIM_GLOW.extraSize,
              borderRadius: (AVATAR_SIZE + SPECTRA_RIM_GLOW.extraSize) / 2,
              borderWidth: SPECTRA_RIM_GLOW.borderWidth,
              borderColor: SPECTRA_RIM_GLOW.color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              top: -SPECTRA_RIM_BEZEL.extraSize / 2,
              width: AVATAR_SIZE + SPECTRA_RIM_BEZEL.extraSize,
              height: AVATAR_SIZE + SPECTRA_RIM_BEZEL.extraSize,
              borderRadius: (AVATAR_SIZE + SPECTRA_RIM_BEZEL.extraSize) / 2,
              overflow: 'hidden',
            }}
          >
            <LinearGradient
              colors={SPECTRA_RIM_BEZEL.colors}
              locations={SPECTRA_RIM_BEZEL.locations}
              start={SPECTRA_RIM_BEZEL.start}
              end={SPECTRA_RIM_BEZEL.end}
              style={StyleSheet.absoluteFill}
            />
          </View>
          <View
            style={{
              position: 'absolute',
              top: AVATAR_SIZE - AVATAR_SIZE * SPECTRA_CONTACT_SHADOW.heightRatio * SPECTRA_CONTACT_SHADOW.overlapRatio,
              width: AVATAR_SIZE * SPECTRA_CONTACT_SHADOW.widthRatio,
              height: AVATAR_SIZE * SPECTRA_CONTACT_SHADOW.heightRatio,
              borderRadius: (AVATAR_SIZE * SPECTRA_CONTACT_SHADOW.heightRatio) / 2,
              backgroundColor: SPECTRA_CONTACT_SHADOW.color,
            }}
          />
        </View>
      </View>
    );
  }

  if (theme !== 'foil') return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* 1. Base dark veil — softens the hero image top and bottom */}
      <LinearGradient
        colors={['rgba(0,0,0,0.28)', 'transparent', 'rgba(0,0,0,0.18)']}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />

      {/* 2. Foil layer 1 — purple → teal diagonal */}
      <LinearGradient
        colors={['rgba(120,60,220,0.10)', 'rgba(0,200,180,0.10)', 'transparent']}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {/* 3. Foil layer 2 — gold → rose counter-diagonal */}
      <LinearGradient
        colors={['rgba(220,180,40,0.08)', 'rgba(200,60,120,0.08)', 'transparent']}
        locations={[0, 0.50, 1]}
        start={{ x: 1, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {/* 4. Foil layer 3 — horizontal cyan → blue shimmer */}
      <LinearGradient
        colors={['rgba(0,210,230,0.07)', 'transparent', 'rgba(40,80,220,0.07)']}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />

      {/* 5. Edge vignette — frames the canvas, improves text contrast */}
      <LinearGradient
        colors={['rgba(0,0,0,0.30)', 'transparent', 'rgba(0,0,0,0.22)']}
        locations={[0, 0.40, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = {
  overscanFill: (overscan: number) => ({
    position: 'absolute' as const,
    top: -overscan,
    left: -overscan,
    right: -overscan,
    bottom: -overscan,
  }),
};
