import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import type { Folder } from '@/types';

const PLACEHOLDER_COLORS = [
  '#E3F2FD',
  '#F3E5F5',
  '#E8F5E9',
  '#FFF3E0',
  '#FCE4EC',
  '#E0F2F1',
];

function placeholderColor(name: string) {
  return PLACEHOLDER_COLORS[name.charCodeAt(0) % PLACEHOLDER_COLORS.length];
}

type Props = {
  folder: Folder;
  onPress: () => void;
};

export function FolderCard({ folder, onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      onPress={onPress}>
      <View style={[styles.cover, { backgroundColor: placeholderColor(folder.name) }]}>
        {folder.cover_image_url ? (
          <Image
            source={{ uri: folder.cover_image_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
          />
        ) : (
          <Text style={styles.initial}>{folder.name.charAt(0).toUpperCase()}</Text>
        )}
      </View>
      <Text style={styles.name} numberOfLines={2}>
        {folder.name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    margin: 6,
    borderRadius: 12,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.85,
  },
  cover: {
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    fontSize: 40,
    fontWeight: '700',
    color: 'rgba(0,0,0,0.25)',
  },
  name: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    fontWeight: '500',
    color: '#11181C',
  },
});
