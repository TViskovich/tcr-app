import { useMemo } from 'react';
import { FlatList, StyleSheet, useWindowDimensions, View } from 'react-native';

import { SECTION_GUTTER } from '@/components/collection/collection-header-row';
import { CollectionPreviewCard } from '@/components/collection/collection-preview-card';
import { CollectionPreviewPlaceholder } from '@/components/collection/collection-preview-placeholder';
import { groupItemsByPlayer, type PlayerGroup } from '@/hooks/use-collection';
import type { CollectionItem } from '@/types';

// Shows ~3.6 cards across the screen width so the next one is always
// partially visible at rest — the visual cue that the row scrolls, per the
// "3.5 to 4 cards" spec. Non-integer on purpose: an exact fit would hide
// the partial-card cue entirely at rest.
const CARDS_VISIBLE = 3.6;
const CARD_GAP = 10;

// Folders with this many real groups or more fill the initial row on their
// own — no placeholders. ceil(CARDS_VISIBLE): with ~3.6 cards visible, 3
// real groups alone still left a trailing gap of empty space at the row's
// end, so a folder needs a full 4 to be considered "complete" with no
// placeholder needed.
const MIN_VISIBLE_SLOTS = Math.ceil(CARDS_VISIBLE);

function groupSubtitle(group: PlayerGroup): string {
  return `${group.items.length} ${group.items.length === 1 ? 'card' : 'cards'}`;
}

// Same cover-resolution rule as the folder detail screen's grouping grid —
// first item in the group with a real image_url.
function groupCover(group: PlayerGroup): string | null {
  return group.items.find((i) => i.image_url)?.image_url ?? null;
}

type PreviewSlot =
  | { kind: 'group'; group: PlayerGroup }
  | { kind: 'placeholder'; key: string };

type Props = {
  folderId: string;
  items: CollectionItem[];
  onOpenGroup: (group: PlayerGroup) => void;
  onAddItem: () => void;
};

// A free-scrolling (no snap, indicator hidden) horizontal preview of one
// collection's player groupings (e.g. "Shohei Ohtani — 2 cards"), matching
// the grouping grid on the folder detail screen (app/collection/[folderId].tsx)
// so tapping a preview tile lands on the same grouping's card gallery. No
// data fetching of its own — items are already resolved and capped by the
// caller (see hooks/use-collection.ts's PREVIEW_ITEM_LIMIT), so a group's
// count here reflects only that capped recent sample, not the folder's full
// total (the folder detail screen is the source of truth for exact counts).
// Real groups always come first; generated placeholder slots (local-only,
// never persisted) fill out the rest of the initial visible row so a sparse
// or empty collection still reads as a complete, intentional row.
export function HorizontalCardPreview({ folderId, items, onOpenGroup, onAddItem }: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const visibleWidth = windowWidth - SECTION_GUTTER;
  const tileWidth = (visibleWidth - CARD_GAP * Math.floor(CARDS_VISIBLE)) / CARDS_VISIBLE;

  const groups = useMemo(() => groupItemsByPlayer(items), [items]);

  const slots = useMemo<PreviewSlot[]>(() => {
    const real: PreviewSlot[] = groups.map((group) => ({ kind: 'group', group }));
    const placeholderCount = Math.max(0, MIN_VISIBLE_SLOTS - groups.length);
    const placeholders: PreviewSlot[] = Array.from({ length: placeholderCount }, (_, i) => ({
      kind: 'placeholder',
      key: `placeholder-${folderId}-${i}`,
    }));
    return [...real, ...placeholders];
  }, [groups, folderId]);

  return (
    <FlatList
      data={slots}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyExtractor={(slot) => (slot.kind === 'group' ? slot.group.key : slot.key)}
      contentContainerStyle={styles.content}
      ItemSeparatorComponent={() => <View style={{ width: CARD_GAP }} />}
      renderItem={({ item: slot }) =>
        slot.kind === 'group' ? (
          <CollectionPreviewCard
            imageUrl={groupCover(slot.group)}
            title={slot.group.label}
            subtitle={groupSubtitle(slot.group)}
            tileWidth={tileWidth}
            onPress={() => onOpenGroup(slot.group)}
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
