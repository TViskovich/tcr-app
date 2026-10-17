import { useState } from 'react';
import { ActivityIndicator, Alert, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { SafeAreaView } from 'react-native-safe-area-context';

import { ProfileV2Grid } from '@/components/profile-v2/profile-v2-grid';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { type ExpectedGrailSlot, expectedRefIdForSlot, useGrailSlots } from '@/hooks/use-grail-slots';
import type { GrailSlot } from '@/types';

type Props = {
  visible: boolean;
  userId: string;
  // Label for the confirmation ("Replace … with <itemLabel>?").
  itemLabel: string;
  onClose: () => void;
  // Performs the replacement (useItemGrailMembership.replaceGrail); resolves
  // true on success. Failures are reported by it; the sheet stays open.
  onReplace: (expected: ExpectedGrailSlot) => Promise<boolean>;
};

const noop = () => {};

function slotLabel(slot: GrailSlot): string {
  if (slot.entry_type === 'collection') return slot.collection?.name ? `the “${slot.collection.name}” collection` : 'this collection';
  const title = slot.item?.title ?? slot.item?.player;
  return title ? `“${title}”` : 'this Grail';
}

// "Replace a Grail" from Item Detail when all 9 slots are full: the owner's
// own 3×3 Grails grid, exactly as Profile renders it (ProfileV2Grid — same
// thumbnails, collection previews and slot positions), in its tap-to-select
// mode with no rank badges. Tapping a slot asks for confirmation, then
// replaces that one slot with the current item. Long-press menus and
// navigation are off here.
export function ReplaceGrailSheet({ visible, ...rest }: Props) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={rest.onClose}>
      {/* Mounted only while open, so the full Grails payload (items,
          collections, preview images) loads on demand — never on a plain
          Item Detail open, which keeps using the lightweight slot query. */}
      {visible && <ReplaceGrailSheetBody {...rest} />}
    </Modal>
  );
}

function ReplaceGrailSheetBody({ userId, itemLabel, onClose, onReplace }: Omit<Props, 'visible'>) {
  const { slots, loading, error, refresh } = useGrailSlots(userId);
  const [replacingSlotId, setReplacingSlotId] = useState<string | null>(null);

  function handleSelect(slotId: string) {
    if (replacingSlotId) return;
    const slot = slots.find((s) => s.id === slotId);
    const expectedRefId = slot ? expectedRefIdForSlot(slot) : null;
    if (!slot || !expectedRefId) return;
    Alert.alert('Replace this Grail?', `${slotLabel(slot)} will be replaced with ${itemLabel}. It stays in its collection.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Replace',
        onPress: async () => {
          setReplacingSlotId(slot.id);
          const ok = await onReplace({
            slotIndex: slot.slot_index,
            expectedSlotId: slot.id,
            expectedEntryType: slot.entry_type,
            expectedRefId,
          });
          setReplacingSlotId(null);
          if (ok) onClose();
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} hitSlop={8} disabled={!!replacingSlotId}>
          <Text style={[styles.cancel, !!replacingSlotId && styles.cancelDisabled]}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Replace a Grail</Text>
        <View style={styles.headerSpacer} />
      </View>

      <Text style={styles.hint}>Tap the Grail to swap out. The one you replace stays in its collection.</Text>

      <View pointerEvents={replacingSlotId ? 'none' : 'auto'}>
        <ProfileV2Grid
          slots={slots}
          loading={loading}
          error={error}
          onRetry={refresh}
          isOwnProfile
          onPressEmpty={noop}
          onPressItem={noop}
          onPressCollection={noop}
          onReplace={noop}
          onRemove={noop}
          reorderMode
          rankedSlotIds={[]}
          onToggleRank={handleSelect}
        />
        {replacingSlotId && (
          <View style={styles.savingOverlay}>
            <ActivityIndicator color={PV2.textPrimary} />
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

// Header matches components/item-detail/move-item-modal.tsx.
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
  hint: {
    fontSize: 14,
    color: PV2.textSecondary,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 14,
  },
  savingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
});
