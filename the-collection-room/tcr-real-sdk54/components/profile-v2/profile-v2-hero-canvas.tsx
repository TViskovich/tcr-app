import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import { getHeroCanvasImageAsset, type HeroCanvasThemeId } from '@/components/profile/hero-canvas-themes';
import { PV2 } from './profile-v2-theme';

type Props = {
  heroTheme: HeroCanvasThemeId;
  // Only actually used for procedural themes (LinearGradient colors) — an
  // image-kind theme renders its own bundled artwork instead (see
  // getHeroCanvasImageAsset below), never this swatch.
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
// IDENTICAL for owner and public view mode — same gridStage 32/32
// padding, no action row inside it either way. The public Back button
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
// Background is always the profile's currently selected hero THEME —
// never the former custom-uploaded hero photo (hero_image_url), which has
// no role in this layout (see the Pass 2 plan's own explicit note on
// this). getHeroCanvasImageAsset already existed, already exported, and
// was already fully designed for exactly this (its own comments describe
// rendering it "full-bleed as-is") but had no live call site anywhere in
// the app until now — this wires up an existing, already-designed
// capability, not new visual language. No radial vignette here (unlike
// the old Hero): nothing overlays this canvas except the opaque grid and
// the action row, which already has its own dark pill button backgrounds
// — there's no bottom-anchored text left to protect.
export function ProfileV2HeroCanvas({
  heroTheme,
  themeFallbackSwatch,
  editMode,
  saving,
  onCancelPress,
  onSavePress,
  identityHeader,
  children,
}: Props) {
  const imageAsset = getHeroCanvasImageAsset(heroTheme);

  return (
    <View style={styles.canvas}>
      {imageAsset ? (
        <>
          <Image
            source={imageAsset.source}
            style={StyleSheet.absoluteFillObject}
            contentFit="cover"
            contentPosition={imageAsset.focalPoint}
          />
          {imageAsset.vignetteOpacity != null && (
            <View
              style={[
                StyleSheet.absoluteFillObject,
                { backgroundColor: '#000000', opacity: imageAsset.vignetteOpacity },
              ]}
              pointerEvents="none"
            />
          )}
        </>
      ) : (
        <LinearGradient
          colors={themeFallbackSwatch}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />
      )}

      {/* Themed breathing room around the grid — padding, not a solid
          spacer, so the hero-theme background stays visible above/below
          the grid. Gated on `children` (not always-rendered) because
          children is `false` during edit mode (see profile-v2-screen.tsx,
          which omits ProfileV2Grid there) — an unconditional wrapper
          would still contribute its own padding as empty height even
          with nothing inside it. Always the same 32/32 padding now — no
          per-caller override — so owner and public view-mode canvases are
          dimensionally identical. */}
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
  // Tighter, more modern corner radius (was 20) — shape, size, background,
  // spacing, and everything else about this canvas are otherwise
  // unchanged. Grail-local literal, not a shared constant.
  canvas: {
    width: '100%',
    overflow: 'hidden',
    backgroundColor: PV2.panel,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  // Extra themed showcase space above/below the grid — normal padding,
  // not a spacer view, so it's part of the same themed/clipped box as
  // the grid itself rather than a separately colored region. Always
  // 32/32 now — same for owner and public view mode.
  gridStage: {
    paddingTop: 32,
    paddingBottom: 32,
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
