import { useCallback, useEffect, useState } from 'react';
import { AppState, type ColorValue, StyleSheet, View } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

// Profile V2's optional "Grails Divider Glow" (profiles.grails_divider_glow
// — the profile owner's choice, so visitors see it too). A soft light that
// travels through the narrow gaps between the nine Grail tiles, tinted with
// the owner's banner theme.
//
// Purely additive and isolated: drawn BEHIND the tiles, only inside the four
// divider channels (the two vertical and two horizontal gaps), so it never
// covers a card, and with pointerEvents="none" so it never takes a touch —
// taps, long-press and drag-to-reorder all go to the tiles as before. Empty
// slots don't matter: the channels are the grid's, not the cards'.
//
// One looping shared value drives everything on the UI thread (no React
// state per frame, no shared-value reads during render). Two streaks, half a
// loop apart (LIGHT_PHASES), run the same circuit around the centre tile —
// top gap left→right, right gap down, bottom gap right→left, left gap up.
// It stops when `active` is false (scrolled off-screen, edit/reorder mode),
// when the screen loses focus, and while the app is in the background; with
// Reduce Motion on it never moves — the channels just keep a faint static
// tint.
//
// Animated Dividers also includes GrailsPerimeterGlow (below): two slower
// lights on the outside of the whole grid that bounce off each other, drawn
// above the tiles.

const LOOP_MS = 9000;
// The moving highlight's length along a channel.
const STREAK_LENGTH = 96;
// Two lights on the same circuit, half a loop apart. The circuit is four
// equal segments, one per channel, so half a loop is exactly two segments:
// whenever one light is in the top gap the other is in the bottom gap (and
// right ↔ left). They're always in opposite, parallel channels — same
// direction, same speed, never crossing, meeting or overtaking.
const LIGHT_PHASES = [0, 0.5] as const;
// The faint, always-on tint of the channels themselves — a quiet base for
// the streak rather than permanently bright lines.
const BASE_OPACITY = 0.14;

// Luminous treatment (dark-neutral banners — see getGrailsEffectTheme): the
// streaks are silver-white with a bright core inside a soft halo. Both live
// INSIDE the streak's own box (the full streak is the halo, at HALO_OPACITY;
// a shorter, centred copy at full opacity is the core), so they ride the
// existing transform and visibility windows exactly — no blur filter, no
// extra animated value, nothing popping in at a segment boundary. The
// channel base tint is a touch quieter, since silver reads brighter than the
// charcoal it replaces.
const LUMINOUS_BASE_OPACITY = 0.1;
const HALO_OPACITY = 0.45;
const CORE_LENGTH_SCALE = 0.45;

type Props = {
  cellWidth: number;
  cellHeight: number;
  gap: number;
  // The effect colours (getGrailsEffectTheme(...).colors) — the owner's
  // theme, or silver-white for a dark banner. The streak blends through them.
  colors: readonly ColorValue[];
  // Dark-banner luminous treatment: adds the streak halo.
  luminous?: boolean;
  // False when the grid is off-screen or being reordered: no animation runs.
  active: boolean;
};

// Whether a Grails glow animation should run right now. Shared by the inner
// divider lights and the outer perimeter light, so both pause together.
function useGlowRunning(active: boolean) {
  const reducedMotion = useReducedMotion();

  // Same focus + app-state handling as GrailSlotPreview's own animation: a
  // screen can stay "focused" while the OS backgrounds the app.
  const [isRouteFocused, setIsRouteFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setIsRouteFocused(true);
      return () => setIsRouteFocused(false);
    }, []),
  );
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setIsAppActive(state === 'active'));
    return () => sub.remove();
  }, []);

  return { running: active && isRouteFocused && isAppActive && !reducedMotion, reducedMotion };
}

// One linear 0→1 progress value, looping every `duration` ms while `running`.
function useLoopProgress(running: boolean, duration: number) {
  const progress = useSharedValue(0);
  useEffect(() => {
    if (!running || duration <= 0) {
      cancelAnimation(progress);
      return;
    }
    progress.set(0);
    progress.set(withRepeat(withTiming(1, { duration, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(progress);
  }, [running, duration, progress]);
  return progress;
}

export function GrailsDividerGlow({ cellWidth, cellHeight, gap, colors, luminous = false, active }: Props) {
  const width = cellWidth * 3 + gap * 2;
  const height = cellHeight * 3 + gap * 2;

  const { running, reducedMotion } = useGlowRunning(active);
  const progress = useLoopProgress(running, LOOP_MS);

  const streakColors = streakGradient(colors);
  const base = {
    baseColor: colors[Math.floor(colors.length / 2)] ?? colors[0],
    baseOpacity: luminous ? LUMINOUS_BASE_OPACITY : BASE_OPACITY,
  };
  const lights = { progress, thickness: gap, colors: streakColors, halo: luminous };
  // Channel positions: the gaps after the first and second column / row.
  const x1 = cellWidth;
  const x2 = cellWidth * 2 + gap;
  const y1 = cellHeight;
  const y2 = cellHeight * 2 + gap;

  return (
    <View pointerEvents="none" style={[styles.layer, { width, height }]}>
      {/* Horizontal channels */}
      <Channel left={0} top={y1} length={width} thickness={gap} horizontal {...base}>
        {!reducedMotion && <ChannelLights {...lights} segment={0} length={width} horizontal />}
      </Channel>
      <Channel left={0} top={y2} length={width} thickness={gap} horizontal {...base}>
        {!reducedMotion && <ChannelLights {...lights} segment={2} length={width} horizontal reverse />}
      </Channel>
      {/* Vertical channels */}
      <Channel left={x2} top={0} length={height} thickness={gap} {...base}>
        {!reducedMotion && <ChannelLights {...lights} segment={1} length={height} />}
      </Channel>
      <Channel left={x1} top={0} length={height} thickness={gap} {...base}>
        {!reducedMotion && <ChannelLights {...lights} segment={3} length={height} reverse />}
      </Channel>
    </View>
  );
}

// transparent → theme colours → transparent: the soft head and tail.
type GradientColors = readonly [ColorValue, ColorValue, ...ColorValue[]];

function streakGradient(colors: readonly ColorValue[]): GradientColors {
  const [first = '#FFFFFF', ...rest] = colors;
  return ['transparent', first, ...rest, 'transparent'];
}

function Channel({
  left,
  top,
  length,
  thickness,
  horizontal = false,
  baseColor,
  baseOpacity,
  children,
}: {
  left: number;
  top: number;
  length: number;
  thickness: number;
  horizontal?: boolean;
  baseColor: ColorValue | undefined;
  baseOpacity: number;
  children: React.ReactNode;
}) {
  return (
    <View
      style={[
        styles.channel,
        { left, top },
        horizontal ? { width: length, height: thickness } : { width: thickness, height: length },
      ]}>
      {baseColor ? <View style={[StyleSheet.absoluteFill, { backgroundColor: baseColor, opacity: baseOpacity }]} /> : null}
      {children}
    </View>
  );
}

// A streak's gradient, filling its (moving) box. With `halo`, the luminous
// treatment: the whole box at HALO_OPACITY plus a shorter full-strength core
// in its centre.
function StreakFill({
  colors,
  horizontal,
  length,
  halo,
}: {
  colors: GradientColors;
  horizontal: boolean;
  length: number;
  halo: boolean;
}) {
  const direction = horizontal
    ? { start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } }
    : { start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } };
  if (!halo) return <LinearGradient colors={colors} {...direction} style={StyleSheet.absoluteFill} />;

  const core = length * CORE_LENGTH_SCALE;
  const inset = (length - core) / 2;
  return (
    <>
      <LinearGradient colors={colors} {...direction} style={[StyleSheet.absoluteFill, { opacity: HALO_OPACITY }]} />
      <LinearGradient
        colors={colors}
        {...direction}
        style={[
          styles.streakCore,
          horizontal ? { left: inset, width: core, top: 0, bottom: 0 } : { top: inset, height: core, left: 0, right: 0 },
        ]}
      />
    </>
  );
}

type StreakProps = {
  progress: SharedValue<number>;
  segment: number;
  length: number;
  thickness: number;
  horizontal?: boolean;
  reverse?: boolean;
  colors: GradientColors;
  halo: boolean;
};

// Both lights' passes through one channel. Each light is the same circuit
// at a fixed phase offset (LIGHT_PHASES) of the ONE shared progress value,
// so they can't drift apart — not across loop repeats, pauses, or resumes.
function ChannelLights(props: StreakProps) {
  return (
    <>
      {LIGHT_PHASES.map((phase) => (
        <Streak key={phase} {...props} phase={phase} />
      ))}
    </>
  );
}

// One light's quarter of the circuit: visible only while that light's
// position in the loop is in this channel's segment, travelling the full
// channel (entering and leaving off its ends).
function Streak({
  progress,
  segment,
  length,
  thickness,
  horizontal = false,
  reverse = false,
  colors,
  halo,
  phase,
}: StreakProps & { phase: number }) {
  const style = useAnimatedStyle(() => {
    // This light's own position in the loop: the shared progress, shifted
    // by its phase and wrapped, so a light past the end continues from the
    // start with no jump.
    const local = ((progress.get() + phase) % 1) * 4 - segment;
    if (local < 0 || local > 1) return { opacity: 0, transform: [{ translateX: 0 }, { translateY: 0 }] };
    const t = reverse ? 1 - local : local;
    const offset = -STREAK_LENGTH + t * (length + STREAK_LENGTH);
    return {
      opacity: 1,
      transform: horizontal ? [{ translateX: offset }, { translateY: 0 }] : [{ translateX: 0 }, { translateY: offset }],
    };
  });

  return (
    <Animated.View
      style={[
        styles.streak,
        horizontal ? { width: STREAK_LENGTH, height: thickness } : { width: thickness, height: STREAK_LENGTH },
        style,
      ]}>
      <StreakFill colors={colors} horizontal={horizontal} length={STREAK_LENGTH} halo={halo} />
    </Animated.View>
  );
}

// ── Outer perimeter lights ──────────────────────────────────────────────────
// Part of Animated Dividers: two more lights on the OUTSIDE edge of the whole
// 3×3 grid — dimmer and slower than the inner ones — that run towards each
// other, meet head-on, bounce apart, and meet again on the far side. Rendered
// by the grid as its LAST child (above the tiles): the outer edge has no gap
// to shine through, so they run along the grid's outermost
// PERIMETER_THICKNESS points, inside the grid's own box. Same
// pointerEvents="none", same pausing (useGlowRunning) as the inner lights;
// with Reduce Motion they aren't drawn at all.
//
// Both lights come from ONE looping shared value, as mirror images about a
// fixed point C on the perimeter (top centre): light A at C + x, light B at
// C − x, where x is a triangle wave of that value. So they always move at the
// same speed in opposite directions, can't drift apart, and reverse in the
// same frame — at x = min they meet at C, at x = max at C + perimeter/2
// (bottom centre). Each only ever covers its own half of the track, so they
// never pass or overtake. The triangle wave is continuous across the loop
// point, so there's no jump when the timing repeats.
//
// Positions are distances clockwise round the perimeter from the top-left
// corner. Each edge clips the streaks to itself, so a light rounding a corner
// is split across both edges — it turns rather than jumping. The perimeter
// comes from the grid's measured size (onLayout), never screen-size
// constants.

// Points per second along the perimeter. The inner lights cover a channel
// (plus their own length) in a quarter of LOOP_MS — roughly 215–285 pt/s on
// a phone — so this is noticeably slower.
const PERIMETER_SPEED = 150;
const PERIMETER_STREAK_LENGTH = 120;
const HALF_STREAK = PERIMETER_STREAK_LENGTH / 2;
const PERIMETER_THICKNESS = 1.5;
// Dimmer than the inner streaks (drawn at full opacity).
const PERIMETER_OPACITY = 0.6;
// Closest the two streak CENTRES get (each is this far from the meeting
// point): their faded tails just overlap, so they read as touching, never as
// passing through each other.
const MEET_DISTANCE = PERIMETER_STREAK_LENGTH * 0.4;
// +1: light A (clockwise from C on the way out); −1: light B (anticlockwise).
const LIGHTS = [1, -1] as const;

// Luminous perimeter: a little stronger overall, because the halo half of
// each streak (HALO_OPACITY) is fainter than a plain streak.
const LUMINOUS_PERIMETER_OPACITY = 0.7;

export function GrailsPerimeterGlow({
  colors,
  luminous = false,
  active,
}: {
  colors: readonly ColorValue[];
  // Dark-banner luminous treatment: silver core + halo (see StreakFill).
  luminous?: boolean;
  active: boolean;
}) {
  const { running, reducedMotion } = useGlowRunning(active);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const perimeter = 2 * (width + height);
  // One full cycle: each light goes meet → far meet → meet, i.e. twice its
  // half of the track minus the two meeting gaps.
  const travel = perimeter - 4 * MEET_DISTANCE;
  const progress = useLoopProgress(running && travel > 0, Math.round((travel / PERIMETER_SPEED) * 1000));

  if (reducedMotion) return null;

  const streakColors = streakGradient(colors);
  // C = the top edge's midpoint; the far meeting point is the bottom's.
  const edge = { progress, perimeter, meetPoint: width / 2, colors: streakColors, halo: luminous };

  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { opacity: luminous ? LUMINOUS_PERIMETER_OPACITY : PERIMETER_OPACITY }]}
      onLayout={(e) => {
        const { width: w, height: h } = e.nativeEvent.layout;
        if (w !== width || h !== height) setSize({ width: w, height: h });
      }}>
      {size && (
        <>
          {/* Clockwise: top → right → bottom (right to left) → left (upwards). */}
          <PerimeterEdge {...edge} left={0} top={0} length={width} start={0} horizontal />
          <PerimeterEdge {...edge} left={width - PERIMETER_THICKNESS} top={0} length={height} start={width} />
          <PerimeterEdge
            {...edge}
            left={0}
            top={height - PERIMETER_THICKNESS}
            length={width}
            start={width + height}
            horizontal
            reverse
          />
          <PerimeterEdge {...edge} left={0} top={0} length={height} start={2 * width + height} reverse />
        </>
      )}
    </View>
  );
}

type PerimeterEdgeProps = {
  progress: SharedValue<number>;
  perimeter: number;
  // C: where the lights meet (and, half the perimeter on, meet again).
  meetPoint: number;
  colors: GradientColors;
  halo: boolean;
  left: number;
  top: number;
  length: number;
  // This edge's distance clockwise round the perimeter from the top-left
  // corner.
  start: number;
  horizontal?: boolean;
  // Perimeter distance runs right→left / bottom→top along this edge.
  reverse?: boolean;
};

function PerimeterEdge(props: PerimeterEdgeProps) {
  const { left, top, length, horizontal = false } = props;
  return (
    <View
      style={[
        styles.channel,
        { left, top },
        horizontal
          ? { width: length, height: PERIMETER_THICKNESS }
          : { width: PERIMETER_THICKNESS, height: length },
      ]}>
      {LIGHTS.map((direction) => (
        <PerimeterStreak key={direction} {...props} direction={direction} />
      ))}
    </View>
  );
}

// One light's part on one edge (if any of it is on this edge right now).
function PerimeterStreak({
  progress,
  perimeter,
  meetPoint,
  colors,
  halo,
  length,
  start,
  horizontal = false,
  reverse = false,
  direction,
}: PerimeterEdgeProps & { direction: (typeof LIGHTS)[number] }) {
  const style = useAnimatedStyle(() => {
    // Triangle wave 0→1→0 over one loop, at ½ when progress is 0 — so the
    // lights START a quarter of the track either side of C (opposite each
    // other) — and continuous across the loop point.
    const phase = (progress.get() + 0.25) % 1;
    const wave = 1 - Math.abs(2 * phase - 1);
    const x = MEET_DISTANCE + wave * (perimeter / 2 - 2 * MEET_DISTANCE);
    // This light's centre, as a distance past this edge's start in
    // [0, perimeter).
    let center = (meetPoint + direction * x - start) % perimeter;
    if (center < 0) center += perimeter;
    // Its streak spans center ± HALF_STREAK. On this edge if that overlaps
    // [0, length] — either directly, or (just before the edge's start) one
    // perimeter back, for a light rounding the corner into this edge.
    if (center - HALF_STREAK >= length) {
      if (center + HALF_STREAK > perimeter) center -= perimeter;
      else return { opacity: 0, transform: [{ translateX: 0 }, { translateY: 0 }] };
    }
    const along = (reverse ? length - center : center) - HALF_STREAK;
    return {
      opacity: 1,
      transform: horizontal ? [{ translateX: along }, { translateY: 0 }] : [{ translateX: 0 }, { translateY: along }],
    };
  });

  return (
    <Animated.View
      style={[
        styles.streak,
        horizontal
          ? { width: PERIMETER_STREAK_LENGTH, height: PERIMETER_THICKNESS }
          : { width: PERIMETER_THICKNESS, height: PERIMETER_STREAK_LENGTH },
        style,
      ]}>
      <StreakFill colors={colors} horizontal={horizontal} length={PERIMETER_STREAK_LENGTH} halo={halo} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  channel: {
    position: 'absolute',
    overflow: 'hidden',
  },
  streak: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  // Luminous core — placed inline (StreakFill).
  streakCore: {
    position: 'absolute',
  },
});
