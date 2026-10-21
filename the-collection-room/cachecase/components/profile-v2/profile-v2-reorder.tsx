import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { useCollectionPathMap } from '@/components/collection/collection-search';
import { ShareCardDragGrid } from '@/components/share/share-card-drag-grid';
import type { ProfileViewMode } from '@/hooks/use-profile-view-mode';
import { useSignedFolderCovers } from '@/hooks/use-signed-folder-covers';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';
import type { OrderSaveResult } from '@/lib/profile-ordering';
import type { Folder } from '@/types';

import { COLLECTION_ROW_HEIGHT, CollectionListRow } from './profile-v2-collections';
import { ITEM_ROW_HEIGHT, type ListableItem, ProfileV2ItemRow } from './profile-v2-item-row';
import { CELL_HEIGHT, CELL_WIDTH, COLS, GRID_GAP, GRID_HORIZONTAL_MARGIN } from './profile-v2-items-grid';
import { PV2 } from './profile-v2-theme';
import { SortableList, type SortableListAutoScroll } from './sortable-list';

// Profile V2's owner Edit Mode — drag-and-drop rearranging of the Collection
// tab (top-level collections) and the Items tab (the profile-wide item
// order). Entered by long-pressing an entry on your own profile; Done
// exits. Nothing in here navigates: entries are static while editing.
//
// Each completed drop saves once (never per frame) through the caller's
// onSave (lib/profile-ordering.ts → the reorder RPCs). While a save is in
// flight nothing can be lifted, so requests never overlap; if it fails the
// entries animate back to the last saved order and an alert says why.

// ── Shared: the order being edited and its save cycle ──────────────────────
function useReorderState(
  initialIds: string[],
  // The new order, and the last order the server confirmed (the move a
  // save describes is the difference between the two).
  onSave: (next: string[], previous: string[]) => Promise<OrderSaveResult>,
) {
  const [order, setOrder] = useState(initialIds);
  const confirmedRef = useRef(initialIds);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);

  const drop = useCallback(
    async (next: string[]) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setOrder(next); // shown right away; rolled back below if the save fails
      const result = await onSave(next, confirmedRef.current);
      savingRef.current = false;
      setSaving(false);
      if (result.ok) {
        confirmedRef.current = next;
      } else {
        setOrder(confirmedRef.current);
        Alert.alert('Order not saved', result.message);
      }
    },
    [onSave],
  );

  return { order, saving, drop };
}

function ReorderHeader({ title, saving, onDone }: { title: string; saving: boolean; onDone: () => void }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerText}>
        <Text style={styles.headerTitle}>{title}</Text>
        <Text style={styles.headerHint}>Press and hold, then drag to rearrange.</Text>
      </View>
      {/* Done waits for an in-flight save, so leaving never abandons one. */}
      <TouchableOpacity
        style={styles.doneButton}
        onPress={onDone}
        disabled={saving}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Done"
        accessibilityState={{ disabled: saving, busy: saving }}>
        {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.doneText}>Done</Text>}
      </TouchableOpacity>
    </View>
  );
}

type CommonProps = {
  // The entry that was long-pressed — outlined until the first drop.
  initialActiveId: string | null;
  onDone: () => void;
  onDragActiveChange: (active: boolean) => void;
  autoScroll: SortableListAutoScroll;
};

// ── Collections ─────────────────────────────────────────────────────────────
// The owner's top-level collections (the whole sibling group the
// Collection tab shows) as a vertical sortable list, in either view —
// Grid View's collections are full-width sections stacked one per row, so
// a vertical drag is the natural fit for both. Nested collections stay
// with their parent (they aren't shown here and never change parent).
export function ProfileV2ReorderCollections({
  folders,
  itemCounts,
  onSave,
  initialActiveId,
  onDone,
  onDragActiveChange,
  autoScroll,
}: CommonProps & {
  folders: Folder[];
  itemCounts: Record<string, number>;
  onSave: (next: string[], previous: string[]) => Promise<OrderSaveResult>;
}) {
  const initialIds = useMemo(() => folders.map((f) => f.id), [folders]);
  const { order, saving, drop } = useReorderState(initialIds, onSave);
  const [highlightId, setHighlightId] = useState(initialActiveId);
  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const ordered = order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const { coverSource } = useSignedFolderCovers(initialIds, COMPACT_IMAGE_TIER);

  return (
    <View>
      <ReorderHeader title="Reorder Collections" saving={saving} onDone={onDone} />
      <View style={styles.listInset}>
        <SortableList
          items={ordered}
          rowHeight={COLLECTION_ROW_HEIGHT}
          enabled={!saving}
          onReorder={(next) => {
            setHighlightId(null);
            drop(next);
          }}
          onDragActiveChange={onDragActiveChange}
          autoScroll={autoScroll}
          renderItem={(folder) => {
            const count = itemCounts[folder.id] ?? 0;
            return (
              <CollectionListRow
                folder={folder}
                cover={coverSource(folder)}
                subtitle={`${count} ${count === 1 ? 'item' : 'items'}`}
                highlighted={folder.id === highlightId}
              />
            );
          }}
        />
      </View>
    </View>
  );
}

// ── Items ───────────────────────────────────────────────────────────────────
// The owner's profile-wide item order: Grid View is the same 3-column grid
// (same cells, gaps and thumbnails) with Grails-style drag across rows and
// columns; List View is the same rows as a vertical sortable list.
export function ProfileV2ReorderItems({
  items,
  layout,
  ownerId,
  onSave,
  initialActiveId,
  onDone,
  onDragActiveChange,
  autoScroll,
  renderLimit,
}: CommonProps & {
  items: ListableItem[];
  layout: ProfileViewMode;
  ownerId: string;
  onSave: (next: string[], previous: string[]) => Promise<OrderSaveResult>;
  // How many entries are rendered (the Items tab's own window — grows as
  // the page scrolls toward the end). The full order is still held, so a
  // drop is saved against its true neighbours.
  renderLimit: number;
}) {
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const initialIds = useMemo(() => items.map((i) => i.id), [items]);
  const { order, saving, drop } = useReorderState(initialIds, onSave);
  const [highlightId, setHighlightId] = useState(initialActiveId);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  // Only the rendered window is draggable; the rest of the order is kept.
  const ordered = order.slice(0, renderLimit).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  // The same batched compact-tier URLs the Items grid/list already signed
  // for this window (shared cache) — nothing new, and never every image.
  const { urls, servedTiers } = useSignedItemImages(
    ordered.map((i) => i.primary_image_id),
    COMPACT_IMAGE_TIER,
  );
  const pathMap = useCollectionPathMap(ownerId, true, layout === 'list');

  // A drop reorders the window; the full order is that window followed by
  // every id it doesn't contain, in their existing order — so ids that
  // joined the window mid-drag (it grew while auto-scrolling) are kept too.
  const handleReorder = (nextWindow: string[]) => {
    setHighlightId(null);
    const inWindow = new Set(nextWindow);
    drop([...nextWindow, ...order.filter((id) => !inWindow.has(id))]);
  };
  const imageFor = (item: ListableItem) => {
    const imageId = item.primary_image_id;
    return {
      uri: imageId ? urls.get(imageId) : undefined,
      cacheKey: imageId ? itemImageCacheKey(identity, imageId, COMPACT_IMAGE_TIER, servedTiers) : undefined,
    };
  };

  return (
    <View>
      <ReorderHeader title="Reorder Items" saving={saving} onDone={onDone} />
      {layout === 'grid' ? (
        <View style={styles.gridInset}>
          <ShareCardDragGrid
            items={ordered}
            enabled={!saving}
            onReorder={handleReorder}
            onDragActiveChange={onDragActiveChange}
            cellWidth={CELL_WIDTH}
            cellHeight={CELL_HEIGHT}
            gap={GRID_GAP}
            columns={COLS}
            renderItem={(item) => {
              const image = imageFor(item);
              return (
                <View style={[styles.gridCell, item.id === highlightId && styles.gridCellHighlighted]}>
                  {image.uri ? (
                    <Image
                      source={{ uri: image.uri, cacheKey: image.cacheKey }}
                      style={StyleSheet.absoluteFill}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                    />
                  ) : null}
                </View>
              );
            }}
          />
        </View>
      ) : (
        <View style={styles.listInset}>
          <SortableList
            items={ordered}
            rowHeight={ITEM_ROW_HEIGHT}
            enabled={!saving}
            onReorder={handleReorder}
            onDragActiveChange={onDragActiveChange}
            autoScroll={autoScroll}
            renderItem={(item) => {
              const image = imageFor(item);
              return (
                <ProfileV2ItemRow
                  item={item}
                  imageUri={image.uri}
                  imageCacheKey={image.cacheKey}
                  context={pathMap?.get(item.folder_id)?.join(' › ') ?? null}
                  highlighted={item.id === highlightId}
                  trailing="bars"
                />
              );
            }}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 10,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  headerHint: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
  doneButton: {
    minWidth: 72,
    height: 34,
    paddingHorizontal: 16,
    borderRadius: 17,
    backgroundColor: PV2.actionPrimaryFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },
  // Same 16px inset as the Collection/Items List Views.
  listInset: {
    marginHorizontal: 16,
  },
  // Same edge-to-edge inset as the Items grid.
  gridInset: {
    marginHorizontal: GRID_HORIZONTAL_MARGIN,
  },
  gridCell: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: PV2.emptyCardBg,
  },
  gridCellHighlighted: {
    borderWidth: 2,
    borderColor: PV2.actionPrimary,
  },
});
