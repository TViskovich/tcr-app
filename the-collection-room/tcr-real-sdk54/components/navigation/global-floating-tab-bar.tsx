import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { usePathname, useRouter } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { useMessageBadgeCount } from '@/lib/message-badge-context';
import { TAB_BAR_HEIGHT, useTabVisibility } from '@/lib/tab-visibility-context';

// The same floating pill rendered inside the (tabs) group (see
// app/(tabs)/_layout.tsx's AnimatedTabBar), but pathname-driven instead of
// Tabs-navigator-driven so it can sit on top of every stack screen that
// lives outside the tabs group (folder, item, user, saved, settings,
// conversation, post, etc). Routes that already render their own instance
// via the Tabs navigator are skipped here to avoid a duplicate bar. Kept
// as its own copy (same constants, same shell/glow styling) rather than
// sharing code with the tabs-group version, so that working bar is left
// untouched.
// Standalone icon mark (3x3 gradient tile grid), not the wordmark —
// rendered at its own natural colors always (no tintColor; see the render
// loop below). assets/brand/cachecase-app-icon.png (the first asset tried
// here) turned out to be a flat RGB PNG with NO alpha channel — verified
// via its PNG color type (2, not 6/RGBA) — i.e. its near-black square
// canvas is a real, opaque, baked-in background, not transparent padding,
// so it rendered as a visible dark box behind the mark. cachecase-icon.png
// is a genuine RGBA asset (verified: alpha 0 at all four corners, 255 at
// center) with the same mark tightly cropped (visible content ~93%x89% of
// its own canvas, vs. app-icon's ~79%x60%). Same asset as
// app/(tabs)/_layout.tsx's AnimatedTabBar.
const CacheCaseIconMark = require('@/assets/brand/cachecase-icon.png');

// Discover (search) and Messages stay in TABS below (routes/navigation
// untouched, still reachable) but are hidden from this bar for now — mirrors
// HIDDEN_TABS in app/(tabs)/_layout.tsx. Remove an entry here to restore it.
const HIDDEN_GLOBAL_TABS = new Set<GlobalTabName>(['search', 'messages']);

const BAR_HEIGHT = TAB_BAR_HEIGHT;
// Matches app/(tabs)/_layout.tsx's own BAR_HORIZONTAL_INSET — see that
// file's comment for the full rationale (was 22, then 56; narrowing/
// widening the pill is also what sets the spacing between the 3 flex:1
// tab items, since there's no other spacing mechanism between them).
const BAR_HORIZONTAL_INSET = 42;
const BAR_BOTTOM_GAP = 8;
const BAR_RADIUS = BAR_HEIGHT / 2;
const BAR_BG = 'rgba(9,10,16,1)';
const BAR_BORDER = 'rgba(100,105,145,0.28)';
const ICON_SIZE = 28;
const INACTIVE_COLOR = '#555762';
// The owner's own collector profile (/(tabs)/profile) — not the Collection
// grid anymore. See app/(tabs)/_layout.tsx's matching FEATURED_TAB for the
// full rationale.
const FEATURED_TAB: GlobalTabName = 'profile';
// Matches app/(tabs)/_layout.tsx's CENTER_BADGE_WIDTH/HEIGHT — see that
// file's own comment for the full sizing rationale (cachecase-icon.png's
// 454x359 canvas, ≈1.265:1, with the mark tightly cropped inside it).
const CENTER_BADGE_WIDTH = 50;
const CENTER_BADGE_HEIGHT = 40;
// Matches app/(tabs)/_layout.tsx's DRAG_VERTICAL_CANCEL_MARGIN.
const DRAG_VERTICAL_CANCEL_MARGIN = 40;

type GlobalTabName = 'index' | 'profile' | 'search' | 'messages' | 'dashboard';

// 'profile' here is the CENTER/CacheCase destination (the owner's own
// collector profile, /(tabs)/profile) — not the right-hand Profile/
// Dashboard icon. 'dashboard' is the new right-hand destination
// (/(tabs)/dashboard). Route/icon/label values are otherwise unchanged
// from before this rename; only which logical destination each name/route
// points at has moved. See app/(tabs)/_layout.tsx's matching Tabs.Screen
// list for the same mapping inside the tabs group.
const TABS: {
  name: GlobalTabName;
  route: '/' | '/profile' | '/search' | '/messages' | '/dashboard';
  icon: 'house' | 'square.grid.2x2' | 'magnifyingglass' | 'message' | 'person';
  // Accessibility-only now — no longer rendered as visible text under the
  // icon (the bar is icon-only), read via accessibilityLabel below instead.
  label: string;
}[] = [
  { name: 'index', route: '/', icon: 'house', label: 'Feed' },
  { name: 'search', route: '/search', icon: 'magnifyingglass', label: 'Discover' },
  { name: 'profile', route: '/profile', icon: 'square.grid.2x2', label: 'CacheCase' },
  { name: 'messages', route: '/messages', icon: 'message', label: 'Messages' },
  { name: 'dashboard', route: '/dashboard', icon: 'person', label: 'Profile' },
];

// Paths that already have the Tabs-navigator's own floating bar rendered —
// don't stack a second one on top of those. '/collection' stays here even
// though it's no longer a visible bottom-nav button (see HIDDEN_TABS in
// app/(tabs)/_layout.tsx): it's still a real, still-mounted Tabs.Screen —
// AnimatedTabBar still renders while viewing it, just without its own
// button in the row — so this bar must still skip it too, to avoid a
// duplicate.
const TAB_COVERED_PATHS = new Set([
  '/',
  '/collection',
  '/search',
  '/messages',
  '/profile',
  '/notifications',
  '/dashboard',
]);

export function GlobalFloatingTabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const unreadMessages = useMessageBadgeCount();
  // Same shared translateY/opacity the tabs-group bar animates — driven by
  // useScrollResponsiveNavbar() on whichever screen is currently focused,
  // so this bar (rendered on every screen outside the tabs group) hides
  // and restores exactly like the Feed screen's original effect.
  const { translateY, opacity } = useTabVisibility();
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  // Drag/scrub state for the Instagram-style bottom nav gesture below — see
  // app/(tabs)/_layout.tsx's AnimatedTabBar for the full rationale (kept in
  // sync here). rowWidth is measured by a single onLayout on the exact same
  // row View the drag gesture is attached to — one measurement, one
  // coordinate frame, no per-tab aggregation to drift out of sync with the
  // gesture's own x.
  const rowWidth = useSharedValue(0);
  const dragSelectedTab = useSharedValue<GlobalTabName | null>(null);

  // Public/non-owner profile (app/user/[username].tsx) — outside the tabs
  // group like every other route this bar covers, but unlike those it must
  // render with no floating nav at all (its own standalone back chevron is
  // the only nav control there). Prefix match, not TAB_COVERED_PATHS' exact
  // match, since the username segment is dynamic; no username is ever
  // compared here.
  if (TAB_COVERED_PATHS.has(pathname) || pathname.startsWith('/user/')) return null;

  const messageBadge = unreadMessages === 0 ? undefined : unreadMessages > 99 ? '99+' : unreadMessages;
  // Unlike AnimatedTabBar (which lights the CacheCase center button up via
  // state.index === index whenever the Tabs navigator is actually on
  // /profile), this bar's own center button can never show as active: the
  // early return above already excludes every path in TAB_COVERED_PATHS,
  // which includes '/profile' itself — so by the time this component
  // renders anything, pathname is guaranteed not to be the owner-profile
  // route. There's no equivalent "profile-adjacent" pushed-screen
  // hierarchy the way collection/folder/item pages were for the old
  // Collection-tab behavior, so the center button here just always renders
  // in its default (inactive) state.

  // Shared by both a normal tap (via each tab's onPress below) and the
  // drag/scrub gesture, so dragging onto a tab behaves identically to
  // tapping it.
  const selectTab = (tab: (typeof TABS)[number]) => {
    if (process.env.EXPO_OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (tab.name === FEATURED_TAB) {
      // Always land on the owner's own profile — same reset-to-root
      // mechanism the Collection tab used before this button's
      // destination changed, so a screen reached outside the tabs group
      // (folder, item, etc.) always replaces cleanly onto it.
      router.replace('/(tabs)/profile');
      return;
    }
    router.navigate(tab.route as any);
  };

  // Looked up by name rather than closed over `tab`, since this is invoked
  // from the pan gesture via runOnJS, which can only round-trip plain
  // serializable values across the worklet boundary.
  const selectTabByName = (name: GlobalTabName) => {
    const tab = TABS.find((t) => t.name === name);
    if (tab) selectTab(tab);
  };

  // Left-to-right names of the tabs actually rendered below (Feed,
  // CacheCase, Profile today) — derived from the same TABS/
  // HIDDEN_GLOBAL_TABS source of truth the render loop uses, so the drag
  // zones below can never disagree with what's actually on screen or
  // include a hidden tab.
  const visibleTabOrder = TABS.filter((t) => !HIDDEN_GLOBAL_TABS.has(t.name)).map((t) => t.name);

  const dragGesture = Gesture.Pan()
    // Only activates once the finger has actually moved horizontally — a
    // plain tap never crosses this, so it never steals the touch from the
    // tab buttons' own TouchableOpacity/onPress below.
    .activeOffsetX([-10, 10])
    // Fails (leaving the touch to the buttons) if the movement is
    // predominantly vertical, so small vertical jitter can't select a tab.
    .failOffsetY([-20, 20])
    .onUpdate((e) => {
      if (e.y < -DRAG_VERTICAL_CANCEL_MARGIN || e.y > BAR_HEIGHT + DRAG_VERTICAL_CANCEL_MARGIN) {
        // Strayed too far above/below the pill — ignore this update rather
        // than selecting anything; resumes if the finger comes back in.
        return;
      }
      const width = rowWidth.value;
      const tabCount = visibleTabOrder.length;
      if (width <= 0 || tabCount === 0) return;
      // e.x is relative to this same row View (see the GestureDetector
      // below and rowWidth's onLayout) — clamp so a finger that's strayed
      // slightly into the row's own horizontal padding still resolves to
      // the nearest tab instead of falling outside every zone.
      const clampedX = Math.min(Math.max(e.x, 0), width);
      const zoneWidth = width / tabCount;
      let zoneIndex = Math.floor(clampedX / zoneWidth);
      if (zoneIndex >= tabCount) zoneIndex = tabCount - 1;
      if (zoneIndex < 0) zoneIndex = 0;
      const matched = visibleTabOrder[zoneIndex];
      if (matched !== dragSelectedTab.value) {
        dragSelectedTab.value = matched;
        runOnJS(selectTabByName)(matched);
      }
    })
    .onFinalize(() => {
      dragSelectedTab.value = null;
    });

  return (
    <Animated.View
      style={[styles.rootWrap, { bottom: insets.bottom + BAR_BOTTOM_GAP }, animStyle]}
      pointerEvents="box-none">
      <View style={styles.tabBarShadow}>
        <View style={styles.tabBarShell}>
          <GestureDetector gesture={dragGesture}>
            {/* This is the exact view the drag gesture above is attached to
                (via GestureDetector) and whose width it measures below —
                e.x in dragGesture.onUpdate is guaranteed relative to this
                same box, so the two can never drift into different
                coordinate spaces. */}
            <View
              style={styles.tabBarContent}
              onLayout={(e) => {
                rowWidth.value = e.nativeEvent.layout.width;
              }}>
            {TABS.map((tab) => {
              if (HIDDEN_GLOBAL_TABS.has(tab.name)) return null;
              const centered = tab.name === FEATURED_TAB;
              const onPress = () => selectTab(tab);
              return (
                <TouchableOpacity
                  key={tab.name}
                  onPress={onPress}
                  style={centered ? styles.tabItemCenter : styles.tabItem}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={centered ? 'CacheCase' : tab.label}>
                  <View
                    style={[
                      centered ? styles.centerTabContent : styles.tabContent,
                      tab.name === 'search'
                        ? { transform: [{ translateX: -6 }] }
                        : tab.name === 'messages'
                          ? { transform: [{ translateX: 8 }] }
                          : null,
                    ]}>
                    <View style={centered ? styles.iconWrapCenter : styles.iconWrap}>
                      <View style={styles.iconLitWrap}>
                        {centered ? (
                          // No tintColor — full RGB gradient graphic;
                          // see CacheCaseIconMark's own comment above.
                          <Image source={CacheCaseIconMark} contentFit="contain" style={styles.cacheCaseLogo} />
                        ) : (
                          <IconSymbol size={ICON_SIZE} name={tab.icon} color={INACTIVE_COLOR} />
                        )}
                      </View>
                      {tab.name === 'messages' && messageBadge != null ? (
                        <View style={styles.badge}>
                          <Text style={styles.badgeText}>{messageBadge}</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}
            </View>
          </GestureDetector>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  rootWrap: {
    position: 'absolute',
    left: BAR_HORIZONTAL_INSET,
    right: BAR_HORIZONTAL_INSET,
  },
  tabBarShadow: {
    borderRadius: BAR_RADIUS,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 10,
  },
  tabBarShell: {
    height: BAR_HEIGHT,
    borderRadius: BAR_RADIUS,
    backgroundColor: BAR_BG,
    borderWidth: 1,
    borderColor: BAR_BORDER,
    overflow: 'hidden',
  },
  tabBarContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
  },
  tabItemCenter: {
    flex: 1,
    alignSelf: 'stretch',
  },
  // Icon-only content, centered as a unit — no gap here now that there's
  // no label underneath it to space away from.
  tabContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerTabContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrap: {
    position: 'relative',
  },
  iconWrapCenter: {
    position: 'relative',
  },
  cacheCaseLogo: {
    width: CENTER_BADGE_WIDTH,
    height: CENTER_BADGE_HEIGHT,
  },
  iconLitWrap: {
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 8,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: '#e53935',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 12,
  },
});
