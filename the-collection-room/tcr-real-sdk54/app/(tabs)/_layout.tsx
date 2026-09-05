import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { Tabs, usePathname, useRouter } from 'expo-router';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { useAuth } from '@/lib/auth';
import { BadgeRefreshContext } from '@/lib/badge-context';
import { COLLECTION_ROOT_ROUTE, isCacheCaseRoute } from '@/lib/cachecase-navigation';
import { useMessageBadgeCount, useMessageBadgeRefresh } from '@/lib/message-badge-context';
import { TAB_BAR_HEIGHT, useTabVisibility } from '@/lib/tab-visibility-context';

// Routes that have href:null — don't render a visible tab button for these.
// Discover (search) and Messages are routes/screens we intentionally keep
// wired up (still reachable via router.push/navigate, badges etc. all still
// work) but hide from the visible bottom nav for now — same pattern already
// used for notifications below. Remove an entry here (and the matching
// href:null on its Tabs.Screen) to restore it to the visible bar.
const HIDDEN_TABS = new Set(['search', 'messages', 'notifications']);

const CacheCaseLogoNav = require('@/assets/icons/cachecase-wordmark-nav.png');

// Floating capsule shell — was a full-width bar flush with the screen
// bottom, now an inset pill raised above the safe area. Height comes from
// TAB_BAR_HEIGHT (lib/tab-visibility-context) — the single source of truth
// screens also use to reserve enough bottom padding to clear it.
const BAR_HEIGHT = TAB_BAR_HEIGHT;
const BAR_HORIZONTAL_INSET = 22;
const BAR_BOTTOM_GAP = 8;
const BAR_RADIUS = BAR_HEIGHT / 2;
// Same dark surface as before, fully opaque — no see-through content
// behind the floating pill.
const BAR_BG = 'rgba(9,10,16,1)';
const BAR_BORDER = 'rgba(100,105,145,0.28)';
const ICON_SIZE = 25;
const INACTIVE_COLOR = '#555762';
// The Collection tab ("CacheCase") gets a touch more default-state
// prominence than the other four — a brighter muted gray rather than the
// standard inactive gray — so it draws the eye without changing size.
const FEATURED_INACTIVE_COLOR = '#8A8DA0';

// Per-tab active accent, used both to tint the icon and to color its glow —
// one distinct color per tab.
const DEFAULT_ACCENT = '#A97BFF';
const TAB_ACCENTS: Record<string, string> = {
  index: '#74F5C8', // Home — mint/green
  collection: '#A97BFF', // Collection — purple
  search: '#4DA6FF', // Search — blue
  messages: '#FF5C5C', // Messages — red
  profile: '#FFD84D', // Profile — yellow
};

const TAB_LABELS: Record<string, string> = {
  index: 'Feed',
  collection: 'CacheCase',
  search: 'Discover',
  messages: 'Messages',
  profile: 'Profile',
};

const FEATURED_TAB = 'collection';

// The CacheCase logo replaces both the icon and label for the center tab,
// so it renders larger than the other four icons (which stay at ICON_SIZE)
// — the vertical space the removed label used to occupy goes to the logo
// instead. The source PNG (842x343, ≈2.45:1) is the wordmark alone with the
// surrounding bracket mark cropped out. 72x29 keeps that aspect ratio (so
// contentFit="contain" never letterboxes it) at a size still visibly larger
// than the plain ICON_SIZE icons either side of it — CacheCase stays the
// featured tab without dominating the now-more-compact pill.
// Comfortably inside BAR_HEIGHT (68) with room to spare on both edges.
const CENTER_BADGE_WIDTH = 72;
const CENTER_BADGE_HEIGHT = 29;

// Instagram-style drag/scrub selection: how far (in px) the finger can
// stray above/below the bar's own height before we stop treating the drag
// as a scrub over it. Generous enough that a natural arc-shaped swipe still
// tracks, tight enough that dragging up into the screen content cancels it.
const DRAG_VERTICAL_CANCEL_MARGIN = 40;

// Only used for the small Android glow assist now (see glowAssist below).
function glowAssistColorFor(accent: string) {
  const hex = accent.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r},${g},${b},0.18)`;
}

// A single tab button — icon, optional badge, and (when focused) a glow
// that lights the icon itself up rather than sitting behind it as a
// separate shape. Its own component (rather than inlined in the .map()
// below) purely to keep AnimatedTabBar's render body readable.
//
// On iOS this is a real shadow applied directly to the View wrapping the
// icon (shadowOffset 0,0, no shadowPath) — UIKit computes that shadow from
// the icon's own rendered alpha mask, so the "glow" traces the actual SF
// Symbol pixels with no separate visible shape and no hidden light source
// to spot. That alpha-mask shadow trick doesn't exist on Android (shadow*
// is a no-op there without `elevation`, which can't be tinted), so Android
// gets one small, tight, low-opacity circle as a much subtler assist —
// deliberately undersized so it reads as ambient bleed rather than a halo
// shape, not the previous 3-layer 50px blob.
function TabBarItem({
  isFocused,
  icon,
  label,
  color,
  accent,
  featured,
  badge,
  accessibilityLabel,
  onPress,
  offsetX,
  centered,
}: {
  isFocused: boolean;
  icon: React.ReactNode;
  // Omitted (the CacheCase center tab) means: no visible label — the badge
  // itself is the destination's identity, so nothing renders underneath it.
  label?: string;
  color: string;
  accent: string;
  featured?: boolean;
  badge?: string | number;
  accessibilityLabel?: string;
  onPress: () => void;
  offsetX?: number;
  // The CacheCase tab only: no label row, so its icon+content stretches to
  // fill and center within the tab's full touch target instead of the
  // shrink-wrapped icon-over-label column the other four tabs use.
  centered?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={centered ? styles.tabItemCenter : styles.tabItem}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={isFocused ? { selected: true } : {}}
      accessibilityLabel={accessibilityLabel}>
      <View
        style={[
          centered ? styles.centerTabContent : styles.tabContent,
          offsetX ? { transform: [{ translateX: offsetX }] } : null,
        ]}>
        <View style={centered ? styles.iconWrapCenter : styles.iconWrap}>
          {isFocused && Platform.OS !== 'ios' && (
            <View
              style={[
                centered ? styles.glowAssistCenter : styles.glowAssist,
                { backgroundColor: glowAssistColorFor(accent) },
              ]}
              pointerEvents="none"
            />
          )}
          <View
            style={
              isFocused
                ? [styles.iconLitWrap, styles.iconLit, { shadowColor: accent }]
                : styles.iconLitWrap
            }>
            {icon}
          </View>
          {badge != null ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          ) : null}
        </View>
        {label != null ? (
          <Text
            style={[styles.tabLabel, featured && styles.tabLabelFeatured, { color }]}
            numberOfLines={1}>
            {label}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function AnimatedTabBar({ state, descriptors, navigation }: any) {
  const pathname = usePathname();
  const router = useRouter();
  const hideTabBar = pathname.startsWith('/user/');
  const insets = useSafeAreaInsets();

  const { translateY, opacity } = useTabVisibility();

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  // Drag/scrub state for the Instagram-style bottom nav gesture below.
  // rowWidth is measured by a single onLayout on the exact same row View
  // the drag gesture is attached to (see the GestureDetector below) — one
  // measurement, one coordinate frame, no per-child aggregation to drift
  // out of sync with the gesture's own x. dragSelectedTab remembers which
  // tab the current gesture last selected so continued movement inside the
  // same third doesn't re-navigate.
  const rowWidth = useSharedValue(0);
  const dragSelectedTab = useSharedValue<string | null>(null);

  if (hideTabBar) return null;

  // Shared by both a normal tap (via each TabBarItem's onPress below) and
  // the drag/scrub gesture — same tabPress-event/featured/isFocused logic
  // either way, so dragging onto a tab behaves identically to tapping it.
  const selectRoute = (route: any, featured: boolean, isFocused: boolean) => {
    if (process.env.EXPO_OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    const event = navigation.emit({
      type: 'tabPress',
      target: route.key,
      canPreventDefault: true,
    });
    if (event.defaultPrevented) return;
    if (featured) {
      // Always land on the Collection root — never stacked on top of, and
      // never preserving, a nested collection screen.
      router.replace(COLLECTION_ROOT_ROUTE as any);
      return;
    }
    if (!isFocused) {
      navigation.navigate(route.name, route.params);
    }
  };

  // Looked up by name rather than closed over route/index, since this is
  // invoked from the pan gesture via runOnJS, which can only round-trip
  // plain serializable values across the worklet boundary.
  const selectRouteByName = (name: string) => {
    const idx = state.routes.findIndex((r: any) => r.name === name);
    if (idx === -1) return;
    const route = state.routes[idx];
    const featured = route.name === FEATURED_TAB;
    const isFocused = state.index === idx || (featured && isCacheCaseRoute(pathname));
    selectRoute(route, featured, isFocused);
  };

  // Left-to-right names of the tabs actually rendered below (Feed,
  // CacheCase, Profile today) — derived from the same state.routes/
  // HIDDEN_TABS source of truth the render loop uses, so the drag zones
  // below can never disagree with what's actually on screen or include a
  // hidden tab. Recomputed each render (cheap: 6 routes), same as the
  // gesture callbacks themselves.
  const visibleTabOrder = state.routes
    .filter((r: any) => !HIDDEN_TABS.has(r.name))
    .map((r: any) => r.name as string);

  const dragGesture = Gesture.Pan()
    // Only activates once the finger has actually moved horizontally —
    // a plain tap never crosses this, so it never steals the touch from
    // the tab buttons' own TouchableOpacity/onPress below.
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
        runOnJS(selectRouteByName)(matched);
      }
    })
    .onFinalize(() => {
      dragSelectedTab.value = null;
    });

  return (
    <Animated.View
      style={[styles.rootWrap, { bottom: insets.bottom + BAR_BOTTOM_GAP }, animStyle]}
      pointerEvents="box-none">
      {/* Shadow lives on this outer wrapper (unclipped) and the rounded
          background/border on the inner one (overflow:hidden) — combining
          both on one view would clip the shadow along with the corners. */}
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
              {state.routes.map((route: any, index: number) => {
            if (HIDDEN_TABS.has(route.name)) return null;

            const { options } = descriptors[route.key];
            const featured = route.name === FEATURED_TAB;
            // The CacheCase tab also lights up for any screen belonging to
            // the collection hierarchy (see lib/cachecase-navigation.ts) —
            // in practice this bar is only ever visible when pathname is
            // exactly one of the 5 tab routes (nested screens like
            // /folder/[id] are pushed on top and cover it), so this is
            // equivalent to state.index === index today, but keeps the
            // logic centralized and correct if that ever changes.
            const isFocused = state.index === index || (featured && isCacheCaseRoute(pathname));
            const badge = options.tabBarBadge;
            const accent = TAB_ACCENTS[route.name] ?? DEFAULT_ACCENT;
            const color = isFocused ? accent : featured ? FEATURED_INACTIVE_COLOR : INACTIVE_COLOR;

            const onPress = () => selectRoute(route, featured, isFocused);

            return (
              <TabBarItem
                key={route.key}
                isFocused={isFocused}
                icon={options.tabBarIcon?.({ color, size: ICON_SIZE, focused: isFocused })}
                label={featured ? undefined : (TAB_LABELS[route.name] ?? route.name)}
                color={color}
                accent={accent}
                featured={featured}
                badge={badge}
                accessibilityLabel={options.tabBarAccessibilityLabel}
                onPress={onPress}
                offsetX={route.name === 'search' ? -6 : route.name === 'messages' ? 8 : undefined}
                centered={featured}
              />
            );
              })}
            </View>
          </GestureDetector>
        </View>
      </View>
    </Animated.View>
  );
}

export default function TabLayout() {
  const { session } = useAuth();
  const userId = session?.user?.id;

  const { unreadCount, refresh: refreshNotifBadge } = useUnreadCount(userId);
  const unreadMessages = useMessageBadgeCount();
  const refreshMessageBadge = useMessageBadgeRefresh();

  const messageBadge = unreadMessages === 0 ? undefined : unreadMessages > 99 ? '99+' : unreadMessages;

  return (
    <BadgeRefreshContext.Provider value={{ count: unreadCount, refresh: refreshNotifBadge }}>
      <Tabs
        tabBar={(props) => <AnimatedTabBar {...props} />}
        screenListeners={({ route }) => ({
          focus: () => {
            if (route.name === 'messages') refreshMessageBadge();
            // Ownership Transfer Notifications Phase 1 — same existing
            // focus-refresh convention as messages above, just not
            // previously applied to notifications. Not polling, not a
            // new subscription: this only refetches the unread count
            // when the user actually navigates to/focuses this screen
            // (reached via router.push('/(tabs)/notifications') from
            // the Home bell icon, which — since notifications is
            // declared as a real Tabs.Screen, just hidden from the tab
            // bar via href:null — fires this same navigator focus
            // event). Does not make the badge update live while the
            // user stays idle on another tab; no mechanism in this app
            // does that for any notification type today.
            if (route.name === 'notifications') refreshNotifBadge();
          },
        })}
        screenOptions={{ headerShown: false }}>
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color }) => <IconSymbol size={ICON_SIZE} name="house" color={color} />,
          }}
        />
        <Tabs.Screen
          name="search"
          options={{
            title: 'Search',
            href: null,
            tabBarIcon: ({ color }) => <IconSymbol size={ICON_SIZE} name="magnifyingglass" color={color} />,
          }}
        />
        <Tabs.Screen
          name="collection"
          options={{
            title: 'Collection',
            tabBarAccessibilityLabel: 'CacheCase',
            tabBarIcon: ({ color }) => (
              <Image
                source={CacheCaseLogoNav}
                contentFit="contain"
                tintColor={color}
                style={styles.cacheCaseLogo}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="messages"
          options={{
            title: 'Messages',
            href: null,
            tabBarIcon: ({ color }) => <IconSymbol size={ICON_SIZE} name="message" color={color} />,
            tabBarBadge: messageBadge,
          }}
        />
        <Tabs.Screen name="notifications" options={{ href: null }} />
        <Tabs.Screen
          name="profile"
          options={{
            title: 'Profile',
            tabBarIcon: ({ color }) => <IconSymbol size={ICON_SIZE} name="person" color={color} />,
          }}
        />
      </Tabs>
    </BadgeRefreshContext.Provider>
  );
}

const styles = StyleSheet.create({
  // Floating pill — inset from both edges (was full-width), raised above
  // the safe area via `bottom` (set inline with insets.bottom, since it
  // depends on the device). box-none so taps outside the pill's own bounds
  // (there's no full-width strip anymore) pass through to the screen below.
  rootWrap: {
    position: 'absolute',
    left: BAR_HORIZONTAL_INSET,
    right: BAR_HORIZONTAL_INSET,
  },
  // Shadow only — unclipped, so it isn't cut off by tabBarShell's
  // overflow:hidden (which it would be if both lived on the same view).
  tabBarShadow: {
    borderRadius: BAR_RADIUS,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 10,
  },
  // The actual capsule surface — dark translucent CacheCase background,
  // thin border, fully rounded (not just the bottom corners like the old
  // full-width bar).
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
  // CacheCase tab only — no label row underneath, so this stretches to the
  // bar's full height (tabBarContent's cross-axis) instead of shrink-
  // wrapping to its own content like the other four tabs.
  tabItemCenter: {
    flex: 1,
    alignSelf: 'stretch',
  },
  // Vertical icon-over-label stack — centers as one unit within the taller
  // bar, replacing the old icon-only layout.
  tabContent: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  // CacheCase tab only — fills tabItemCenter and centers the (larger,
  // label-less) badge within the tab's full touch target.
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
  // CacheCase (Collection) tab only — a touch heavier so it reads with
  // slightly more presence, same size/spacing as the other four.
  tabLabelFeatured: {
    fontWeight: '600',
  },
  iconWrap: {
    position: 'relative',
  },
  // CacheCase tab only — same role as iconWrap. (No optical nudge needed
  // now that the mark is the plain wordmark rather than the taller,
  // asymmetric bracket badge.)
  iconWrapCenter: {
    position: 'relative',
  },
  cacheCaseLogo: {
    width: CENTER_BADGE_WIDTH,
    height: CENTER_BADGE_HEIGHT,
  },
  // shadowOffset/shadowRadius live in the base style always (harmless when
  // shadowOpacity is 0); iconLit only adds shadowOpacity, and shadowColor
  // comes in inline per-tab. Together, on iOS, this makes the icon's own
  // alpha silhouette cast the glow — no separate shape, no visible source.
  iconLitWrap: {
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 8,
  },
  iconLit: {
    shadowOpacity: 0.85,
  },
  // Android/web fallback only (view shadows there don't hug alpha content
  // the way iOS's do) — kept small and tight so it reads as a faint bleed
  // right at the icon's edge rather than a distinct halo shape.
  glowAssist: {
    position: 'absolute',
    top: -5,
    left: -5,
    width: ICON_SIZE + 10,
    height: ICON_SIZE + 10,
    borderRadius: (ICON_SIZE + 10) / 2,
  },
  // CacheCase tab only — same restrained assist, sized up to match the
  // larger badge footprint instead of the standard icon size.
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
