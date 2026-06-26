import React, { createContext, useContext } from 'react';
import { useSharedValue } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

type TabVisibilityCtx = { translateY: SharedValue<number> };

const TabVisibilityContext = createContext<TabVisibilityCtx | null>(null);

export function TabVisibilityProvider({ children }: { children: React.ReactNode }) {
  const translateY = useSharedValue(0);
  return (
    <TabVisibilityContext.Provider value={{ translateY }}>
      {children}
    </TabVisibilityContext.Provider>
  );
}

export function useTabVisibility() {
  const ctx = useContext(TabVisibilityContext);
  if (!ctx) throw new Error('useTabVisibility must be inside TabVisibilityProvider');
  return ctx;
}
