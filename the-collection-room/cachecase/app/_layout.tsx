import { DarkTheme, ThemeProvider, type Theme } from 'expo-router/react-navigation';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { AuthProvider, useAuth } from '@/lib/auth';
import { useUnreadMessages } from '@/hooks/use-unread-messages';
import { GlobalFloatingTabBar } from '@/components/navigation/global-floating-tab-bar';
import { MessageBadgeContext } from '@/lib/message-badge-context';
import { TabVisibilityProvider } from '@/lib/tab-visibility-context';

export const unstable_settings = {
  anchor: '(tabs)',
};

// CacheCase is always-dark — every PV2 token is a fixed dark value, with no
// light-mode counterpart anywhere in the app's own screen styling. Before
// this, the native Stack header (title/back/right-button chrome — used
// unmodified by screens like app/post/[id].tsx, which don't set headerShown:
// false) followed the DEVICE's own light/dark setting via useColorScheme(),
// completely independent of PV2 — a phone set to light mode got a white
// native header bar directly above this app's already-dark screen content.
// Built from React Navigation's own DarkTheme (not invented from scratch)
// with just its `colors` remapped onto the equivalent PV2 tokens, so native
// chrome (headers, and anything else that reads from navigation theme
// colors) matches the same palette the rest of the app already uses,
// unconditionally — not layering a second dark-theme system alongside PV2.
const CACHECASE_NAV_THEME: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: PV2.bg,
    card: PV2.panel,
    text: PV2.textPrimary,
    border: PV2.border,
    primary: PV2.accent,
  },
};

function RootLayoutNav() {
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
    <ThemeProvider value={CACHECASE_NAV_THEME}>
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
            {/* Reply composer (Feed comment redesign) — same modal
                presentation treatment as registry/[id] above, but unlike
                that one headerShown is set statically here rather than via
                an inline Stack.Screen inside app/post-reply/[id].tsx: that
                screen renders its own custom "Cancel · Reply · Post" header,
                so the native header must never be shown at all, not shown-
                then-hidden. Setting it here means the navigator mounts the
                screen already knowing headerShown is false — dynamically
                flipping it post-mount (which is what the removed inline
                Stack.Screen was doing) forces a modal to remount its whole
                content to switch header configurations, discarding local
                state (React Navigation's own "Dynamically changing header's
                visibility in modals..." warning, confirmed reproduced
                before this fix). */}
            <Stack.Screen name="post-reply/[id]" options={{ presentation: 'modal', headerShown: false }} />
          </Stack>
          {session && !inAuthGroup ? <GlobalFloatingTabBar /> : null}
        </MessageBadgeContext.Provider>
      </TabVisibilityProvider>
      {/* "light" (not "auto") — always white/light status-bar content,
          matching CacheCase's always-dark screens regardless of the
          device's own system light/dark setting; "auto" was choosing
          based on device state, which could land on dark status-bar
          content (hard to see) against this app's dark backgrounds. */}
      <StatusBar style="light" />
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
