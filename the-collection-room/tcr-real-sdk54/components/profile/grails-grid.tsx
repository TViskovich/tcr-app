import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';

import { PremiumCardHeader, PremiumEmptyCard, VAULT_COLORS } from '@/components/ui/premium-empty-card';
import { GrailsSlot } from '@/components/profile/grails-slot';
import type { ShowcaseItem } from '@/types';

type Props = {
  grails: ShowcaseItem[];
  editable?: boolean;
  onItemPress?: (item: ShowcaseItem) => void;
  onCabinetPress?: () => void;
  onAddFirstGrail?: () => void;
  vaultMargin?: number;
};

const COLS = 3;
const MAX_SLOTS = 9;

// Small warm-gold particles rising from the bottom of the filled-grid
// vault's background. They pass behind the header/card grid (rendered
// after this layer, so opaque content covers them) and read clearly in the
// open space around the "GRAILS" title near the top — the vault's own
// overflow:'hidden' clips anything that drifts past its edges. RN Animated
// (not reanimated) to match this file's existing press-animation approach.
const PARTICLE_COUNT = 14;
const PARTICLE_FIELD_HEIGHT = 340;

type ParticleSpec = {
  left: `${number}%`;
  top: number;
  size: number;
  duration: number;
  delay: number;
  peakOpacity: number;
};

// Deterministic jitter (not Math.random()) so the field is stable across
// re-renders — spread across the field's width, biased toward the lower
// half vertically so particles visibly originate from "the bottom" before
// their own rising animation carries them up toward the top.
const GRAIL_PARTICLES: ParticleSpec[] = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
  const t = i / (PARTICLE_COUNT - 1);
  return {
    left: `${(4 + t * 92).toFixed(1)}%` as `${number}%`,
    top: PARTICLE_FIELD_HEIGHT * (0.45 + ((i * 47) % 10) / 10 * 0.55),
    size: 1.4 + ((i * 37) % 10) / 10 * 1.6,
    duration: 5200 + ((i * 53) % 10) * 420,
    delay: (i * 311) % 4200,
    peakOpacity: 0.32 + ((i * 71) % 10) / 10 * 0.34,
  };
});

// A single rising, fading particle. Resets instantly (0ms) from t=1 back to
// t=0 each loop, but opacity is 0 at both ends so the reset itself is
// invisible — the classic "rising ember" loop trick.
function GrailParticle({ spec }: { spec: ParticleSpec }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(spec.delay),
        Animated.timing(progress, {
          toValue: 1,
          duration: spec.duration,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(progress, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [progress, spec.delay, spec.duration]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -PARTICLE_FIELD_HEIGHT * 0.85],
  });
  const opacity = progress.interpolate({
    inputRange: [0, 0.12, 0.7, 1],
    outputRange: [0, spec.peakOpacity, spec.peakOpacity * 0.45, 0],
  });

  return (
    <Animated.View
      style={[
        styles.grailParticle,
        {
          left: spec.left,
          top: spec.top,
          width: spec.size,
          height: spec.size,
          borderRadius: spec.size / 2,
          opacity,
          transform: [{ translateY }],
        },
      ]}
    />
  );
}

function GrailParticles() {
  return (
    <View style={styles.grailParticleField} pointerEvents="none">
      {GRAIL_PARTICLES.map((spec, i) => (
        <GrailParticle key={i} spec={spec} />
      ))}
    </View>
  );
}

export function GrailsGrid({
  grails,
  editable = false,
  onItemPress,
  onCabinetPress,
  onAddFirstGrail,
  vaultMargin = 14,
}: Props) {
  // Explicit pixel width ensures identical screen-edge margins regardless of parent padding.
  const { width: screenWidth } = useWindowDimensions();
  const vaultWidth = screenWidth - vaultMargin * 2;

  // Press animation — declared before early return to satisfy Rules of Hooks.
  const pressScale = useRef(new Animated.Value(1)).current;
  const pressOpacity = useRef(new Animated.Value(1)).current;

  function handlePressIn() {
    Animated.parallel([
      Animated.spring(pressScale, { toValue: 0.93, useNativeDriver: true, speed: 60, bounciness: 0 }),
      Animated.timing(pressOpacity, { toValue: 0.65, duration: 100, useNativeDriver: true }),
    ]).start();
  }

  function handlePressOut() {
    Animated.parallel([
      Animated.spring(pressScale, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 5 }),
      Animated.timing(pressOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
    ]).start();
  }

  // Slow, subtle breathing pulse for the featured center card (index 4)
  // only — scale only, nothing else animates. Declared before the early
  // return to satisfy Rules of Hooks.
  const featuredPulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(featuredPulse, {
          toValue: 1,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(featuredPulse, {
          toValue: 0,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    animation.start();

    return () => animation.stop();
  }, [featuredPulse]);

  const featuredScale = featuredPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1.06, 1.09],
  });

  // ── Zero state ────────────────────────────────────────────────
  if (grails.length === 0) {
    if (!editable) return null;

    return (
      <PremiumEmptyCard
        title="GRAILS"
        heading={"A grail isn't just rare.\nIt's personal."}
        body="Every collector has one."
        ctaLabel="➕ Add First Grail"
        onCtaPress={onAddFirstGrail}
        vaultMargin={vaultMargin}
      />
    );
  }

  // ── Filled grid ───────────────────────────────────────────────
  const slots = grails.slice(0, MAX_SLOTS);

  // Split into rows of 3 so each row can choose its own justifyContent.
  const rows: ShowcaseItem[][] = [];
  for (let i = 0; i < slots.length; i += COLS) {
    rows.push(slots.slice(i, i + COLS));
  }

  // Gap between cards in a full row: cards are 32% wide, so 3 cards = 96%,
  // leaving 4% split across 2 gaps = 2% each. Used as explicit gap on partial rows.
  const gridWidth = vaultWidth - 20; // vault has paddingHorizontal: 10 each side
  const cardGap = Math.round(gridWidth * 0.02);

  const vault = (
    // Outer View: subtle shadow ring. No overflow:'hidden' — clips shadow.
    <View style={[styles.vaultShadow, { width: vaultWidth, alignSelf: 'center' }]}>
      {/* Inner gradient: overflow:'hidden' clips gradient to border radius. */}
      <LinearGradient colors={VAULT_COLORS} style={styles.vault} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}>
        <GrailParticles />
        <PremiumCardHeader title="GRAILS" />
        <View style={styles.grid}>
          {rows.map((row, rowIndex) => (
            <View
              key={rowIndex}
              style={[
                styles.row,
                row.length === COLS ? styles.rowFull : { justifyContent: 'center', gap: cardGap },
              ]}>
              {row.map((item, colIndex) => {
                // Global 0-8 position in the 3x3 grid — index 4 is the exact
                // center slot (row 1, col 1), the only one that pulses.
                const globalIndex = rowIndex * COLS + colIndex;
                const isFeaturedGrail = globalIndex === 4;
                const slot = (
                  <GrailsSlot
                    item={item}
                    // When the whole cabinet is tappable, individual slots are passive.
                    onPress={onCabinetPress ? undefined : () => onItemPress?.(item)}
                  />
                );
                // Standard cards: plain View, no animation. Featured card
                // only: Animated.View with the pulsing scale. Same
                // grailCell sizing/centering either way — the fixed-size
                // cell (not GrailsSlot's own layout) is what keeps the
                // center card aligned with its neighbors while it scales.
                return isFeaturedGrail ? (
                  <Animated.View
                    key={item.id}
                    style={[styles.grailCell, { transform: [{ scale: featuredScale }], zIndex: 5 }]}>
                    {slot}
                  </Animated.View>
                ) : (
                  <View key={item.id} style={styles.grailCell}>
                    {slot}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </LinearGradient>
    </View>
  );

  return onCabinetPress ? (
    <Pressable
      onPress={onCabinetPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}>
      <Animated.View style={{ transform: [{ scale: pressScale }], opacity: pressOpacity }}>
        {vault}
      </Animated.View>
    </Pressable>
  ) : vault;
}

const styles = StyleSheet.create({
  // ── Vault panel ───────────────────────────────────────────────
  // Width is set dynamically (14px margin each side). No marginHorizontal here.
  // Shadow kept minimal — cards are the visual focus, not the container.
  vaultShadow: {
    marginTop: 16,
    marginBottom: 8,
    borderRadius: 20,
    shadowColor: '#B8860B',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.10,
    shadowRadius: 8,
    elevation: 3,
  },
  vault: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(180, 128, 20, 0.30)',
    paddingHorizontal: 10,
    paddingTop: 14,
    paddingBottom: 14,
  },

  // Rising background particles — layout-only wrapper (top:0 aligns with
  // the vault's own top edge, ahead of the header in flow), explicitly
  // transparent, clipped by vault's own overflow:'hidden'.
  grailParticleField: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: PARTICLE_FIELD_HEIGHT,
    backgroundColor: 'transparent',
  },
  grailParticle: {
    position: 'absolute',
    backgroundColor: 'rgba(255, 214, 150, 0.9)',
  },

  // ── Row-based grid ────────────────────────────────────────────
  // Each row is its own View so partial rows can be centered independently.
  // Gaps bumped slightly and evenly across the whole grid (was 8 / none) so
  // the featured card's pulse (max scale 1.09) has breathing room — applied
  // uniformly, not just around the center card.
  grid: {
    gap: 12, // vertical gap between rows
  },
  row: {
    flexDirection: 'row',
    gap: 3, // small horizontal buffer, including full rows (space-between)
  },
  // Fixed-size cell every card (standard or featured) renders inside. This
  // is what keeps the featured card centered against its neighbors as it
  // scales — GrailsSlot itself just fills this cell, so growing/shrinking
  // the card never shifts its own position within the row.
  grailCell: {
    width: '32%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Full 3-card rows use space-between so cards sit at the edges with even gaps.
  rowFull: {
    justifyContent: 'space-between',
  },
});
