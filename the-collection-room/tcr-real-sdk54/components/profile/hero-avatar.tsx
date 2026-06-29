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
  },
  avatarWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    overflow: 'hidden',
    backgroundColor: '#2A2A2A',
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
