import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { IconSymbol } from '@/components/ui/icon-symbol';

type Props = {
  visible: boolean;
  onClose: () => void;
};

type MenuOption = {
  id: string;
  icon: 'square.and.pencil' | 'rectangle.stack.fill' | 'folder.fill' | 'crown.fill';
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

  function handleShareCard() {
    onClose();
    router.push('/share-card/new');
  }

  // Share Folder = compose a CacheCase feed post showcasing one of your
  // folders (folder picker -> caption/preview -> Post). Not external
  // sharing: the folder screen's own Share icon is what opens the native
  // share sheet.
  function handleShareFolder() {
    onClose();
    // Cast: expo-router's generated typed-routes file doesn't know this new
    // route until the dev server next regenerates it.
    router.push('/share-folder/new' as never);
  }

  function handleRateMyGrails() {
    onClose();
    router.push('/rate-my-grails/new');
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
      id: 'rate-my-grails',
      icon: 'crown.fill',
      title: 'Rate My Grails',
      subtitle: 'Share your showcase for others to rate',
      onSelect: handleRateMyGrails,
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
