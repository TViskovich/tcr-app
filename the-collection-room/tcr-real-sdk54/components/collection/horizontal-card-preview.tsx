import { FlatList, StyleSheet, useWindowDimensions, View } from 'react-native';

import { COMPACT_SECTION_GUTTER, SECTION_GUTTER } from '@/components/collection/collection-header-row';
import { CollectionPreviewCard } from '@/components/collection/collection-preview-card';
import { IconSymbol } from '@/components/ui/icon-symbol';
import type { CollectionGridEntry } from '@/hooks/use-collection';
import { useSignedFolderCovers } from '@/hooks/use-signed-folder-covers';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import type { CollectionItem, Folder } from '@/types';

// Shows ~3.6 cards across the screen width so the next one is always
// partially visible at rest — the visual cue that the row scrolls, per the
// "3.5 to 4 cards" spec. Non-integer on purpose: an exact fit would hide
// the partial-card cue entirely at rest.
const CARDS_VISIBLE = 3.6;
// Matches the folder-detail grid's own GRID_GAP (see
// app/collection/[folderId].tsx) — same tight, Instagram-tile gutter,
// applied here to this row's real tiles instead of a fixed grid.
const CARD_GAP = 1;

// Compact (variant="compact", see profile-v2-collections.tsx) — same
// non-integer-on-purpose reasoning as CARDS_VISIBLE, tuned to match the
// Profile V3 Collection tab reference: ~3 tiles fully visible with the
// next one partially peeking past the edge. COMPACT_CARD_GAP is now 0
// (was 4, then 1 to match CARD_GAP) — tiles sit fully edge-to-edge, tighter
// than the main Collection screen's own 1px, per follow-up request.
const COMPACT_CARDS_VISIBLE = 3.6;
const COMPACT_CARD_GAP = 0;

type Props = {
  folderId: string;
  entries: CollectionGridEntry[];
  // Tapping a real preview tile opens that specific card's own item-detail
  // page (app/item/[id].tsx) — the same destination app/collection/
  // [folderId].tsx's own openItem uses. Opening the folder itself via
  // CollectionHeaderRow's title/chevron tap is a separate action from
  // either of these.
  onOpenItem: (item: CollectionItem) => void;
  // Tapping a child-folder entry navigates directly into that folder
  // (app/collection/[folderId].tsx, recursively) — distinct from
  // onOpenItem and from CollectionHeaderRow's own "open this row's own
  // folder" tap.
  onOpenChildFolder: (folder: Folder) => void;
  onAddItem: () => void;
  // "compact" only shrinks tile size/spacing (see
  // components/profile-v2/profile-v2-collections.tsx) — same slot-filling
  // logic, same tap targets, same aspect ratio as "full" (the default).
  variant?: 'full' | 'compact';
};

// A free-scrolling (no snap, indicator hidden) horizontal preview of one
// folder's own direct contents — a mix of CollectionItems and direct child
// folders, in the exact same recency order as the full folder-detail grid
// (compareGridEntriesByRecency, hooks/use-collection.ts) — never folders
// forced to the front or given a reserved slot. No data fetching of its
// own for entries themselves — already resolved and capped by the caller
// (see hooks/use-collection.ts's PREVIEW_ITEM_LIMIT/buildPreviewEntries),
// so this preview reflects only that capped recent sample, not the
// folder's full total. This component does own the signed-URL resolution
// for whichever entries it was actually given (item images vs. folder
// covers are two different signed-delivery paths — see below). Shows only
// real entries — a sparse or empty collection just renders fewer (or
// zero) tiles, no generated filler.
//
// Deliberately does NOT group items by player (that's a separate,
// intentional feature scoped to the folder-detail screen's own top-level
// grid — see app/collection/[folderId].tsx) — a folder preview must keep
// filling additional visible positions as more entries are added, never
// losing positions because several items share a player or have none set.
export function HorizontalCardPreview({ entries, onOpenItem, onOpenChildFolder, variant = 'full' }: Props) {
  const compact = variant === 'compact';
  const { width: windowWidth } = useWindowDimensions();
  const gutter = compact ? COMPACT_SECTION_GUTTER : SECTION_GUTTER;
  const cardsVisible = compact ? COMPACT_CARDS_VISIBLE : CARDS_VISIBLE;
  const cardGap = compact ? COMPACT_CARD_GAP : CARD_GAP;
  const visibleWidth = windowWidth - gutter;
  const tileWidth = (visibleWidth - cardGap * Math.floor(cardsVisible)) / cardsVisible;

  // Two independent, batched signed-delivery paths — item images and
  // folder covers are resolved by two different Edge Functions/hooks
  // (item-images beta privacy hardening vs. Phase 3D folder-cover
  // signing), so a mixed row still issues at most one batched request per
  // path, never one request per tile.
  const itemEntries = entries.filter((e): e is Extract<CollectionGridEntry, { kind: 'item' }> => e.kind === 'item');
  const folderEntries = entries.filter(
    (e): e is Extract<CollectionGridEntry, { kind: 'folder' }> => e.kind === 'folder',
  );
  const { urls: signedUrls } = useSignedItemImages(itemEntries.map((e) => e.item.primary_image_id));
  const { urls: coverUrls } = useSignedFolderCovers(folderEntries.map((e) => e.folder.id));

  return (
    <FlatList
      data={entries}
      horizontal
      scrollEnabled
      showsHorizontalScrollIndicator={false}
      keyExtractor={(entry) => (entry.kind === 'folder' ? `folder-${entry.folder.id}` : entry.item.id)}
      contentContainerStyle={{ paddingHorizontal: gutter }}
      ItemSeparatorComponent={() => <View style={{ width: cardGap }} />}
      renderItem={({ item: entry }) =>
        entry.kind === 'folder' ? (
          <View style={{ width: tileWidth }}>
            <CollectionPreviewCard
              testID={`child-folder-preview-${entry.folder.id}`}
              imageUrl={coverUrls.get(entry.folder.id) ?? null}
              tileWidth={tileWidth}
              variant={variant}
              squareEdges={!compact}
              onPress={() => onOpenChildFolder(entry.folder)}
            />
            {/* Same small, subtle dark-scrim-circle badge language as the
                folder-detail grid's own folderBadge (app/collection/
                [folderId].tsx) — the only thing that distinguishes a
                nested-collection preview tile from an ordinary item
                preview tile, consistent at every nesting depth.
                pointerEvents="none" so it never steals the card's own tap
                target underneath it. */}
            <View style={styles.folderBadge} pointerEvents="none">
              <IconSymbol name="folder.fill" size={11} color="#fff" />
            </View>
          </View>
        ) : (
          <CollectionPreviewCard
            imageUrl={entry.item.primary_image_id ? (signedUrls.get(entry.item.primary_image_id) ?? null) : null}
            tileWidth={tileWidth}
            variant={variant}
            squareEdges={!compact}
            onPress={() => onOpenItem(entry.item)}
          />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  // Same rgba(0,0,0,~0.55) dark-scrim-circle language as the folder-detail
  // grid's own folderBadge (app/collection/[folderId].tsx) — kept as its
  // own copy rather than a shared import since the two live in otherwise
  // unrelated StyleSheets with no existing shared "badges" module; the
  // visual language matching is what needs to stay consistent, not the
  // style object identity.
  folderBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
