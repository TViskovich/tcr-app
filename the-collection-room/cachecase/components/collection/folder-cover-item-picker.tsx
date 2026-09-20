import { Image } from 'expo-image';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import type { CollectionItem } from '@/types';

// 3-column grid math for this picker's slots. Both width AND height are
// computed explicitly here (see slotWidth/slotHeight in the component
// below) — aspectRatio-based sizing (first with a percentage width, then
// with an explicit numeric width) measured height: 0 at runtime for every
// tile in this Modal/grid combination. Computing height directly removes
// the dependency on aspectRatio resolving at all.
const PICKER_NUM_COLUMNS = 3;
const PICKER_GRID_PADDING = 12;
const PICKER_GRID_GAP = 2;
const PICKER_SLOT_ASPECT_RATIO = 5 / 7; // width / height

type Props = {
  visible: boolean;
  onClose: () => void;
  // Passed straight through from the folder-detail screen's own already-
  // loaded item list and its own useSignedItemImages() map — this picker
  // fetches nothing of its own, so a folder's items and their signed
  // covers are only ever resolved once, by the screen that already needed
  // them anyway.
  items: CollectionItem[];
  signedUrls: Map<string, string>;
  onSelect: (item: CollectionItem) => void;
};

// Single-select grid for "Choose from Folder" (folder-cover-menu.tsx) — one
// tap picks that item as the folder's cover and closes. Deliberately not a
// multi-select/confirm flow like app/share-card/new.tsx's picker: there is
// only ever one folder cover at a time.
export function FolderCoverItemPicker({ visible, onClose, items, signedUrls, onSelect }: Props) {
  // Eligible = has a primary image at all — never has meant "already
  // resolved in signedUrls." An item whose signed URL just hasn't come
  // back yet still belongs in the grid (with the normal loading/fallback
  // background below, same as the folder detail grid's own thumbPlaceholder
  // convention), not silently dropped until it happens to resolve.
  const eligibleItems = items.filter((i) => !!i.primary_image_id);

  const { width: windowWidth } = useWindowDimensions();
  const slotWidth =
    (windowWidth - PICKER_GRID_PADDING * 2 - PICKER_GRID_GAP * (PICKER_NUM_COLUMNS - 1)) / PICKER_NUM_COLUMNS;
  const slotHeight = slotWidth / PICKER_SLOT_ASPECT_RATIO;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <Text style={styles.cancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Choose from Folder</Text>
          <View style={styles.headerSpacer} />
        </View>

        {eligibleItems.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No card photos yet</Text>
            <Text style={styles.emptyBody}>Add a photo to a card in this collection first.</Text>
          </View>
        ) : (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.grid}>
            {eligibleItems.map((item) => {
              const url = signedUrls.get(item.primary_image_id!);
              return (
                <Pressable
                  key={item.id}
                  style={[styles.slot, { width: slotWidth, height: slotHeight }]}
                  onPress={() => onSelect(item)}
                  accessibilityRole="button"
                  accessibilityLabel={item.title ?? item.player ?? 'Card'}>
                  {url ? (
                    <Image source={{ uri: url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
                  ) : (
                    <View style={styles.slotLoading} />
                  )}
                </Pressable>
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
  // Balances the Cancel label on the left so the centered title stays
  // visually centered rather than skewed toward one side.
  headerSpacer: {
    minWidth: 50,
  },
  scroll: {
    flex: 1,
  },
  grid: {
    padding: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
  },
  // width AND height are both applied inline per-render (see
  // slotWidth/slotHeight above) — no aspectRatio here. See this file's
  // module comment for why aspectRatio was removed rather than combined
  // with an explicit dimension.
  slot: {
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  // Shown for an eligible item whose signed URL hasn't resolved yet — same
  // "just the tile's own dark surface, nothing else" convention as
  // app/collection/[folderId].tsx's own thumbPlaceholder for the exact
  // same not-yet-resolved state.
  slotLoading: {
    ...StyleSheet.absoluteFill,
    backgroundColor: PV2.collectorPanelBg,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  emptyBody: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
});
