import type { ReactNode } from 'react';
import { useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

export type GridImage = {
  key: string;
  uri: string | null;
};

type Props = {
  images: GridImage[];
  // Fixed cell shapes (not measured per-image, unlike the single-photo
  // path elsewhere in this app) — standard for a multi-image attachment
  // grid in every common social layout (Twitter/Instagram included):
  // every cell is a predictable size regardless of the source photo's own
  // aspect ratio, cropped via contentFit="cover". Shared by both the
  // composer's own preview (app/post/new.tsx) and the feed card
  // (post-card.tsx) so the two never drift into two independently-tuned
  // layouts for the same 1/2/3/4-count rules.
  borderRadius?: number;
  gap?: number;
  onPressImage?: (index: number) => void;
  // Composer-only remove-X badge, feed-only (absent) for a read-only grid
  // — kept as an injection point here rather than two near-duplicate grid
  // implementations.
  renderOverlay?: (index: number) => ReactNode;
};

const DEFAULT_RADIUS = 11;
const DEFAULT_GAP = 3;

// One tile — background placeholder shows through until the image
// resolves (signed item-image URLs can take a moment; library URIs are
// local and load instantly), matching this app's existing "no raw
// fallback, no flash of broken image" convention. width/height are always
// plain, already-computed NUMBERS (see computeLayout below) — never
// `aspectRatio` or `flex`-derived — so there is nothing here for Yoga to
// resolve on its own; every tile's size is a fact, not a computation.
function Tile({
  image,
  index,
  width,
  height,
  radius,
  onPress,
  overlay,
}: {
  image: GridImage;
  index: number;
  width: number;
  height: number;
  radius: number;
  onPress?: (index: number) => void;
  overlay?: ReactNode;
}) {
  const boxStyle = { width, height, borderRadius: radius, backgroundColor: PV2.collectorPanelBg, overflow: 'hidden' as const };

  if (!onPress) {
    return (
      <View style={boxStyle}>
        {image.uri && (
          <Image source={{ uri: image.uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        )}
        {overlay}
      </View>
    );
  }
  return (
    <Pressable onPress={() => onPress(index)} style={{ width, height }}>
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: PV2.collectorPanelBg, overflow: 'hidden' }]}>
        {image.uri && (
          <Image source={{ uri: image.uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        )}
      </View>
      {overlay}
    </Pressable>
  );
}

// Every cell's exact pixel box for a given image count, container width,
// and gap — plain arithmetic, not Yoga. Rounded at each step (not just
// the final numbers) so cells built from a shared total (e.g. the 3-image
// layout's lead+stack split, or a stack's own two-cell height split)
// still sum back to that exact total — a naive independent Math.round on
// each side can drift a pixel short/over, leaving a visible gap or
// overlap; deriving the SECOND value as "total - first" instead removes
// that drift by construction.
type SingleLayout = { kind: 'single'; width: number; height: number };
type PairLayout = { kind: 'pair'; cell: number };
type ThreeLayout = {
  kind: 'three';
  leadWidth: number;
  stackWidth: number;
  blockHeight: number;
  stackCellHeights: [number, number];
};
type QuadLayout = { kind: 'quad'; cell: number };

function computeLayout(count: number, containerWidth: number, gap: number): SingleLayout | PairLayout | ThreeLayout | QuadLayout {
  if (count === 1) {
    // 4:3 — matches the previous aspectRatio: 4/3 intent exactly.
    return { kind: 'single', width: containerWidth, height: Math.round((containerWidth * 3) / 4) };
  }
  if (count === 2) {
    return { kind: 'pair', cell: Math.round((containerWidth - gap) / 2) };
  }
  if (count === 3) {
    // Whole-block height from the full container width at a 3:2 ratio —
    // matches the previous threeRow aspectRatio: 3/2 intent exactly.
    const blockHeight = Math.round((containerWidth * 2) / 3);
    // Lead cell gets 2 of 3 flex shares (matching the previous
    // threeLead flex:2 / threeStack flex:1 split), stack gets the
    // remainder so the two widths always sum to exactly containerWidth - gap.
    const innerWidth = containerWidth - gap;
    const leadWidth = Math.round((innerWidth * 2) / 3);
    const stackWidth = innerWidth - leadWidth;
    const firstStackCell = Math.round((blockHeight - gap) / 2);
    const secondStackCell = blockHeight - gap - firstStackCell;
    return { kind: 'three', leadWidth, stackWidth, blockHeight, stackCellHeights: [firstStackCell, secondStackCell] };
  }
  // count >= 4 (composer/RPC both already cap at 4; defensively treated
  // the same as exactly 4 here too).
  return { kind: 'quad', cell: Math.round((containerWidth - gap) / 2) };
}

// Responsive 1/2/3/4-image layout — common social-post shapes:
//   1 → one large box (4:3)
//   2 → two square boxes side by side
//   3 → one large box on the left, two stacked squares on the right
//   4 → a 2x2 grid of squares
//
// Every cell's width/height is an explicit NUMBER computed from the
// measured container width (see computeLayout above) — never
// `aspectRatio` and never bare `flex` sizing. This app hit the identical
// failure mode once before in a very similar nested grid
// (components/collection/folder-cover-item-picker.tsx — see that file's
// own module comment: "aspectRatio-based sizing... measured height: 0 at
// runtime for every tile in this Modal/grid combination"), and the fix
// there was the same one applied here: stop asking Yoga to resolve
// aspectRatio through nested flex at all, and compute both dimensions
// directly instead. A first render (before onLayout has fired) renders
// nothing but the measuring View itself — one frame, imperceptible in
// practice — rather than guessing at a size and correcting it later.
export function AttachmentImageGrid({ images, borderRadius = DEFAULT_RADIUS, gap = DEFAULT_GAP, onPressImage, renderOverlay }: Props) {
  const radius = borderRadius;
  const count = images.length;
  const [containerWidth, setContainerWidth] = useState(0);

  if (count === 0) return null;

  function handleLayout(e: LayoutChangeEvent) {
    const width = Math.round(e.nativeEvent.layout.width);
    if (width > 0 && width !== containerWidth) setContainerWidth(width);
  }

  // Still keyed by count as an extra safety net — a count change always
  // gets a truly fresh measuring pass (and so a freshly-computed layout)
  // rather than reusing whatever containerWidth a differently-shaped
  // layout last measured, even though that width is normally identical
  // (same caller, same outer padding) across counts.
  const layoutKey = `count-${count}`;

  if (containerWidth === 0) {
    return <View key={layoutKey} onLayout={handleLayout} style={styles.measuring} />;
  }

  const layout = computeLayout(count, containerWidth, gap);

  if (layout.kind === 'single') {
    return (
      <View key={layoutKey} onLayout={handleLayout}>
        <Tile
          image={images[0]}
          index={0}
          width={layout.width}
          height={layout.height}
          radius={radius}
          onPress={onPressImage}
          overlay={renderOverlay?.(0)}
        />
      </View>
    );
  }

  if (layout.kind === 'pair') {
    return (
      <View key={layoutKey} onLayout={handleLayout} style={[styles.row, { gap }]}>
        {images.map((img, i) => (
          <Tile
            key={img.key}
            image={img}
            index={i}
            width={layout.cell}
            height={layout.cell}
            radius={radius}
            onPress={onPressImage}
            overlay={renderOverlay?.(i)}
          />
        ))}
      </View>
    );
  }

  if (layout.kind === 'three') {
    return (
      <View key={layoutKey} onLayout={handleLayout} style={[styles.row, { gap }]}>
        <Tile
          image={images[0]}
          index={0}
          width={layout.leadWidth}
          height={layout.blockHeight}
          radius={radius}
          onPress={onPressImage}
          overlay={renderOverlay?.(0)}
        />
        <View style={{ width: layout.stackWidth, gap }}>
          {[images[1], images[2]].map((img, i) => (
            <Tile
              key={img.key}
              image={img}
              index={i + 1}
              width={layout.stackWidth}
              height={layout.stackCellHeights[i]}
              radius={radius}
              onPress={onPressImage}
              overlay={renderOverlay?.(i + 1)}
            />
          ))}
        </View>
      </View>
    );
  }

  // layout.kind === 'quad'
  const four = images.slice(0, 4);
  return (
    <View key={layoutKey} onLayout={handleLayout} style={{ gap }}>
      <View style={[styles.row, { gap }]}>
        {[four[0], four[1]].map((img, i) => (
          <Tile
            key={img.key}
            image={img}
            index={i}
            width={layout.cell}
            height={layout.cell}
            radius={radius}
            onPress={onPressImage}
            overlay={renderOverlay?.(i)}
          />
        ))}
      </View>
      <View style={[styles.row, { gap }]}>
        {[four[2], four[3]].map((img, i) => (
          <Tile
            key={img.key}
            image={img}
            index={i + 2}
            width={layout.cell}
            height={layout.cell}
            radius={radius}
            onPress={onPressImage}
            overlay={renderOverlay?.(i + 2)}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // First-render-only measuring pass — full width (so onLayout reports
  // the real usable width immediately), zero height (no children), no
  // visible placeholder box. Also doubles as the onLayout target for
  // every subsequent render (each branch above re-attaches onLayout to
  // its own root too), so a genuine container-width change (e.g. a
  // device rotation) is still picked up, not just the very first mount.
  measuring: {
    width: '100%',
  },
  row: {
    flexDirection: 'row',
  },
});
