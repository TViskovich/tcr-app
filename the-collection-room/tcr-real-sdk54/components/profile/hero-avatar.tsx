import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { AVATAR_SIZE, GLOW_SIZE, GLOW_OFFSET } from './hero-constants';

type Props = {
  avatarUri: string | null;
  displayName: string; // used for the initials fallback
  onPress?: () => void;
  editMode?: boolean;
};

export function HeroAvatar({ avatarUri, displayName, onPress, editMode = false }: Props) {
  return (
    // Fixed-size container so the glow's negative offsets don't shift sibling layout
    <View style={styles.avatarAnchor}>
      {/* Diffuse glow ring — very low opacity, centered behind the avatar */}
      <View style={styles.avatarGlow} pointerEvents="none" />

      <Pressable
        style={styles.avatarWrap}
        onPress={onPress}
        disabled={!onPress}>
        {avatarUri ? (
          <Image
            source={{ uri: avatarUri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
            <Text style={styles.avatarInitial}>
              {displayName.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}

        {editMode && (
          <View style={styles.avatarOverlay}>
            <Text style={styles.avatarOverlayText}>Change</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  avatarAnchor: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
  },
  avatarGlow: {
    position: 'absolute',
    width: GLOW_SIZE,
    height: GLOW_SIZE,
    borderRadius: GLOW_SIZE / 2,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    top: -GLOW_OFFSET,
    left: -GLOW_OFFSET,
  },
  avatarWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    overflow: 'hidden',
    backgroundColor: '#2A2A2A',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 44,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  avatarOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.50)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarOverlayText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
