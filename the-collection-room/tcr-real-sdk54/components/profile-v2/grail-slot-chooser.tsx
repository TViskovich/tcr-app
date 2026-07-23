import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useRouter } from 'expo-router';

import { IconSymbol } from '@/components/ui/icon-symbol';
import type { GrailChooserTarget } from '@/types';

type Props = {
  target: GrailChooserTarget | null;
  onClose: () => void;
};

function paramsFor(target: GrailChooserTarget) {
  if (target.mode === 'replace') {
    return {
      slotIndex: String(target.slotIndex),
      mode: target.mode,
      expectedSlotId: target.expectedSlotId,
      expectedEntryType: target.expectedEntryType,
      expectedRefId: target.expectedRefId,
    };
  }
  return {
    slotIndex: String(target.slotIndex),
    mode: target.mode,
  };
}

// The "Add to Grails" sheet — Single Item / Collection. Purely a router,
// no data fetching or writes of its own: forwards target's slotIndex/
// mode/expected* fields straight through to whichever picker route the
// user taps, as plain string route params (lib/grail-chooser-target.ts's
// parseGrailChooserParams is what re-validates and re-narrows them on
// the picker side — this component doesn't assume the picker will trust
// them). Mirrors components/create/create-menu.tsx's Modal sheet
// shell/styling exactly.
export function GrailSlotChooser({ target, onClose }: Props) {
  const router = useRouter();
  const visible = target !== null;

  function openItemPicker() {
    if (!target) return;
    onClose();
    router.push({ pathname: '/grail-slot/pick-item', params: paramsFor(target) });
  }

  function openCollectionPicker() {
    if (!target) return;
    onClose();
    router.push({ pathname: '/grail-slot/pick-collection', params: paramsFor(target) });
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent>
      <View style={styles.backdrop}>
        {/* Tapping outside the sheet dismisses it */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View style={styles.sheet}>
          {/* Drag handle */}
          <View style={styles.handle} />

          <Text style={styles.title}>{target?.mode === 'replace' ? 'Replace Grail Slot' : 'Add to Grails'}</Text>

          <TouchableOpacity style={styles.row} onPress={openItemPicker} activeOpacity={0.65}>
            <View style={styles.iconWrap}>
              <IconSymbol name="rectangle.stack.fill" size={20} color="#FFFFFF" />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Single Item</Text>
              <Text style={styles.rowSubtitle}>Pick one card from your collection</Text>
            </View>
            <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity style={styles.row} onPress={openCollectionPicker} activeOpacity={0.65}>
            <View style={styles.iconWrap}>
              <IconSymbol name="folder.fill" size={20} color="#FFFFFF" />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Collection</Text>
              <Text style={styles.rowSubtitle}>Showcase a whole folder</Text>
            </View>
            <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />
          </TouchableOpacity>

          {/* Bottom safe-area spacer */}
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
    marginBottom: 20,
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.40)',
    letterSpacing: 1.0,
    textTransform: 'uppercase',
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
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  rowSubtitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.50)',
  },
  bottomSpacer: {
    height: 36,
  },
});
