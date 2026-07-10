import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import type { Folder } from '@/types';

// Kept in sync with folder-card.tsx's own palette by design, but duplicated
// rather than imported — this is a visually distinct card for the profile's
// horizontal Folders row, independent of folder-card.tsx (still used as-is
// by the Collection tab's grid).
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
};

const CHIP_WIDTH = 104;
const CHIP_HEIGHT = 128;

export function FolderChip({ folder, onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      onPress={onPress}>
      <View style={[styles.fill, { backgroundColor: placeholderColor(folder.name) }]}>
        {folder.cover_image_url ? (
          <Image
            source={{ uri: folder.cover_image_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
          />
        ) : (
          <Text style={styles.initial}>{folder.name.charAt(0).toUpperCase()}</Text>
        )}
      </View>

      {/* Faint top highlight — suggests a glass surface without a heavy shadow */}
      <View style={styles.topGlow} pointerEvents="none" />

      {/* Name caption anchored at the bottom, same treatment as the Collection
          tab's grid cards — photo stays fully visible above it. */}
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={styles.gradient}>
        <Text style={styles.name} numberOfLines={1}>
          {folder.name}
        </Text>
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: CHIP_WIDTH,
    height: CHIP_HEIGHT,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.88,
    transform: [{ scale: 0.97 }],
  },
  fill: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Subtle inner glow along the top edge — a soft highlight rather than a
  // bright gradient or drop shadow.
  topGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: CHIP_HEIGHT * 0.3,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  initial: {
    fontSize: 30,
    fontWeight: '800',
    color: 'rgba(0,0,0,0.16)',
  },
  gradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '42%',
    justifyContent: 'flex-end',
    paddingBottom: 10,
    paddingHorizontal: 10,
  },
  name: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.1,
  },
});
