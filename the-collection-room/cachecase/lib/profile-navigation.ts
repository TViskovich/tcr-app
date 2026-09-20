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
    router.push('/(tabs)/profile');
    return;
  }
  router.push({ pathname: '/user/[username]', params: { username } });
}
