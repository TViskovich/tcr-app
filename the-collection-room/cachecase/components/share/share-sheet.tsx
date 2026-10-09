import { useRef, useState, type ComponentProps } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

type IconName = ComponentProps<typeof IconSymbol>['name'];

// One Share-sheet row's state, decided by the caller (which knows the
// target and its rules):
//   available   — tapping closes the sheet and runs onPress.
//   blocked     — supported for this target, but a client-side PRE-CHECK
//                 knows it can't succeed right now (e.g. a private item);
//                 tapping explains why inline instead. Server checks stay
//                 authoritative either way.
//   unsupported — this target has no such share representation yet; the
//                 row is shown muted and disabled so every sheet keeps the
//                 same three rows without pretending the action exists.
export type ShareSheetAction =
  | { kind: 'available'; subtitle: string; onPress: () => void }
  | {
      kind: 'blocked';
      subtitle: string;
      noticeTitle: string;
      noticeText: string;
      fixLabel?: string;
      onFix?: () => void;
    }
  | { kind: 'unsupported'; subtitle: string };

type Props = {
  visible: boolean;
  onClose: () => void;
  // Sheet heading, e.g. "Share Item".
  heading: string;
  // Preview header — the caller passes an already-resolved image uri (this
  // sheet never fetches or signs anything itself) plus display text.
  // 'card' is the item's portrait card, 'square' a folder cover, 'circle' an
  // avatar.
  imageUri?: string | null;
  imageShape?: 'card' | 'square' | 'circle';
  title: string;
  subtitle?: string | null;
  feed: ShareSheetAction;
  dm: ShareSheetAction;
  onShareElsewhere: () => void;
};

// The CacheCase Share sheet — every in-app Share button opens this (Item
// Detail, folders, profiles) instead of jumping straight to the native share
// sheet, so the same three choices appear everywhere: Share to Feed, Share
// to DM, Share Elsewhere. What each one does is target-specific and lives
// with the caller (see lib/share/share-target.ts for the shared target
// model and Share Elsewhere). Structurally modeled on
// components/create/create-menu.tsx (dark rounded sheet / drag handle /
// icon+title+subtitle+chevron rows, slide-up Modal, tap-outside-to-dismiss).
export function ShareSheet({
  visible,
  onClose,
  heading,
  imageUri,
  imageShape = 'card',
  title,
  subtitle,
  feed,
  dm,
  onShareElsewhere,
}: Props) {
  const [notice, setNotice] = useState<'feed' | 'dm' | null>(null);
  // Synchronous re-entry guard: the sheet stays touchable while its dismiss
  // animation runs, so a fast second tap could otherwise start the same
  // action twice. Re-armed each time the sheet is shown.
  const handledRef = useRef(false);

  // Every dismissal path resets the inline notice so it never reappears on
  // the next open.
  function close() {
    setNotice(null);
    onClose();
  }

  function run(action: () => void) {
    if (handledRef.current) return;
    handledRef.current = true;
    close();
    action();
  }

  function press(which: 'feed' | 'dm', action: ShareSheetAction) {
    if (action.kind === 'available') run(action.onPress);
    else if (action.kind === 'blocked') setNotice(which);
  }

  function renderRow(
    which: 'feed' | 'dm',
    action: ShareSheetAction,
    label: string,
    icon: IconName,
    iconStyle: object,
  ) {
    const muted = action.kind !== 'available';
    const disabled = action.kind === 'unsupported';
    return (
      <>
        <TouchableOpacity
          style={[styles.row, disabled && styles.rowDisabled]}
          onPress={() => press(which, action)}
          disabled={disabled}
          activeOpacity={0.65}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          accessibilityHint={action.kind === 'blocked' ? `Explains why this can’t be shared yet` : undefined}>
          <View style={[styles.iconWrap, iconStyle, muted && styles.iconWrapMuted]}>
            <IconSymbol name={icon} size={20} color="#FFFFFF" />
          </View>
          <View style={styles.rowText}>
            <Text style={[styles.rowTitle, muted && styles.rowTitleMuted]}>{label}</Text>
            <Text style={styles.rowSubtitle}>{action.subtitle}</Text>
          </View>
          {!muted ? <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" /> : null}
        </TouchableOpacity>

        {action.kind === 'blocked' && notice === which ? (
          <View style={styles.notice} accessibilityLiveRegion="polite">
            <Text style={styles.noticeTitle}>{action.noticeTitle}</Text>
            <Text style={styles.noticeText}>{action.noticeText}</Text>
            {action.onFix && action.fixLabel ? (
              <TouchableOpacity
                style={styles.noticeButton}
                onPress={() => run(action.onFix!)}
                activeOpacity={0.7}
                accessibilityRole="button">
                <Text style={styles.noticeButtonText}>{action.fixLabel}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </>
    );
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
      onShow={() => {
        handledRef.current = false;
      }}
      statusBarTranslucent>
      <View style={styles.backdrop}>
        {/* Tapping outside the sheet dismisses it */}
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          <Text style={styles.title}>{heading}</Text>

          <View style={styles.preview}>
            <View
              style={[
                styles.thumbWrap,
                imageShape === 'square' && styles.thumbSquare,
                imageShape === 'circle' && styles.thumbCircle,
              ]}>
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
            {renderRow('feed', feed, 'Share to Feed', 'plus', styles.iconWrapFeed)}

            <View style={styles.divider} />

            {renderRow('dm', dm, 'Share to DM', 'message.fill', styles.iconWrapDM)}

            <View style={styles.divider} />

            <TouchableOpacity
              style={styles.row}
              onPress={() => run(onShareElsewhere)}
              activeOpacity={0.65}
              accessibilityRole="button">
              <View style={[styles.iconWrap, styles.iconWrapExternal]}>
                <IconSymbol name="square.and.arrow.up" size={20} color="#FFFFFF" />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>Share Elsewhere</Text>
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
  thumbSquare: {
    width: 96,
    height: 96,
    borderRadius: 12,
  },
  thumbCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
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
  rowDisabled: {
    opacity: 0.6,
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
