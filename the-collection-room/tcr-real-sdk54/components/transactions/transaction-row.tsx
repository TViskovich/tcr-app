import { StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { formatTransactionDate, type TransactionPreview } from '@/lib/placeholder-transactions';

type Props = {
  transaction: TransactionPreview;
  // compact: profile-rail preview (transfers-preview.tsx) — date trailing,
  // no status pill, no chevron. full: the dedicated Transactions page —
  // larger thumbnail, date on its own line, status pill when pending, and
  // a chevron reserved for future per-transaction detail navigation (not
  // wired up yet).
  variant?: 'compact' | 'full';
};

const DIRECTION_LABEL: Record<TransactionPreview['direction'], string> = {
  sent: 'Transferred to',
  received: 'Received from',
};

export function TransactionRow({ transaction, variant = 'compact' }: Props) {
  const isFull = variant === 'full';
  const isPending = transaction.status === 'pending';

  return (
    <View style={[styles.row, isFull && styles.rowFull]}>
      <View style={[styles.thumb, isFull && styles.thumbFull]}>
        {transaction.imageUrl ? (
          <Image source={{ uri: transaction.imageUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <IconSymbol name="rectangle.stack.fill" size={isFull ? 15 : 12} color={PV2.textTertiary} />
        )}
      </View>

      <View style={styles.body}>
        <Text style={[styles.title, isFull && styles.titleFull]} numberOfLines={1}>
          {transaction.itemTitle}
        </Text>
        <Text style={styles.direction} numberOfLines={1}>
          {DIRECTION_LABEL[transaction.direction]} @{transaction.counterpartUsername}
        </Text>
        {isFull && <Text style={styles.date}>{formatTransactionDate(transaction.date)}</Text>}
      </View>

      <View style={styles.trailing}>
        {!isFull && <Text style={styles.dateCompact}>{formatTransactionDate(transaction.date)}</Text>}
        {isPending && (
          <View style={styles.statusPill}>
            <Text style={styles.statusPillText}>Pending</Text>
          </View>
        )}
        {isFull && <IconSymbol name="chevron.right" size={16} color={PV2.textTertiary} />}
      </View>
    </View>
  );
}

const THUMB_SIZE = 32;
const THUMB_SIZE_FULL = 44;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
  },
  rowFull: {
    paddingVertical: 12,
    gap: 12,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbFull: {
    width: THUMB_SIZE_FULL,
    height: THUMB_SIZE_FULL,
    borderRadius: 10,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  titleFull: {
    fontSize: 15,
  },
  direction: {
    color: PV2.textTertiary,
    fontSize: 12,
  },
  date: {
    color: PV2.textTertiary,
    fontSize: 11,
    marginTop: 2,
  },
  trailing: {
    alignItems: 'flex-end',
    gap: 6,
  },
  dateCompact: {
    color: PV2.textTertiary,
    fontSize: 11,
  },
  // Pending is the only status that gets accent color — a completed
  // transaction shows no badge at all, matching "accent color only for
  // meaningful status emphasis."
  statusPill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: PV2.accentSoft,
  },
  statusPillText: {
    color: PV2.accent,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
});
