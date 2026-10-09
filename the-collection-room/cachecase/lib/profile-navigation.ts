import type { ImperativeRouter } from 'expo-router';

// Single source of truth for "tap a user, go to their profile" — every
// user-row/avatar/username tap in the app (Feed, Followers/Following,
// Search, Notifications, an item's owner row, registry history, a
// profile's own Posts tab) should resolve through this, not push
// /user/[username] directly. Self taps go to the owner Profile tab (normal
// bottom nav, no public back chevron); anyone else goes to the public
// /user/[username] route (bottom nav hidden, standalone back chevron) —
// see components/navigation/global-floating-tab-bar.tsx and
// app/(tabs)/_layout.tsx's AnimatedTabBar, which key that chrome off
// exactly this route distinction. ID comparison only (never username) —
// usernames are user-editable and not guaranteed to match at read time the
// way the stable auth id does.
export function navigateToProfile(
  router: ImperativeRouter,
  currentUserId: string | null | undefined,
  targetUserId: string,
  username: string,
) {
  if (currentUserId && targetUserId === currentUserId) {
    navigateToOwnProfile(router);
    return;
  }
  router.push({ pathname: '/user/[username]', params: { username } });
}

// Returns to the EXISTING owner Profile tab rather than creating another.
// From a screen pushed above the tab group (another user's profile, a post,
// an item, a conversation…), router.push('/(tabs)/profile') would push a
// second copy of the whole tab navigator onto the root stack, so instead
// dismissTo pops back to the original one, switching it to Profile (its
// state and scroll position kept). From inside the tabs there is nothing to
// dismiss — and the tab navigator can't handle dismissTo — so it's a plain
// tab switch. canDismiss() is true exactly when something is pushed above
// the tabs, since no tab has its own nested stack.
export function navigateToOwnProfile(router: ImperativeRouter) {
  if (router.canDismiss()) {
    router.dismissTo('/(tabs)/profile');
  } else {
    router.navigate('/(tabs)/profile');
  }
}
