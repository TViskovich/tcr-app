import { useMemo } from 'react';
import { FlatList, useWindowDimensions, View } from 'react-native';

import { COMPACT_SECTION_GUTTER, SECTION_GUTTER } from '@/components/collection/collection-header-row';
import { CollectionPreviewCard } from '@/components/collection/collection-preview-card';
import { CollectionPreviewPlaceholder } from '@/components/collection/collection-preview-placeholder';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import type { CollectionItem } from '@/types';

// Shows ~3.6 cards across the screen width so the next one is always
// partially visible at rest — the visual cue that the row scrolls, per the
// "3.5 to 4 cards" spec. Non-integer on purpose: an exact fit would hide
// the partial-card cue entirely at rest.
const CARDS_VISIBLE = 3.6;
const CARD_GAP = 10;

// Compact (variant="compact", see profile-v2-collections.tsx) shows more,
// smaller tiles — same non-integer-on-purpose reasoning as CARDS_VISIBLE,
// just scaled for a narrower row rather than the full-width carousel.
const COMPACT_CARDS_VISIBLE = 4.6;
const COMPACT_CARD_GAP = 8;

// Folders with this many real groups or more fill the initial row on their
// own — no placeholders. ceil(CARDS_VISIBLE): with ~3.6 cards visible, 3
// real groups alone still left a trailing gap of empty space at the row's
// end, so a folder needs a full 4 to be considered "complete" with no
// placeholder needed.
const MIN_VISIBLE_SLOTS = Math.ceil(CARDS_VISIBLE);

// Compact (profile) rows never scroll and never show a 5th tile, real or
// placeholder — real items and generated placeholders both count toward
// this same cap, applied to whichever mix reaches it first.
const PROFILE_COLLECTION_PREVIEW_LIMIT = 4;

type PreviewSlot =
  | { kind: 'item'; item: CollectionItem }
  | { kind: 'placeholder'; key: string };

type Props = {
  folderId: string;
  items: CollectionItem[];
  // Tapping any real preview tile opens the folder itself — this is a
  // preview of the folder's CONTENTS (distinct CollectionItems), not a
  // navigator into a player-filtered subset, so there's no per-tile
  // destination beyond "open this folder" (same destination
  // CollectionHeaderRow's own title tap already uses).
  onOpenFolder: () => void;
  onAddItem: () => void;
  // "compact" only shrinks tile size/spacing (see
  // components/profile-v2/profile-v2-collections.tsx) — same slot-filling
  // logic, same tap targets, same aspect ratio as "full" (the default).
  variant?: 'full' | 'compact';
};

// A free-scrolling (no snap, indicator hidden) horizontal preview of one
// folder's own distinct CollectionItems — one tile per item, each showing
// only that item's own primary_image_id signed cover. No data fetching of
// its own — items are already resolved and capped by the caller (see
// hooks/use-collection.ts's PREVIEW_ITEM_LIMIT), so this preview reflects
// only that capped recent sample, not the folder's full total. Real items
// always come first; generated placeholder slots (local-only, never
// persisted) fill out the rest of the initial visible row so a sparse or
// empty collection still reads as a complete, intentional row.
//
// Deliberately does NOT group items by player (that's a separate,
// intentional feature scoped to the folder-detail screen's own top-level
// grid — see app/collection/[folderId].tsx) — a folder preview must keep
// filling additional visible positions as more items are added, never
// losing positions because several items share a player or have none set.
export function HorizontalCardPreview({ folderId, items, onOpenFolder, onAddItem, variant = 'full' }: Props) {
  const compact = variant === 'compact';
  const { width: windowWidth } = useWindowDimensions();
  const gutter = compact ? COMPACT_SECTION_GUTTER : SECTION_GUTTER;
  const cardsVisible = compact ? COMPACT_CARDS_VISIBLE : CARDS_VISIBLE;
  const cardGap = compact ? COMPACT_CARD_GAP : CARD_GAP;
  const visibleWidth = windowWidth - gutter;
  const tileWidth = (visibleWidth - cardGap * Math.floor(cardsVisible)) / cardsVisible;

  // One batched call for every item currently in this preview row (already
  // capped by the caller, see hooks/use-collection.ts's PREVIEW_ITEM_LIMIT).
  const { urls: signedUrls } = useSignedItemImages(items.map((i) => i.primary_image_id));

  const slots = useMemo<PreviewSlot[]>(() => {
    const capacity = compact ? PROFILE_COLLECTION_PREVIEW_LIMIT : MIN_VISIBLE_SLOTS;
    // Compact (profile) rows never scroll, so they hard-cap to `capacity`
    // real tiles; the full/scrollable row shows every item the caller
    // passed in — `capacity` there only determines the placeholder floor.
    const realItems = compact ? items.slice(0, PROFILE_COLLECTION_PREVIEW_LIMIT) : items;
    const real: PreviewSlot[] = realItems.map((item) => ({ kind: 'item', item }));
    const placeholderCount = Math.max(0, capacity - realItems.length);
    const placeholders: PreviewSlot[] = Array.from({ length: placeholderCount }, (_, i) => ({
      kind: 'placeholder',
      key: `placeholder-${folderId}-${i}`,
    }));
    return [...real, ...placeholders];
  }, [compact, items, folderId]);

  return (
    <FlatList
      data={slots}
      horizontal
      scrollEnabled={!compact}
      showsHorizontalScrollIndicator={false}
      keyExtractor={(slot) => (slot.kind === 'item' ? slot.item.id : slot.key)}
      contentContainerStyle={{ paddingHorizontal: gutter }}
      ItemSeparatorComponent={() => <View style={{ width: cardGap }} />}
      renderItem={({ item: slot }) =>
        slot.kind === 'item' ? (
          <CollectionPreviewCard
            imageUrl={slot.item.primary_image_id ? (signedUrls.get(slot.item.primary_image_id) ?? null) : null}
            tileWidth={tileWidth}
            variant={variant}
            onPress={onOpenFolder}
          />
        ) : (
          <CollectionPreviewPlaceholder tileWidth={tileWidth} onPress={onAddItem} />
        )
      }
    />
  );
}
