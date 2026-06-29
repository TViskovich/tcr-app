import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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
  // null = disabled / coming soon
  route: string | null;
};

const OPTIONS: MenuOption[] = [
  {
    id: 'text',
    icon: 'square.and.pencil',
    title: 'Text Post',
    subtitle: 'Share a collecting thought',
    route: '/post/new',
  },
  {
    id: 'card',
    icon: 'rectangle.stack.fill',
    title: 'Share Card',
    subtitle: 'Post one collectible from your collection',
    route: null,
  },
  {
    id: 'folder',
    icon: 'folder.fill',
    title: 'Share Folder',
    subtitle: 'Share a curated folder',
    route: null,
  },
  {
    id: 'showcase',
    icon: 'sparkles',
    title: 'Showcase',
    subtitle: 'Feature multiple grails or favorites',
    route: null,
  },
];

export function CreateMenu({ visible, onClose }: Props) {
  const router = useRouter();

  function handleOption(route: string) {
    onClose();
    router.push(route as any);
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

          <Text style={styles.title}>Create</Text>

          {OPTIONS.map((option, index) => {
            const active = option.route !== null;
            return (
              <View key={option.id}>
                {index > 0 && <View style={styles.divider} />}
                <TouchableOpacity
                  style={styles.row}
                  onPress={active ? () => handleOption(option.route!) : undefined}
                  disabled={!active}
                  activeOpacity={0.65}>

                  <View style={[styles.iconWrap, !active && styles.iconWrapDisabled]}>
                    <IconSymbol
                      name={option.icon}
                      size={20}
                      color={active ? '#FFFFFF' : 'rgba(255,255,255,0.35)'}
                    />
                  </View>

                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, !active && styles.rowTitleDisabled]}>
                      {option.title}
                    </Text>
                    <Text style={[styles.rowSubtitle, !active && styles.rowSubtitleDisabled]}>
                      {active ? option.subtitle : 'Coming soon'}
                    </Text>
                  </View>

                  {active ? (
                    <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />
                  ) : (
                    <View style={styles.soonBadge}>
                      <Text style={styles.soonText}>SOON</Text>
                    </View>
                  )}
                </TouchableOpacity>
              </View>
            );
          })}

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
  iconWrapDisabled: {
    backgroundColor: 'rgba(255,255,255,0.07)',
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
  rowTitleDisabled: {
    color: 'rgba(255,255,255,0.38)',
  },
  rowSubtitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.50)',
  },
  rowSubtitleDisabled: {
    color: 'rgba(255,255,255,0.25)',
  },
  soonBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  soonText: {
    fontSize: 9,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.28)',
    letterSpacing: 0.6,
  },
  bottomSpacer: {
    height: 36,
  },
});
