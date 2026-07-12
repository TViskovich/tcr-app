import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import ReanimatedView, {
  Easing as ReEasing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Image } from 'expo-image';
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

// Reuses the Hero Canvas material language (see hero-canvas-theme.tsx /
// spectra-config.ts): the same grain texture asset, a warm gold wash, and
// several crisp diagonal streak reflections sharing one axis — here in
// gold/champagne instead of Spectra's cyan/violet, so the empty-state card
// reads as another surface in CacheCase's material system rather than a
// bespoke rendered scene. Covers the whole card (header included), not just
// the zero-state body, so the shimmer plays across the entire Grails area.
const GRAILS_GRAIN_SOURCE = require('../../assets/materials/spectra/spectra-metallic-grain-v2.png');
const GRAILS_WARM_WASH = {
  colors: ['rgba(255,190,90,0.05)', 'transparent', 'rgba(255,190,90,0.05)'],
  locations: [0, 0.5, 1],
} as const;
const GRAILS_MATERIAL_STREAKS = [
  {
    colors: ['transparent', 'rgba(255,200,100,0.16)', 'transparent'],
    locations: [0.04, 0.16, 0.28],
  },
  {
    colors: ['transparent', 'rgba(255,224,160,0.24)', 'transparent'],
    locations: [0.38, 0.5, 0.62],
  },
  {
    colors: ['transparent', 'rgba(255,190,90,0.14)', 'transparent'],
    locations: [0.72, 0.84, 0.96],
  },
] as const;

// The floating logo uses CacheCaseLogo's numeric `size`, which maps to its
// rendered HEIGHT, not width (see components/brand/cachecase-logo.tsx —
// width = height * (454/359) for the icon variant). Duplicated here (rather
// than importing a constant that component doesn't export) purely to compute
// the platform's width as a fraction of the logo's actual rendered width.
const LOGO_ICON_ASPECT = 454 / 359;
const LOGO_SIZE = 40;
const LOGO_WIDTH = LOGO_SIZE * LOGO_ICON_ASPECT;
// Optical centering: the mark's diagonal/angled shape reads as left-heavy
// when placed at strict geometric center, so it's nudged right a few px.
// Does not move the platform — only the logo itself, via its float transform.
const LOGO_OPTICAL_SHIFT_X = 5;

// The provided platform asset (assets/ui/grails-platform.png, 1536x1024) has
// its artwork — a slim bar with a baked-in gold rim + soft bloom — sitting in
// a small region of a much larger transparent canvas. Crop box found by
// scanning the PNG's alpha channel directly (any alpha > ~2%); re-verified
// this is the real content region, not noise — alpha stays negligible
// (<1%) everywhere else in the file.
const PLATFORM_SOURCE = require('../../assets/ui/grails-platform.png');
const PLATFORM_SOURCE_SIZE = { width: 1536, height: 1024 };
const PLATFORM_CROP = { x: 196, y: 567, width: 1136, height: 168 };
// Base vertical squish from the previous pass (70-75% asked for). This round
// asks for a further ~2x height boost on top of that so the platform reads
// as a pedestal with real thickness rather than a flat line — combined
// that's slightly *taller* than the source's native proportions, which is
// intentional (a flat 2D asset needs help reading as a dimensional object).
const PLATFORM_VERTICAL_SQUISH = 0.725;
const PLATFORM_THICKNESS_BOOST = 2;
const PLATFORM_HEIGHT_FACTOR = PLATFORM_VERTICAL_SQUISH * PLATFORM_THICKNESS_BOOST;
// Card's own default left+right margin (GrailsGrid's vaultMargin default —
// ZeroGrailsState is only ever reached with editable=true, i.e. only from
// the one call site in app/(tabs)/profile.tsx that uses this default).
const CARD_MARGIN = 14;
// Target: platform occupies ~25-30% of the card's width.
const PLATFORM_WIDTH_RATIO = 0.275;

// The full source image, scaled + the above height factor, then shifted so
// the cropped region lands exactly inside a clipped window sized to the
// computed platform width/height — the same oversize-and-clip technique
// hero-background.tsx uses for heroBg. This crops and reshapes purely via
// layout/rendering; the source PNG file itself is never modified.
function computePlatformLayout(cardWidth: number) {
  const width = cardWidth * PLATFORM_WIDTH_RATIO;
  const scale = width / PLATFORM_CROP.width;
  const height = PLATFORM_CROP.height * scale * PLATFORM_HEIGHT_FACTOR;
  return {
    width,
    height,
    imageWidth: PLATFORM_SOURCE_SIZE.width * scale,
    imageHeight: PLATFORM_SOURCE_SIZE.height * scale * PLATFORM_HEIGHT_FACTOR,
    imageLeft: -PLATFORM_CROP.x * scale,
    imageTop: -PLATFORM_CROP.y * scale * PLATFORM_HEIGHT_FACTOR,
  };
}
// 8px gap below the logo, per spec — unchanged from the previous pass.
const PLATFORM_TOP = LOGO_SIZE + 8;

// Grain + warm wash + streaks + edge light — one component so both the
// zero-state and (if ever needed) the filled grid can share the exact same
// material treatment.
function GrailsMaterial() {
  return (
    <>
      <Image
        source={GRAILS_GRAIN_SOURCE}
        style={[StyleSheet.absoluteFill, styles.grain]}
        contentFit="cover"
        pointerEvents="none"
      />
      <LinearGradient
        colors={GRAILS_WARM_WASH.colors}
        locations={GRAILS_WARM_WASH.locations}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {GRAILS_MATERIAL_STREAKS.map((streak, i) => (
        <LinearGradient
          key={i}
          colors={streak.colors}
          locations={streak.locations}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ))}
      <LinearGradient
        colors={['rgba(255,214,150,0.10)', 'transparent']}
        style={styles.materialEdgeTop}
        pointerEvents="none"
      />
      <LinearGradient
        colors={['transparent', 'rgba(255,170,60,0.08)']}
        style={styles.materialEdgeBottom}
        pointerEvents="none"
      />
    </>
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

  // ── Zero state ────────────────────────────────────────────────
  if (grails.length === 0) {
    if (!editable) return null;

    return (
      <View style={[styles.vaultShadow, styles.vaultShadowFlat, { width: vaultWidth, alignSelf: 'center' }]}>
        <LinearGradient
          colors={VAULT_COLORS}
          style={[styles.vault, styles.vaultFlat]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}>
          {/* Covers the whole card — header included — so the shimmer plays
              across the entire Grails area, not just the body below it. */}
          <GrailsMaterial />
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
// The card's material (grain, streaks, edge light) is rendered by the caller
// via <GrailsMaterial /> so it covers the whole card including the header;
// this component is just the logo + copy + CTA on top of it. The floating
// CacheCase mark is untouched — unchanged asset, tilt, proportions, gradient.
function ZeroGrailsState({ onAddFirstGrail }: { onAddFirstGrail?: () => void }) {
  const reducedMotion = useReducedMotion();
  const floatY = useSharedValue(0);
  // Responsive: platform width targets ~25-30% of the card, and the card's
  // width itself is screenWidth - CARD_MARGIN*2 (same formula GrailsGrid
  // uses for vaultWidth).
  const { width: screenWidth } = useWindowDimensions();
  const platform = computePlatformLayout(screenWidth - CARD_MARGIN * 2);

  useEffect(() => {
    if (reducedMotion) {
      floatY.value = 0;
      return;
    }
    // ~6s full loop (3s up, 3s down), 5px amplitude — slow and premium.
    floatY.value = withRepeat(
      withSequence(
        withTiming(-5, { duration: 3000, easing: ReEasing.inOut(ReEasing.sin) }),
        withTiming(0, { duration: 3000, easing: ReEasing.inOut(ReEasing.sin) }),
      ),
      -1,
      false,
    );
  }, [reducedMotion, floatY]);

  const floatStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: floatY.value }, { translateX: LOGO_OPTICAL_SHIFT_X }],
  }));

  // The much taller platform (see computePlatformLayout) now extends past
  // the old fixed 16px gap reserved below the logo. logoWrap's marginBottom
  // is widened just enough to keep the platform clear of the heading below
  // it — the one deliberate exception to "everything else pixel-for-pixel
  // identical," made to avoid the platform visually overlapping the text.
  const logoWrapMarginBottom = PLATFORM_TOP - LOGO_SIZE + platform.height + 4;

  return (
    <View style={styles.zeroState}>
      <View style={[styles.logoWrap, { marginBottom: logoWrapMarginBottom }]}>
        {/* Platform — the provided asset, cropped to its content region,
            sized to ~25-30% of the card width, and given extra vertical
            thickness (beyond the source's native proportions) so it reads
            as a pedestal with real presence rather than a flat line. Sits
            at the very back of this cluster; its own baked-in gold
            rim/bloom is the "warm gold bloom from the platform" layer, and
            scales with it automatically since the crop region is unchanged.
            Static, no animation. */}
        <View
          style={[
            styles.platformClip,
            { top: PLATFORM_TOP, width: platform.width, height: platform.height },
          ]}
          pointerEvents="none">
          <Image
            source={PLATFORM_SOURCE}
            contentFit="fill"
            style={{
              position: 'absolute',
              width: platform.imageWidth,
              height: platform.imageHeight,
              left: platform.imageLeft,
              top: platform.imageTop,
            }}
          />
        </View>

        {/* The existing floating logo — unchanged asset, larger (+~18%) and
            with a slower, taller float amplitude/timing live here. Nudged
            ~5px right of strict geometric center: the mark's diagonal shape
            reads as left-heavy when perfectly centered, so this is optical
            centering, not a layout shift. */}
        <ReanimatedView.View style={[styles.floatingPiece, floatStyle]}>
          <CacheCaseLogo variant="icon" size={LOGO_SIZE} />
        </ReanimatedView.View>
      </View>

      <Text style={styles.zeroHeading}>A grail isn&apos;t just rare.{'\n'}It&apos;s personal.</Text>
      <Text style={styles.zeroBody}>Every collector has one.</Text>

      <Pressable
        style={({ pressed }) => [styles.zeroCta, pressed && styles.zeroCtaPressed]}
        onPress={onAddFirstGrail}>
        <Text style={styles.zeroCtaText}>➕ Add First Grail</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Vault panel ───────────────────────────────────────────────
  // Width is set dynamically (14px margin each side). No marginHorizontal here.
  // Shadow kept minimal — cards are the visual focus, not the container.
  vaultShadow: {
    // Was -14 (pulled the whole card up into the hero canvas). Now positive
    // so the card sits with real breathing room below the hero instead of
    // colliding with it.
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
  // Zero-state only: no border, no box — content sits directly on the
  // gradient background. Rounded corners and the background/material stay;
  // only the stroke is neutralized (kept as a property, set to 0-width,
  // rather than deleted, so the filled-grid card's border is untouched).
  vaultFlat: {
    borderWidth: 0,
  },
  // Zero-state only: no drop shadow behind the card — same "no box" goal.
  vaultShadowFlat: {
    shadowOpacity: 0,
    elevation: 0,
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
  },
  // Reused Hero Canvas grain texture, kept quiet.
  grain: {
    opacity: 0.08,
  },
  // Restrained top/bottom edge light — same beveled-edge language as the
  // Hero Canvas material, not a glow.
  materialEdgeTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 40,
  },
  materialEdgeBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 40,
  },
  // Wraps the logo + platform + bloom. marginBottom is computed responsively
  // (logoWrapMarginBottom, in ZeroGrailsState) since the platform's height
  // now varies with screen width and is tall enough to need more than a
  // fixed value — see the comment at its call site.
  logoWrap: {
    alignItems: 'center',
  },
  floatingPiece: {
    shadowColor: '#FFE060',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.55,
    shadowRadius: 14,
    elevation: 8,
  },
  // Clips the (oversized, positioned) platform Image down to just its
  // content region. width/height/top are screen-size-responsive, so they're
  // applied inline from computePlatformLayout() — see the PLATFORM_*
  // constants above for the underlying math.
  platformClip: {
    position: 'absolute',
    overflow: 'hidden',
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
    marginTop: 4,
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.50)',
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 250,
  },
  zeroCta: {
    marginTop: 16,
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
