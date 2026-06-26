import * as Haptics from 'expo-haptics';
import { Tabs } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { useUnreadMessages } from '@/hooks/use-unread-messages';
import { useAuth } from '@/lib/auth';
import { BadgeRefreshContext } from '@/lib/badge-context';
import { MessageBadgeRefreshContext } from '@/lib/message-badge-context';
import { TabVisibilityProvider, useTabVisibility } from '@/lib/tab-visibility-context';

// Routes that have href:null — don't render a visible tab button for these.
const HIDDEN_TABS = new Set(['notifications', 'settings']);

function AnimatedTabBar({ state, descriptors, navigation }: any) {
  const { translateY } = useTabVisibility();

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Animated.View style={[styles.tabBar, animStyle]}>
      {state.routes.map((route: any, index: number) => {
        if (HIDDEN_TABS.has(route.name)) return null;

        const { options } = descriptors[route.key];
        const isFocused = state.index === index;
        const color = isFocused ? '#ffffff' : 'rgba(255,255,255,0.42)';
        const badge = options.tabBarBadge;

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
          <TouchableOpacity
            key={route.key}
            onPress={onPress}
            style={styles.tabItem}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={options.tabBarAccessibilityLabel}>
            <View style={styles.iconWrap}>
              {options.tabBarIcon?.({ color, size: 28, focused: isFocused })}
              {badge != null ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.tabLabel, { color }]} numberOfLines={1}>
              {options.title ?? route.name}
            </Text>
          </TouchableOpacity>
        );
      })}
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
                tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} />,
              }}
            />
            <Tabs.Screen
              name="collection"
              options={{
                title: 'Collection',
                tabBarIcon: ({ color }) => <IconSymbol size={28} name="folder.fill" color={color} />,
              }}
            />
            <Tabs.Screen
              name="search"
              options={{
                title: 'Search',
                tabBarIcon: ({ color }) => <IconSymbol size={28} name="magnifyingglass" color={color} />,
              }}
            />
            <Tabs.Screen
              name="messages"
              options={{
                title: 'Messages',
                tabBarIcon: ({ color }) => <IconSymbol size={28} name="message.fill" color={color} />,
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
                tabBarIcon: ({ color }) => <IconSymbol size={28} name="person.fill" color={color} />,
              }}
            />
            <Tabs.Screen
              name="settings"
              options={{ href: null }}
            />
          </Tabs>
        </MessageBadgeRefreshContext.Provider>
      </BadgeRefreshContext.Provider>
    </TabVisibilityProvider>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    // start/end override React Navigation's default start:0, end:0
    start: 16,
    end: 16,
    bottom: 24,
    height: 78,
    borderRadius: 39,
    backgroundColor: '#1c1c1e',
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 14,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 9,
    paddingBottom: 8,
  },
  iconWrap: {
    position: 'relative',
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 16,
    marginTop: 3,
    paddingBottom: 2,
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
