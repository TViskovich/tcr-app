import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { HERO_HEIGHT } from './hero-constants';
import { HeroCanvasTheme } from './hero-canvas-theme';
import type { HeroCanvasThemeId } from './hero-canvas-themes';

type Props = {
  // Resolved background source: heroImageUri ?? avatarUri ?? null
  bgSource: string | null;
  // True when a dedicated hero image is showing; false when falling back to avatar.
  // Controls blur level so hero images feel intentional, avatar fallback feels atmospheric.
  isHeroImage?: boolean;
  editMode?: boolean;
  onHeroPress?: () => void;
  theme?: HeroCanvasThemeId;
  // Existing scroll position, read-only — drives Spectra's restrained lighting
  // parallax (Material M-001). Not used by classic/foil.
  scrollY?: Animated.Value;
};

export function HeroBackground({
  bgSource,
  isHeroImage = false,
  editMode = false,
  onHeroPress,
  theme,
  scrollY,
}: Props) {
  return (
    <>
      {/* Layer 1 — background. Spectra (M-001) is a canvas-replacement material:
          it IS the display surface the showcase circle mounts onto, so it renders
          here instead of the photo, fully opaque, with no tint/blur/enhancement
          of the original image. Every other theme (classic/foil) still shows the
          photo as before. TEMP(M2): 'spectra' isn't in HeroCanvasThemeId yet
          (Milestone 3 registers it) — cast to string until then. */}
      {(theme as string) === 'spectra' ? (
        <HeroCanvasTheme theme={theme} scrollY={scrollY} />
      ) : bgSource ? (
        <Image
          source={{ uri: bgSource }}
          style={[styles.heroBg, { opacity: isHeroImage ? 1.0 : 0.82 }]}
          contentFit="cover"
          blurRadius={isHeroImage ? 1 : 5}
        />
      ) : null}

      {/* Layer 2 — flat dark scrim tones the image without flattening it */}
      <View style={[StyleSheet.absoluteFill, styles.heroScrim]} pointerEvents="none" />

      {/* Layer 3 — top vignette frames the upper canvas edge */}
      <LinearGradient
        colors={['rgba(0,0,0,0.52)', 'transparent']}
        locations={[0, 0.32]}
        style={[StyleSheet.absoluteFill]}
        pointerEvents="none"
      />

      {/* Layer 4 — cinematic bottom vignette. Eases slowly: barely perceptible
          through the identity block, only fully dark at the hero base. */}
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.07)', 'rgba(0,0,0,0.27)', 'rgba(0,0,0,0.50)']}
        locations={[0, 0.32, 0.68, 1.0]}
        style={styles.heroBottomGradient}
        pointerEvents="none"
      />

      {/* Layer 5 — gold ambient. A faint warm upwash at the hero base that ties
          the collector identity to the Grails showcase below. Invisible as a conscious
          effect — experienced only as warmth rather than cold black at the transition. */}
      <LinearGradient
        colors={['transparent', 'rgba(255, 185, 30, 0.08)']}
        locations={[0, 1]}
        style={styles.heroGoldAmbient}
        pointerEvents="none"
      />

      {/* Layer 6 — selectable canvas theme overlay (foil, etc). Renders above the
          photo and default gradients so the effect reads on every background
          source. Spectra is rendered at Layer 1 instead (it replaces the photo
          rather than tinting it), so it's skipped here to avoid double-rendering. */}
      {(theme as string) !== 'spectra' ? <HeroCanvasTheme theme={theme} /> : null}

      {/* Edit-mode banner button — bottom-right corner, above gradients */}
      {editMode && onHeroPress ? (
        <TouchableOpacity style={styles.heroEditBtn} onPress={onHeroPress} activeOpacity={0.75}>
          <Text style={styles.heroEditText}>Change Banner</Text>
        </TouchableOpacity>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  // Inset of -100 on all sides creates a ~1.5x oversize container.
  // contentFit="cover" then zooms the image into that container, producing
  // abstract texture rather than a legible photo.
  heroBg: {
    position: 'absolute',
    top: -100,
    left: -100,
    right: -100,
    bottom: -100,
  },
  heroScrim: {
    backgroundColor: 'rgba(0, 0, 0, 0.09)',
  },
  // Cinematic text-zone vignette — starts at 76% (593px) so the hero canvas stays
  // visible deep into the identity area. Four stops ease gradually: darkness only
  // becomes meaningful in the last ~25% of the hero, preserving the image while
  // still giving name/bio enough contrast to read.
  heroBottomGradient: {
    position: 'absolute',
    top: HERO_HEIGHT * 0.76,
    left: 0,
    right: 0,
    bottom: 0,
  },
  heroGoldAmbient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: HERO_HEIGHT * 0.26,
  },
  heroEditBtn: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  heroEditText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
});
