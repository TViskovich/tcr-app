import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import type { Folder } from '@/types';

const PLACEHOLDER_COLORS = [
  '#C8DFF5',
  '#DDD0F0',
  '#C6E8D3',
  '#F5E6C8',
  '#F5CDD0',
  '#C6E8E8',
];

function placeholderColor(name: string) {
  return PLACEHOLDER_COLORS[name.charCodeAt(0) % PLACEHOLDER_COLORS.length];
}

type Props = {
  folder: Folder;
  onPress: () => void;
  itemCount?: number;
};

export function FolderCard({ folder, onPress, itemCount }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        pressed && styles.pressed,
      ]}
      onPress={onPress}>
      <View style={[styles.cover, { backgroundColor: placeholderColor(folder.name) }]}>
        {/* Cover image */}
        {folder.cover_image_url ? (
          <Image
            source={{ uri: folder.cover_image_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
          />
        ) : (
          // Decorative initial — very subtle, image should dominate
          <Text style={styles.initial}>{folder.name.charAt(0).toUpperCase()}</Text>
        )}

        {/* Gradient scrim + title anchored at bottom */}
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.72)']}
          style={styles.gradient}>
          <Text style={styles.overlayTitle} numberOfLines={2}>
            {folder.name}
          </Text>
          {typeof itemCount === 'number' && (
            <Text style={styles.overlaySubtitle}>
              {itemCount === 1 ? '1 card' : `${itemCount} cards`}
            </Text>
          )}
        </LinearGradient>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    margin: 6,
    borderRadius: 20,
    backgroundColor: '#e0e0e0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.20,
    shadowRadius: 14,
    elevation: 7,
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.88,
    transform: [{ scale: 0.97 }],
  },
  cover: {
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initial: {
    fontSize: 26,
    fontWeight: '800',
    color: 'rgba(0,0,0,0.07)',
  },
  // Gradient occupies the bottom ~30% of the card.
  // The top of the gradient is fully transparent, so the image reads clearly
  // through the top half; text sits in the darkened lower portion.
  gradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '34%',
    justifyContent: 'flex-end',
    paddingBottom: 14,
    paddingHorizontal: 14,
  },
  overlayTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.1,
  },
  overlaySubtitle: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 12,
    fontWeight: '400',
    marginTop: 2,
  },
});
