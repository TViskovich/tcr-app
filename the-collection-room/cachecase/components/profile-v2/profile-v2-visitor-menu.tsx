import { ActivityIndicator, Platform, Pressable, StyleSheet, Text } from 'react-native';

import { IconSymbol } from '@/components/ui/icon-symbol';

import { AnchoredMenu, menuStyles, useAnchoredMenu } from './profile-v2-anchored-menu';
import { PV2 } from './profile-v2-theme';

type Props = {
  username: string;
  // null while the block status is still loading — the menu stays closed
  // until it is known, so it never offers the wrong action.
  blockedByMe: boolean | null;
  busy: boolean;
  onBlock: () => void;
  onUnblock: () => void;
  // Content reporting (lib/content-reports.ts).
  onReport?: () => void;
};

// "More" (⋯) menu on ANOTHER collector's profile (never rendered on your
// own — see profile-v2-screen.tsx's publicBackRow). Uses the shared anchored
// menu (profile-v2-anchored-menu.tsx), like ProfileV2FollowMenu. Holds the
// collector-blocking action (lib/user-blocks.ts); the confirmation itself is
// shown by the screen.
export function ProfileV2VisitorMenu({ username, blockedByMe, busy, onBlock, onUnblock, onReport }: Props) {
  const { open, anchor, triggerRef, openMenu, closeMenu } = useAnchoredMenu();
  const label = blockedByMe ? `Unblock @${username}` : `Block @${username}`;

  return (
    <>
      <Pressable
        ref={triggerRef}
        onPress={openMenu}
        disabled={busy || blockedByMe === null}
        hitSlop={10}
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel="More options"
        accessibilityHint={`Options for @${username}, including blocking`}
        accessibilityState={{ disabled: busy || blockedByMe === null, busy }}
        testID="profile-more-button">
        {busy ? (
          <ActivityIndicator size="small" color={PV2.textPrimary} />
        ) : (
          <IconSymbol name="ellipsis" size={24} color={PV2.textPrimary} accessible={false} />
        )}
      </Pressable>

      <AnchoredMenu visible={open} anchor={anchor} onRequestClose={closeMenu}>
        {onReport ? (
          <Pressable
            style={menuStyles.item}
            onPress={() => {
              closeMenu();
              // iOS can't present the report sheet while this menu's own
              // modal is still dismissing.
              setTimeout(onReport, Platform.OS === 'ios' ? 350 : 0);
            }}
            hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={`Report @${username}`}>
            <Text style={menuStyles.itemLabel}>{`Report @${username}`}</Text>
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
  // Same 44x44 bare-icon touch target as the bookmark beside it.
  trigger: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
