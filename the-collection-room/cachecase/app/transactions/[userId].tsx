import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { TransactionsList } from '@/components/transactions/transactions-list';
import { BackButton } from '@/components/ui/back-button';
import { useAuth } from '@/lib/auth';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

// Real ownership_transfers data — replaces the old placeholder-only screen
// (lib/placeholder-transactions.ts). This is a genuinely private view: it
// only shows the SIGNED-IN user's own transfers (sender or recipient),
// enforced both by TransactionsList's own query (which scopes by the
// caller's own id, never a route param) and independently by
// ownership_transfers' own participant-only RLS policy. The `userId` route
// param is only ever used HERE to confirm it matches the signed-in
// session — never passed through to fetch someone else's data — since
// real transfer history isn't the kind of thing another user should be
// able to view via a URL, unlike a public profile.
//
// All of the actual data loading, filtering, and accept/decline/cancel
// logic now lives in components/transactions/transactions-list.tsx,
// shared with the Profile V2 selector's inline "transfer" rail section —
// this screen owns only the page chrome (header/back button) and the
// route-param ownership check.
export default function TransactionsScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;

  const isOwnRoute = !!currentUserId && currentUserId === userId;

  if (!isOwnRoute) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <BackButton fallbackHref="/(tabs)" />
          <Text style={styles.headerTitle}>Transactions</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.centerState}>
          <Text style={styles.emptyTitle}>Not available</Text>
          <Text style={styles.emptyBody}>You can only view your own transaction history.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Custom PV2-dark header instead of the native Stack header — the
          native header follows the device's system light/dark theme (see
          components/ui/screen-header.tsx), not this app's bespoke dark
          palette, which would visually clash here. */}
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <BackButton fallbackHref="/(tabs)" />
        <Text style={styles.headerTitle}>Transactions</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }}
        showsVerticalScrollIndicator={false}>
        <TransactionsList currentUserId={currentUserId} />
      </ScrollView>
    </SafeAreaView>
  );
}

// Matches BackButton's own fixed 44x44 touch target — this right-side
// spacer has no button of its own, it exists purely so headerTitle stays
// centered between two equal-width slots.
const HEADER_SPACER_SIZE = 44;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: PV2.panelBorder,
  },
  headerSpacer: {
    width: HEADER_SPACER_SIZE,
    height: HEADER_SPACER_SIZE,
  },
  headerTitle: {
    color: PV2.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  emptyTitle: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 6,
    textAlign: 'center',
  },
  emptyBody: {
    color: PV2.textTertiary,
    fontSize: 13,
    textAlign: 'center',
  },
});
