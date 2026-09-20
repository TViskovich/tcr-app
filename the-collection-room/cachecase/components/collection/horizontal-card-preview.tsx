import { FlatList, StyleSheet, useWindowDimensions, View } from 'react-native';

import { SECTION_GUTTER } from '@/components/collection/collection-header-row';
import { CollectionMoreTile } from '@/components/collection/collection-more-tile';
import { CollectionPreviewCard } from '@/components/collection/collection-preview-card';
import { GRID_CELL_WIDTH, GRID_GAP, GRID_HORIZONTAL_MARGIN } from '@/components/profile-v2/profile-v2-grid';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { PREVIEW_ITEM_LIMIT, type CollectionGridEntry } from '@/hooks/use-collection';
import { useSignedFolderCovers } from '@/hooks/use-signed-folder-covers';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { folderCoverCacheKey, itemImageCacheKey } from '@/lib/private-image-cache-key';
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
  // Authoritative total active-item count for this folder (hooks/
  // use-collection.ts's useFolders().itemCounts — an uncapped COUNT query,
  // unlike `entries` below which is already capped to PREVIEW_ITEM_LIMIT).
  // Optional and omitted by app/(tabs)/collection.tsx's own call site today
  // — only the Profile Collection tab (profile-v2-collections.tsx) passes
  // it — so that screen's rows are completely unaffected by this prop's
  // existence. When present and greater than PREVIEW_ITEM_LIMIT, this row's
  // last slot becomes a "+N more" tile instead of a real preview card; see
  // the overflow math inside the component body below.
  itemCount?: number;
  // Tap target for the "+N more" tile — opens this row's own folder, the
  // exact same destination/params as CollectionHeaderRow's title tap (both
  // ultimately call profile-v2-screen.tsx's/app/(tabs)/collection.tsx's own
  // openFolder). Optional: with no itemCount there's never an overflow tile
  // to tap, so a caller that never passes itemCount doesn't need this either.
  onOpenFolder?: () => void;
  // "compact" only shrinks tile size/spacing (see
  // components/profile-v2/profile-v2-collections.tsx) — same slot-filling
  // logic, same tap targets, same aspect ratio as "full" (the default).
  variant?: 'full' | 'compact';
};

// One row of the FlatList below — either a real preview entry or the
// synthetic overflow tile. Built fresh on every render from `entries` +
// itemCount; never stored in state and never fed back into previewEntries,
// so it can't participate in the signed-URL/prefetch paths (those read
// `entries` directly, see itemEntries/folderEntries below) and can't
// reintroduce the previewEntries double-publish flicker useFolders() was
// fixed for.
type PreviewRowItem = { kind: 'entry'; entry: CollectionGridEntry } | { kind: 'more'; remainingCount: number };

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
export function HorizontalCardPreview({
  entries,
  onOpenItem,
  onOpenChildFolder,
  itemCount,
  onOpenFolder,
  variant = 'full',
}: Props) {
  const compact = variant === 'compact';
  // Same identity the two signed-image hooks below already key their own
  // caches by (hooks/use-signed-item-images.ts, hooks/
  // use-signed-folder-covers.ts) — reused here, not a second identity
  // concept, purely to build each tile's stable expo-image cacheKey (Phase
  // 2 of the private-image caching upgrade — see lib/private-image-cache-key.ts).
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const { width: windowWidth } = useWindowDimensions();
  // Compact (profile Collection tab) reuses the Grails grid's own
  // GRID_HORIZONTAL_MARGIN/GRID_GAP/GRID_CELL_WIDTH (profile-v2-grid.tsx)
  // for row padding, card gap, AND card width — not just width alone —
  // so this row's columns land pixel-exactly under the Grails grid's own
  // 3 columns above it: same left inset, same gap, same cell size. The
  // header row above this (CollectionHeaderRow) intentionally keeps its
  // own separate COMPACT_SECTION_GUTTER — only this image row's geometry
  // needs to match Grails, not the title's padding.
  const gutter = compact ? GRID_HORIZONTAL_MARGIN : SECTION_GUTTER;
  const cardGap = compact ? GRID_GAP : CARD_GAP;
  const visibleWidth = windowWidth - gutter;
  // Since CollectionPreviewCard's PREVIEW_CARD_ASPECT_RATIO already equals
  // the Grails grid's own CARD_ASPECT_RATIO, matching width alone (via the
  // shared GRID_CELL_WIDTH) makes the derived tile height match too.
  const tileWidth = compact ? GRID_CELL_WIDTH : (visibleWidth - cardGap * Math.floor(CARDS_VISIBLE)) / CARDS_VISIBLE;

  // Two independent, batched signed-delivery paths — item images and
  // folder covers are resolved by two different Edge Functions/hooks
  // (item-images beta privacy hardening vs. Phase 3D folder-cover
  // signing), so a mixed row still issues at most one batched request per
  // path, never one request per tile. Deliberately built from `entries`
  // (the full, un-trimmed prop), not from the overflow-aware rowItems
  // below — signed-URL warmup/prefetch behavior for real entries is
  // unchanged by this tile's existence, exactly as before.
  const itemEntries = entries.filter((e): e is Extract<CollectionGridEntry, { kind: 'item' }> => e.kind === 'item');
  const folderEntries = entries.filter(
    (e): e is Extract<CollectionGridEntry, { kind: 'folder' }> => e.kind === 'folder',
  );
  const { urls: signedUrls } = useSignedItemImages(itemEntries.map((e) => e.item.primary_image_id));
  const { urls: coverUrls } = useSignedFolderCovers(folderEntries.map((e) => e.folder.id));

  // Overflow math — see the PR description's formula. hasOverflow only
  // considers itemCount (the folder's real, uncapped total), never
  // entries.length (already capped to PREVIEW_ITEM_LIMIT, so it alone can
  // never reveal whether more items exist beyond the cap). realPreviewCount
  // trims the LAST slot away for the overflow tile itself — remainingCount
  // is every item not represented by a real tile, including the ones
  // `entries` never even fetched past PREVIEW_ITEM_LIMIT. Safe at
  // PREVIEW_ITEM_LIMIT = 1: realPreviewCount becomes 0, entries.slice(0, 0)
  // is simply empty, and the row is just the one "+N more" tile.
  const hasOverflow = itemCount != null && itemCount > PREVIEW_ITEM_LIMIT;
  const realPreviewCount = hasOverflow ? PREVIEW_ITEM_LIMIT - 1 : PREVIEW_ITEM_LIMIT;
  const remainingCount = hasOverflow ? itemCount! - realPreviewCount : 0;

  const rowItems: PreviewRowItem[] = entries
    .slice(0, realPreviewCount)
    .map((entry) => ({ kind: 'entry', entry }) as const);
  if (hasOverflow) rowItems.push({ kind: 'more', remainingCount });

  return (
    <FlatList
      data={rowItems}
      horizontal
      scrollEnabled
      showsHorizontalScrollIndicator={false}
      keyExtractor={(row) =>
        row.kind === 'more' ? 'more' : row.entry.kind === 'folder' ? `folder-${row.entry.folder.id}` : row.entry.item.id
      }
      contentContainerStyle={{ paddingHorizontal: gutter }}
      ItemSeparatorComponent={() => <View style={{ width: cardGap }} />}
      renderItem={({ item: row }) => {
        if (row.kind === 'more') {
          return (
            <CollectionMoreTile
              remainingCount={row.remainingCount}
              tileWidth={tileWidth}
              variant={variant}
              squareEdges={!compact}
              onPress={() => onOpenFolder?.()}
            />
          );
        }
        const entry = row.entry;
        return entry.kind === 'folder' ? (
          <View style={{ width: tileWidth }}>
            <CollectionPreviewCard
              testID={`child-folder-preview-${entry.folder.id}`}
              imageUrl={coverUrls.get(entry.folder.id) ?? null}
              cacheKey={folderCoverCacheKey(identity, entry.folder)}
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
            cacheKey={entry.item.primary_image_id ? itemImageCacheKey(identity, entry.item.primary_image_id) : undefined}
            tileWidth={tileWidth}
            variant={variant}
            squareEdges={!compact}
            onPress={() => onOpenItem(entry.item)}
          />
        );
      }}
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
