import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';

// RN doesn't expose the OS's real pull-to-refresh trigger distance, so this is
// a visual estimate only — it drives our own reveal/rotate/snap animation, not
// the actual refresh trigger (that stays fully native via RefreshControl).
export const PULL_THRESHOLD = 70;

type Props = {
  // 0 → resting, 1 → at the visual threshold. Fed from the list's onScroll
  // (contentOffset.y while overscrolled) — see app/(tabs)/index.tsx.
  pullProgress: SharedValue<number>;
  refreshing: boolean;
};

// Visual-only overlay drawn above the feed list; the real RefreshControl
// underneath keeps handling the gesture, threshold, and refresh callback —
// this component never touches any of that, it just reacts to it.
export function CacheCaseRefreshControl({ pullProgress, refreshing }: Props) {
  const refreshingSV = useSharedValue(0);
  const spin = useSharedValue(0);
  const snap = useSharedValue(1);
  const displayOpacity = useSharedValue(0);
  const displayScale = useSharedValue(0.5);

  // Continuous spin while refreshing; explicit fade/collapse when it ends.
  useEffect(() => {
    refreshingSV.value = refreshing ? 1 : 0;
    if (refreshing) {
      displayOpacity.value = withTiming(1, { duration: 120 });
      displayScale.value = withTiming(1, { duration: 120 });
      spin.value = 0;
      spin.value = withRepeat(withTiming(360, { duration: 900, easing: Easing.linear }), -1);
    } else {
      cancelAnimation(spin);
      displayOpacity.value = withTiming(0, { duration: 260 });
      displayScale.value = withTiming(0.5, { duration: 260 });
    }
  }, [refreshing, refreshingSV, displayOpacity, displayScale, spin]);

  // Progressive reveal + snap while the user is actively pulling (ignored
  // once a refresh is in flight — that phase is owned by the effect above).
  useAnimatedReaction(
    () => pullProgress.value,
    (current, previous) => {
      if (refreshingSV.value === 1) return;
      displayOpacity.value = interpolate(current, [0, 1], [0, 1], 'clamp');
      displayScale.value = interpolate(current, [0, 1], [0.5, 1], 'clamp');
      if (current >= 1 && (previous ?? 0) < 1) {
        snap.value = withSequence(withTiming(1.18, { duration: 110 }), withSpring(1, { damping: 9 }));
      }
    },
  );

  const style = useAnimatedStyle(() => {
    const rotateDeg =
      refreshingSV.value === 1 ? spin.value : interpolate(pullProgress.value, [0, 1], [0, 180], 'clamp');
    return {
      opacity: displayOpacity.value,
      transform: [{ scale: displayScale.value * snap.value }, { rotate: `${rotateDeg}deg` }],
    };
  });

  return (
    <Animated.View style={[styles.wrap, style]} pointerEvents="none">
      <CacheCaseLogo variant="icon" size={25} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: PULL_THRESHOLD,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
