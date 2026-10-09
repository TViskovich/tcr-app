import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { IconSymbol } from '@/components/ui/icon-symbol';

type Props = {
  visible: boolean;
  // The ORIGINAL post's current state — the first row reads "Undo Repost"
  // when the viewer has already reposted it.
  reposted: boolean;
  onRepost: () => void;
  onQuote: () => void;
  // Backdrop, Cancel, or the system back gesture — nothing changes.
  onClose: () => void;
};

// The feed's Repost / Quote menu (X-style), opened from the Repost control
// on Feed, Post Detail and Profile → Posts. Same sheet treatment as the
// app's other bottom menus (AddPhotoMenu): dark #161616 sheet, handle,
// icon rows, Cancel. Selecting a row is the caller's job to act on (and to
// close the sheet).
export function RepostMenu({ visible, reposted, onRepost, onQuote, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          <TouchableOpacity style={styles.row} onPress={onRepost} activeOpacity={0.65} accessibilityRole="button">
            <View style={styles.iconWrap}>
              <IconSymbol name="arrow.2.squarepath" size={20} color="#FFFFFF" />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{reposted ? 'Undo Repost' : 'Repost'}</Text>
              <Text style={styles.rowSubtitle}>
                {reposted ? 'Remove it from your followers’ feeds' : 'Share it to your followers’ feeds'}
              </Text>
            </View>
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity style={styles.row} onPress={onQuote} activeOpacity={0.65} accessibilityRole="button">
            <View style={styles.iconWrap}>
              <IconSymbol name="square.and.pencil" size={20} color="#FFFFFF" />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Quote</Text>
              <Text style={styles.rowSubtitle}>Add your comment above it</Text>
            </View>
            <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />
          </TouchableOpacity>

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
    marginBottom: 14,
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
