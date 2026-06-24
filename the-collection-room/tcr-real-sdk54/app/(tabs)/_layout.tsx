import { Tabs } from 'expo-router';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { useUnreadMessages } from '@/hooks/use-unread-messages';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { BadgeRefreshContext } from '@/lib/badge-context';
import { MessageBadgeRefreshContext } from '@/lib/message-badge-context';
import { useAuth } from '@/lib/auth';

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const { session } = useAuth();
  const userId = session?.user?.id;

  const { unreadCount, refresh: refreshNotifBadge } = useUnreadCount(userId);
  const { unreadCount: unreadMessages, refresh: refreshMessageBadge } = useUnreadMessages(userId);

  const notifBadge = unreadCount === 0 ? undefined : unreadCount > 99 ? '99+' : unreadCount;
  const messageBadge = unreadMessages === 0 ? undefined : unreadMessages > 99 ? '99+' : unreadMessages;

  return (
    <BadgeRefreshContext.Provider value={refreshNotifBadge}>
      <MessageBadgeRefreshContext.Provider value={refreshMessageBadge}>
        <Tabs
          screenListeners={({ route }) => ({
            focus: () => {
              if (route.name === 'notifications') refreshNotifBadge();
              if (route.name === 'messages') refreshMessageBadge();
            },
          })}
          screenOptions={{
            tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
            headerShown: false,
            tabBarButton: HapticTab,
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
            name="messages"
            options={{
              title: 'Messages',
              tabBarIcon: ({ color }) => <IconSymbol size={28} name="message.fill" color={color} />,
              tabBarBadge: messageBadge,
            }}
          />
          <Tabs.Screen
            name="notifications"
            options={{
              title: 'Notifications',
              tabBarIcon: ({ color }) => <IconSymbol size={28} name="bell.fill" color={color} />,
              tabBarBadge: notifBadge,
            }}
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
