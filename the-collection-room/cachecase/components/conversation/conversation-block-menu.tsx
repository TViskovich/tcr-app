import { ActivityIndicator, Platform, Pressable, StyleSheet, Text } from 'react-native';

import { AnchoredMenu, menuStyles, useAnchoredMenu } from '@/components/profile-v2/profile-v2-anchored-menu';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

type Props = {
  // null while the block status loads — the menu stays closed until known.
  blockedByMe: boolean | null;
  busy: boolean;
  onBlock: () => void;
  onUnblock: () => void;
  // Content reporting: Report Collector (omitted when their profile isn't
  // visible to the viewer — their messages stay reportable).
  onReport?: () => void;
};

// "More" (⋯) menu in a 1:1 conversation's header (never for groups — see
// app/conversation/[id].tsx). Holds Block Collector / Unblock Collector
// (lib/user-blocks.ts); the screen shows the confirmation.
export function ConversationBlockMenu({ blockedByMe, busy, onBlock, onUnblock, onReport }: Props) {
  const { open, anchor, triggerRef, openMenu, closeMenu } = useAnchoredMenu();
  const label = blockedByMe ? 'Unblock Collector' : 'Block Collector';

  return (
    <>
      <Pressable
        ref={triggerRef}
        onPress={openMenu}
        disabled={busy || blockedByMe === null}
        hitSlop={10}
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel="Conversation options"
        accessibilityHint="Includes blocking this collector"
        accessibilityState={{ disabled: busy || blockedByMe === null, busy }}
        testID="conversation-more-button">
        {busy ? (
          <ActivityIndicator size="small" color={PV2.textPrimary} />
        ) : (
          <IconSymbol name="ellipsis" size={22} color={PV2.textPrimary} accessible={false} />
        )}
      </Pressable>
      <AnchoredMenu visible={open} anchor={anchor} onRequestClose={closeMenu}>
        {onReport ? (
          <Pressable
            style={menuStyles.item}
            onPress={() => {
              closeMenu();
              // iOS can't present the report sheet while this menu is still dismissing.
              setTimeout(onReport, Platform.OS === 'ios' ? 350 : 0);
            }}
            hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Report Collector">
            <Text style={menuStyles.itemLabel}>Report Collector</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={menuStyles.item}
          onPress={() => {
            closeMenu();
            if (blockedByMe) onUnblock();
            else onBlock();
          }}
          hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={label}>
          <Text style={blockedByMe ? menuStyles.itemLabel : menuStyles.itemDestructive}>{label}</Text>
        </Pressable>
      </AnchoredMenu>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
