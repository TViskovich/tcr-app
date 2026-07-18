import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

const HERO_RADIUS = 16;

type Props = {
  imageUrl: string | null;
  // Reserved for a future full-screen viewer — no implementation yet. In
  // edit mode the parent passes the existing "change photo" picker instead,
  // so this stays a single reusable component for both contexts rather than
  // two separate hero renderers.
  onPress?: () => void;
  editMode?: boolean;
};

// The hero is the page — nearly full-width, portrait, rounded, softly
// shadowed, fading into the dark background beneath it. Deliberately no
// text overlay and no per-status framing (e.g. the old Grails gold frame) —
// one consistent treatment for every card, per the current design direction.
export function ItemHeroImage({ imageUrl, onPress, editMode = false }: Props) {
  return (
    <View style={styles.wrap}>
      <Pressable
        style={styles.shadowBox}
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? 'imagebutton' : undefined}
        accessibilityLabel={editMode ? 'Change card photo' : 'Card image'}>
        <View style={styles.imageBox}>
          {imageUrl ? (
            <Image source={{ uri: imageUrl }} style={styles.image} contentFit="cover" transition={200} />
          ) : (
            <View style={[styles.image, styles.placeholder]}>
              <Text style={styles.placeholderText}>
                {editMode ? 'Tap to add a photo' : 'No image'}
              </Text>
            </View>
          )}
          {editMode && (
            <View style={styles.editOverlay} pointerEvents="none">
              <Text style={styles.editOverlayText}>Change Photo</Text>
            </View>
          )}
        </View>
      </Pressable>
      {/* Subtle fade bridging the hero into the page background below it —
          a separate decorative strip beneath the image, never over it. */}
      <LinearGradient
        colors={['rgba(0,0,0,0.22)', 'transparent']}
        style={styles.fade}
        pointerEvents="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '92%',
    alignSelf: 'center',
    marginTop: 12,
  },
  shadowBox: {
    borderRadius: HERO_RADIUS,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 6,
  },
  imageBox: {
    aspectRatio: 5 / 7,
    borderRadius: HERO_RADIUS,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    color: PV2.textTertiary,
    fontSize: 14,
  },
  editOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 14,
  },
  editOverlayText: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  // Short decorative strip immediately below the hero — reads as the image
  // gently fading into the page rather than ending on a hard edge.
  fade: {
    height: 16,
    marginTop: 0,
  },
});
