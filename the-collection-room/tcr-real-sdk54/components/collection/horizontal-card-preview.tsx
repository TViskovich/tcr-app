import { FlatList, useWindowDimensions, View } from 'react-native';

import { COMPACT_SECTION_GUTTER, SECTION_GUTTER } from '@/components/collection/collection-header-row';
import { CollectionPreviewCard } from '@/components/collection/collection-preview-card';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import type { CollectionItem } from '@/types';

// Shows ~3.6 cards across the screen width so the next one is always
// partially visible at rest — the visual cue that the row scrolls, per the
// "3.5 to 4 cards" spec. Non-integer on purpose: an exact fit would hide
// the partial-card cue entirely at rest.
const CARDS_VISIBLE = 3.6;
// Matches the folder-detail grid's own GRID_GAP (see
// app/collection/[folderId].tsx) — same tight, Instagram-tile gutter,
// applied here to this row's real tiles instead of a fixed grid.
const CARD_GAP = 1;

// Compact (variant="compact", see profile-v2-collections.tsx) shows more,
// smaller tiles — same non-integer-on-purpose reasoning as CARDS_VISIBLE,
// just scaled for a narrower row rather than the full-width carousel.
const COMPACT_CARDS_VISIBLE = 4.6;
const COMPACT_CARD_GAP = 8;

// Compact (profile) rows never scroll, so they hard-cap to this many real
// tiles rather than showing every item in the folder.
const PROFILE_COLLECTION_PREVIEW_LIMIT = 4;

type Props = {
  folderId: string;
  items: CollectionItem[];
  // Tapping a real preview tile opens that specific card's own item-detail
  // page (app/item/[id].tsx) — the same destination app/collection/
  // [folderId].tsx's own openItem uses. Opening the folder itself is
  // CollectionHeaderRow's title/chevron tap, not this row's job.
  onOpenItem: (item: CollectionItem) => void;
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
// only that capped recent sample, not the folder's full total. Shows only
// real items — a sparse or empty collection just renders fewer (or zero)
// tiles, no generated filler.
//
// Deliberately does NOT group items by player (that's a separate,
// intentional feature scoped to the folder-detail screen's own top-level
// grid — see app/collection/[folderId].tsx) — a folder preview must keep
// filling additional visible positions as more items are added, never
// losing positions because several items share a player or have none set.
export function HorizontalCardPreview({ items, onOpenItem, variant = 'full' }: Props) {
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

  // Compact (profile) rows never scroll, so they hard-cap to this many real
  // tiles; the full/scrollable row shows every item the caller passed in.
  const visibleItems = compact ? items.slice(0, PROFILE_COLLECTION_PREVIEW_LIMIT) : items;

  return (
    <FlatList
      data={visibleItems}
      horizontal
      scrollEnabled={!compact}
      showsHorizontalScrollIndicator={false}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ paddingHorizontal: gutter }}
      ItemSeparatorComponent={() => <View style={{ width: cardGap }} />}
      renderItem={({ item }) => (
        <CollectionPreviewCard
          imageUrl={item.primary_image_id ? (signedUrls.get(item.primary_image_id) ?? null) : null}
          tileWidth={tileWidth}
          variant={variant}
          squareEdges={!compact}
          onPress={() => onOpenItem(item)}
        />
      )}
    />
  );
}
