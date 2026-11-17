import React, { createContext, useContext } from 'react';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { bottomContentPadding, floatingBarCoversRoute } from './bottom-overlay-layout';

// Whether app/_layout.tsx currently mounts the floating tab bars at all
// (false while the account is suspended, pending deletion, in password
// recovery, or its state is still being checked). Provided by the root
// layout from the same condition that renders <GlobalFloatingTabBar />.
// Defaults to true outside a provider: reserving the space is the safe
// failure (a little extra room) — never a hidden button.
const FloatingBarAllowedContext = createContext<boolean>(true);

export function FloatingBarAllowedProvider({ allowed, children }: { allowed: boolean; children: React.ReactNode }) {
  return <FloatingBarAllowedContext.Provider value={allowed}>{children}</FloatingBarAllowedContext.Provider>;
}

// Bottom padding for a scrollable screen's content container, so its last
// row or button scrolls fully above the floating tab bar when one covers
// this screen, and above the home indicator when none does.
// Pass insetAppliedByContainer: true when the screen's SafeAreaView already
// includes the 'bottom' edge. Not for screens presented as native modals.
export function useBottomContentPadding(options?: { insetAppliedByContainer?: boolean; gap?: number }): number {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const barAllowed = useContext(FloatingBarAllowedContext);
  return bottomContentPadding({
    barVisible: floatingBarCoversRoute({ barAllowed, pathname }),
    insetBottom: insets.bottom,
    insetAppliedByContainer: options?.insetAppliedByContainer,
    gap: options?.gap,
  });
}
