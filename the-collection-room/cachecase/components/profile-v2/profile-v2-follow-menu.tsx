import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { AnchoredMenu, menuStyles, useAnchoredMenu } from './profile-v2-anchored-menu';
import { PV2 } from './profile-v2-theme';

type Props = {
  isFollowing: boolean;
  loading?: boolean;
  // The one existing toggle handler (profile-v2-screen.tsx's toggleFollow)
  // — it already reads the current follow state itself and does the
  // correct insert/delete, so the menu's single item just calls this same
  // function regardless of which label it's showing. No separate
  // onFollow/onUnfollow, no parallel follow/unfollow implementation.
  onToggleFollow: () => void;
};

// Compact anchored dropdown for the expanded profile panel's Follow/
// Following button — see profile-v2-anchored-menu.tsx for the shared
// open/measure/close mechanics and menu shell this builds on (the owner's
// "..." is a direct tap into enterEdit() with no menu of its own — see
// profile-v2-expanded-details.tsx).
//
// Tapping the button itself never toggles follow state — it only opens
// this menu (see `openMenu`/onPress below), which holds the one real
// action (Follow or Unfollow, matching whichever state is current).
export function ProfileV2FollowMenu({ isFollowing, loading, onToggleFollow }: Props) {
  const { open, anchor, triggerRef, openMenu, closeMenu } = useAnchoredMenu();

  function selectAction() {
    closeMenu();
    onToggleFollow();
  }

  return (
    <>
      <Pressable
        ref={triggerRef}
        style={styles.actionBtn}
        onPress={openMenu}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel={isFollowing ? 'Following' : 'Follow'}
        accessibilityHint="Opens follow options">
        {loading ? (
          <ActivityIndicator size="small" color={PV2.textPrimary} />
        ) : (
          <Text style={styles.actionBtnLabel}>{isFollowing ? 'Following' : 'Follow'} ▾</Text>
        )}
      </Pressable>

      <AnchoredMenu visible={open} anchor={anchor} onRequestClose={closeMenu}>
        {/* menuStyles.item's own visual box lands around 34-35px tall
            (matching actionBtn's compact height) — hitSlop extends the
            actual tappable area to a comfortable ~44px+ without growing
            the visible pill beyond the button it hangs from. */}
        <Pressable
          style={menuStyles.item}
          onPress={selectAction}
          hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}>
          <Text style={isFollowing ? menuStyles.itemDestructive : menuStyles.itemLabel}>
            {isFollowing ? 'Unfollow' : 'Follow'}
          </Text>
        </Pressable>
      </AnchoredMenu>
    </>
  );
}

const styles = StyleSheet.create({
  // Same dark-pill spec as ProfileV2ExpandedDetails' own Message button
  // (subtle border, dark translucent fill, rounded, compact) — the two
  // sit side by side and must read as one matched pair.
  actionBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: PV2.border,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnLabel: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
});
