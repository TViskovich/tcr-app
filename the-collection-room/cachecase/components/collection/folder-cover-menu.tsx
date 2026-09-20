import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { IconSymbol } from '@/components/ui/icon-symbol';

type Props = {
  visible: boolean;
  onClose: () => void;
  // Fires once this Modal's own dismiss animation has actually finished
  // (iOS only — see [folderId].tsx's runLibraryCoverPick comment). Optional
  // since only the folder-cover screen currently needs to sequence a
  // native picker launch after this specific Modal closes.
  onDismiss?: () => void;
  onChooseFromFolder: () => void;
  onChooseFromLibrary: () => void;
  onRemoveCover: () => void;
  // "Remove Cover" only makes sense once an explicit cover already exists
  // (cover_source 'upload' or 'item') — a folder that has never had one set
  // doesn't get a Remove option with nothing to remove.
  hasCover: boolean;
};

type MenuOption = {
  id: string;
  icon: 'rectangle.stack.fill' | 'camera.fill' | 'xmark';
  title: string;
  subtitle: string;
  onSelect: () => void;
};

// Opened from folder-edit-modal.tsx's "Change Cover" row — same bottom-sheet
// shell shape (backdrop dismiss, drag handle, divided icon rows) as
// components/collection/collection-add-menu.tsx and
// components/create/create-menu.tsx, kept as its own small component since
// these three options are specific to folder covers.
export function FolderCoverMenu({
  visible,
  onClose,
  onDismiss,
  onChooseFromFolder,
  onChooseFromLibrary,
  onRemoveCover,
  hasCover,
}: Props) {
  const OPTIONS: MenuOption[] = [
    {
      id: 'folder',
      icon: 'rectangle.stack.fill',
      title: 'Choose from Folder',
      subtitle: 'Use one of this collection’s own card photos',
      onSelect: onChooseFromFolder,
    },
    {
      id: 'library',
      icon: 'camera.fill',
      title: 'Choose from Photo Library',
      subtitle: 'Pick any photo from your device',
      onSelect: onChooseFromLibrary,
    },
    ...(hasCover
      ? [
          {
            id: 'remove',
            icon: 'xmark' as const,
            title: 'Remove Cover',
            subtitle: 'Go back to the default collection cover',
            onSelect: onRemoveCover,
          },
        ]
      : []),
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={onDismiss}
      statusBarTranslucent>
      <View style={styles.backdrop}>
        {/* Tapping outside the sheet dismisses it */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View style={styles.sheet}>
          {/* Drag handle */}
          <View style={styles.handle} />

          <Text style={styles.title}>Change Cover</Text>

          {OPTIONS.map((option, index) => (
            <View key={option.id}>
              {index > 0 && <View style={styles.divider} />}
              <TouchableOpacity
                style={styles.row}
                onPress={option.onSelect}
                activeOpacity={0.65}>

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
