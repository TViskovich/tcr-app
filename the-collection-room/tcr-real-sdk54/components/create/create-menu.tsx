import { Alert, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { IconSymbol } from '@/components/ui/icon-symbol';

type Props = {
  visible: boolean;
  onClose: () => void;
};

type MenuOption = {
  id: string;
  icon: 'square.and.pencil' | 'rectangle.stack.fill' | 'folder.fill' | 'sparkles';
  title: string;
  subtitle: string;
  onSelect: () => void;
};

export function CreateMenu({ visible, onClose }: Props) {
  const router = useRouter();

  function handleTextPost() {
    onClose();
    router.push('/post/new');
  }

  // TODO: Share Card — no card-picker or per-card share entry point exists yet
  // (app/item/[id].tsx has no share action). Real implementation needs a card
  // picker, then a Share.share() call — see handleShareFolder below for the
  // exact pattern to reuse (app/folder/[id].tsx already does this for folders).
  function handleShareCard() {
    onClose();
    Alert.alert('Share Card', 'Sharing an individual card is coming soon.');
  }

  // TODO: Share Folder — app/folder/[id].tsx already has a working Share.share()
  // call (see its handleShare), but it operates on a folder already loaded in
  // that screen's state. This menu has no folder selected yet, so there's
  // nothing to reuse directly until a folder-picker exists here.
  function handleShareFolder() {
    onClose();
    Alert.alert('Share Folder', 'Sharing a folder from here is coming soon.');
  }

  // TODO: Share Showcase — would deep-link to the current user's own profile
  // (thecollectionroom://user/${username}), mirroring the folder share
  // pattern, once the current user's username is available here (needs a
  // profiles-table lookup; useAuth()'s session only has email, not username).
  function handleShareShowcase() {
    onClose();
    Alert.alert('Share Showcase', 'Sharing your showcase is coming soon.');
  }

  const OPTIONS: MenuOption[] = [
    {
      id: 'text',
      icon: 'square.and.pencil',
      title: 'Text Post',
      subtitle: 'Share a collecting thought',
      onSelect: handleTextPost,
    },
    {
      id: 'card',
      icon: 'rectangle.stack.fill',
      title: 'Share Card',
      subtitle: 'Post one collectible from your collection',
      onSelect: handleShareCard,
    },
    {
      id: 'folder',
      icon: 'folder.fill',
      title: 'Share Folder',
      subtitle: 'Share a curated folder',
      onSelect: handleShareFolder,
    },
    {
      id: 'showcase',
      icon: 'sparkles',
      title: 'Share Showcase',
      subtitle: 'Feature multiple grails or favorites',
      onSelect: handleShareShowcase,
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

          <Text style={styles.title}>Create</Text>

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
