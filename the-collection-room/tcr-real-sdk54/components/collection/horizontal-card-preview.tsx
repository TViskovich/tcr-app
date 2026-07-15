import { useMemo } from 'react';
import { FlatList, StyleSheet, useWindowDimensions, View } from 'react-native';

import { SECTION_GUTTER } from '@/components/collection/collection-header-row';
import { CollectionPreviewCard } from '@/components/collection/collection-preview-card';
import { CollectionPreviewPlaceholder } from '@/components/collection/collection-preview-placeholder';
import type { CollectionItem } from '@/types';

// Shows ~3.6 cards across the screen width so the next one is always
// partially visible at rest — the visual cue that the row scrolls, per the
// "3.5 to 4 cards" spec. Non-integer on purpose: an exact fit would hide
// the partial-card cue entirely at rest.
const CARDS_VISIBLE = 3.6;
const CARD_GAP = 10;

// Folders with this many real items or more fill the initial row on their
// own — no placeholders. ceil(CARDS_VISIBLE): with ~3.6 cards visible, 3
// real items alone still left a trailing gap of empty space at the row's
// end, so a folder needs a full 4 to be considered "complete" with no
// placeholder needed.
const MIN_VISIBLE_SLOTS = Math.ceil(CARDS_VISIBLE);

function previewTitle(item: CollectionItem): string | null {
  return item.title;
}

function previewSubtitle(item: CollectionItem): string | null {
  return item.year ? String(item.year) : null;
}

type PreviewSlot =
  | { kind: 'item'; item: CollectionItem }
  | { kind: 'placeholder'; key: string };

type Props = {
  folderId: string;
  items: CollectionItem[];
  onItemPress: (item: CollectionItem) => void;
  onAddItem: () => void;
};

// A free-scrolling (no snap, indicator hidden) horizontal preview of one
// collection's items. No data fetching of its own — items are already
// resolved and capped by the caller (see hooks/use-collection.ts's
// PREVIEW_ITEM_LIMIT), so this never renders more than a small, fixed slice
// of even a very large collection. Real items always come first; generated
// placeholder slots (local-only, never persisted) fill out the rest of the
// initial visible row so a sparse or empty collection still reads as a
// complete, intentional row rather than a half-empty one.
export function HorizontalCardPreview({ folderId, items, onItemPress, onAddItem }: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const visibleWidth = windowWidth - SECTION_GUTTER;
  const tileWidth = (visibleWidth - CARD_GAP * Math.floor(CARDS_VISIBLE)) / CARDS_VISIBLE;

  const slots = useMemo<PreviewSlot[]>(() => {
    const real: PreviewSlot[] = items.map((item) => ({ kind: 'item', item }));
    const placeholderCount = Math.max(0, MIN_VISIBLE_SLOTS - items.length);
    const placeholders: PreviewSlot[] = Array.from({ length: placeholderCount }, (_, i) => ({
      kind: 'placeholder',
      key: `placeholder-${folderId}-${i}`,
    }));
    return [...real, ...placeholders];
  }, [items, folderId]);

  return (
    <FlatList
      data={slots}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyExtractor={(slot) => (slot.kind === 'item' ? slot.item.id : slot.key)}
      contentContainerStyle={styles.content}
      ItemSeparatorComponent={() => <View style={{ width: CARD_GAP }} />}
      renderItem={({ item: slot }) =>
        slot.kind === 'item' ? (
          <CollectionPreviewCard
            imageUrl={slot.item.image_url}
            title={previewTitle(slot.item)}
            subtitle={previewSubtitle(slot.item)}
            tileWidth={tileWidth}
            onPress={() => onItemPress(slot.item)}
          />
        ) : (
          <CollectionPreviewPlaceholder tileWidth={tileWidth} onPress={onAddItem} />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: SECTION_GUTTER,
  },
});
