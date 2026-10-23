import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { IconSymbol } from '@/components/ui/icon-symbol';
import type { GrailSlot } from '@/types';

import { PV2 } from './profile-v2-theme';

type Props = {
  // The tapped Grail, or null when the menu is closed.
  slot: GrailSlot | null;
  onReplace: (slot: GrailSlot) => void;
  onRemove: (slot: GrailSlot) => void;
  // Backdrop, Cancel, or the system back gesture — nothing changes.
  onClose: () => void;
  // iOS only (RN Modal's onDismiss): the close animation has finished — the
  // caller runs a chosen action from here (see chooseGrailAction).
  onDismiss?: () => void;
};

// Grails Edit Mode's per-Grail menu (owner only), opened by TAPPING a Grail
// in the drag grid — so Replace / Remove are discoverable without knowing a
// hidden gesture. Same sheet treatment as the app's other bottom menus
// (RepostMenu, AddPhotoMenu): dark #161616 sheet, handle, icon rows, Cancel.
// Picking a row is the caller's job to act on (and to close the sheet).
export function GrailActionMenu({ slot, onReplace, onRemove, onClose, onDismiss }: Props) {
  const kind = slot?.entry_type === 'collection' ? 'collection' : 'item';
  const name = slot?.entry_type === 'collection' ? slot.collection?.name : slot?.item?.title;

  return (
    <Modal
      visible={!!slot}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={onDismiss}
      statusBarTranslucent>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />

        <View style={styles.sheet}>
          <View style={styles.handle} />
          {!!name && (
            <Text style={styles.heading} numberOfLines={1}>
              {name}
            </Text>
          )}

          <TouchableOpacity
            style={styles.row}
            onPress={() => slot && onReplace(slot)}
            activeOpacity={0.65}
            accessibilityRole="button">
            <View style={styles.iconWrap}>
              <IconSymbol name="arrow.2.squarepath" size={20} color="#FFFFFF" />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Replace Grail</Text>
              <Text style={styles.rowSubtitle}>Feature a different item or collection here</Text>
            </View>
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.row}
            onPress={() => slot && onRemove(slot)}
            activeOpacity={0.65}
            accessibilityRole="button">
            <View style={[styles.iconWrap, styles.iconWrapDestructive]}>
              <IconSymbol name="minus.circle" size={20} color={PV2.statusNegative} />
            </View>
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, styles.rowTitleDestructive]}>Remove from Grails</Text>
              <Text style={styles.rowSubtitle}>Your {kind} itself won’t be deleted</Text>
            </View>
          </TouchableOpacity>

          <View style={styles.divider} />
          <TouchableOpacity style={styles.cancelRow} onPress={onClose} activeOpacity={0.65} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>

          <View style={styles.bottomSpacer} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#161616',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 12,
    paddingHorizontal: 20,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignSelf: 'center',
    marginBottom: 14,
  },
  heading: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.50)',
    textAlign: 'center',
    marginBottom: 6,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    gap: 14,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 11,
    backgroundColor: '#0a7ea4',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconWrapDestructive: {
    backgroundColor: 'rgba(255,59,48,0.14)',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  rowTitleDestructive: {
    color: PV2.statusNegative,
  },
  rowSubtitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.50)',
  },
  cancelRow: {
    paddingVertical: 15,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.75)',
  },
  bottomSpacer: {
    height: 20,
  },
});
