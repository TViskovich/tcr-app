import { useCallback } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { useFocusEffect } from 'expo-router';

import { useTabVisibility } from '@/lib/tab-visibility-context';

const VISIBLE_TRANSLATE_Y = 0;
export const NAVBAR_SCROLL_EVENT_THROTTLE = 16;

type Options = {
  // No longer changes behavior — the floating navbar is always stationary
  // now (see below). Kept so existing call sites that pass this don't need
  // to change.
  enabled?: boolean;
};

/**
 * The floating navbar is fixed to the bottom of the screen (Instagram-
 * style) and no longer reacts to scroll — previously this drove the shared
 * `translateY` from TabVisibilityProvider to hide/show it on scroll
 * direction, which is exactly what made it appear to bounce/move with the
 * page. That logic is removed; this hook now only guarantees `translateY`
 * stays at its visible value (belt-and-braces against any stale value from
 * before this change) and returns the same `onScroll`/`scrollEventThrottle`
 * shape every screen already wires into its ScrollView/FlatList, so no call
 * site needs to change.
 */
export function useScrollResponsiveNavbar(_options?: Options) {
  const { translateY } = useTabVisibility();

  useFocusEffect(
    useCallback(() => {
      translateY.value = VISIBLE_TRANSLATE_Y;
    }, [translateY]),
  );

  const onScroll = useCallback((_event: NativeSyntheticEvent<NativeScrollEvent>) => {}, []);

  return { onScroll, scrollEventThrottle: NAVBAR_SCROLL_EVENT_THROTTLE };
}
