// How the GlobalFloatingTabBar (components/navigation/global-floating-tab-bar.tsx)
// navigates. Pure (no React Native imports) so it is unit tested:
//   node --test lib/global-tab-navigation.test.ts
//
// That bar is shown on STACK screens pushed above the tabs (a post, an item,
// Saved, Delete Account, …). The root stack then looks like
//   [(tabs), post/[id], item/[id], …]
// and every tab destination already exists, mounted, inside that one (tabs)
// route. Pre-build-23 tap-responsiveness fix:
//   * router.navigate('/') PUSHED a brand-new (tabs) navigator on top
//     (Expo Router v4+ navigate pushes unless the route is the current one),
//   * router.replace('/(tabs)/profile') swapped the current screen for a NEW
//     (tabs) navigator, leaving the original mounted underneath.
// Either way each tap mounted a whole tab screen from scratch (data loading
// included) before anything appeared, and every earlier navigator stayed
// mounted, so taps got slower over a session. router.dismissTo pops back to
// the existing (tabs) route and switches it to the chosen tab — nothing is
// remounted, and a repeated tap is a no-op.

export type GlobalTabName = 'index' | 'profile' | 'search' | 'messages' | 'dashboard';

// Destination of each global-bar tab. All live inside the single (tabs) route.
export const GLOBAL_TAB_HREF: Record<GlobalTabName, '/' | '/(tabs)/profile' | '/search' | '/messages' | '/dashboard'> = {
  index: '/',
  profile: '/(tabs)/profile',
  search: '/search',
  messages: '/messages',
  dashboard: '/dashboard',
};

// The router method the global bar uses: return to the existing tabs. (With
// nothing pushed above the tabs — router.canDismiss() false — it falls back
// to a plain tab switch, exactly like navigateToOwnProfile in
// lib/profile-navigation.ts; the tab navigator itself can't handle dismissTo.)
export const GLOBAL_TAB_METHOD = 'dismissTo' as const;
