import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import ReanimatedView, {
  Easing as ReEasing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { LinearGradient } from 'expo-linear-gradient';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
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

// Warm near-black — aged wood / display case felt
const VAULT_COLORS = ['#1A1510', '#0F0D09', '#080604'] as const;

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

  // ── Zero state ────────────────────────────────────────────────
  if (grails.length === 0) {
    if (!editable) return null;

    return (
      <View style={[styles.vaultShadow, { width: vaultWidth, alignSelf: 'center' }]}>
        <LinearGradient colors={VAULT_COLORS} style={styles.vault} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}>
          <VaultHeader />
          <ZeroGrailsState onAddFirstGrail={onAddFirstGrail} />
        </LinearGradient>
      </View>
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
        <VaultHeader />
        <View style={styles.grid}>
          {rows.map((row, rowIndex) => (
            <View
              key={rowIndex}
              style={[
                styles.row,
                row.length === COLS ? styles.rowFull : { justifyContent: 'center', gap: cardGap },
              ]}>
              {row.map((item) => (
                <GrailsSlot
                  key={item.id}
                  item={item}
                  // When the whole cabinet is tappable, individual slots are passive.
                  onPress={onCabinetPress ? undefined : () => onItemPress?.(item)}
                />
              ))}
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

function VaultHeader() {
  return (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>🏆 GRAILS 🏆</Text>
      {/* Thin gold lines flanking the diamond per spec */}
      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.diamond}>◆</Text>
        <View style={styles.dividerLine} />
      </View>
    </View>
  );
}

// Best-effort reduced-motion check — no existing shared hook for this in the
// codebase, kept local since this is the only place that needs it.
function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduced(value);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

// First-time empty state — aspirational rather than a bare "no items" notice.
// The floating CacheCase mark is untouched and remains the hero element,
// hovering above the grails-display-platform.png stage image.
function ZeroGrailsState({ onAddFirstGrail }: { onAddFirstGrail?: () => void }) {
  const reducedMotion = useReducedMotion();
  const floatY = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) {
      floatY.value = 0;
      return;
    }
    floatY.value = withRepeat(
      withSequence(
        withTiming(-2.5, { duration: 1750, easing: ReEasing.inOut(ReEasing.sin) }),
        withTiming(0, { duration: 1750, easing: ReEasing.inOut(ReEasing.sin) }),
      ),
      -1,
      false,
    );
  }, [reducedMotion, floatY]);

  const floatStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: floatY.value }],
  }));

  return (
    <View style={styles.zeroState}>
      <View style={styles.stage}>
        {/* The existing floating logo — unchanged asset, only its bob amplitude/timing live here. */}
        <ReanimatedView.View style={[styles.floatingPiece, floatStyle]}>
          <CacheCaseLogo variant="icon" size={40} />
        </ReanimatedView.View>

        <DisplayStage reducedMotion={reducedMotion} />
      </View>

      <Text style={styles.zeroHeading}>A grail isn&apos;t just rare. It&apos;s personal.</Text>
      <Text style={styles.zeroBody}>Every collector has one.</Text>

      <Pressable
        style={({ pressed }) => [styles.zeroCta, pressed && styles.zeroCtaPressed]}
        onPress={onAddFirstGrail}>
        <Text style={styles.zeroCtaText}>➕ Add First Grail</Text>
      </Pressable>
    </View>
  );
}

// The stage beneath the logo: a small animated glow + a few drifting dust
// motes (the only animated elements here), sitting above the static
// grails-display-platform.png. The PNG itself is never animated.
function DisplayStage({ reducedMotion }: { reducedMotion: boolean }) {
  const glowBreathe = useSharedValue(0.5);

  useEffect(() => {
    if (reducedMotion) {
      glowBreathe.value = 0.55;
      return;
    }
    glowBreathe.value = withRepeat(
      withSequence(
        withTiming(0.65, { duration: 2600, easing: ReEasing.inOut(ReEasing.sin) }),
        withTiming(0.45, { duration: 2600, easing: ReEasing.inOut(ReEasing.sin) }),
      ),
      -1,
      false,
    );
  }, [reducedMotion, glowBreathe]);

  const glowStyle = useAnimatedStyle(() => ({ opacity: glowBreathe.value }));

  return (
    <View style={styles.pedestalStage} pointerEvents="none">
      {/* Subtle warm glow directly beneath the logo — separate from, and much
          smaller than, the light beam already baked into the platform image. */}
      <ReanimatedView.View style={[styles.underLogoGlow, glowStyle]}>
        <LinearGradient
          colors={['rgba(255,214,140,0)', 'rgba(255,214,140,0.16)']}
          style={StyleSheet.absoluteFill}
        />
      </ReanimatedView.View>

      {/* A few tiny dust motes drifting through the beam — kept sparse. */}
      {!reducedMotion && (
        <>
          <DustParticle left="41%" size={1.5} duration={6400} delay={0} />
          <DustParticle left="54%" size={2} duration={7600} delay={2400} />
          <DustParticle left="47%" size={1.5} duration={5600} delay={4400} />
        </>
      )}

      <Image
        source={require('@/assets/ui/grails-display-platform.png')}
        style={styles.platformImage}
        resizeMode="contain"
      />
    </View>
  );
}

function DustParticle({
  left,
  size,
  duration,
  delay,
}: {
  left: `${number}%`;
  size: number;
  duration: number;
  delay: number;
}) {
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = withRepeat(
      withSequence(
        withDelay(delay, withTiming(1, { duration, easing: ReEasing.linear })),
        withTiming(0, { duration: 0 }),
      ),
      -1,
      false,
    );
  }, [t, duration, delay]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(t.value, [0, 1], [8, -60]) }],
    opacity: interpolate(t.value, [0, 0.15, 0.75, 1], [0, 0.45, 0.28, 0], Extrapolation.CLAMP),
  }));

  return (
    <ReanimatedView.View
      style={[styles.dustParticle, { left, width: size, height: size, borderRadius: size / 2 }, style]}
    />
  );
}

const styles = StyleSheet.create({
  // ── Vault panel ───────────────────────────────────────────────
  // Width is set dynamically (14px margin each side). No marginHorizontal here.
  // Shadow kept minimal — cards are the visual focus, not the container.
  vaultShadow: {
    marginTop: -14,
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

  // ── Header ────────────────────────────────────────────────────
  header: {
    alignItems: 'center',
    marginBottom: 12,
    gap: 4,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#D4A520',
    letterSpacing: 4,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dividerLine: {
    width: 28,
    height: 0.5,
    backgroundColor: 'rgba(212, 165, 32, 0.55)',
  },
  diamond: {
    fontSize: 8,
    color: 'rgba(212, 165, 32, 0.70)',
    lineHeight: 10,
  },
  subtitle: {
    fontSize: 11,
    fontStyle: 'italic',
    color: 'rgba(200, 158, 58, 0.62)',
    letterSpacing: 0.3,
  },

  // ── Row-based grid ────────────────────────────────────────────
  // Each row is its own View so partial rows can be centered independently.
  grid: {
    gap: 8, // vertical gap between rows
  },
  row: {
    flexDirection: 'row',
  },
  // Full 3-card rows use space-between so cards sit at the edges with even gaps.
  rowFull: {
    justifyContent: 'space-between',
  },

  // ── Zero state ────────────────────────────────────────────────
  zeroState: {
    paddingVertical: 30,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  stage: {
    width: '100%',
    alignItems: 'center',
    gap: 18,
  },
  floatingPiece: {
    shadowColor: '#FFE060',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.55,
    shadowRadius: 14,
    elevation: 8,
  },
  // Sized to content (the platform image) — no fixed height, so the image's
  // own aspect ratio is never cropped or squashed.
  pedestalStage: {
    width: '100%',
    alignItems: 'center',
  },
  // grails-display-platform.png — cropped tight to the platform itself
  // (886x200, ~4.4:1). Scaled by width only so contain never distorts it.
  platformImage: {
    width: '60%',
    aspectRatio: 886 / 200,
  },
  // Small, separate accent glow directly under the logo — distinct from (and
  // much smaller than) the light beam already baked into the platform image.
  underLogoGlow: {
    position: 'absolute',
    top: -4,
    left: '50%',
    marginLeft: -16,
    width: 32,
    height: 38,
  },
  dustParticle: {
    position: 'absolute',
    top: 6,
    backgroundColor: 'rgba(255, 231, 170, 0.85)',
  },
  zeroHeading: {
    fontSize: 16,
    fontWeight: '700',
    color: 'rgba(255, 255, 255, 0.90)',
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 260,
  },
  zeroBody: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.50)',
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 250,
  },
  zeroCta: {
    marginTop: 4,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: 'rgba(212, 165, 32, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(212, 165, 32, 0.55)',
  },
  zeroCtaPressed: {
    opacity: 0.7,
  },
  zeroCtaText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#D4A520',
    letterSpacing: 0.3,
  },
});
