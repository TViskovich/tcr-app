import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { TransactionRow } from '@/components/transactions/transaction-row';
import { IconSymbol } from '@/components/ui/icon-symbol';
import {
  getPlaceholderTransactions,
  getTransactionSummary,
  type TransactionPreview,
} from '@/lib/placeholder-transactions';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

type FilterKey = 'all' | 'sent' | 'received' | 'pending';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'sent', label: 'Sent' },
  { key: 'received', label: 'Received' },
  { key: 'pending', label: 'Pending' },
];

function matchesFilter(transaction: TransactionPreview, filter: FilterKey): boolean {
  switch (filter) {
    case 'sent':
      return transaction.direction === 'sent';
    case 'received':
      return transaction.direction === 'received';
    case 'pending':
      return transaction.status === 'pending';
    default:
      return true;
  }
}

// Full transaction history for one user — reached from the profile rail's
// Transfers preview (components/profile-v2/transfers-preview.tsx) via
// "View all transactions". userId is whichever profile was being viewed
// (own or someone else's), not necessarily the signed-in session — see
// that component for how it's threaded through. Placeholder data only, via
// lib/placeholder-transactions.ts — filters run locally over the fixed
// list; no query/database exists yet.
export default function TransactionsScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<FilterKey>('all');

  const transactions = useMemo(() => getPlaceholderTransactions(userId), [userId]);
  const { total, pending } = getTransactionSummary(transactions);
  const filtered = useMemo(() => transactions.filter((t) => matchesFilter(t, filter)), [transactions, filter]);

  function handleBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)');
  }

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
                <Text style={styles.summaryValue}>{pending}</Text>
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
          <View style={styles.rowWrap}>
            <TransactionRow transaction={item} variant="full" />
          </View>
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
  rowWrap: {
    // TransactionRow owns no horizontal padding itself so it can also sit
    // flush inside the profile rail's card (see transfers-preview.tsx) —
    // this page supplies its own instead.
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
  },
  emptyBody: {
    color: PV2.textTertiary,
    fontSize: 13,
    textAlign: 'center',
  },
});
