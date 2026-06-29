import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { HERO_HEIGHT } from './hero-constants';

type Props = {
  // Resolved background source: heroImageUri ?? avatarUri ?? null
  bgSource: string | null;
  editMode?: boolean;
  onHeroPress?: () => void;
};

// Renders the three purely decorative background layers of the hero.
// All children are absolute and do not affect layout height.
export function HeroBackground({ bgSource, editMode = false, onHeroPress }: Props) {
  return (
    <>
      {/* Layer 1 — blurred background image, expanded -20px on each edge
          so the blur fringe is hidden by the parent's overflow: 'hidden' */}
      {bgSource ? (
        <Image
          source={{ uri: bgSource }}
          style={styles.heroBg}
          contentFit="cover"
          blurRadius={12}
        />
      ) : null}

      {/* Layer 2 — flat dark scrim keeps the hero legible at any image brightness */}
      <View style={[StyleSheet.absoluteFill, styles.heroScrim]} pointerEvents="none" />

      {/* Layer 3 — bottom gradient dissolves the hero into the section below */}
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.68)', '#0D0D0D']}
        locations={[0.42, 0.76, 1]}
        style={[StyleSheet.absoluteFill, styles.heroGradient]}
        pointerEvents="none"
      />

      {/* Edit-mode banner button — bottom-right corner, above the gradient */}
      {editMode && onHeroPress ? (
        <TouchableOpacity style={styles.heroEditBtn} onPress={onHeroPress} activeOpacity={0.75}>
          <Text style={styles.heroEditText}>Change Banner</Text>
        </TouchableOpacity>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  heroBg: {
    position: 'absolute',
    top: -20,
    left: -20,
    right: -20,
    bottom: -20,
    opacity: 0.48,
  },
  heroScrim: {
    backgroundColor: 'rgba(0, 0, 0, 0.40)',
  },
  // Gradient starts at the lower 58% of the hero
  heroGradient: {
    top: HERO_HEIGHT * 0.42,
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
