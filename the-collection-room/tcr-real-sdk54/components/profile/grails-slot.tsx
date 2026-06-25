import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import type { ShowcaseItem } from '@/types';

type Props = {
  item: ShowcaseItem;
  onPress?: () => void;
};

export function GrailsSlot({ item, onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
      onPress={onPress}>
      {item.item.image_url ? (
        <Image
          source={{ uri: item.item.image_url }}
          style={styles.image}
          contentFit="cover"
        />
      ) : (
        <View style={styles.noImage}>
          <Text style={styles.noImageText} numberOfLines={2}>
            {item.item.title ?? '—'}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cell: {
    width: '32%',
    aspectRatio: 3 / 4,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#e9ecef',
  },
  pressed: {
    opacity: 0.78,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  noImage: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
  },
  noImageText: {
    fontSize: 10,
    color: '#aaa',
    textAlign: 'center',
  },
});
