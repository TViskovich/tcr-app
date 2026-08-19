import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { AuthProvider, useAuth } from '@/lib/auth';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useUnreadMessages } from '@/hooks/use-unread-messages';
import { GlobalFloatingTabBar } from '@/components/navigation/global-floating-tab-bar';
import { MessageBadgeContext } from '@/lib/message-badge-context';
import { TabVisibilityProvider } from '@/lib/tab-visibility-context';

export const unstable_settings = {
  anchor: '(tabs)',
};

function RootLayoutNav() {
  const colorScheme = useColorScheme();
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  const inAuthGroup = segments[0] === '(auth)';

  // Single authoritative unread-DM-message source for the whole
  // authenticated session — mounted here (above both <Stack> and
  // <GlobalFloatingTabBar>) so the Tabs-group badge and the floating bar's
  // own badge, rendered outside the tabs subtree, share one query/poll
  // lifecycle and one count instead of each owning a private instance.
  const { unreadCount, refresh: refreshMessageBadge } = useUnreadMessages(session?.user?.id);
  const messageBadgeContextValue = useMemo(
    () => ({ unreadCount, refreshMessageBadge }),
    [unreadCount, refreshMessageBadge],
  );

  useEffect(() => {
    if (loading) return;
    if (!session && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (session && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [session, loading, inAuthGroup, router]);

  // Withhold the route tree until the initial session restore resolves —
  // otherwise (auth) or (tabs) can paint for a frame before the redirect
  // above runs. Plain view, not null: matches the native splash screen's
  // backgroundColor (app.json expo-splash-screen config) so there's no
  // color flash between splash and this holding frame.
  if (loading) {
    return <View style={{ flex: 1, backgroundColor: '#000000' }} />;
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <TabVisibilityProvider>
        <MessageBadgeContext.Provider value={messageBadgeContextValue}>
          <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            {/* CacheCase ID button (ItemActionBar) opens this as a slide-up
                modal instead of a normal push — the same route/component,
                app/registry/[id].tsx, still owns its own header/title via its
                own inline Stack.Screen options; this only attaches the
                presentation transition. */}
            <Stack.Screen name="registry/[id]" options={{ presentation: 'modal' }} />
          </Stack>
          {session && !inAuthGroup ? <GlobalFloatingTabBar /> : null}
        </MessageBadgeContext.Provider>
      </TabVisibilityProvider>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <RootLayoutNav />
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
