import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { HERO_HEIGHT } from './hero-constants';

type Props = {
  // Resolved background source: heroImageUri ?? avatarUri ?? null
  bgSource: string | null;
  // True when a dedicated hero image is showing; false when falling back to avatar.
  // Controls blur level so hero images feel intentional, avatar fallback feels atmospheric.
  isHeroImage?: boolean;
  editMode?: boolean;
  onHeroPress?: () => void;
};

export function HeroBackground({
  bgSource,
  isHeroImage = false,
  editMode = false,
  onHeroPress,
}: Props) {
  return (
    <>
      {/* Layer 1 — source image fills the full canvas.
          Hero images run full opacity + minimal blur so artwork is immediately recognizable.
          Avatar fallback uses light blur to stay atmospheric rather than literal. */}
      {bgSource ? (
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

      {/* Layer 4 — gentle text-zone tint: never reaches solid black.
          Starts below the avatar body, adds just enough contrast for name/bio to read. */}
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.55)']}
        locations={[0, 1.0]}
        style={styles.heroBottomGradient}
        pointerEvents="none"
      />

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
    backgroundColor: 'rgba(0, 0, 0, 0.14)',
  },
  // Gentle tint starts at 65% of hero height (377px), covering only the text zone.
  // Fades from transparent to 55% dark — enough to read white text, never solid black.
  heroBottomGradient: {
    position: 'absolute',
    top: HERO_HEIGHT * 0.65,
    left: 0,
    right: 0,
    bottom: 0,
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
