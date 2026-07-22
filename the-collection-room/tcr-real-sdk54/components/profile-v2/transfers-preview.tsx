import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useRouter } from 'expo-router';

import { TransactionRow } from '@/components/transactions/transaction-row';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { getPlaceholderTransactions, getTransactionSummary } from '@/lib/placeholder-transactions';
import { PV2 } from './profile-v2-theme';

const RECENT_COUNT = 3;

type Props = {
  // The profile being VIEWED — same id ProfileV2Screen threads into every
  // other data hook. Never assume auth.uid() here; on someone else's
  // profile this is THEIR id, not the viewer's.
  userId: string;
  isOwnProfile: boolean;
};

// Compact dashboard-card summary of an item's transfer history — the
// Transfers section rail entry. Real content lives on the dedicated
// Transactions page (app/transactions/[userId].tsx); this just previews it
// and links there. Backed by the same placeholder data source as that page
// (lib/placeholder-transactions.ts) — no ownership-transfer table/query
// exists yet, so both self and public profiles render identical content
// for now, but the userId/isOwnProfile plumbing is already correct for
// when that changes.
export function TransfersPreview({ userId, isOwnProfile }: Props) {
  const router = useRouter();
  const transactions = getPlaceholderTransactions(userId);
  const { total, pending } = getTransactionSummary(transactions);
  const recent = transactions.slice(0, RECENT_COUNT);

  function openTransactions() {
    router.push({ pathname: '/transactions/[userId]', params: { userId } });
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.header}>Transfers</Text>
        </View>

        <View style={styles.summaryRow}>
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

        <Text style={styles.recentLabel}>Recent activity</Text>

        {recent.length === 0 ? (
          <Text style={styles.emptyText}>
            {isOwnProfile ? "You haven't transferred any items yet." : 'No transfer activity yet.'}
          </Text>
        ) : (
          recent.map((transaction, index) => (
            <View key={transaction.id}>
              {index > 0 && <View style={styles.divider} />}
              <TransactionRow transaction={transaction} variant="compact" />
            </View>
          ))
        )}

        <Pressable style={styles.viewAllRow} onPress={openTransactions} hitSlop={4}>
          <Text style={styles.viewAllText}>View all transactions</Text>
          <IconSymbol name="chevron.right" size={14} color={PV2.link} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 12,
  },
  card: {
    borderRadius: 14,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 6,
  },
  headerRow: {
    marginBottom: 12,
  },
  header: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  summaryStat: {
    flex: 1,
    gap: 2,
  },
  summaryValue: {
    color: PV2.textPrimary,
    fontSize: 20,
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
    height: 28,
    backgroundColor: PV2.dividerColor,
    marginHorizontal: 16,
  },
  recentLabel: {
    color: PV2.textTertiary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  emptyText: {
    color: PV2.textTertiary,
    fontSize: 13,
    paddingVertical: 12,
  },
  divider: {
    height: 1,
    backgroundColor: PV2.dividerColor,
  },
  viewAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: PV2.dividerColor,
  },
  viewAllText: {
    color: PV2.link,
    fontSize: 13,
    fontWeight: '700',
  },
});
