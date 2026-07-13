import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
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

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Defs,
  Ellipse,
  LinearGradient as SvgLinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';

// The premium black/gold "empty state" card design — originally built for
// the Grails section (components/profile/grails-grid.tsx) and extracted here
// so other sections can reuse the exact same look/size rather than a
// re-implementation. Grails itself now renders through this component too.

// Warm near-black — aged wood / display case felt. Used by the filled grid.
export const VAULT_COLORS = ['#1A1510', '#0F0D09', '#080604'] as const;
// Nearly black with a very subtle warm graphite undertone (not neutral grey,
// not brown) — used by the empty state only, which reads darker than the
// filled-grid vault.
const EMPTY_STATE_VAULT_COLORS = ['#0a0908', '#050403', '#000000'] as const;

// Reuses the Hero Canvas material language (see hero-canvas-theme.tsx /
// spectra-config.ts): the same grain texture asset, a warm gold wash, and
// several crisp diagonal streak reflections sharing one axis — here in
// gold/champagne instead of Spectra's cyan/violet, so the card reads as
// another surface in CacheCase's material system rather than a bespoke
// rendered scene. Covers the whole card (header included).
const GRAIN_SOURCE = require('../../assets/materials/spectra/spectra-metallic-grain-v2.png');
const WARM_WASH = {
  colors: ['rgba(255,190,90,0.05)', 'transparent', 'rgba(255,190,90,0.05)'],
  locations: [0, 0.5, 1],
} as const;

// The floating logo uses CacheCaseLogo's numeric `size`, which maps to its
// rendered HEIGHT, not width (see components/brand/cachecase-logo.tsx —
// width = height * (454/359) for the icon variant).
// Shrunk from 80 to fit the transparent display-case card more comfortably
// (its own width is fixed at LOGO_CARD_WIDTH, independent of this).
const LOGO_SIZE = 55;
// Optical centering: the mark's diagonal/angled shape reads as left-heavy
// when placed at strict geometric center, so it's nudged right a few px.
const LOGO_OPTICAL_SHIFT_X = 3;
// Moves only the logo itself up toward the title — platform, vignette, and
// spacing are all positioned independently of the logo, so this doesn't
// affect anything else.
const LOGO_VERTICAL_SHIFT = -60;

// Horizon line — a single razor-thin horizontal gold line marking the
// boundary between the logo area and the text area below it. Exactly one
// gradient, no glow/blur layer, no second line, no background — see its
// render site for the full spec.
// Fixed at 78 (was LOGO_SIZE - 2 back when LOGO_SIZE was 80) rather than
// derived from LOGO_SIZE — frozen so resizing the logo doesn't also shift
// the horizon/its glow, which are positioned independently of the logo.
const HORIZON_TOP = 78;
const HORIZON_HEIGHT = 1.5;
// Of the vault's actual INNER width (vaultWidth minus the vault's own
// paddingHorizontal on each side) — the vault's overflow:hidden is the only
// real clip boundary in the parent chain, so this is what "92% of usable
// width inside the card" actually means. Must match styles.vault's own
// paddingHorizontal to stay correct.
const VAULT_PADDING_HORIZONTAL = 10;
const HORIZON_WIDTH_RATIO = 0.92;

// Radial light source centered on the horizon line — a real radial
// gradient (react-native-svg), not dozens of stacked LinearGradient
// rectangles faking softness. expo-linear-gradient can only fade along one
// straight axis per layer; every earlier version of this glow was an
// approximation built from many small rectangles, which is what kept
// reading as geometric/engineered no matter how it was tuned. An actual
// RadialGradient has a true smooth falloff with no seams, steps, or edges
// to hide.
// A tight, bright core (see HorizonGlow's inner stops) plus a much larger,
// very faint outer wash — two true radial gradients, not one, so the light
// fades gradually into the black over a wide area instead of cutting off
// at a small, tightly-bounded shape.
const HORIZON_GLOW_CORE_WIDTH = 170;
const HORIZON_GLOW_CORE_HEIGHT = 60;
const HORIZON_GLOW_WASH_WIDTH = 320;
const HORIZON_GLOW_WASH_HEIGHT = 160;
// Fraction of the wash's own height sitting above the line's center — 0.5
// would be symmetric; higher biases it to reach further up into the dark
// gap toward the logo without extending further down too (the core stays
// centered/unchanged, so the line itself doesn't get any brighter — only
// the very faint ambient wash reaches a bit higher).
const HORIZON_GLOW_WASH_UPWARD_BIAS = 0.62;

// A tall, narrow, subtle radial plume rising from the horizon most of the
// way toward the logo — like heat/light rising off the line, not a flat
// dome sitting on it. Centered on the line same as the core/wash (its own
// radial falloff — bright in the middle of its own shape, fading toward
// both its top and bottom edges — is what makes it read as "emanating
// upward from the horizon" once it overlaps the core below it). Kept low-
// opacity on purpose: earlier tall attempts (built from stacked fake
// gradients) got rejected for being too bright/geometric — this is a true
// RadialGradient, so it can afford to be subtle and still read clearly.
const HORIZON_RISE_WIDTH = 110;
const HORIZON_RISE_HEIGHT = 230;

// Soft warm glow directly behind the logo — "heat rising from the horizon
// lighting the logo up a little." Same visual language (warm amber radial)
// as the horizon glow, much smaller and fainter, so it reads as ambient
// light reaching the logo rather than a light source of its own.
const LOGO_GLOW_SIZE = 130;
// Fixed at -20 (was LOGO_SIZE / 2 + LOGO_VERTICAL_SHIFT back when LOGO_SIZE
// was 80) rather than derived from LOGO_SIZE — frozen for the same reason
// as HORIZON_TOP above, so resizing the logo doesn't shift its own glow.
const LOGO_GLOW_OFFSET_Y = -20;

// Transparent display-case card framing the logo — a plain bordered box,
// no fill, no gradient. Bottom edge anchored at the horizon line (like it's
// standing on it), tall enough to give the logo generous empty space inside
// the frame above and below it, matching the reference's glass-vitrine look.
const LOGO_CARD_WIDTH = 130;
const LOGO_CARD_HEIGHT = 210;

// Small 3D bronze/gold platform, flush against the horizon line — a real
// cylinder (flat top ellipse + a visible front "wall" giving it height),
// not just a flat disc, matching the reference photo. The wall is an SVG
// Path: straight down the left edge, an elliptical arc along the bottom,
// straight up the right edge, arc back along the top ellipse's own lower
// half to close — the standard technique for a 2D "cylinder" silhouette.
// The top ellipse is drawn last so it caps the wall cleanly.
const PLATFORM_3D_WIDTH = 150;
const PLATFORM_3D_HEIGHT = 34; // top ellipse's own height (flatness)
const PLATFORM_3D_WALL_HEIGHT = 16; // visible thickness of the cylinder
const PLATFORM_3D_GAP = 0;

// Best-effort reduced-motion check — no existing shared hook for this in the
// codebase.
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

// Grain + warm wash + edge light. Covers the whole card, header included, so
// it plays across the entire card, not just the body.
export function PremiumCardMaterial() {
  return (
    <>
      <Image
        source={GRAIN_SOURCE}
        style={[StyleSheet.absoluteFill, styles.grain]}
        contentFit="cover"
        pointerEvents="none"
      />
      <LinearGradient
        colors={WARM_WASH.colors}
        locations={WARM_WASH.locations}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
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

// Soft radial glow centered on the horizon line — two real RadialGradients
// (react-native-svg), which naturally stretch into ellipses matching the
// width/height of the Rects they fill. Smooth continuous falloff, no
// stacked layers, no visible edge. A large/very faint "wash" underneath a
// smaller/brighter "core" gives the light a wide, gradual fade into the
// black instead of cutting off at one small, tightly-bounded shape.
function HorizonGlow() {
  return (
    <>
      <Svg
        width={HORIZON_GLOW_WASH_WIDTH}
        height={HORIZON_GLOW_WASH_HEIGHT}
        style={styles.horizonGlowWash}
        pointerEvents="none">
        <Defs>
          <RadialGradient id="horizonGlowWash" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#FFC978" stopOpacity={0.22} />
            <Stop offset="40%" stopColor="#E2903F" stopOpacity={0.1} />
            <Stop offset="100%" stopColor="#E2903F" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect
          x={0}
          y={0}
          width={HORIZON_GLOW_WASH_WIDTH}
          height={HORIZON_GLOW_WASH_HEIGHT}
          fill="url(#horizonGlowWash)"
        />
      </Svg>
      <Svg
        width={HORIZON_RISE_WIDTH}
        height={HORIZON_RISE_HEIGHT}
        style={styles.horizonGlowRise}
        pointerEvents="none">
        <Defs>
          <RadialGradient id="horizonGlowRise" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#FFD9A0" stopOpacity={0.2} />
            <Stop offset="35%" stopColor="#E2903F" stopOpacity={0.1} />
            <Stop offset="70%" stopColor="#C9642A" stopOpacity={0.04} />
            <Stop offset="100%" stopColor="#C9642A" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={HORIZON_RISE_WIDTH} height={HORIZON_RISE_HEIGHT} fill="url(#horizonGlowRise)" />
      </Svg>
      <Svg
        width={HORIZON_GLOW_CORE_WIDTH}
        height={HORIZON_GLOW_CORE_HEIGHT}
        style={styles.horizonGlowCore}
        pointerEvents="none">
        <Defs>
          <RadialGradient id="horizonGlowCore" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#FFEFD1" stopOpacity={0.95} />
            <Stop offset="25%" stopColor="#FFC978" stopOpacity={0.55} />
            <Stop offset="55%" stopColor="#E2903F" stopOpacity={0.2} />
            <Stop offset="100%" stopColor="#E2903F" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect
          x={0}
          y={0}
          width={HORIZON_GLOW_CORE_WIDTH}
          height={HORIZON_GLOW_CORE_HEIGHT}
          fill="url(#horizonGlowCore)"
        />
      </Svg>
    </>
  );
}

// Soft warm glow directly behind the logo — see LOGO_GLOW_SIZE comment.
function LogoGlow() {
  return (
    <Svg width={LOGO_GLOW_SIZE} height={LOGO_GLOW_SIZE} style={styles.logoGlow} pointerEvents="none">
      <Defs>
        <RadialGradient id="logoGlow" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor="#FFD9A0" stopOpacity={0.22} />
          <Stop offset="45%" stopColor="#E2903F" stopOpacity={0.09} />
          <Stop offset="100%" stopColor="#E2903F" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={0} y={0} width={LOGO_GLOW_SIZE} height={LOGO_GLOW_SIZE} fill="url(#logoGlow)" />
    </Svg>
  );
}

// Small 3D bronze platform beneath the display case — see PLATFORM_3D_WIDTH
// comment for the construction technique. Recolored from scratch to match
// the reference photo directly: warm dark bronze throughout (wall and the
// top face's outer area alike — never pure black), with a bright warm gold
// hotspot at the top face's center-front and a thin bright gold rim
// tracing the top ellipse's edge.
function Platform3D() {
  const cx = PLATFORM_3D_WIDTH / 2;
  const topCy = PLATFORM_3D_HEIGHT / 2;
  const rx = PLATFORM_3D_WIDTH / 2 - 4;
  const ry = PLATFORM_3D_HEIGHT / 2;
  const bottomCy = topCy + PLATFORM_3D_WALL_HEIGHT;
  const wallPath = `M ${cx - rx} ${topCy} L ${cx - rx} ${bottomCy} A ${rx} ${ry} 0 0 0 ${cx + rx} ${bottomCy} L ${cx + rx} ${topCy} A ${rx} ${ry} 0 0 1 ${cx - rx} ${topCy} Z`;
  return (
    <Svg
      width={PLATFORM_3D_WIDTH}
      height={bottomCy + 14}
      style={styles.platform3d}
      pointerEvents="none">
      <Defs>
        <RadialGradient id="platformShadow" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor="#000000" stopOpacity={0.55} />
          <Stop offset="100%" stopColor="#000000" stopOpacity={0} />
        </RadialGradient>
        {/* Warm dark bronze wall — a mild lift near the top where it meets
            the light, settling into a darker (but still warm, never pure
            black) bronze toward the base. */}
        <SvgLinearGradient id="platformWall" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor="#4a3018" stopOpacity={1} />
          <Stop offset="100%" stopColor="#1c1208" stopOpacity={1} />
        </SvgLinearGradient>
        {/* Top face — bright warm gold hotspot at center-front, fading
            through amber to a darker warm bronze at the outer edge — the
            edge stays warm-toned, it never goes to black. Kept fairly
            tight/quick (not a broad slow falloff) — a wide soft gradient
            here previously read as light pooling into a concave bowl
            rather than a crisp reflection sitting on a flat surface. */}
        <RadialGradient id="platformTop" cx="50%" cy="58%" r="42%">
          <Stop offset="0%" stopColor="#FFF0C8" stopOpacity={1} />
          <Stop offset="18%" stopColor="#FFCB74" stopOpacity={1} />
          <Stop offset="38%" stopColor="#8a5a22" stopOpacity={1} />
          <Stop offset="100%" stopColor="#3a2410" stopOpacity={1} />
        </RadialGradient>
      </Defs>
      {/* Grounding shadow beneath the base of the cylinder. */}
      <Ellipse
        cx={cx}
        cy={bottomCy + 5}
        rx={PLATFORM_3D_WIDTH / 2}
        ry={ry / 1.6}
        fill="url(#platformShadow)"
      />
      {/* The wall — front face of the cylinder, giving it visible height. */}
      <Path d={wallPath} fill="url(#platformWall)" />
      {/* The top face — caps the wall, warm gold hotspot at front-center. */}
      <Ellipse cx={cx} cy={topCy} rx={rx} ry={ry} fill="url(#platformTop)" />
      {/* Thin bright gold rim tracing the top edge, per the reference. */}
      <Ellipse cx={cx} cy={topCy} rx={rx} ry={ry} fill="none" stroke="#FFD37A" strokeOpacity={0.55} strokeWidth={1.2} />
    </Svg>
  );
}

// Diamond-flanked uppercase title + gold divider line with center diamond.
// Same small gold diamond used everywhere else in this card (Divider,
// below) instead of an emoji — a separate styled Text flanking the title
// row rather than characters crammed into the title's own Text run, so
// spacing on both sides is even regardless of font/emoji rendering quirks.
export function PremiumCardHeader({ title }: { title: string }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerTitleRow}>
        <Text style={styles.diamond}>◆</Text>
        <Text style={styles.headerTitle}>{title}</Text>
        <Text style={styles.diamond}>◆</Text>
      </View>
      <Divider />
    </View>
  );
}

// Shared with the header — thin gold line, center diamond, thin gold line.
function Divider({ style }: { style?: object }) {
  return (
    <View style={[styles.dividerRow, style]}>
      <View style={styles.dividerLine} />
      <Text style={styles.diamond}>◆</Text>
      <View style={styles.dividerLine} />
    </View>
  );
}

// Covers the header down through roughly where the horizon glow begins.
const DUST_FIELD_HEIGHT = 400;
// A moderate, clearly-visible-but-not-busy star field — dozens, not
// hundreds, and not near-invisible.
const DUST_PARTICLE_COUNT = 46;
// The uniform-random field above happened to land sparser on the left side,
// making it look noticeably darker — this tops it up specifically there.
const DUST_LEFT_TOPUP_COUNT = 10;

// Deterministic PRNG (mulberry32), seeded once at module load — stable
// across re-renders, no Math.random() flicker.
function mulberry32(seed: number) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type DustSpec = {
  left: `${number}%`;
  top: number;
  size: number;
  peakOpacity: number;
  color: string;
  duration: number;
  delay: number;
};

// Uniform placement — no center bias, no exclusion zone. Any deliberate
// density gradient reads as a shape of its own once enough dots are on
// screen; flat-random is the only distribution with no visible geometry.
const DUST_PARTICLES: DustSpec[] = (() => {
  const rand = mulberry32(20260712);
  const particles: DustSpec[] = [];
  for (let i = 0; i < DUST_PARTICLE_COUNT; i++) {
    const left = `${(2 + rand() * 96).toFixed(1)}%` as `${number}%`;
    const top = rand() * DUST_FIELD_HEIGHT;
    const sizeT = Math.pow(rand(), 1.6); // skewed small, with a light tail of slightly bigger ones
    const size = 1 + sizeT * 1.8;
    const peakOpacity = 0.25 + sizeT * 0.4;
    const g = Math.round(220 - sizeT * 30);
    const b = Math.round(180 - sizeT * 90);
    particles.push({
      left,
      top,
      size,
      peakOpacity: Math.min(peakOpacity, 0.65),
      color: `rgba(255,${g},${b},0.9)`,
      duration: 7000 + rand() * 7000,
      delay: rand() * 7000,
    });
  }
  // Left-side top-up — same generation logic, just constrained to the
  // left ~40% of the card instead of the full width.
  for (let i = 0; i < DUST_LEFT_TOPUP_COUNT; i++) {
    const left = `${(2 + rand() * 38).toFixed(1)}%` as `${number}%`;
    const top = rand() * DUST_FIELD_HEIGHT;
    const sizeT = Math.pow(rand(), 1.6);
    const size = 1 + sizeT * 1.8;
    const peakOpacity = 0.25 + sizeT * 0.4;
    const g = Math.round(220 - sizeT * 30);
    const b = Math.round(180 - sizeT * 90);
    particles.push({
      left,
      top,
      size,
      peakOpacity: Math.min(peakOpacity, 0.65),
      color: `rgba(255,${g},${b},0.9)`,
      duration: 7000 + rand() * 7000,
      delay: rand() * 7000,
    });
  }
  return particles;
})();

// A single drifting, twinkling dust mote.
function DustParticle({ left, top, size, peakOpacity, color, duration, delay }: DustSpec) {
  const t = useSharedValue(0);
  const midOpacity = peakOpacity * 0.5;
  const drift = 4 + size * 2;

  useEffect(() => {
    t.value = withRepeat(
      withSequence(
        withDelay(delay, withTiming(1, { duration, easing: ReEasing.inOut(ReEasing.sin) })),
        withTiming(0, { duration, easing: ReEasing.inOut(ReEasing.sin) }),
      ),
      -1,
      false,
    );
  }, [t, duration, delay]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(t.value, [0, 1], [drift, -drift]) }],
    opacity: interpolate(t.value, [0, 0.5, 1], [midOpacity, peakOpacity, midOpacity], Extrapolation.CLAMP),
  }));

  return (
    <ReanimatedView.View
      style={[
        styles.dustParticle,
        { left, top, width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        style,
      ]}
    />
  );
}

// A moderate, clearly visible field of warm gold dust across the upper
// portion of the card.
function DustField({ reducedMotion }: { reducedMotion: boolean }) {
  if (reducedMotion) return null;
  return (
    <View style={styles.dustField} pointerEvents="none">
      {DUST_PARTICLES.map((p, i) => (
        <DustParticle key={i} {...p} />
      ))}
    </View>
  );
}

type Props = {
  title: string;
  heading: string;
  body: string;
  ctaLabel?: string;
  onCtaPress?: () => void;
  vaultMargin?: number;
};

// The full card: bordered near-black vault + material + header + faint dust
// field + floating CacheCase logo over a thin light platform + heading +
// divider + body + an optional CTA. title/heading/body/CTA are the only
// things that vary between uses.
export function PremiumEmptyCard({
  title,
  heading,
  body,
  ctaLabel,
  onCtaPress,
  vaultMargin = 14,
}: Props) {
  const { width: screenWidth } = useWindowDimensions();
  const vaultWidth = screenWidth - vaultMargin * 2;
  const horizonWidth = (vaultWidth - VAULT_PADDING_HORIZONTAL * 2) * HORIZON_WIDTH_RATIO;

  const reducedMotion = useReducedMotion();
  const floatY = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) {
      floatY.value = 0;
      return;
    }
    // ~6s full loop (3s up, 3s down), 5px amplitude — slow and premium.
    // withRepeat's own `reverse: true` oscillates a single withTiming back
    // and forth, instead of manually chaining two withTiming calls via
    // withSequence and repeating that (which restarts the whole sequence
    // from scratch every loop — the seam between one full sequence ending
    // and the next beginning is exactly the kind of spot that can hitch).
    floatY.value = withRepeat(
      withTiming(-5, { duration: 3000, easing: ReEasing.inOut(ReEasing.sin) }),
      -1,
      true,
    );
  }, [reducedMotion, floatY]);

  const floatStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: floatY.value + LOGO_VERTICAL_SHIFT },
      { translateX: LOGO_OPTICAL_SHIFT_X },
    ],
  }));

  return (
    <View style={[styles.vaultShadow, styles.vaultShadowFlat, { width: vaultWidth, alignSelf: 'center' }]}>
      <LinearGradient
        colors={EMPTY_STATE_VAULT_COLORS}
        style={styles.vault}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}>
        <PremiumCardMaterial />
        <PremiumCardHeader title={title} />
        <DustField reducedMotion={reducedMotion} />

        <View style={styles.zeroState}>
          <View style={styles.logoWrap}>

            {/* Radial light source — anchored on the horizon line, behind
                it (rendered first). A real RadialGradient — see
                HorizonGlow. */}
            <HorizonGlow />

            {/* Warm glow behind the logo, as if lit by the heat rising off
                the horizon. Rendered before the logo so it stays behind
                it. */}
            <LogoGlow />

            {/* Horizon line — the ONLY active horizon implementation
                (confirmed live via a temporary red/8px/50%-width diagnostic,
                now removed). One LinearGradient, 7 stops, no glow/blur, no
                second line, no background. Brightest (white-gold) exactly
                at center (50%), fading through medium then faint gold to
                fully transparent at both ends. */}
            <LinearGradient
              colors={[
                'transparent',
                'rgba(179,126,18,0.08)', // 18% — faint gold
                'rgba(214,160,42,0.45)', // 38% — brighter warm gold
                'rgba(255,226,145,0.95)', // 50% — brightest white-gold
                'rgba(214,160,42,0.45)', // 62% — brighter warm gold
                'rgba(179,126,18,0.08)', // 82% — faint gold
                'transparent',
              ]}
              locations={[0, 0.18, 0.38, 0.5, 0.62, 0.82, 1]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={[styles.horizonLine, { top: HORIZON_TOP, width: horizonWidth }]}
              pointerEvents="none"
            />

            {/* Small 3D onyx platform the card appears to float just above
                — rendered after the horizon line so it sits in front of
                the glow, before the card so the card sits in front of it. */}
            <Platform3D />

            {/* Transparent display-case card framing the logo — mostly
                see-through, but its border and a faint interior wash both
                brighten toward the bottom edge (nearest the horizon) and
                fade toward the top, like it's catching light rising off the
                line rather than being lit evenly. */}
            <Svg
              width={LOGO_CARD_WIDTH}
              height={LOGO_CARD_HEIGHT}
              style={[styles.logoCard, { top: HORIZON_TOP - LOGO_CARD_HEIGHT }]}
              pointerEvents="none">
              <Defs>
                <SvgLinearGradient id="logoCardBorder" x1="0" y1="1" x2="0" y2="0">
                  <Stop offset="0%" stopColor="#FFD9A0" stopOpacity={0.8} />
                  <Stop offset="30%" stopColor="#D8A542" stopOpacity={0.45} />
                  <Stop offset="100%" stopColor="#8A6B28" stopOpacity={0.22} />
                </SvgLinearGradient>
                <SvgLinearGradient id="logoCardFill" x1="0" y1="1" x2="0" y2="0">
                  <Stop offset="0%" stopColor="#FFC978" stopOpacity={0.14} />
                  <Stop offset="35%" stopColor="#FFC978" stopOpacity={0.03} />
                  <Stop offset="100%" stopColor="#FFC978" stopOpacity={0} />
                </SvgLinearGradient>
              </Defs>
              <Rect
                x={0.5}
                y={0.5}
                width={LOGO_CARD_WIDTH - 1}
                height={LOGO_CARD_HEIGHT - 1}
                rx={18}
                ry={18}
                fill="url(#logoCardFill)"
                stroke="url(#logoCardBorder)"
                strokeWidth={1}
              />
            </Svg>

            {/* The floating logo — unchanged asset. Nudged a few px right of
                strict geometric center: the mark's diagonal shape reads as
                left-heavy when perfectly centered, so this is optical
                centering, not a layout shift. */}
            <ReanimatedView.View style={[styles.floatingPiece, floatStyle]}>
              <CacheCaseLogo variant="icon" size={LOGO_SIZE} />
            </ReanimatedView.View>
          </View>

          <Text style={styles.zeroHeading}>{heading}</Text>
          <Divider style={styles.headingDivider} />
          <Text style={styles.zeroBody}>{body}</Text>

          {ctaLabel && onCtaPress ? (
            <Pressable
              style={({ pressed }) => [styles.zeroCta, pressed && styles.zeroCtaPressed]}
              onPress={onCtaPress}>
              <Text style={styles.zeroCtaText}>{ctaLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  vaultShadow: {
    marginTop: 16,
    marginBottom: 8,
    borderRadius: 20,
    shadowColor: '#B8860B',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  vault: {
    borderRadius: 20,
    overflow: 'hidden',
    // Thin gold outline — kept at its original opacity ("do not increase the
    // border brightness").
    borderWidth: 1,
    borderColor: 'rgba(180, 128, 20, 0.30)',
    paddingHorizontal: 10,
    paddingTop: 26,
    paddingBottom: 14,
  },
  vaultShadowFlat: {
    shadowOpacity: 0,
    elevation: 0,
  },

  header: {
    alignItems: 'center',
    marginBottom: 12,
    gap: 4,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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

  // paddingTop pushes this whole block (horizon, card shell, logo, text,
  // button) down, away from the GRAILS title above it.
  zeroState: {
    paddingTop: 155,
    paddingBottom: 176,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  grain: {
    opacity: 0.08,
  },
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
  // Scattered dust motes covering roughly the header-through-horizon zone.
  // Layout-only — explicitly transparent, nothing should render a fill here.
  dustField: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: DUST_FIELD_HEIGHT,
    backgroundColor: 'transparent',
  },
  dustParticle: {
    position: 'absolute',
  },
  // marginBottom: fixed at 25.5 (the previous line's computed spacing,
  // 24 + old 1.5px line height) rather than derived from HORIZON_HEIGHT, so
  // changing the horizon line's own thickness never changes this spacing —
  // spacing is explicitly out of scope for horizon-line edits.
  logoWrap: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 95,
    backgroundColor: 'transparent',
  },
  // No shadow here — a View shadow (especially Android's elevation) draws
  // from the View's rectangular bounds, not the logo image's transparent
  // silhouette, which read as a semi-transparent box behind the logo. There
  // is no separate "glow behind the logo" element anymore — removed rather
  // than rebuilt again, per instruction not to replace it with another layer.
  floatingPiece: {
    opacity: 0.65,
  },
  // Absolute + only `top` set: centers horizontally via logoWrap's own
  // alignItems: 'center', same pattern used elsewhere in this file.
  horizonLine: {
    position: 'absolute',
    height: HORIZON_HEIGHT,
  },
  horizonGlowWash: {
    position: 'absolute',
    top: HORIZON_TOP + HORIZON_HEIGHT / 2 - HORIZON_GLOW_WASH_HEIGHT * HORIZON_GLOW_WASH_UPWARD_BIAS,
  },
  horizonGlowCore: {
    position: 'absolute',
    top: HORIZON_TOP + HORIZON_HEIGHT / 2 - HORIZON_GLOW_CORE_HEIGHT / 2,
  },
  horizonGlowRise: {
    position: 'absolute',
    top: HORIZON_TOP + HORIZON_HEIGHT / 2 - HORIZON_RISE_HEIGHT / 2,
  },
  logoGlow: {
    position: 'absolute',
    top: LOGO_GLOW_OFFSET_Y - LOGO_GLOW_SIZE / 2,
  },
  logoCard: {
    position: 'absolute',
  },
  platform3d: {
    position: 'absolute',
    top: HORIZON_TOP + PLATFORM_3D_GAP,
  },
  zeroHeading: {
    fontSize: 16,
    fontWeight: '700',
    color: 'rgba(255, 255, 255, 0.90)',
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 260,
  },
  // The new divider beneath the headline, matching the header's spacing.
  headingDivider: {
    marginTop: 10,
  },
  zeroBody: {
    marginTop: 10,
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
