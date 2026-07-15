import { Pressable, StyleSheet, View } from 'react-native';

import { Image } from 'expo-image';

import { IconSymbol } from '@/components/ui/icon-symbol';
import type { ShowcaseItem } from '@/types';
import { PV2 } from './profile-v2-theme';

const SLOT_COUNT = 9;
const COLS = 3;

type Props = {
  grails: ShowcaseItem[];
  onItemPress: (item: ShowcaseItem) => void;
  // There's no per-slot "add to this exact spot" flow in the app today —
  // Grails are added from an item's detail screen, not picked into a slot.
  // Every empty slot reuses that same existing entry point (same one the
  // old zero-state CTA used) rather than inventing a new add-flow.
  onAddPress: () => void;
};

export function ProfileV2Grid({ grails, onItemPress, onAddPress }: Props) {
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => grails[i] ?? null);
  const rows: (ShowcaseItem | null)[][] = [];
  for (let i = 0; i < slots.length; i += COLS) rows.push(slots.slice(i, i + COLS));

  return (
    <View style={styles.grid}>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((item, colIndex) =>
            item ? (
              <Pressable
                key={item.id}
                style={styles.slot}
                onPress={() => onItemPress(item)}>
                {item.item.image_url ? (
                  <Image source={{ uri: item.item.image_url }} style={styles.slotImage} contentFit="cover" transition={150} />
                ) : (
                  <View style={styles.slotEmptyFill} />
                )}
              </Pressable>
            ) : (
              <Pressable
                key={`empty-${rowIndex}-${colIndex}`}
                style={[styles.slot, styles.slotEmpty]}
                onPress={onAddPress}>
                <IconSymbol name="plus" size={18} color="rgba(255,255,255,0.20)" />
              </Pressable>
            ),
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    marginHorizontal: 3,
    marginTop: 2,
    gap: 2,
  },
  row: {
    flexDirection: 'row',
    gap: 2,
  },
  slot: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: PV2.emptyCardBg,
  },
  slotImage: {
    width: '100%',
    height: '100%',
  },
  slotEmptyFill: {
    flex: 1,
    backgroundColor: PV2.emptyCardBg,
  },
  slotEmpty: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
