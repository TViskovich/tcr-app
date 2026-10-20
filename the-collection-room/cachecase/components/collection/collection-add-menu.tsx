import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

// The floating tab bar's gap above the bottom safe-area inset
// (BAR_BOTTOM_GAP in components/navigation/global-floating-tab-bar.tsx).
const FLOATING_NAV_BOTTOM_GAP = 4;

type Props = {
  visible: boolean;
  onClose: () => void;
  onAddFolder: () => void;
  onAddItem: () => void;
};

type MenuOption = {
  id: string;
  icon: 'folder.fill' | 'rectangle.stack.fill';
  title: string;
  subtitle: string;
  onSelect: () => void;
};

// The Collections screen's "+ Add" chooser — same bottom-sheet shell shape
// (backdrop dismiss, drag handle, divided icon rows) as
// components/create/create-menu.tsx, kept as its own small component
// rather than added to that one since these two options (Add Item / Add
// Collection) are specific to the Collections screen, not general
// content-create types like Text Post/Share Card. Icons match the Create
// menu's own item (Share Item) and collection (Share a Collection) icons.
// "Add Collection" is UI wording only — it still creates a folder.
export function CollectionAddMenu({ visible, onClose, onAddFolder, onAddItem }: Props) {
  // The options sit above where the floating tab bar normally is — up in
  // easy thumb reach — rather than down against the home indicator.
  const insets = useSafeAreaInsets();
  const bottomSpace = insets.bottom + FLOATING_NAV_BOTTOM_GAP + TAB_BAR_HEIGHT;
  const OPTIONS: MenuOption[] = [
    {
      id: 'item',
      icon: 'rectangle.stack.fill',
      title: 'Add Item',
      subtitle: 'Add a card to a collection',
      onSelect: onAddItem,
    },
    {
      id: 'folder',
      icon: 'folder.fill',
      title: 'Add Collection',
      subtitle: 'Create a new collection',
      onSelect: onAddFolder,
    },
  ];

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

          {/* Lifts the options into thumb reach (see bottomSpace) */}
          <View style={{ height: bottomSpace }} />
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
});
