import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { usePathname, useRouter } from 'expo-router';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { COLLECTION_ROOT_ROUTE, isCacheCaseRoute } from '@/lib/cachecase-navigation';
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
const CacheCaseLogoNav = require('@/assets/icons/cachecase-wordmark-nav.png');

// Discover (search) and Messages stay in TABS below (routes/navigation
// untouched, still reachable) but are hidden from this bar for now — mirrors
// HIDDEN_TABS in app/(tabs)/_layout.tsx. Remove an entry here to restore it.
const HIDDEN_GLOBAL_TABS = new Set<GlobalTabName>(['search', 'messages']);

const BAR_HEIGHT = TAB_BAR_HEIGHT;
const BAR_HORIZONTAL_INSET = 22;
const BAR_BOTTOM_GAP = 8;
const BAR_RADIUS = BAR_HEIGHT / 2;
const BAR_BG = 'rgba(9,10,16,1)';
const BAR_BORDER = 'rgba(100,105,145,0.28)';
const ICON_SIZE = 25;
const INACTIVE_COLOR = '#555762';
// The Collection tab ("CacheCase") gets a touch more default-state
// prominence than the other four — matches app/(tabs)/_layout.tsx.
const FEATURED_INACTIVE_COLOR = '#8A8DA0';
const FEATURED_TAB: GlobalTabName = 'collection';
// Matches app/(tabs)/_layout.tsx's CENTER_BADGE_WIDTH/HEIGHT — the
// CacheCase tab has no label here either, so the logo gets the same
// larger size.
const CENTER_BADGE_WIDTH = 72;
const CENTER_BADGE_HEIGHT = 29;
// Matches app/(tabs)/_layout.tsx's DRAG_VERTICAL_CANCEL_MARGIN.
const DRAG_VERTICAL_CANCEL_MARGIN = 40;
// Matches TAB_ACCENTS.collection in app/(tabs)/_layout.tsx — the CacheCase
// tab's active color, used here when the current screen belongs to the
// collection hierarchy (see lib/cachecase-navigation.ts).
const CACHECASE_ACCENT = '#A97BFF';

function glowAssistColorFor(accent: string) {
  const hex = accent.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r},${g},${b},0.18)`;
}

type GlobalTabName = 'index' | 'collection' | 'search' | 'messages' | 'profile';

const TABS: {
  name: GlobalTabName;
  route: '/' | '/collection' | '/search' | '/messages' | '/profile';
  icon: 'house' | 'square.grid.2x2' | 'magnifyingglass' | 'message' | 'person';
  label: string;
}[] = [
  { name: 'index', route: '/', icon: 'house', label: 'Feed' },
  { name: 'search', route: '/search', icon: 'magnifyingglass', label: 'Discover' },
  { name: 'collection', route: '/collection', icon: 'square.grid.2x2', label: 'CacheCase' },
  { name: 'messages', route: '/messages', icon: 'message', label: 'Messages' },
  { name: 'profile', route: '/profile', icon: 'person', label: 'Profile' },
];

// Paths that already have the Tabs-navigator's own floating bar rendered —
// don't stack a second one on top of those.
const TAB_COVERED_PATHS = new Set(['/', '/collection', '/search', '/messages', '/profile', '/notifications']);

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

  if (TAB_COVERED_PATHS.has(pathname)) return null;

  const messageBadge = unreadMessages === 0 ? undefined : unreadMessages > 99 ? '99+' : unreadMessages;
  // True on every screen pushed outside the tabs group that still belongs
  // to the collection-browsing hierarchy (folder, item, gallery, etc.) —
  // not just when the pathname literally equals the Collection tab route.
  const cacheCaseActive = isCacheCaseRoute(pathname);

  // Shared by both a normal tap (via each tab's onPress below) and the
  // drag/scrub gesture, so dragging onto a tab behaves identically to
  // tapping it.
  const selectTab = (tab: (typeof TABS)[number]) => {
    if (process.env.EXPO_OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (tab.name === FEATURED_TAB) {
      // Always land on the Collection root — never the nested screen the
      // user happened to be on, and never stacked on top of it.
      router.replace(COLLECTION_ROOT_ROUTE as any);
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
              const logoColor = cacheCaseActive ? CACHECASE_ACCENT : FEATURED_INACTIVE_COLOR;
              return (
                <TouchableOpacity
                  key={tab.name}
                  onPress={onPress}
                  style={centered ? styles.tabItemCenter : styles.tabItem}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityState={centered && cacheCaseActive ? { selected: true } : {}}
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
                      {centered && cacheCaseActive && Platform.OS !== 'ios' && (
                        <View
                          style={[
                            styles.glowAssistCenter,
                            { backgroundColor: glowAssistColorFor(CACHECASE_ACCENT) },
                          ]}
                          pointerEvents="none"
                        />
                      )}
                      <View
                        style={
                          centered && cacheCaseActive
                            ? [styles.iconLitWrap, styles.iconLit, { shadowColor: CACHECASE_ACCENT }]
                            : styles.iconLitWrap
                        }>
                        {centered ? (
                          <Image
                            source={CacheCaseLogoNav}
                            contentFit="contain"
                            tintColor={logoColor}
                            style={styles.cacheCaseLogo}
                          />
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
                    {centered ? null : (
                      <Text
                        style={[
                          styles.tabLabel,
                          tab.name === FEATURED_TAB && styles.tabLabelFeatured,
                          { color: tab.name === FEATURED_TAB ? FEATURED_INACTIVE_COLOR : INACTIVE_COLOR },
                        ]}
                        numberOfLines={1}>
                        {tab.label}
                      </Text>
                    )}
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
  tabContent: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  centerTabContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.1,
  },
  tabLabelFeatured: {
    fontWeight: '600',
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
  iconLit: {
    shadowOpacity: 0.85,
  },
  // Android/web fallback only — matches app/(tabs)/_layout.tsx's
  // glowAssistCenter, sized to the (larger) CacheCase logo.
  glowAssistCenter: {
    position: 'absolute',
    top: -4,
    left: -4,
    width: CENTER_BADGE_WIDTH + 8,
    height: CENTER_BADGE_HEIGHT + 8,
    borderRadius: 14,
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
