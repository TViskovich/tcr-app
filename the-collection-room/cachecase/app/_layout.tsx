import { DarkTheme, ThemeProvider, type Theme } from 'expo-router/react-navigation';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { AccountStatusUnknown } from '@/components/account/account-status-unknown';
import { DeletionNoticeScreen } from '@/components/account/deletion-notice-screen';
import { AccountLifecycleProvider, useAccountLifecycle } from '@/lib/account-lifecycle';
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
  const { session, loading, recoveryHold } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  const inAuthGroup = segments[0] === '(auth)';
  // Password recovery (lib/auth.tsx): a session created by verifying a
  // recovery code is HELD on the reset screen until the new password is
  // saved or the reset is cancelled — no tabs, no account screens (Delete
  // Account, Download My Data, Pending Deletion), whatever route is asked for
  // (back gesture, deep link, relaunch).
  const held = !!session && recoveryHold;
  const onResetScreen = inAuthGroup && (segments as string[])[1] === 'reset-password';
  // Account lifecycle (Dashboard Milestone 2): a collector whose account is
  // pending deletion — or being deleted — sees only the Pending Deletion
  // screen. The database already hides and freezes the account; this keeps
  // the app from showing an empty, failing version of itself.
  const { status: lifecycleStatus, deletionNotice } = useAccountLifecycle();
  const lifecycleChecking = !!session && lifecycleStatus === 'checking';
  // The state couldn't be confirmed and this device has never seen it:
  // don't show the app (it may be pending deletion) until it's known.
  const lifecycleUnknown = !!session && lifecycleStatus === 'unknown';
  const accountHidden = !!session && (lifecycleStatus === 'pending_deletion' || lifecycleStatus === 'deleting');
  const onPendingScreen = (segments as string[])[0] === 'account' && (segments as string[])[1] === 'pending';

  // Single authoritative unread-DM-message source for the whole
  // authenticated session — mounted here (above both <Stack> and
  // <GlobalFloatingTabBar>) so the Tabs-group badge and the floating bar's
  // own badge, rendered outside the tabs subtree, share one query/poll
  // lifecycle and one count instead of each owning a private instance.
  const { unreadCount, latestUnreadAt, refresh: refreshMessageBadge } = useUnreadMessages(accountHidden || lifecycleUnknown || held ? undefined : session?.user?.id);
  const messageBadgeContextValue = useMemo(
    () => ({ unreadCount, latestUnreadAt, refreshMessageBadge }),
    [unreadCount, latestUnreadAt, refreshMessageBadge],
  );

  useEffect(() => {
    if (loading) return;
    if (!session) {
      if (!inAuthGroup) router.replace('/(auth)/login');
      return;
    }
    if (held) {
      if (!onResetScreen) {
        if (router.canDismiss()) router.dismissAll();
        router.replace('/(auth)/reset-password');
      }
      return;
    }
    if (lifecycleChecking || lifecycleUnknown) return;
    if (accountHidden) {
      // Every other route (back gesture, deep link, a stale tab) bounces
      // here. Emptying the stack first unmounts the app's screens, so none
      // of them keeps loading data underneath the Pending Deletion screen.
      if (!onPendingScreen) {
        if (router.canDismiss()) router.dismissAll();
        router.replace('/account/pending');
      }
      return;
    }
    if (inAuthGroup || onPendingScreen) router.replace('/(tabs)');
  }, [session, loading, held, onResetScreen, inAuthGroup, lifecycleChecking, lifecycleUnknown, accountHidden, onPendingScreen, router]);

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
            {/* Quote composer — same modal, own-header treatment as the reply
                composer above (app/quote/[id].tsx). */}
            <Stack.Screen name="quote/[id]" options={{ presentation: 'modal', headerShown: false }} />
            {/* DM thread renders its own glass ConversationHeader — set
                statically (not via an inline Stack.Screen) so the native
                header never paints for a frame before being hidden. */}
            <Stack.Screen name="conversation/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="account/delete" options={{ headerShown: false }} />
            <Stack.Screen name="account/export" options={{ headerShown: false }} />
            <Stack.Screen name="account/password" options={{ headerShown: false }} />
            <Stack.Screen name="account/blocked" options={{ headerShown: false }} />
            <Stack.Screen name="account/pending" options={{ headerShown: false, gestureEnabled: false }} />
          </Stack>
          {session && !held && !inAuthGroup && !accountHidden && !lifecycleChecking && !lifecycleUnknown && !onPendingScreen ? (
            <GlobalFloatingTabBar />
          ) : null}
          {/* Until the account's state is known, nothing of the app shows —
              a pending collector never sees it flash. */}
          {lifecycleChecking && !held ? <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000000' }]} /> : null}
          {lifecycleUnknown && !held ? <AccountStatusUnknown /> : null}
          {/* After a permanent deletion from this device, once signed out. */}
          {!session && deletionNotice ? <DeletionNoticeScreen notice={deletionNotice} /> : null}
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
        <AccountLifecycleProvider>
          <RootLayoutNav />
        </AccountLifecycleProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
