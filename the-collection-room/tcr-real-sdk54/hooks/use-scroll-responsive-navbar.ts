import { useCallback, useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { useFocusEffect } from 'expo-router';
import { withSpring } from 'react-native-reanimated';

import { useTabVisibility } from '@/lib/tab-visibility-context';

// Extracted verbatim from the Feed screen's original scroll handler
// (app/(tabs)/index.tsx) — the source of truth for this behavior. Do not
// tune these without re-checking Feed still feels identical.
const HIDE_DELTA_THRESHOLD = 6;
const HIDE_MIN_OFFSET = 80;
const SHOW_DELTA_THRESHOLD = -6;
const HIDDEN_TRANSLATE_Y = 102;
const VISIBLE_TRANSLATE_Y = 0;
const SPRING_CONFIG = { damping: 20, stiffness: 200 };
export const NAVBAR_SCROLL_EVENT_THROTTLE = 16;

type Options = {
  // false for screens that show the floating navbar but must keep it fully
  // visible and stationary (e.g. the item-detail route) — the hook still
  // resets the shared translateY to visible on focus (so a bar left hidden
  // by a previous screen never leaks in), it just never hides it here.
  enabled?: boolean;
};

/**
 * Reuses the Feed screen's exact scroll-direction navbar hide/show
 * behavior (same thresholds, same spring config, same hidden/visible
 * translateY values) via the single shared `translateY` value from
 * TabVisibilityProvider — so every screen using this hook drives the same
 * one floating navbar instance, never a per-screen copy.
 */
export function useScrollResponsiveNavbar(options?: Options) {
  const enabled = options?.enabled ?? true;
  const { translateY } = useTabVisibility();
  const lastScrollY = useRef(0);
  const tabBarHidden = useRef(false);

  // A navbar hidden by scrolling on a previous screen (or by this screen's
  // own last visit) must never carry over to a freshly-focused screen.
  useFocusEffect(
    useCallback(() => {
      lastScrollY.current = 0;
      tabBarHidden.current = false;
      translateY.value = withSpring(VISIBLE_TRANSLATE_Y, SPRING_CONFIG);
    }, [translateY]),
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!enabled) return;
      const y = event.nativeEvent.contentOffset.y;
      const dy = y - lastScrollY.current;
      // Hide on scroll down (past 80px), show on scroll up — identical to
      // Feed's original inline logic.
      if (dy > HIDE_DELTA_THRESHOLD && y > HIDE_MIN_OFFSET && !tabBarHidden.current) {
        tabBarHidden.current = true;
        translateY.value = withSpring(HIDDEN_TRANSLATE_Y, SPRING_CONFIG);
      } else if (dy < SHOW_DELTA_THRESHOLD && tabBarHidden.current) {
        tabBarHidden.current = false;
        translateY.value = withSpring(VISIBLE_TRANSLATE_Y, SPRING_CONFIG);
      }
      lastScrollY.current = y;
    },
    [enabled, translateY],
  );

  return { onScroll, scrollEventThrottle: NAVBAR_SCROLL_EVENT_THROTTLE };
}
