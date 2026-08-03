import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { CollectionPreviewCard } from '@/components/collection/collection-preview-card';
import { CreateFolderModal } from '@/components/collection/create-folder-modal';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { resolveCovers } from '@/hooks/use-collection';
import { supabase } from '@/lib/supabase';
import type { Folder } from '@/types';

const NUM_COLUMNS = 3;
const GRID_GAP = 10;
const HORIZONTAL_PADDING = 16;

// Own-folders-only fetch with real error/retry state — modeled directly on
// app/grail-slot/pick-collection.tsx's useOwnFoldersForPicker (that
// screen's own comment explains why: hooks/use-collection.ts's useFolders()
// discards query errors, and a picker needs to distinguish "empty" from
// "failed to load"). Request-id guarded so a slower, superseded request
// (a fast refresh() landing after a newer one, or unmount) can never
// commit stale state. `userId` is always the caller's own authenticated
// session id (see ClaimFolderPicker's own comment below) — the query
// itself is scoped to it, and folders' own RLS
// (folders_select_own-equivalent) independently protects it regardless.
function useOwnFoldersForClaimPicker(userId: string | undefined) {
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
        .order('created_at', { ascending: false });
      if (queryError) throw queryError;

      // resolveCovers only enriches cover_image_url on the rows it's given
      // (for cover_source='first_card' folders, via one batched
      // collection_items query scoped to exactly these folder ids) — it
      // never fetches additional folders and cannot broaden this already
      // owner-filtered set.
      const resolved = await resolveCovers((data ?? []) as Folder[]);
      const sorted = resolved.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      // One batched query for every visible folder's item count — not one
      // query per folder — scoped via .in('folder_id', folderIds) to
      // exactly this owner-filtered set, so it can never include another
      // user's folder's count.
      let counts: Record<string, number> = {};
      const folderIds = sorted.map((f) => f.id);
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
      setFolders(sorted);
      setItemCounts(counts);
    } catch (e) {
      if (__DEV__) console.error('[ClaimFolderPicker] load failed:', e);
      if (requestIdRef.current !== requestId) return;
      // Generic message only — the raw Supabase error is never shown in
      // the UI, only logged (and only in dev).
      setError('Failed to load your folders.');
      setFolders([]);
      setItemCounts({});
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  // Unmount cleanup — bumps requestIdRef so an in-flight request that
  // resolves after this hook's owner has unmounted can never match
  // requestId anymore, and its success/error/finally branches all become
  // no-ops instead of calling setState on an unmounted component.
  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
    };
  }, []);

  return { folders, itemCounts, loading, error, refresh: load };
}

type Props = {
  // Always the active session's own id (session.user.id), passed down by
  // app/claim-card/[id].tsx — never a route param, never
  // registered_cards.current_owner_id, never any other profile's id. Even
  // if it somehow were, folders' own RLS and the eventual
  // claim_registered_card RPC's own folder-ownership check both
  // independently re-verify this — this component's own filtering is not
  // the only thing standing between a caller and another user's folders.
  userId: string;
  onSelect: (folder: Folder) => void;
};

// Dedicated own-folder picker for the recipient claim flow — embedded as a
// component (not a separate route) inside app/claim-card/[id].tsx's own
// two-step local state, the same shape already used for the Ownership
// Transfer recipient picker (components/registry/transfer-recipient-picker.tsx)
// inside the registry Transfer modal.
export function ClaimFolderPicker({ userId, onSelect }: Props) {
  const { folders, itemCounts, loading, error, refresh } = useOwnFoldersForClaimPicker(userId);
  const { width: windowWidth } = useWindowDimensions();
  const tileWidth = (windowWidth - HORIZONTAL_PADDING * 2 - GRID_GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS;
  const [isCreateFolderVisible, setIsCreateFolderVisible] = useState(false);

  function handleFolderCreated() {
    setIsCreateFolderVisible(false);
    refresh();
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.title}>Choose a Folder</Text>
        <Pressable
          onPress={() => setIsCreateFolderVisible(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Create a new folder">
          <Text style={styles.createLink}>New Folder</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.stateWrap}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      ) : error ? (
        <View style={styles.stateWrap}>
          <Text style={styles.errorText}>Couldn&apos;t load your folders.</Text>
          <Pressable
            onPress={refresh}
            style={styles.retryButton}
            accessibilityRole="button"
            accessibilityLabel="Retry loading folders">
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : folders.length === 0 ? (
        <View style={styles.stateWrap}>
          <Text style={styles.emptyText}>You don&apos;t have any folders yet.</Text>
          <Pressable
            onPress={() => setIsCreateFolderVisible(true)}
            style={styles.retryButton}
            accessibilityRole="button"
            accessibilityLabel="Create your first folder">
            <Text style={styles.retryButtonText}>Create a Folder</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.grid}>
          {folders.map((folder) => (
            // CollectionPreviewCard's own accessibilityLabel defaults to
            // its `title` prop (see components/collection/
            // collection-preview-card.tsx) — passing the folder's real
            // name here already gives every tile a meaningful,
            // folder-specific selection label (e.g. "Baseball"), not the
            // component's generic "Collection item" fallback.
            <CollectionPreviewCard
              key={folder.id}
              imageUrl={folder.cover_image_url}
              title={folder.name}
              subtitle={`${itemCounts[folder.id] ?? 0} items`}
              tileWidth={tileWidth}
              onPress={() => onSelect(folder)}
            />
          ))}
        </View>
      )}

      <CreateFolderModal
        visible={isCreateFolderVisible}
        userId={userId}
        onClose={() => setIsCreateFolderVisible(false)}
        onCreated={handleFolderCreated}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: HORIZONTAL_PADDING,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
  },
  createLink: {
    fontSize: 13,
    fontWeight: '700',
    color: PV2.link,
  },
  stateWrap: {
    paddingVertical: 32,
    alignItems: 'center',
    gap: 12,
  },
  errorText: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
  emptyText: {
    fontSize: 13,
    color: PV2.textTertiary,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 18,
  },
  retryButtonText: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
});
