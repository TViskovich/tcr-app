import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CollectionPreviewCard } from '@/components/collection/collection-preview-card';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { resolveCovers } from '@/hooks/use-collection';
import { insertGrailSlot, replaceGrailSlot, useGrailSlots } from '@/hooks/use-grail-slots';
import { parseGrailChooserParams, type RawGrailChooserParams } from '@/lib/grail-chooser-target';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { Folder } from '@/types';

const NUM_COLUMNS = 3;
const GRID_GAP = 10;
const HORIZONTAL_PADDING = 16;

// hooks/use-collection.ts's useFolders() doesn't surface query errors
// (its own `const { data } = await query` discards them), and this
// picker needs a real error+retry state — a local fetch instead of
// modifying that shared hook. Owner-scoped only (no publicOnly option;
// this screen only ever runs for the signed-in user managing their own
// Grails). Reuses resolveCovers (already exported, not hook-specific) so
// cover_source:'first_card' folders still resolve correctly.
function useOwnFoldersForPicker(userId: string | undefined) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slower, superseded request (e.g. a fast refresh()
  // call landing before an earlier one's response arrives, or the
  // component unmounting mid-flight) committing stale state after a
  // newer request has already started, finished, or the component is
  // gone.
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

      const resolved = await resolveCovers((data ?? []) as Folder[]);
      const sorted = resolved.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

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
      console.error('[pick-collection] load failed:', e);
      if (requestIdRef.current !== requestId) return;
      setError(e instanceof Error ? e.message : 'Failed to load collections.');
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

// Collection Grail slot picker. Folders are flat in this schema (no
// parent_folder_id / hierarchy column exists anywhere) — every folder
// returned here is equally selectable, there is no parent-vs-child
// distinction to make.
export default function PickGrailCollectionScreen() {
  const router = useRouter();
  const rawParams = useLocalSearchParams<RawGrailChooserParams>();
  // Deliberately depends on rawParams' individual fields, not the whole
  // object — useLocalSearchParams() returns a new object reference every
  // render, so depending on it directly would recompute (and re-run the
  // invalid-target check below) on every render regardless of whether
  // any actual param value changed.
  const target = useMemo(
    () => parseGrailChooserParams(rawParams),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawParams.slotIndex, rawParams.mode, rawParams.expectedSlotId, rawParams.expectedEntryType, rawParams.expectedRefId],
  );

  const hasShownInvalidAlertRef = useRef(false);
  useEffect(() => {
    if (target || hasShownInvalidAlertRef.current) return;
    hasShownInvalidAlertRef.current = true;
    Alert.alert('Invalid Grail Slot', undefined, [
      { text: 'OK', onPress: () => (router.canGoBack() ? router.back() : router.replace('/')) },
    ]);
  }, [target, router]);

  const { session, loading: authLoading } = useAuth();
  const currentUserId = session?.user?.id;

  const {
    folders,
    itemCounts,
    loading: foldersLoading,
    error: foldersError,
    refresh: refreshFolders,
  } = useOwnFoldersForPicker(target ? currentUserId : undefined);
  const {
    slots: grailSlots,
    loading: slotsLoading,
    error: slotsError,
    refresh: refreshSlots,
  } = useGrailSlots(target ? currentUserId : undefined);

  const dataLoading = foldersLoading || slotsLoading;
  const dataError = foldersError ?? slotsError;

  function retryAll() {
    refreshFolders();
    refreshSlots();
  }

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const tileWidth = (windowWidth - HORIZONTAL_PADDING * 2 - GRID_GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS;

  // Every folder currently occupying ANY Grail slot — including this
  // exact replace target's current occupant. No `as string` — collection_id
  // is narrowed by the type-guard filter, not cast.
  const assignedElsewhere = useMemo(
    () =>
      new Set(
        grailSlots
          .filter((s) => s.entry_type === 'collection')
          .map((s) => s.collection_id)
          .filter((id): id is string => id !== null),
      ),
    [grailSlots],
  );

  // Same staleness guard as the item picker — clears the selection if the
  // folder disappears or becomes assigned to a different slot while this
  // screen sits open.
  useEffect(() => {
    if (!selectedId) return;
    const stillExists = folders.some((f) => f.id === selectedId);
    if (!stillExists || assignedElsewhere.has(selectedId)) {
      setSelectedId(null);
    }
  }, [folders, assignedElsewhere, selectedId]);

  function toggleSelect(id: string) {
    if (assignedElsewhere.has(id)) return;
    setSelectedId((prev) => (prev === id ? null : id));
  }

  function leaveScreen() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  async function handleConfirm() {
    if (!target || !currentUserId || !selectedId || saving) return;
    setSaving(true);
    try {
      if (target.mode === 'add') {
        const { error: saveError, conflict } = await insertGrailSlot(currentUserId, target.slotIndex, 'collection', selectedId);
        if (saveError) {
          if (conflict === 'duplicate_source') {
            Alert.alert('Already in Grails', 'This collection is already in another Grail slot.');
          } else if (conflict === 'slot_conflict') {
            Alert.alert('Try Again', 'That Grail slot changed. Please try again.');
          } else {
            Alert.alert('Save Failed', 'Something went wrong. Please try again.');
          }
          return;
        }
        leaveScreen();
        return;
      }

      const { error: saveError, conflict } = await replaceGrailSlot(
        currentUserId,
        {
          slotIndex: target.slotIndex,
          expectedSlotId: target.expectedSlotId,
          expectedEntryType: target.expectedEntryType,
          expectedRefId: target.expectedRefId,
        },
        'collection',
        selectedId,
      );
      if (saveError) {
        if (conflict === 'duplicate_source') {
          Alert.alert('Already in Grails', 'This collection is already in another Grail slot.');
        } else if (conflict === 'slot_conflict') {
          Alert.alert(
            'Try Again',
            'The original Grail slot changed. Please go back and try again.',
            [{ text: 'OK', onPress: leaveScreen }],
          );
        } else {
          Alert.alert('Save Failed', 'Something went wrong. Please try again.');
        }
        return;
      }
      leaveScreen();
    } finally {
      setSaving(false);
    }
  }

  const canConfirm =
    selectedId !== null &&
    !saving &&
    !authLoading &&
    !!currentUserId &&
    !dataLoading &&
    !dataError &&
    !assignedElsewhere.has(selectedId);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={[styles.headerTop, { paddingTop: insets.top ? 4 : 10 }]}>
          <Pressable onPress={leaveScreen} hitSlop={12} style={styles.iconBtn}>
            <IconSymbol name="chevron.left" size={26} color={PV2.textPrimary} />
          </Pressable>
          <Text style={styles.headerTitle}>{target?.mode === 'replace' ? 'Replace Collection' : 'Choose Collection'}</Text>
          <TouchableOpacity onPress={handleConfirm} disabled={!canConfirm} hitSlop={12}>
            {saving ? (
              <ActivityIndicator size="small" color={PV2.accent} />
            ) : (
              <Text style={[styles.headerSave, !canConfirm && styles.headerSaveDisabled]}>Save</Text>
            )}
          </TouchableOpacity>
        </View>

        {!target ? null : authLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={PV2.accent} />
          </View>
        ) : !currentUserId ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>Sign in required</Text>
            <Text style={styles.emptyBody}>You need to be signed in to manage your Grails.</Text>
          </View>
        ) : dataLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={PV2.accent} />
          </View>
        ) : dataError ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>Couldn&apos;t load your collections</Text>
            <TouchableOpacity style={styles.retryButton} onPress={retryAll} activeOpacity={0.8}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : folders.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>No collections yet</Text>
            <Text style={styles.emptyBody}>Create a folder in your collection first.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.grid}>
            {folders.map((folder) => {
              const disabled = assignedElsewhere.has(folder.id);
              const selected = selectedId === folder.id;
              const count = itemCounts[folder.id] ?? 0;
              return (
                <View key={folder.id} style={{ width: tileWidth }}>
                  <View style={disabled ? styles.tileDisabled : undefined} pointerEvents={disabled ? 'none' : 'auto'}>
                    <CollectionPreviewCard
                      imageUrl={folder.cover_image_url}
                      title={folder.name}
                      subtitle={disabled ? 'In Grails' : `${count} ${count === 1 ? 'item' : 'items'}`}
                      tileWidth={tileWidth}
                      onPress={() => toggleSelect(folder.id)}
                    />
                  </View>
                  {selected && <View style={styles.selectedRing} pointerEvents="none" />}
                </View>
              );
            })}
          </ScrollView>
        )}
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  headerSave: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.accent,
  },
  headerSaveDisabled: {
    color: PV2.textTertiary,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
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
  grid: {
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingTop: 4,
    paddingBottom: 32,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  tileDisabled: {
    opacity: 0.35,
  },
  selectedRing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 12,
    borderWidth: 3,
    borderColor: PV2.accent,
  },
});
