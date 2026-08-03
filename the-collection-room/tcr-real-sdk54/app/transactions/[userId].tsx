import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { TransactionRow } from '@/components/transactions/transaction-row';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAuth } from '@/lib/auth';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import {
  acceptOwnershipTransfer,
  cancelOwnershipTransfer,
  declineOwnershipTransfer,
  fetchOwnershipTransfersForUser,
  type OwnershipTransferView,
} from '@/lib/ownership-transfer';

type FilterKey = 'all' | 'sent' | 'received' | 'pending';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'sent', label: 'Sent' },
  { key: 'received', label: 'Received' },
  { key: 'pending', label: 'Pending' },
];

function matchesFilter(transfer: OwnershipTransferView, filter: FilterKey): boolean {
  switch (filter) {
    case 'sent':
      return transfer.direction === 'sent';
    case 'received':
      return transfer.direction === 'received';
    case 'pending':
      return transfer.status === 'pending';
    default:
      return true;
  }
}

// Real ownership_transfers data — replaces the old placeholder-only screen
// (lib/placeholder-transactions.ts). This is a genuinely private view: it
// only shows the SIGNED-IN user's own transfers (sender or recipient),
// enforced both by the query itself (fetchOwnershipTransfersForUser scopes
// by the caller's own id, never the route param) and independently by
// ownership_transfers' own participant-only RLS policy. The `userId` route
// param is only ever used to confirm it matches the signed-in session —
// never to fetch someone else's data — since real transfer history isn't
// the kind of thing another user should be able to view via a URL, unlike
// a public profile.
export default function TransactionsScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;

  const [filter, setFilter] = useState<FilterKey>('all');
  const [transfers, setTransfers] = useState<OwnershipTransferView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-row action-in-flight guard, keyed by transfer id — never a single
  // screen-wide flag, so acting on one row can't disable an unrelated row.
  const [actionLoadingIds, setActionLoadingIds] = useState<Set<string>>(new Set());

  const isOwnRoute = !!currentUserId && currentUserId === userId;

  const loadTransfers = useCallback(async () => {
    if (!currentUserId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { error: fetchError, data } = await fetchOwnershipTransfersForUser(currentUserId);
    if (fetchError) {
      if (__DEV__) console.error('[TransactionsScreen] fetch failed:', fetchError);
      setError(fetchError);
      setLoading(false);
      return;
    }
    setError(null);
    setTransfers(data);
    setLoading(false);
  }, [currentUserId]);

  useFocusEffect(
    useCallback(() => {
      if (isOwnRoute) loadTransfers();
    }, [isOwnRoute, loadTransfers]),
  );

  function handleBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)');
  }

  async function runAction(
    transferId: string,
    rpcCall: () => Promise<{ error: string | null; data: unknown }>,
    failureMessage: string,
  ) {
    if (actionLoadingIds.has(transferId)) return;
    setActionLoadingIds((prev) => new Set(prev).add(transferId));
    try {
      const { error: rpcError } = await rpcCall();
      if (rpcError) {
        if (__DEV__) console.error('[TransactionsScreen] action failed:', rpcError);
        Alert.alert('Error', __DEV__ ? rpcError : failureMessage);
        return;
      }
      // The RPC already performed the full state change atomically
      // (including, for accept, the registered_cards ownership move,
      // collection_item_id clear, and registry_events insert — none of
      // that is duplicated here). A full refetch is what updates this
      // screen's summary counts and re-renders every row (including the
      // acted-on one) with its new, real status.
      await loadTransfers();
    } finally {
      setActionLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(transferId);
        return next;
      });
    }
  }

  function handleAccept(transfer: OwnershipTransferView) {
    Alert.alert('Accept transfer?', 'You will become the owner of this card.', [
      { text: 'Not Now', style: 'cancel' },
      {
        text: 'Accept',
        onPress: () =>
          runAction(transfer.id, () => acceptOwnershipTransfer(transfer.id), 'Unable to accept this transfer. Please try again.'),
      },
    ]);
  }

  function handleDecline(transfer: OwnershipTransferView) {
    Alert.alert('Decline transfer?', 'This transfer will be declined and cannot be undone.', [
      { text: 'Keep Pending', style: 'cancel' },
      {
        text: 'Decline',
        style: 'destructive',
        onPress: () =>
          runAction(transfer.id, () => declineOwnershipTransfer(transfer.id), 'Unable to decline this transfer. Please try again.'),
      },
    ]);
  }

  function handleCancel(transfer: OwnershipTransferView) {
    Alert.alert('Cancel this transfer?', 'This will cancel the pending transfer.', [
      { text: 'Keep Transfer', style: 'cancel' },
      {
        text: 'Cancel Transfer',
        style: 'destructive',
        onPress: () =>
          runAction(transfer.id, () => cancelOwnershipTransfer(transfer.id), 'Unable to cancel this transfer. Please try again.'),
      },
    ]);
  }

  // Registry navigation — TransactionRow itself already only ever calls
  // this when transfer.card resolved (see its own tappability gate), but
  // this guard stays regardless so nothing here ever navigates on a bare/
  // absent id. Never uses cc_id as the route param — app/registry/[id].tsx
  // expects registered_cards.id specifically.
  function handleOpenRegistry(transfer: OwnershipTransferView) {
    if (!transfer.card?.registeredCardId) return;
    router.push({ pathname: '/registry/[id]', params: { id: transfer.card.registeredCardId } });
  }

  if (!isOwnRoute) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <Pressable style={styles.headerButton} onPress={handleBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
            <IconSymbol name="chevron.left" size={20} color={PV2.textPrimary} />
          </Pressable>
          <Text style={styles.headerTitle}>Transactions</Text>
          <View style={styles.headerButton} />
        </View>
        <View style={styles.centerState}>
          <Text style={styles.emptyTitle}>Not available</Text>
          <Text style={styles.emptyBody}>You can only view your own transaction history.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const filtered = transfers.filter((t) => matchesFilter(t, filter));
  const total = transfers.length;
  const pendingCount = transfers.filter((t) => t.status === 'pending').length;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Custom PV2-dark header instead of the native Stack header — the
          native header follows the device's system light/dark theme (see
          components/ui/screen-header.tsx), not this app's bespoke dark
          palette, which would visually clash here. */}
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Pressable style={styles.headerButton} onPress={handleBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <IconSymbol name="chevron.left" size={20} color={PV2.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>Transactions</Text>
        <View style={styles.headerButton} />
      </View>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color={PV2.accent} />
        </View>
      ) : error ? (
        <View style={styles.centerState}>
          <Text style={styles.emptyTitle}>Couldn&apos;t load transactions</Text>
          <Pressable style={styles.retryButton} onPress={loadTransfers} accessibilityRole="button" accessibilityLabel="Retry">
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(t) => t.id}
          contentContainerStyle={[styles.listContent, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <>
              <View style={styles.summaryCard}>
                <View style={styles.summaryStat}>
                  <Text style={styles.summaryValue}>{total}</Text>
                  <Text style={styles.summaryLabel}>Total</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryStat}>
                  <Text style={styles.summaryValue}>{pendingCount}</Text>
                  <Text style={styles.summaryLabel}>Pending</Text>
                </View>
              </View>

              <View style={styles.filterRow}>
                {FILTERS.map((f) => {
                  const active = f.key === filter;
                  return (
                    <Pressable
                      key={f.key}
                      style={[styles.filterPill, active && styles.filterPillActive]}
                      onPress={() => setFilter(f.key)}
                      accessibilityRole="button"
                      accessibilityLabel={`Filter: ${f.label}`}>
                      <Text style={[styles.filterPillText, active && styles.filterPillTextActive]}>{f.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          }
          ItemSeparatorComponent={() => <View style={styles.divider} />}
          renderItem={({ item }) => (
            <TransactionRow
              transfer={item}
              currentUserId={currentUserId}
              actionLoading={actionLoadingIds.has(item.id)}
              onAccept={() => handleAccept(item)}
              onDecline={() => handleDecline(item)}
              onCancel={() => handleCancel(item)}
              onPressCard={() => handleOpenRegistry(item)}
            />
          )}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No transactions</Text>
              <Text style={styles.emptyBody}>
                {filter === 'all' ? 'Transfer activity will show up here.' : `No ${filter} transactions yet.`}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const HEADER_BUTTON_SIZE = 36;

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
  headerButton: {
    width: HEADER_BUTTON_SIZE,
    height: HEADER_BUTTON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
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
  // Matches Profile V2's established neutral retry-button treatment
  // (components/profile-v2/profile-v2-grid.tsx / profile-v2-posts.tsx) —
  // same values, not a one-off style.
  retryButton: {
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 18,
  },
  retryButtonText: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  summaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 18,
  },
  summaryStat: {
    flex: 1,
    gap: 2,
  },
  summaryValue: {
    color: PV2.textPrimary,
    fontSize: 22,
    fontWeight: '800',
  },
  summaryLabel: {
    color: PV2.textTertiary,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  summaryDivider: {
    width: 1,
    height: 30,
    backgroundColor: PV2.dividerColor,
    marginHorizontal: 16,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  filterPill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  filterPillActive: {
    backgroundColor: PV2.accent,
    borderColor: PV2.accent,
  },
  filterPillText: {
    color: PV2.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  filterPillTextActive: {
    color: '#fff',
  },
  divider: {
    height: 1,
    backgroundColor: PV2.dividerColor,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 48,
    paddingHorizontal: 24,
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
