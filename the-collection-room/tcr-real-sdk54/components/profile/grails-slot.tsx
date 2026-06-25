import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import type { ShowcaseItem } from '@/types';

type Props = {
  item?: ShowcaseItem;
  size: number;
  onPress?: () => void;
};

export function GrailsSlot({ item, size, onPress }: Props) {
  if (!item) return null;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.cell,
        { width: size, height: size * (4 / 3) },
        pressed && styles.pressed,
      ]}
      onPress={onPress}>
      {item.item.image_url ? (
        <Image
          source={{ uri: item.item.image_url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.noImage]}>
          <Text style={styles.noImageText}>{item.item.title ?? '—'}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cell: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#e9ecef',
  },
  pressed: {
    opacity: 0.80,
  },
  noImage: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  noImageText: {
    fontSize: 10,
    color: '#aaa',
    textAlign: 'center',
  },
});
