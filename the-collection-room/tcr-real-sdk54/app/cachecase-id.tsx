import { StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';

const IcLogo = require('@/assets/icons/ic-logo-transparent.png');

// Placeholder only — the permanent slot for the full CacheCase ID
// experience. Reachable today from the item-detail action row's logo
// button (components/item-detail/item-action-bar.tsx); nothing else
// depends on this screen's contents, so it can be filled in later without
// touching the route path or the button that opens it.
export default function CacheCaseIdScreen() {
  // Not scrollable — no scroll-hide effect, but still resets the shared
  // navbar to visible on focus, matching every other non-list screen.
  useScrollResponsiveNavbar({ enabled: false });

  return (
    <>
      <Stack.Screen options={{ title: 'CacheCase ID', headerBackTitle: '' }} />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <View style={styles.center}>
          <Image source={IcLogo} contentFit="contain" style={styles.logo} />
          <Text style={styles.title}>CacheCase ID</Text>
          <Text style={styles.body}>CacheCase ID coming soon!</Text>
          <Text style={styles.subtitle}>
            Every collectible will eventually have its own permanent CacheCase identity.
          </Text>
        </View>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  logo: {
    height: 64,
    aspectRatio: 563 / 350,
    marginBottom: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: PV2.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    color: PV2.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 13,
    color: PV2.textTertiary,
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 280,
  },
});
