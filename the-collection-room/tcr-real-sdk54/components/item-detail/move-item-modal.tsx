import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { resolveCovers } from '@/hooks/use-collection';
import { useSignedFolderCovers } from '@/hooks/use-signed-folder-covers';
import { supabase } from '@/lib/supabase';
import type { CollectionItem, Folder } from '@/types';

// Flat, all-levels list of the caller's own folders + active item counts —
// deliberately a local, purpose-built hook rather than reusing
// hooks/use-collection.ts's useFolders (top-level-only, with a separate,
// more expensive child-folder preview shape this picker doesn't need).
// Mirrors app/grail-slot/pick-collection.tsx's useOwnFoldersForPicker: same
// "no parent_folder_id filter" (a destination can be any folder the owner
// has, category or leaf — this schema has no rule against items living in
// either), same one-batched-count-query shape, same requestId staleness
// guard.
function useOwnFoldersForMove(userId: string | undefined) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;

    if (!userId) {
      setFolders([]);
      setItemCounts({});
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase
        .from('folders')
        .select('*')
        .eq('user_id', userId)
        .order('name', { ascending: true });
      if (queryError) throw queryError;

      const resolved = await resolveCovers((data ?? []) as Folder[]);

      let counts: Record<string, number> = {};
      const folderIds = resolved.map((f) => f.id);
      if (folderIds.length) {
        const { data: rows, error: countError } = await supabase
          .from('collection_items')
          .select('folder_id')
          .eq('collection_status', 'active')
          .in('folder_id', folderIds);
        if (countError) throw countError;
        counts = {};
        for (const row of (rows ?? []) as { folder_id: string }[]) {
          counts[row.folder_id] = (counts[row.folder_id] ?? 0) + 1;
        }
      }

      if (requestIdRef.current !== requestId) return; // superseded — discard
      setFolders(resolved);
      setItemCounts(counts);
    } catch (e) {
      console.error('[MoveItemModal] folder load failed:', e);
      if (requestIdRef.current !== requestId) return;
      setError(e instanceof Error ? e.message : 'Failed to load your folders.');
      setFolders([]);
      setItemCounts({});
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
    };
  }, []);

  return { folders, itemCounts, loading, error, refresh: load };
}

type BaseProps = {
  visible: boolean;
  currentUserId: string | undefined;
  onClose: () => void;
};

type SingleModeProps = BaseProps & {
  mode: 'single';
  item: CollectionItem;
  // Called once move_collection_items has committed — the caller
  // (app/item/[id].tsx) owns updating its own `item` state (a plain local
  // folder_id patch; nothing else about the item changes on a move) and
  // showing the "Moved to <folder>" confirmation. Only the destination
  // folder id/name come back — not a full updated row, since this now
  // shares move_collection_items with bulk mode (see below), which only
  // ever returns a moved-row count, never full rows.
  onMoved: (destinationFolderId: string, folderName: string) => void;
};

type BulkModeProps = BaseProps & {
  mode: 'bulk';
  // Every id must already be known (by the caller) to live in
  // sourceFolderId and belong to the caller — this modal never trusts that
  // on its own either: the move_collection_items RPC re-validates both
  // server-side before moving anything (Phase 2's own security
  // requirement — never trust client-supplied item ids).
  itemIds: string[];
  sourceFolderId: string;
  // Called once the RPC has committed — movedCount is the RPC's own
  // authoritative row count, not just itemIds.length, though the two are
  // guaranteed equal on success (the RPC rejects the whole call otherwise).
  // The caller (app/collection/[folderId].tsx) owns exiting Select mode,
  // clearing selection, refreshing the folder, and showing the "Moved N
  // items" confirmation.
  onMoved: (movedCount: number, folderName: string) => void;
};

type Props = SingleModeProps | BulkModeProps;

// Phase 1 (single item) + Phase 2 (bulk) item move share this one picker —
// same folder list, same current-folder marking/disabling, same
// move-in-flight lock — so there is only ever one folder-picker design to
// maintain (Phase 2's own explicit preference). Bulk move still goes
// through a single server-side RPC transaction rather than N client
// updates — see move_collection_items in supabase/migrations — so this
// modal doesn't have to reconcile a partial-success state on its own.
export function MoveItemModal(props: Props) {
  const { visible, currentUserId, onClose } = props;
  const currentFolderId = props.mode === 'single' ? props.item.folder_id : props.sourceFolderId;
  const selectionCount = props.mode === 'single' ? 1 : props.itemIds.length;
  const title = props.mode === 'single' ? 'Move Item' : `Move ${selectionCount} ${selectionCount === 1 ? 'Item' : 'Items'}`;

  const { folders, itemCounts, loading, error, refresh } = useOwnFoldersForMove(
    visible ? currentUserId : undefined,
  );
  const { urls: signedCoverUrls } = useSignedFolderCovers(visible ? folders.map((f) => f.id) : []);

  // Re-entrancy lock for the move mutation itself — separate from `loading`
  // (folder list fetch) so a slow initial folder load can never be
  // mistaken for "a move is in flight," and a rapid double-tap on the same
  // (or a different) folder row while the first tap's request is still in
  // flight is a no-op rather than a second concurrent UPDATE/RPC call.
  const [movingFolderId, setMovingFolderId] = useState<string | null>(null);
  const movingRef = useRef(false);

  async function handleSelectFolder(folder: Folder) {
    if (folder.id === currentFolderId) return; // current/source folder — no-op
    if (movingRef.current) return;
    movingRef.current = true;
    setMovingFolderId(folder.id);

    try {
      // Single mode now shares the exact same RPC as bulk mode — a
      // 1-element array is just the trivial case of "N items." This is
      // what lets a single move get a correct, race-free "append at the
      // end of the destination folder" sort_order (see this feature's own
      // migration, 20260912120000_add_collection_item_manual_ordering.sql):
      // the previous raw client `.update({ folder_id })` had no safe way to
      // compute that without a separate read-then-write race, and adding a
      // second sort-order-assignment mechanism just for the single-item
      // path would mean two places to keep in sync instead of one.
      const itemIds = props.mode === 'single' ? [props.item.id] : props.itemIds;
      const sourceFolderId = props.mode === 'single' ? props.item.folder_id : props.sourceFolderId;

      // One atomic server-side transaction for the whole selection — see
      // move_collection_items's own migration comment for the
      // all-or-nothing guarantee and the source-folder re-check that
      // guards against a stale selection (an item moved/removed by
      // something else between selecting it here and confirming).
      const { data: movedCount, error: moveError } = await supabase.rpc('move_collection_items', {
        p_item_ids: itemIds,
        p_source_folder_id: sourceFolderId,
        p_destination_folder_id: folder.id,
      });

      if (moveError) throw new Error(moveError.message);

      if (props.mode === 'single') {
        props.onMoved(folder.id, folder.name);
      } else {
        props.onMoved(typeof movedCount === 'number' ? movedCount : itemIds.length, folder.name);
      }
    } catch (e) {
      // Picker stays open in both modes, selection state resets here — the
      // caller's own item/selection state is never touched on failure
      // (onMoved above is only ever called on confirmed success), so
      // there's nothing to roll back on this side either.
      Alert.alert('Move failed', e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      movingRef.current = false;
      setMovingFolderId(null);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={8} disabled={movingFolderId !== null}>
            <Text style={[styles.cancel, movingFolderId !== null && styles.cancelDisabled]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.title}>{title}</Text>
          <View style={styles.headerSpacer} />
        </View>

        {loading ? (
          <View style={styles.centerWrap}>
            <ActivityIndicator size="large" color={PV2.accent} />
          </View>
        ) : error ? (
          <View style={styles.centerWrap}>
            <Text style={styles.emptyTitle}>Couldn&apos;t load your folders</Text>
            <TouchableOpacity style={styles.retryButton} onPress={refresh} activeOpacity={0.8}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : folders.length === 0 ? (
          <View style={styles.centerWrap}>
            <Text style={styles.emptyTitle}>No other folders yet</Text>
            <Text style={styles.emptyBody}>Create another folder first to move this item into it.</Text>
          </View>
        ) : (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
            {folders.map((folder) => {
              const isCurrent = folder.id === currentFolderId;
              const isMovingThis = movingFolderId === folder.id;
              const rowDisabled = isCurrent || movingFolderId !== null;
              const count = itemCounts[folder.id] ?? 0;
              const coverUrl = signedCoverUrls.get(folder.id);
              return (
                <TouchableOpacity
                  key={folder.id}
                  style={[styles.row, isCurrent && styles.rowCurrent]}
                  onPress={() => handleSelectFolder(folder)}
                  disabled={rowDisabled}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: rowDisabled, selected: isCurrent }}
                  accessibilityLabel={isCurrent ? `${folder.name}, current folder` : folder.name}>
                  <View style={styles.cover}>
                    {coverUrl ? (
                      <Image source={{ uri: coverUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
                    ) : null}
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {folder.name}
                    </Text>
                    <Text style={styles.rowCount}>
                      {count} {count === 1 ? 'item' : 'items'}
                    </Text>
                  </View>
                  {isMovingThis ? (
                    <ActivityIndicator size="small" color={PV2.textSecondary} />
                  ) : isCurrent ? (
                    <View style={styles.currentBadge}>
                      <IconSymbol name="checkmark.circle.fill" size={15} color={PV2.accent} />
                      <Text style={styles.currentBadgeText}>Current</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  cancel: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  cancelDisabled: {
    color: PV2.textTertiary,
  },
  headerSpacer: {
    minWidth: 50,
  },
  scroll: {
    flex: 1,
  },
  list: {
    padding: 16,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PV2.border,
    borderRadius: 12,
    padding: 10,
  },
  rowCurrent: {
    borderColor: PV2.accent,
    opacity: 0.75,
  },
  cover: {
    width: 44,
    height: 44,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: PV2.emptyCardBg,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  rowCount: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  currentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  currentBadgeText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.accent,
  },
  centerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 14,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  retryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
});
