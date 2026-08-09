import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { AuthProvider, useAuth } from '@/lib/auth';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { GlobalFloatingTabBar } from '@/components/navigation/global-floating-tab-bar';
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
