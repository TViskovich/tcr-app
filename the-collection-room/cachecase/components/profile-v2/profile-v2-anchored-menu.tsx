import { type ReactNode, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { PV2 } from './profile-v2-theme';

export type AnchorRect = { x: number; y: number; width: number; height: number };

// Open/measure/close state for the expanded profile panel's Follow/
// Following dropdown (profile-v2-follow-menu.tsx) — "measure the trigger,
// open a Modal-hosted box just under it, close on an outside tap or a
// selection." Kept as its own small, reusable primitive (rather than
// inlined into that one component) in case another anchored dropdown
// needs the exact same mechanics later; the owner's "..." button
// deliberately does NOT use this — it's a direct tap into enterEdit(),
// with no menu at all (see profile-v2-expanded-details.tsx).
export function useAnchoredMenu() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const triggerRef = useRef<View>(null);

  function openMenu() {
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
      setOpen(true);
    });
  }

  function closeMenu() {
    setOpen(false);
  }

  return { open, anchor, triggerRef, openMenu, closeMenu };
}

type Props = {
  visible: boolean;
  anchor: AnchorRect | null;
  onRequestClose: () => void;
  children: ReactNode;
};

// The dropdown box itself — anchored under `anchor` (from useAnchoredMenu
// above), compact, dark. The project's existing menu-shaped components
// (FolderCoverMenu, CollectionAddMenu, CreateMenu) are all full-width
// bottom sheets over a screen-covering backdrop — the opposite of "anchor
// under a small button, stay compact, don't cover large portions of the
// screen" — so none of them fit this use. Built from React Native's own
// Modal + View.measureInWindow; no new dependency.
export function AnchoredMenu({ visible, anchor, onRequestClose, children }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      {/* Invisible full-screen Pressable purely to catch an outside tap and
          close the menu — this is a real anchored dropdown, not a sheet, so
          there's no dimming backdrop. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onRequestClose} />
      {anchor && (
        <View
          style={[
            styles.menu,
            { top: anchor.y + anchor.height + 6, left: anchor.x, minWidth: anchor.width },
          ]}>
          {children}
        </View>
      )}
    </Modal>
  );
}

export const menuStyles = StyleSheet.create({
  // paddingVertical 9 + centered content matches ProfileV2FollowMenu's own
  // actionBtn spec (profile-v2-follow-menu.tsx) exactly, so a single-item
  // menu (the only case today — Follow/Unfollow) reads as a compact
  // extension of the trigger button rather than a left-aligned list row.
  item: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemLabel: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  // Same color this design system already reserves for destructive actions
  // elsewhere (Remove Avatar, Stolen/Missing custody status, Unfollow).
  itemDestructive: {
    color: PV2.accent,
    fontSize: 13,
    fontWeight: '600',
  },
});

const styles = StyleSheet.create({
  // borderRadius 20 matches actionBtn/messageBtn's own radius (both
  // profile-v2-follow-menu.tsx and profile-v2-expanded-details.tsx) — with
  // this menu's own compact height (paddingVertical 4 here + item's own
  // paddingVertical 9 + a ~13px line, landing well under 2*20), RN clips
  // the radius to a true stadium/pill regardless, so this reads as the
  // same pill language as the trigger button above it, not a rounded-rect
  // card.
  menu: {
    position: 'absolute',
    backgroundColor: '#161616',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    paddingVertical: 4,
    overflow: 'hidden',
  },
});
