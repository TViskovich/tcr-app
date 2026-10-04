import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

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
  onSendInDM: () => void;
  onShareOutside: () => void;
  // Client-side PRE-CHECK only: true when the caller already knows the item
  // can't be sent (e.g. the owner's own private item). The row stays
  // tappable but explains why instead of opening the recipient picker. The
  // server's item_not_shareable check remains authoritative either way.
  sendInDMBlocked?: boolean;
  // Optional shortcut shown in that explanation (Item Detail's own edit
  // mode, where visibility is changed).
  onEditItem?: () => void;
};

// CacheCase-owned "Share Item" bottom sheet — opened from Item Detail's
// Share button instead of jumping straight to the native iOS share sheet.
// Structurally modeled on components/create/create-menu.tsx (same dark
// rounded sheet / drag handle / icon+title+subtitle+chevron row pattern,
// slide-up Modal, tap-outside-to-dismiss) rather than the heavier pan-
// gesture sheet in item-comments-sheet.tsx — this sheet has no scrollable
// content and no keyboard, so it doesn't need swipe-to-dismiss physics.
//
// "Send in DM" hands off to the CacheCase recipient picker
// (components/share/send-item-dm-sheet.tsx), which sends a live item
// attachment through the shared DM write path (lib/dm-send.ts).
export function ItemShareSheet({
  visible,
  onClose,
  imageUri,
  title,
  subtitle,
  onPostToFeed,
  onSendInDM,
  onShareOutside,
  sendInDMBlocked,
  onEditItem,
}: Props) {
  const [dmNoticeVisible, setDmNoticeVisible] = useState(false);

  // Every dismissal path resets the inline notice so it never reappears on
  // the next open.
  function close() {
    setDmNoticeVisible(false);
    onClose();
  }

  function handlePostToFeed() {
    close();
    onPostToFeed();
  }

  function handleShareOutside() {
    close();
    onShareOutside();
  }

  function handleSendInDM() {
    if (sendInDMBlocked) {
      setDmNoticeVisible(true);
      return;
    }
    close();
    onSendInDM();
  }

  function handleEditItem() {
    close();
    onEditItem?.();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
      statusBarTranslucent>
      <View style={styles.backdrop}>
        {/* Tapping outside the sheet dismisses it */}
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />

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

            <TouchableOpacity
              style={styles.row}
              onPress={handleSendInDM}
              activeOpacity={0.65}
              accessibilityRole="button"
              accessibilityHint={sendInDMBlocked ? 'Explains why this item can’t be sent yet' : undefined}>
              <View style={[styles.iconWrap, styles.iconWrapDM, sendInDMBlocked && styles.iconWrapMuted]}>
                <IconSymbol name="message.fill" size={20} color="#FFFFFF" />
              </View>
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, sendInDMBlocked && styles.rowTitleMuted]}>Send in DM</Text>
                <Text style={styles.rowSubtitle}>
                  {sendInDMBlocked ? 'Make this item public to share' : 'Send this item to someone on CacheCase'}
                </Text>
              </View>
              {!sendInDMBlocked ? (
                <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />
              ) : null}
            </TouchableOpacity>

            {sendInDMBlocked && dmNoticeVisible ? (
              <View style={styles.notice} accessibilityLiveRegion="polite">
                <Text style={styles.noticeTitle}>This item must be public before it can be shared in DM.</Text>
                <Text style={styles.noticeText}>Change the item’s visibility and try again.</Text>
                {onEditItem ? (
                  <TouchableOpacity
                    style={styles.noticeButton}
                    onPress={handleEditItem}
                    activeOpacity={0.7}
                    accessibilityRole="button">
                    <Text style={styles.noticeButtonText}>Edit Item</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}

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

          <TouchableOpacity style={styles.cancelButton} onPress={close} activeOpacity={0.7}>
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
  iconWrapMuted: {
    opacity: 0.45,
  },
  rowTitleMuted: {
    color: PV2.textSecondary,
  },
  notice: {
    backgroundColor: PV2.collectorPanelBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    padding: 14,
    marginBottom: 12,
    gap: 4,
  },
  noticeTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  noticeText: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  noticeButton: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  noticeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textPrimary,
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
