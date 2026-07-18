import React, { createContext, useContext } from 'react';
import { useSharedValue } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

// Single source of truth for the floating tab bar's own height (see
// app/(tabs)/_layout.tsx) — screens use this to reserve enough bottom
// padding on their scrollable content so the pill never covers the last
// row/button, without each one hardcoding its own guess at the bar's size.
// Final content padding = TAB_BAR_HEIGHT + insets.bottom + a screen-chosen
// gap (24 is the app's convention — see the tab screens' own styles).
export const TAB_BAR_HEIGHT = 78;

type TabVisibilityCtx = {
  translateY: SharedValue<number>;
  opacity: SharedValue<number>;
};

const TabVisibilityContext = createContext<TabVisibilityCtx | null>(null);

export function TabVisibilityProvider({ children }: { children: React.ReactNode }) {
  const translateY = useSharedValue(0);
  const opacity = useSharedValue(1);
  return (
    <TabVisibilityContext.Provider value={{ translateY, opacity }}>
      {children}
    </TabVisibilityContext.Provider>
  );
}

export function useTabVisibility() {
  const ctx = useContext(TabVisibilityContext);
  if (!ctx) throw new Error('useTabVisibility must be inside TabVisibilityProvider');
  return ctx;
}
