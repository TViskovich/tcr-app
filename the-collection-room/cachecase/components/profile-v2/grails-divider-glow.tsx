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

type Props = {
  cellWidth: number;
  cellHeight: number;
  gap: number;
  // The owner's theme colours (getProfileBannerAccent(...).colors). The
  // streak blends through them.
  colors: readonly ColorValue[];
  // False when the grid is off-screen or being reordered: no animation runs.
  active: boolean;
};

export function GrailsDividerGlow({ cellWidth, cellHeight, gap, colors, active }: Props) {
  const reducedMotion = useReducedMotion();
  const width = cellWidth * 3 + gap * 2;
  const height = cellHeight * 3 + gap * 2;

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

  const running = active && isRouteFocused && isAppActive && !reducedMotion;
  const progress = useSharedValue(0);
  useEffect(() => {
    if (!running) {
      cancelAnimation(progress);
      return;
    }
    progress.set(0);
    progress.set(withRepeat(withTiming(1, { duration: LOOP_MS, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(progress);
  }, [running, progress]);

  const streakColors = streakGradient(colors);
  const baseColor = colors[Math.floor(colors.length / 2)] ?? colors[0];
  // Channel positions: the gaps after the first and second column / row.
  const x1 = cellWidth;
  const x2 = cellWidth * 2 + gap;
  const y1 = cellHeight;
  const y2 = cellHeight * 2 + gap;

  return (
    <View pointerEvents="none" style={[styles.layer, { width, height }]}>
      {/* Horizontal channels */}
      <Channel left={0} top={y1} length={width} thickness={gap} horizontal baseColor={baseColor}>
        {!reducedMotion && (
          <ChannelLights progress={progress} segment={0} length={width} thickness={gap} horizontal colors={streakColors} />
        )}
      </Channel>
      <Channel left={0} top={y2} length={width} thickness={gap} horizontal baseColor={baseColor}>
        {!reducedMotion && (
          <ChannelLights progress={progress} segment={2} length={width} thickness={gap} horizontal reverse colors={streakColors} />
        )}
      </Channel>
      {/* Vertical channels */}
      <Channel left={x2} top={0} length={height} thickness={gap} baseColor={baseColor}>
        {!reducedMotion && (
          <ChannelLights progress={progress} segment={1} length={height} thickness={gap} colors={streakColors} />
        )}
      </Channel>
      <Channel left={x1} top={0} length={height} thickness={gap} baseColor={baseColor}>
        {!reducedMotion && (
          <ChannelLights progress={progress} segment={3} length={height} thickness={gap} reverse colors={streakColors} />
        )}
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
  children,
}: {
  left: number;
  top: number;
  length: number;
  thickness: number;
  horizontal?: boolean;
  baseColor: ColorValue | undefined;
  children: React.ReactNode;
}) {
  return (
    <View
      style={[
        styles.channel,
        { left, top },
        horizontal ? { width: length, height: thickness } : { width: thickness, height: length },
      ]}>
      {baseColor ? <View style={[StyleSheet.absoluteFill, { backgroundColor: baseColor, opacity: BASE_OPACITY }]} /> : null}
      {children}
    </View>
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
      <LinearGradient
        colors={colors}
        start={horizontal ? { x: 0, y: 0.5 } : { x: 0.5, y: 0 }}
        end={horizontal ? { x: 1, y: 0.5 } : { x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
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
});
