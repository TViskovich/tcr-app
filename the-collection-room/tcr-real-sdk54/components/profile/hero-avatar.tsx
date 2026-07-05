import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { AVATAR_SIZE } from './hero-constants';

type Props = {
  avatarUri: string | null;
  displayName: string;
  onPress?: () => void;
  editMode?: boolean;
};

export function HeroAvatar({ avatarUri, displayName, onPress, editMode = false }: Props) {
  return (
    <View style={styles.avatarAnchor}>
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
    borderRadius: AVATAR_SIZE / 2,
    // Layout-only — sizes/positions the avatar. Was also casting a floating
    // drop shadow beneath the disc; neutralized (opacity 0) rather than
    // removing the properties, since it showed through as a faint dark "ghost"
    // blob above the badge rail.
    shadowColor: '#000',
    shadowOpacity: 0,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 5 },
    elevation: 0,
  },
  avatarWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    overflow: 'hidden',
    backgroundColor: '#2A2A2A',
    // 1.5px rim light — separates the disc from the dark background
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 145,
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
    fontSize: 17,
    fontWeight: '600',
  },
});
