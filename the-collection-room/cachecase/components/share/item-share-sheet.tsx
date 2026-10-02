import { Alert, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

type Props = {
  visible: boolean;
  onClose: () => void;
  // Preview header — the caller passes an already-resolved image uri (item
  // detail already signs/resolves this for its own carousel; this sheet
  // never re-fetches or re-signs anything itself) plus the same title/
  // subtitle text the identity block above it already shows.
  imageUri?: string;
  title: string;
  subtitle?: string | null;
  onPostToFeed: () => void;
  onShareOutside: () => void;
};

// CacheCase-owned "Share Item" bottom sheet — opened from Item Detail's
// Share button instead of jumping straight to the native iOS share sheet.
// Structurally modeled on components/create/create-menu.tsx (same dark
// rounded sheet / drag handle / icon+title+subtitle+chevron row pattern,
// slide-up Modal, tap-outside-to-dismiss) rather than the heavier pan-
// gesture sheet in item-comments-sheet.tsx — this sheet has no scrollable
// content and no keyboard, so it doesn't need swipe-to-dismiss physics.
//
// "Send in DM" has no real destination yet — public.messages is text-only
// (no item/attachment column, confirmed by auditing app/conversation/
// [id].tsx and the migration history), so this only surfaces a placeholder
// notice rather than faking a deep link or a fake attachment. See this
// component's own module-level comment in the implementation report for
// the schema change that would unblock a real version.
export function ItemShareSheet({
  visible,
  onClose,
  imageUri,
  title,
  subtitle,
  onPostToFeed,
  onShareOutside,
}: Props) {
  function handlePostToFeed() {
    onClose();
    onPostToFeed();
  }

  function handleShareOutside() {
    onClose();
    onShareOutside();
  }

  function handleSendInDM() {
    Alert.alert(
      'Coming Soon',
      'Sending cards directly in a message isn’t available yet — direct messages only support text today.',
    );
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
          <View style={styles.handle} />

          <Text style={styles.title}>Share Item</Text>

          <View style={styles.preview}>
            <View style={styles.thumbWrap}>
              {imageUri ? (
                <Image source={{ uri: imageUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
              ) : null}
            </View>
            <Text style={styles.previewTitle} numberOfLines={1}>
              {title}
            </Text>
            {!!subtitle && (
              <Text style={styles.previewSubtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            )}
          </View>

          <View style={styles.optionsGroup}>
            <TouchableOpacity style={styles.row} onPress={handlePostToFeed} activeOpacity={0.65}>
              <View style={[styles.iconWrap, styles.iconWrapFeed]}>
                <IconSymbol name="plus" size={20} color="#FFFFFF" />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>Post to Feed</Text>
                <Text style={styles.rowSubtitle}>Create a CacheCase post with this item</Text>
              </View>
              <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />
            </TouchableOpacity>

            <View style={styles.divider} />

            <TouchableOpacity style={styles.row} onPress={handleSendInDM} activeOpacity={0.65}>
              <View style={[styles.iconWrap, styles.iconWrapDM]}>
                <IconSymbol name="message.fill" size={20} color="#FFFFFF" />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>Send in DM</Text>
                <Text style={styles.rowSubtitle}>Coming soon</Text>
              </View>
            </TouchableOpacity>

            <View style={styles.divider} />

            <TouchableOpacity style={styles.row} onPress={handleShareOutside} activeOpacity={0.65}>
              <View style={[styles.iconWrap, styles.iconWrapExternal]}>
                <IconSymbol name="square.and.arrow.up" size={20} color="#FFFFFF" />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>Share Outside CacheCase</Text>
                <Text style={styles.rowSubtitle}>Messages, Mail, AirDrop, etc.</Text>
              </View>
              <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.cancelButton} onPress={onClose} activeOpacity={0.7}>
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
    backgroundColor: PV2.panel,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: PV2.panelBorder,
    paddingTop: 12,
    paddingHorizontal: 20,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: PV2.textPrimary,
    textAlign: 'center',
    marginBottom: 16,
  },
  preview: {
    alignItems: 'center',
    gap: 3,
    marginBottom: 20,
  },
  thumbWrap: {
    width: 84,
    height: 108,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    marginBottom: 10,
  },
  previewTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  previewSubtitle: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  optionsGroup: {
    marginBottom: 8,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: PV2.dividerColor,
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
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconWrapFeed: {
    backgroundColor: PV2.accent,
  },
  iconWrapDM: {
    backgroundColor: '#3B7CE8',
  },
  iconWrapExternal: {
    backgroundColor: '#3CA36B',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  rowSubtitle: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  cancelButton: {
    marginTop: 4,
    paddingVertical: 15,
    borderRadius: 12,
    backgroundColor: PV2.collectorPanelBg,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  bottomSpacer: {
    height: 20,
  },
});
