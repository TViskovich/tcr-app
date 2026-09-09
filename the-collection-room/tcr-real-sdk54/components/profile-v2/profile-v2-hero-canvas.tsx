import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { HeroCanvasThemeId } from '@/components/profile/hero-canvas-themes';
import { PV2 } from './profile-v2-theme';

type Props = {
  // Accepted but currently unused — see the "Background simplification
  // pass" comment below.
  heroTheme: HeroCanvasThemeId;
  themeFallbackSwatch: [string, string];
  editMode: boolean;
  saving: boolean;
  onCancelPress: () => void;
  onSavePress: () => void;
  // Public-view only — the profile's own display name, username, and
  // Follow/Message row, rendered inside this canvas (after the action
  // rail) so the hero theme continues behind them. Always undefined for
  // the owner view and edit mode (see profile-v2-screen.tsx, which only
  // supplies this for a visitor).
  identityHeader?: ReactNode;
  children?: ReactNode;
};

// Profile V2 hierarchy redesign, Pass 2 — replaces the old standalone,
// fixed-548px ProfileV2Hero banner. Deliberately NOT a fixed-height
// component: it has no height of its own, it hugs its normal-flow content
// (the Top 9 grid, then the action row below it) — so the theme canvas
// sits directly behind the grid with no gap, matching the approved
// mockup. profile-v2-hero.tsx itself is left in place, unused, in case
// this pass needs to be reverted.
//
// Owner/public normalization pass: this canvas is now DIMENSIONALLY
// IDENTICAL for owner and public view mode — same gridStage padding
// (6/16, see below), no action row inside it either way. The public Back button
// (previously rendered here) and the owner Settings/Saved row both live
// entirely in profile-v2-screen.tsx now, as their own control row below
// this canvas, sharing the same outer spacing footprint so identity
// content begins at the same vertical offset regardless of which one is
// showing. The action row below still exists, but now ONLY for edit
// mode's Cancel/Save — it's what keeps this canvas from collapsing to
// zero height during edit mode (when `children` is omitted by the
// caller, since ProfileV2Grid isn't rendered then): the row's own
// padding still contributes real height, so Cancel/Save stay visible and
// usable without reintroducing a large fixed hero height. Edit mode is
// owner-only, so this is the only remaining owner/public asymmetry, and
// it doesn't affect either profile's shared VIEW-mode canvas dimensions.
//
// Background simplification pass (Profile V3) — this canvas no longer
// renders the profile's hero THEME (image asset or procedural gradient)
// behind the grid; it's a plain PV2.bg fill now, same as the rest of the
// screen, so the grid reads as sitting directly on the app's own
// background rather than inside a themed display case. heroTheme/
// themeFallbackSwatch are still accepted (the caller — profile-v2-screen.tsx
// — and the hero theme picker/profile column are all untouched) so this is
// a one-file, easily-reversible change: reintroducing the themed
// background here is the only thing a revert would need to touch.
export function ProfileV2HeroCanvas({
  editMode,
  saving,
  onCancelPress,
  onSavePress,
  identityHeader,
  children,
}: Props) {
  return (
    <View style={styles.canvas}>
      {/* Breathing room around the grid — padding, not a solid spacer.
          Gated on `children` (not always-rendered) because
          children is `false` during edit mode (see profile-v2-screen.tsx,
          which omits ProfileV2Grid there) — an unconditional wrapper
          would still contribute its own padding as empty height even
          with nothing inside it. Always the same gridStage padding now —
          no per-caller override — so owner and public view-mode canvases
          are dimensionally identical. */}
      {children && <View style={styles.gridStage}>{children}</View>}

      {/* Action rail — normal flow, below the grid, never overlapping any
          card. Owner Settings/Saved and public Back both moved out to
          profile-v2-screen.tsx as their own row below this canvas (see
          the component comment above); this row now only ever renders
          Cancel/Save, and only during edit mode. */}
      {editMode && (
        <View style={styles.actionRow} pointerEvents="box-none">
          <TouchableOpacity onPress={onCancelPress} hitSlop={10} style={styles.textBtn}>
            <Text style={styles.textBtnLabel}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onSavePress} disabled={saving} hitSlop={10} style={styles.textBtn}>
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={[styles.textBtnLabel, styles.saveLabel]}>Save</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {identityHeader}
    </View>
  );
}

const styles = StyleSheet.create({
  // Plain PV2.bg fill, no radius — background simplification pass. The
  // radius (previously 12, framing the themed image/gradient) is dropped
  // rather than kept at the old value: with gridStage's paddingTop now
  // small (6, see below), a rounded corner here would clip the top
  // corners of the outer grid cells; since the box no longer has a
  // visible fill distinct from the screen behind it, the radius had
  // nothing left to frame anyway.
  canvas: {
    width: '100%',
    overflow: 'hidden',
    backgroundColor: PV2.bg,
  },
  // Space above/below the grid — normal padding, not a solid spacer.
  // paddingTop reduced from 32 to 6 (Profile V3 background-removal pass)
  // so the grid sits almost flush under the identity header above it,
  // per the current design direction; paddingBottom (16) is unrelated and
  // untouched — together with ProfileV2TabRow's own marginTop (10) that's
  // still the Grails→tab-row gap (26px), matched by profile-v2-screen.tsx's
  // TAB_CONTENT_TOP_GAP on the other side of the tab row.
  gridStage: {
    paddingTop: 6,
    paddingBottom: 16,
  },
  // Same visual values as profile-v2-hero.tsx's own topRow/textBtn* —
  // copied, not redesigned. Only `position`/`top`/`left`/`right`
  // (absolute overlay) changed to a normal-flow row with padding.
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  textBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  textBtnLabel: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 15,
    fontWeight: '600',
  },
  saveLabel: {
    color: '#fff',
  },
});
