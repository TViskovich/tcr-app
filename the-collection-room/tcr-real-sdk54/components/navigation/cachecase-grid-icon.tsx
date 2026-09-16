import { useId } from 'react';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

// Replaces the old slanted/filled cachecase-icon.png center nav mark with an
// outline-only 3x3 "9-square" grid, drawn to the same visual language as the
// other nav icons (hollow strokes, no filled centers) instead of a raster
// brand asset. Same geometry renders both states — only the stroke color
// (and gradient presence) changes — so dormant/active can never drift apart
// in shape.
const VIEWBOX = 24;
// Squares sized up (5 → 6, +20%) with the gap tightened to compensate
// (2.5 → 1, later eased back up slightly to 1.3 — see below) so the bigger
// squares still fill the exact same 24x24 box. This is what turns "9 small
// badges with visible gaps" into one cohesive tight grid at the same
// overall footprint.
const SQUARE = 6;
// Slightly more breathing room between squares (1 → 1.3) — box size is
// unchanged; margin trimmed to match (2 → 1.7) so the grid still fills the
// same 24x24 box and stays centered (3*6 + 2*1.3 + 2*1.7 = 24).
const GAP = 1.3;
const MARGIN = 1.7;
// Smaller relative to the bigger squares than before (1.4 → 1.1) — a
// tighter corner radius reads as a sleeker/more geometric skeleton grid
// rather than a bubbly rounded one.
const CORNER_RADIUS = 1.1;
// Substantially thinner than 1.6 → 1.4 → 1.0 → 0.9 — this pass targets a
// clearly finer, more delicate line rather than another small step down.
const STROKE_WIDTH = 0.6;
const POSITIONS = [MARGIN, MARGIN + SQUARE + GAP, MARGIN + 2 * (SQUARE + GAP)];

// Matches the other nav icons' inactive color (INACTIVE_COLOR in both
// global-floating-tab-bar.tsx and app/(tabs)/_layout.tsx) so the dormant
// grid reads as the same weight/prominence as Home/Profile.
const INACTIVE_STROKE = '#555762';
// Cool foil/holographic direction — cyan into violet into lavender into a
// soft pink — deliberately narrower than the raw brand mark's full cyan→
// green/yellow sweep (dropped here) and less saturated than NEON_BORDER
// (profile-v2-identity-card.tsx) or IRIDESCENT_BORDER (profile-v2-
// selector.tsx, which still carries a green stop): this reads as premium
// holographic light rather than rainbow neon/candy.
const IRIDESCENT_STROKE = ['#7FD8FF', '#9A8CFF', '#B8A7FF', '#F3A6D8'] as const;

type Props = {
  active: boolean;
  size?: number;
};

// Default bumped from 28 (exactly ICON_SIZE, matching Home/Profile's raw
// glyph box) to 35 — a hollow-outline grid at the same pixel box as a solid
// MaterialIcons glyph reads smaller/lighter than its neighbors, so it needs
// a bit more room to feel like an equal-weight nav icon.
export function CacheCaseGridIcon({ active, size = 35 }: Props) {
  // Unique per instance so two mounted copies (e.g. this bar and the
  // tabs-group bar, or a future duplicate) never collide over the same
  // gradient id — react-native-svg's Android renderer doesn't scope ids to
  // their own <Svg>.
  const gradientId = `cachecase-grid-gradient-${useId()}`;
  const stroke = active ? `url(#${gradientId})` : INACTIVE_STROKE;

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}>
      {active && (
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            {IRIDESCENT_STROKE.map((color, i) => (
              <Stop key={color} offset={i / (IRIDESCENT_STROKE.length - 1)} stopColor={color} />
            ))}
          </LinearGradient>
        </Defs>
      )}
      {POSITIONS.map((y) =>
        POSITIONS.map((x) => (
          <Rect
            key={`${x}-${y}`}
            x={x}
            y={y}
            width={SQUARE}
            height={SQUARE}
            rx={CORNER_RADIUS}
            ry={CORNER_RADIUS}
            fill="none"
            stroke={stroke}
            strokeWidth={STROKE_WIDTH}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )),
      )}
    </Svg>
  );
}
