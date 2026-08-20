import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useAllItems } from '@/hooks/use-collection';
import { insertGrailSlot, replaceGrailSlot, useGrailSlots } from '@/hooks/use-grail-slots';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { parseGrailChooserParams, type RawGrailChooserParams } from '@/lib/grail-chooser-target';
import { useAuth } from '@/lib/auth';

const NUM_COLUMNS = 3;
const GRID_GAP = 10;
const HORIZONTAL_PADDING = 16;

// Single-item Grail slot picker — reached only via GrailSlotChooser, which
// forwards target.mode/slotIndex/expected* as route params. This screen
// re-validates every one of them (never trusts the chooser alone) via
// parseGrailChooserParams before anything else runs.
export default function PickGrailItemScreen() {
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

  // Gated on `target` (not just currentUserId) via each hook's own
  // "if (!userId) { ...; return; }" guard — an invalid target, or auth
  // not yet resolved to a real user, makes the argument undefined, so
  // neither query ever fires.
  const {
    items,
    loading: itemsLoading,
    error: itemsError,
    refresh: refreshItems,
  } = useAllItems(target ? currentUserId : undefined);
  const {
    slots: grailSlots,
    loading: slotsLoading,
    error: slotsError,
    refresh: refreshSlots,
  } = useGrailSlots(target ? currentUserId : undefined);

  const dataLoading = itemsLoading || slotsLoading;
  const dataError = itemsError ?? slotsError;
  // One batched call for every item currently rendered in this picker.
  const { urls: signedImageUrls } = useSignedItemImages(items.map((i) => i.primary_image_id));

  function retryAll() {
    refreshItems();
    refreshSlots();
  }

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const tileWidth = (windowWidth - HORIZONTAL_PADDING * 2 - GRID_GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS;

  // Every item currently occupying ANY Grail slot — including the one
  // this exact replace target already holds. Covers both "already
  // assigned to a different slot" and "already the current occupant of
  // this slot" with one rule instead of two. No `as string` — item_id is
  // narrowed by the type-guard filter below, not cast.
  const assignedElsewhere = useMemo(
    () =>
      new Set(
        grailSlots
          .filter((s) => s.entry_type === 'item')
          .map((s) => s.item_id)
          .filter((id): id is string => id !== null),
      ),
    [grailSlots],
  );

  // A selection can go stale between being made and being confirmed — the
  // item could vanish from the list (deleted elsewhere) or become
  // assigned to a different slot (a concurrent write) while this screen
  // sits open. Clears it rather than letting Save act on a choice that no
  // longer reflects reality.
  useEffect(() => {
    if (!selectedId) return;
    const stillExists = items.some((i) => i.id === selectedId);
    if (!stillExists || assignedElsewhere.has(selectedId)) {
      setSelectedId(null);
    }
  }, [items, assignedElsewhere, selectedId]);

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
        const { error: saveError, conflict } = await insertGrailSlot(currentUserId, target.slotIndex, 'item', selectedId);
        if (saveError) {
          if (conflict === 'duplicate_source') {
            Alert.alert('Already in Grails', 'This item is already in another Grail slot.');
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

      // target.mode === 'replace' — one conditional UPDATE, no pre-read.
      const { error: saveError, conflict } = await replaceGrailSlot(
        currentUserId,
        {
          slotIndex: target.slotIndex,
          expectedSlotId: target.expectedSlotId,
          expectedEntryType: target.expectedEntryType,
          expectedRefId: target.expectedRefId,
        },
        'item',
        selectedId,
      );
      if (saveError) {
        if (conflict === 'duplicate_source') {
          Alert.alert('Already in Grails', 'This item is already in another Grail slot.');
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
          <Text style={styles.headerTitle}>{target?.mode === 'replace' ? 'Replace Item' : 'Choose Item'}</Text>
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
            <Text style={styles.emptyTitle}>Couldn&apos;t load your collection</Text>
            <TouchableOpacity style={styles.retryButton} onPress={retryAll} activeOpacity={0.8}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>No items yet</Text>
            <Text style={styles.emptyBody}>Add cards to your collection first.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.grid}>
            {items.map((item) => {
              const disabled = assignedElsewhere.has(item.id);
              const selected = selectedId === item.id;
              return (
                <View key={item.id} style={{ width: tileWidth }}>
                  <View style={disabled ? styles.tileDisabled : undefined} pointerEvents={disabled ? 'none' : 'auto'}>
                    <CollectionPreviewCard
                      imageUrl={item.primary_image_id ? (signedImageUrls.get(item.primary_image_id) ?? null) : null}
                      title={item.title}
                      subtitle={disabled ? 'In Grails' : item.brand}
                      tileWidth={tileWidth}
                      onPress={() => toggleSelect(item.id)}
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
