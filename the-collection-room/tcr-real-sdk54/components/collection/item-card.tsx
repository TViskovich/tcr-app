import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import type { CollectionItem } from '@/types';

type Props = {
  item: CollectionItem;
  onPress: () => void;
};

export function ItemCard({ item, onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      onPress={onPress}>
      <View style={styles.imageWrap}>
        {item.image_url ? (
          <Image
            source={{ uri: item.image_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.noImage]}>
            <Text style={styles.noImageText}>No Image</Text>
          </View>
        )}
      </View>
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={1}>
          {item.title ?? 'Untitled'}
        </Text>
        {item.player ? (
          <Text style={styles.player} numberOfLines={1}>
            {item.player}
          </Text>
        ) : null}
        {item.grade ? (
          <Text style={styles.grade}>{item.grade}</Text>
        ) : null}
      </View>
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
  imageWrap: {
    aspectRatio: 5 / 7,
    backgroundColor: '#f0f0f0',
  },
  noImage: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  noImageText: {
    fontSize: 12,
    color: '#aaa',
  },
  info: {
    padding: 8,
    gap: 2,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    color: '#11181C',
  },
  player: {
    fontSize: 12,
    color: '#687076',
  },
  grade: {
    fontSize: 11,
    fontWeight: '500',
    color: '#0a7ea4',
  },
});
