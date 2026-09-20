import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { IconSymbol } from '@/components/ui/icon-symbol';

type Props = {
  visible: boolean;
  onClose: () => void;
  onChooseFromLibrary: () => void;
  onChooseFromMyItems: () => void;
};

// Post composer's "Add Photo" source chooser (app/post/new.tsx) — same
// bottom-sheet shell shape (backdrop dismiss, drag handle, divided icon
// rows) as components/collection/folder-cover-menu.tsx and
// components/create/create-menu.tsx, kept as its own small component
// since these two options (plus the explicit Cancel row below) are
// specific to picking a post attachment. Tapping the backdrop already
// dismisses this like every other sheet in the app; the Cancel row is
// additionally rendered because the source spec for this feature calls it
// out as one of the three presented options explicitly.
export function AddPhotoMenu({ visible, onClose, onChooseFromLibrary, onChooseFromMyItems }: Props) {
  const OPTIONS: { id: string; icon: 'camera.fill' | 'rectangle.stack.fill'; title: string; subtitle: string; onSelect: () => void }[] = [
    {
      id: 'library',
      icon: 'camera.fill',
      title: 'Choose from Library',
      subtitle: 'Pick photos from your device',
      onSelect: onChooseFromLibrary,
    },
    {
      id: 'items',
      icon: 'rectangle.stack.fill',
      title: 'Choose from My Items',
      subtitle: 'Use photos from your collection',
      onSelect: onChooseFromMyItems,
    },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          <Text style={styles.title}>Add Photo</Text>

          {OPTIONS.map((option, index) => (
            <View key={option.id}>
              {index > 0 && <View style={styles.divider} />}
              <TouchableOpacity style={styles.row} onPress={option.onSelect} activeOpacity={0.65}>
                <View style={styles.iconWrap}>
                  <IconSymbol name={option.icon} size={20} color="#FFFFFF" />
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{option.title}</Text>
                  <Text style={styles.rowSubtitle}>{option.subtitle}</Text>
                </View>
                <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />
              </TouchableOpacity>
            </View>
          ))}

          <View style={styles.divider} />
          <TouchableOpacity style={styles.cancelRow} onPress={onClose} activeOpacity={0.65}>
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
