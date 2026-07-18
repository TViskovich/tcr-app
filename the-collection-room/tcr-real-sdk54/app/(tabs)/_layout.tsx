import * as Haptics from 'expo-haptics';
import { Tabs, usePathname } from 'expo-router';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { useUnreadMessages } from '@/hooks/use-unread-messages';
import { useAuth } from '@/lib/auth';
import { BadgeRefreshContext } from '@/lib/badge-context';
import { MessageBadgeRefreshContext } from '@/lib/message-badge-context';
import { TAB_BAR_HEIGHT, TabVisibilityProvider, useTabVisibility } from '@/lib/tab-visibility-context';

// Routes that have href:null — don't render a visible tab button for these.
const HIDDEN_TABS = new Set(['notifications']);

// Floating capsule shell — was a full-width bar flush with the screen
// bottom, now an inset pill raised above the safe area. Height comes from
// TAB_BAR_HEIGHT (lib/tab-visibility-context) — the single source of truth
// screens also use to reserve enough bottom padding to clear it.
const BAR_HEIGHT = TAB_BAR_HEIGHT;
const BAR_HORIZONTAL_INSET = 18;
const BAR_BOTTOM_GAP = 8;
const BAR_RADIUS = BAR_HEIGHT / 2;
// Same dark surface as before, fully opaque — no see-through content
// behind the floating pill.
const BAR_BG = 'rgba(9,10,16,1)';
const BAR_BORDER = 'rgba(100,105,145,0.28)';
const ICON_SIZE = 22;
const INACTIVE_COLOR = '#555762';

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
  accent,
  badge,
  accessibilityLabel,
  onPress,
}: {
  isFocused: boolean;
  icon: React.ReactNode;
  accent: string;
  badge?: string | number;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={styles.tabItem}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={isFocused ? { selected: true } : {}}
      accessibilityLabel={accessibilityLabel}>
      <View style={styles.iconWrap}>
        {isFocused && Platform.OS !== 'ios' && (
          <View
            style={[styles.glowAssist, { backgroundColor: glowAssistColorFor(accent) }]}
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
    </TouchableOpacity>
  );
}

function AnimatedTabBar({ state, descriptors, navigation }: any) {
  const pathname = usePathname();
  const hideTabBar = pathname.startsWith('/user/');
  const insets = useSafeAreaInsets();

  const { translateY, opacity } = useTabVisibility();

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  if (hideTabBar) return null;

  return (
    <Animated.View
      style={[styles.rootWrap, { bottom: insets.bottom + BAR_BOTTOM_GAP }, animStyle]}
      pointerEvents="box-none">
      {/* Shadow lives on this outer wrapper (unclipped) and the rounded
          background/border on the inner one (overflow:hidden) — combining
          both on one view would clip the shadow along with the corners. */}
      <View style={styles.tabBarShadow}>
        <View style={styles.tabBarShell}>
          <View style={styles.tabBarContent}>
            {state.routes.map((route: any, index: number) => {
            if (HIDDEN_TABS.has(route.name)) return null;

            const { options } = descriptors[route.key];
            const isFocused = state.index === index;
            const badge = options.tabBarBadge;
            const accent = TAB_ACCENTS[route.name] ?? DEFAULT_ACCENT;
            const color = isFocused ? accent : INACTIVE_COLOR;

            const onPress = () => {
              if (process.env.EXPO_OS === 'ios') {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!isFocused && !event.defaultPrevented) {
                navigation.navigate(route.name, route.params);
              }
            };

            return (
              <TabBarItem
                key={route.key}
                isFocused={isFocused}
                icon={options.tabBarIcon?.({ color, size: ICON_SIZE, focused: isFocused })}
                accent={accent}
                badge={badge}
                accessibilityLabel={options.tabBarAccessibilityLabel}
                onPress={onPress}
              />
            );
          })}
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

export default function TabLayout() {
  const { session } = useAuth();
  const userId = session?.user?.id;

  const { unreadCount, refresh: refreshNotifBadge } = useUnreadCount(userId);
  const { unreadCount: unreadMessages, refresh: refreshMessageBadge } = useUnreadMessages(userId);

  const messageBadge = unreadMessages === 0 ? undefined : unreadMessages > 99 ? '99+' : unreadMessages;

  return (
    <TabVisibilityProvider>
      <BadgeRefreshContext.Provider value={{ count: unreadCount, refresh: refreshNotifBadge }}>
        <MessageBadgeRefreshContext.Provider value={refreshMessageBadge}>
          <Tabs
            tabBar={(props) => <AnimatedTabBar {...props} />}
            screenListeners={({ route }) => ({
              focus: () => {
                if (route.name === 'messages') refreshMessageBadge();
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
              name="collection"
              options={{
                title: 'Collection',
                tabBarIcon: ({ color }) => (
                  <IconSymbol size={ICON_SIZE} name="square.grid.2x2" color={color} />
                ),
              }}
            />
            <Tabs.Screen
              name="search"
              options={{
                title: 'Search',
                tabBarIcon: ({ color }) => <IconSymbol size={ICON_SIZE} name="magnifyingglass" color={color} />,
              }}
            />
            <Tabs.Screen
              name="messages"
              options={{
                title: 'Messages',
                tabBarIcon: ({ color }) => <IconSymbol size={ICON_SIZE} name="message" color={color} />,
                tabBarBadge: messageBadge,
              }}
            />
            <Tabs.Screen
              name="notifications"
              options={{ href: null }}
            />
            <Tabs.Screen
              name="profile"
              options={{
                title: 'Profile',
                tabBarIcon: ({ color }) => <IconSymbol size={ICON_SIZE} name="person" color={color} />,
              }}
            />
          </Tabs>
        </MessageBadgeRefreshContext.Provider>
      </BadgeRefreshContext.Provider>
    </TabVisibilityProvider>
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
  iconWrap: {
    position: 'relative',
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
    width: 32,
    height: 32,
    borderRadius: 16,
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
