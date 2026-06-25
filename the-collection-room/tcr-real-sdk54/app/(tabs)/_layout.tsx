import { Tabs } from 'expo-router';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { useUnreadMessages } from '@/hooks/use-unread-messages';
import { BadgeRefreshContext } from '@/lib/badge-context';
import { MessageBadgeRefreshContext } from '@/lib/message-badge-context';
import { useAuth } from '@/lib/auth';

export default function TabLayout() {
  const { session } = useAuth();
  const userId = session?.user?.id;

  const { unreadCount, refresh: refreshNotifBadge } = useUnreadCount(userId);
  const { unreadCount: unreadMessages, refresh: refreshMessageBadge } = useUnreadMessages(userId);

  const messageBadge = unreadMessages === 0 ? undefined : unreadMessages > 99 ? '99+' : unreadMessages;

  return (
    <BadgeRefreshContext.Provider value={{ count: unreadCount, refresh: refreshNotifBadge }}>
      <MessageBadgeRefreshContext.Provider value={refreshMessageBadge}>
        <Tabs
          screenListeners={({ route }) => ({
            focus: () => {
              if (route.name === 'messages') refreshMessageBadge();
            },
          })}
          screenOptions={{
            headerShown: false,
            tabBarButton: HapticTab,
            tabBarActiveTintColor: '#ffffff',
            tabBarInactiveTintColor: 'rgba(255,255,255,0.42)',
            tabBarStyle: {
              position: 'absolute',
              // left/right state intent; start/end are the logical equivalents
              // that actually override React Navigation's base start:0, end:0
              left: 16,
              right: 16,
              start: 16,
              end: 16,
              bottom: 24,
              height: 78,
              borderRadius: 39,
              backgroundColor: '#1c1c1e',
              borderTopWidth: 0,
              // Cancels the safe-area paddingBottom React Navigation injects
              // (~34px on iPhone) which would otherwise crush the content area.
              paddingBottom: 0,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 6 },
              shadowOpacity: 0.25,
              shadowRadius: 16,
              elevation: 14,
            },
            tabBarItemStyle: {
              flex: 1,
              alignItems: 'center',
              paddingTop: 9,
              paddingBottom: 8,
            },
            tabBarIconStyle: {
              marginBottom: 0,
            },
            tabBarLabelStyle: {
              fontSize: 11,
              fontWeight: '500',
              lineHeight: 16,
              marginTop: 3,
              paddingBottom: 2,
            },
          }}>
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
  );
}
