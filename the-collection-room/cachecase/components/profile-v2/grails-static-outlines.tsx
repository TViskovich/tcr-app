import { type ColorValue, StyleSheet, View } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';

// Profile V2's "Static Outlines" Grails showcase effect
// (profiles.grails_showcase_effect = 'static_outlines' — the profile owner's
// choice, so visitors see it too). A thin, motionless outline around each
// occupied Grail tile in the owner's banner theme: the top and bottom edges
// sweep through the banner's gradient, the left and right edges take its
// first and last stops — the same left→right direction as the banner.
//
// The whole gradient, not one stop: several banners (Brand Gradient, White
// Gradient, Gold Silver) have a near-white middle stop, which on its own at
// low opacity reads as a plain gray border rather than the owner's theme.
//
// Purely additive: one absolutely positioned layer drawn ABOVE the tiles with
// pointerEvents="none", so it never takes a touch (taps, long-press and
// drag-to-reorder go to the tiles as before) and never takes part in the
// grid's layout — tile sizes, crops and gaps are untouched. Every line is
// drawn inside its cell's box, so nothing spills into the gaps. No animation
// of any kind, so Reduce Motion doesn't apply.

const LINE_WIDTH = 1;
// The outline itself, on the tile's outermost pixel.
const OUTLINE_OPACITY = 0.5;
// A fainter second line just inside it — a restrained inner glow that keeps
// the outline legible against busy card images and dark tiles alike.
const HALO_OPACITY = 0.15;

// Luminous treatment (dark-neutral banners — see getGrailsEffectTheme): a
// graphite → silver → graphite outline in place of the banner's own
// (invisible) near-black, with a slightly stronger stationary inner halo.
const LUMINOUS_OUTLINE_COLORS: GradientColors = ['#8E949D', '#D3D7DD', '#8E949D'];
const LUMINOUS_HALO_OPACITY = 0.22;

type GradientColors = readonly [ColorValue, ColorValue, ...ColorValue[]];

type Props = {
  cellWidth: number;
  cellHeight: number;
  gap: number;
  columns: number;
  // Slot indices (0–8, row-major) that hold a Grail. Empty slots get none.
  occupiedSlotIndices: readonly number[];
  // The effect colours (getGrailsEffectTheme(...).colors).
  colors: readonly ColorValue[];
  // Dark-banner luminous treatment: graphite/silver outline (ignores colors).
  luminous?: boolean;
};

export function GrailsStaticOutlines({
  cellWidth,
  cellHeight,
  gap,
  columns,
  occupiedSlotIndices,
  colors: themeColors,
  luminous = false,
}: Props) {
  const colors = luminous ? LUMINOUS_OUTLINE_COLORS : themeColors;
  const [first, ...rest] = colors;
  if (!first) return null;
  // LinearGradient needs at least two stops; a single colour is a solid edge.
  const [second = first, ...others] = rest;
  const gradient: GradientColors = [first, second, ...others];

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {occupiedSlotIndices.map((slotIndex) => (
        <View
          key={slotIndex}
          style={[
            styles.cell,
            {
              left: (slotIndex % columns) * (cellWidth + gap),
              top: Math.floor(slotIndex / columns) * (cellHeight + gap),
              width: cellWidth,
              height: cellHeight,
            },
          ]}>
          <Frame inset={0} opacity={OUTLINE_OPACITY} colors={gradient} />
          <Frame inset={LINE_WIDTH} opacity={luminous ? LUMINOUS_HALO_OPACITY : HALO_OPACITY} colors={gradient} />
        </View>
      ))}
    </View>
  );
}

// One 1px rectangle, `inset` px inside the cell.
function Frame({ inset, opacity, colors }: { inset: number; opacity: number; colors: GradientColors }) {
  return (
    <View style={[styles.frame, { top: inset, right: inset, bottom: inset, left: inset, opacity }]}>
      <LinearGradient colors={colors} start={HORIZONTAL_START} end={HORIZONTAL_END} style={styles.top} />
      <LinearGradient colors={colors} start={HORIZONTAL_START} end={HORIZONTAL_END} style={styles.bottom} />
      <View style={[styles.left, { backgroundColor: colors[0] }]} />
      <View style={[styles.right, { backgroundColor: colors[colors.length - 1] }]} />
    </View>
  );
}

const HORIZONTAL_START = { x: 0, y: 0.5 };
const HORIZONTAL_END = { x: 1, y: 0.5 };

const styles = StyleSheet.create({
  cell: {
    position: 'absolute',
  },
  frame: {
    position: 'absolute',
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: LINE_WIDTH,
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: LINE_WIDTH,
  },
  // Between the top and bottom lines, so corners aren't drawn twice (which
  // would show as brighter dots at the shared opacity).
  left: {
    position: 'absolute',
    top: LINE_WIDTH,
    bottom: LINE_WIDTH,
    left: 0,
    width: LINE_WIDTH,
  },
  right: {
    position: 'absolute',
    top: LINE_WIDTH,
    bottom: LINE_WIDTH,
    right: 0,
    width: LINE_WIDTH,
  },
});
