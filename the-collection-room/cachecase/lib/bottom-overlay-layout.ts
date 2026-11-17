// Bottom-overlay layout rules — how much space scrollable content must leave
// at its end so its last row or button is never hidden behind the floating
// tab bar (or, without the bar, the home indicator). Pure (no React Native
// imports) so it is unit tested: node --test lib/bottom-overlay-layout.test.ts
//
// Two floating bars share one geometry (TAB_BAR_HEIGHT tall, insets.bottom +
// 4 above the screen bottom):
//   * the Tabs navigator's own bar on the tab screens (app/(tabs)/_layout.tsx),
//   * the GlobalFloatingTabBar every stack screen above the tabs gets
//     (components/navigation/global-floating-tab-bar.tsx), mounted by
//     app/_layout.tsx only while the app itself is shown — not while signed
//     out, during password recovery, or while the account is pending
//     deletion, suspended or its state is still unknown.
// Neither bar is shown on another collector's profile (/user/...). Screens
// presented as native modals sit above both bars and must not use this.
//
// The app's convention (see app/account/export.tsx etc.): content ends
// TAB_BAR_HEIGHT + insets.bottom + 24 above the screen bottom, which leaves a
// 20pt gap above the pill.

export const TAB_BAR_HEIGHT = 68;
export const CONTENT_END_GAP = 24;

// Whether a floating bar covers the bottom of the screen at `pathname`.
// `barAllowed` is app/_layout.tsx's own condition for mounting the bars.
export function floatingBarCoversRoute(input: { barAllowed: boolean; pathname: string }): boolean {
  if (!input.barAllowed) return false;
  return !input.pathname.startsWith('/user/');
}

// Bottom padding for a scroll view's content container.
//   barVisible            — floatingBarCoversRoute(...)
//   insetBottom           — useSafeAreaInsets().bottom
//   insetAppliedByContainer — true when the screen's container already pads
//                           the bottom safe area (SafeAreaView edges include
//                           'bottom'), so it must not be counted twice
//   gap                   — space to leave above the bar / home indicator
export function bottomContentPadding(input: {
  barVisible: boolean;
  insetBottom: number;
  insetAppliedByContainer?: boolean;
  gap?: number;
}): number {
  const gap = input.gap ?? CONTENT_END_GAP;
  const inset = input.insetAppliedByContainer ? 0 : Math.max(0, input.insetBottom);
  return (input.barVisible ? TAB_BAR_HEIGHT : 0) + inset + gap;
}

// Distance from the screen bottom to the floating bar's top edge (where
// content becomes hidden), for tests and assertions.
export const FLOATING_BAR_BOTTOM_GAP = 4;
export function floatingBarTop(insetBottom: number): number {
  return Math.max(0, insetBottom) + FLOATING_BAR_BOTTOM_GAP + TAB_BAR_HEIGHT;
}
