import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { ClipPath, Defs, Image as SvgImage, Rect, Text as SvgText } from 'react-native-svg';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { prepareGrailsTileImages, shareJpegFromPngBase64 } from '@/lib/share/share-image';
import type { GrailSlot } from '@/types';

// A shareable picture of someone's Grails showcase for "Share Elsewhere":
// the same 3×3 grid, in slot order (slot_index 0-8, left to right, top to
// bottom), each Grail's image in its own card-shaped tile and empty slots as
// empty tiles — so the arrangement the collector chose is preserved.
//
// Built from react-native-svg (already a dependency) rather than a new
// view-capture library: an offscreen <Svg> is laid out with each tile's
// image as a LOCAL JPEG (lib/share/share-image.ts signs and downloads them
// through the app's existing authorized image path), and once every tile
// has loaded, Svg.toDataURL rasterizes it at the device's screen scale. The
// result is saved as a JPEG in the share cache. Nothing is shown on screen.

const CANVAS_WIDTH = 360; // points; x3 on current iPhones -> 1080px wide
const PADDING = 16;
const HEADER_HEIGHT = 36;
const GAP = 4;
const COLS = 3;
const CARD_ASPECT_RATIO = 2.5 / 3.5; // the profile grid's own cell shape
const CELL_WIDTH = (CANVAS_WIDTH - PADDING * 2 - GAP * (COLS - 1)) / COLS;
const CELL_HEIGHT = CELL_WIDTH / CARD_ASPECT_RATIO;
const GRID_TOP = PADDING + HEADER_HEIGHT;
const CANVAS_HEIGHT = Math.round(GRID_TOP + CELL_HEIGHT * 3 + GAP * 2 + PADDING);
const TILE_RADIUS = 6;
// Local files load almost instantly; this only bounds a tile that never
// reports onLoad, after which the grid is captured with that tile empty.
const TILE_LOAD_TIMEOUT_MS = 4_000;

type Job = {
  tiles: (string | null)[];
  username: string;
  resolve: (uri: string | null) => void;
};

// The image a Grail tile shows: an item's primary image, or a collection's
// first preview image (the first one its grid tile crossfades through).
function tileImageId(slot: GrailSlot | undefined): string | null {
  if (!slot) return null;
  if (slot.entry_type === 'item') return slot.item?.primary_image_id ?? null;
  return slot.previewImageIds?.[0] ?? null;
}

// Returns the offscreen renderer (mount it anywhere in the screen) and
// compose(), which resolves to a local JPEG of the showcase — or null when
// there's nothing to show or anything fails, so the share stays text-only.
export function useGrailsShareImage(): {
  renderer: ReactNode;
  compose: (slots: GrailSlot[], username: string) => Promise<string | null>;
} {
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef<Job | null>(null);

  const finish = useCallback((uri: string | null) => {
    const current = jobRef.current;
    jobRef.current = null;
    setJob(null);
    current?.resolve(uri);
  }, []);

  // A screen leaving mid-compose resolves the pending share as text-only.
  useEffect(() => () => jobRef.current?.resolve(null), []);

  const compose = useCallback(
    async (slots: GrailSlot[], username: string) => {
      const bySlotIndex = new Map(slots.map((s) => [s.slot_index, s]));
      const ids = Array.from({ length: 9 }, (_, i) => tileImageId(bySlotIndex.get(i)));
      if (!ids.some(Boolean)) return null;

      const tiles = await prepareGrailsTileImages(ids);
      if (!tiles.some(Boolean)) return null;

      // One showcase at a time; a newer request replaces an unfinished one.
      jobRef.current?.resolve(null);
      return new Promise<string | null>((resolve) => {
        const next = { tiles, username, resolve };
        jobRef.current = next;
        setJob(next);
      });
    },
    [],
  );

  return {
    renderer: job ? <GrailsShareCanvas key={job.tiles.join('|')} job={job} onDone={finish} /> : null,
    compose,
  };
}

function GrailsShareCanvas({ job, onDone }: { job: Job; onDone: (uri: string | null) => void }) {
  const svgRef = useRef<Svg>(null);
  const expected = job.tiles.filter(Boolean).length;
  const loaded = useRef(0);
  const captured = useRef(false);

  const capture = useCallback(() => {
    if (captured.current) return;
    captured.current = true;
    const svg = svgRef.current;
    if (!svg) {
      onDone(null);
      return;
    }
    svg.toDataURL(
      (base64) => {
        if (!base64) onDone(null);
        else void shareJpegFromPngBase64(base64).then(onDone);
      },
      { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    );
  }, [onDone]);

  useEffect(() => {
    const timer = setTimeout(capture, TILE_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [capture]);

  function handleTileLoad() {
    loaded.current += 1;
    // Next frame, so the last tile is drawn into the view before capture.
    if (loaded.current >= expected) requestAnimationFrame(capture);
  }

  return (
    <View style={styles.offscreen} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg ref={svgRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT}>
        <Rect x={0} y={0} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill={PV2.bg} />
        <SvgText x={PADDING} y={PADDING + 18} fill={PV2.textPrimary} fontSize={16} fontWeight="700">
          {`@${job.username}`}
        </SvgText>
        <SvgText
          x={CANVAS_WIDTH - PADDING}
          y={PADDING + 18}
          fill={PV2.textSecondary}
          fontSize={11}
          fontWeight="700"
          letterSpacing={1.5}
          textAnchor="end">
          GRAILS · CACHECASE
        </SvgText>
        <Defs>
          {job.tiles.map((_, i) => {
            const { x, y } = tileOrigin(i);
            return (
              <ClipPath key={i} id={`grail-tile-${i}`}>
                <Rect x={x} y={y} width={CELL_WIDTH} height={CELL_HEIGHT} rx={TILE_RADIUS} ry={TILE_RADIUS} />
              </ClipPath>
            );
          })}
        </Defs>
        {job.tiles.map((uri, i) => {
          const { x, y } = tileOrigin(i);
          return (
            <Rect
              key={`bg-${i}`}
              x={x}
              y={y}
              width={CELL_WIDTH}
              height={CELL_HEIGHT}
              rx={TILE_RADIUS}
              ry={TILE_RADIUS}
              fill={uri ? PV2.panel : 'rgba(255,255,255,0.04)'}
              stroke={uri ? undefined : PV2.border}
              strokeWidth={uri ? 0 : 1}
            />
          );
        })}
        {job.tiles.map((uri, i) => {
          if (!uri) return null;
          const { x, y } = tileOrigin(i);
          return (
            <SvgImage
              key={`img-${i}`}
              x={x}
              y={y}
              width={CELL_WIDTH}
              height={CELL_HEIGHT}
              href={{ uri }}
              preserveAspectRatio="xMidYMid slice"
              clipPath={`url(#grail-tile-${i})`}
              onLoad={handleTileLoad}
            />
          );
        })}
      </Svg>
    </View>
  );
}

function tileOrigin(index: number) {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return { x: PADDING + col * (CELL_WIDTH + GAP), y: GRID_TOP + row * (CELL_HEIGHT + GAP) };
}

const styles = StyleSheet.create({
  // Laid out (so the native view exists to render from) but never visible.
  offscreen: {
    position: 'absolute',
    left: -10_000,
    top: 0,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  },
});
