import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useFocusEffect, useRouter } from 'expo-router';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { TransactionRow } from '@/components/transactions/transaction-row';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useSignedRegistryImages } from '@/hooks/use-signed-registry-images';
import {
  acceptOwnershipTransfer,
  cancelOwnershipTransfer,
  declineOwnershipTransfer,
  fetchOwnershipTransfersForUser,
  type OwnershipTransferView,
} from '@/lib/ownership-transfer';
import type { OwnershipTransferStatus } from '@/types';

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

type Props = {
  // Always the SIGNED-IN user's own id — this component only ever shows
  // (and only ever CAN show, per ownership_transfers' own participant-only
  // RLS policy) the caller's own transfers, never anyone else's. There is
  // no route-param/ownership mismatch to guard against here the way
  // app/transactions/[userId].tsx has to for its own URL param — callers
  // of this component (that screen, and the Profile V2 Transfer rail
  // section) are each independently responsible for only ever rendering
  // it for the current session's own id.
  currentUserId: string | undefined;
  // Only ever passed by the Profile V2 inline embed (profile-v2-screen.tsx),
  // never by app/transactions/[userId].tsx itself — that screen IS the
  // full page this button opens, so it would be redundant there. Renders
  // nothing when omitted; tapping it never touches transfer data itself,
  // it only navigates.
  onViewAll?: () => void;
};

// Shared core of the ownership-transfer list/summary/actions UI — used by
// BOTH app/transactions/[userId].tsx (the full standalone page, which
// wraps this in its own SafeAreaView/header/back button) and the Profile
// V2 selector's "transfer" rail section (which renders this directly
// inline, no separate navigation). Extracted so there is exactly one
// implementation of the data loading, filtering, and accept/decline/
// cancel logic — neither caller duplicates any of it.
//
// Deliberately a plain `.map()`'d stack, not a FlatList — same reasoning
// as ProfileV2Posts/ProfileV2Collections: FlatList (or any
// VirtualizedList) nested inside a ScrollView with the same orientation
// is a known-broken/warned React Native pattern, and the Profile V2
// screen this renders inside already has its own single outer ScrollView.
// A user's own transfer history is not the kind of large, unbounded list
// virtualization exists for.
export function TransactionsList({ currentUserId, onViewAll }: Props) {
  const router = useRouter();

  const [filter, setFilter] = useState<FilterKey>('all');
  const [transfers, setTransfers] = useState<OwnershipTransferView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-row action-in-flight guard, keyed by transfer id — never a single
  // screen-wide flag, so acting on one row can't disable an unrelated row.
  const [actionLoadingIds, setActionLoadingIds] = useState<Set<string>>(new Set());

  // One shared signing/cache path for every row's thumbnail — resolved from
  // the FULL transfer list (not `filtered` below), so switching filter
  // pills never re-triggers signing for cards already resolved. Each
  // resolved URL is the card's own immutable registry snapshot
  // (registered_cards.snapshot_image_storage_path via
  // get-registry-snapshot-image-url), never the raw legacy
  // transfer.card.imageUrl field and never derived from a current live
  // collection item.
  const { urls: signedRegistryUrls } = useSignedRegistryImages(
    transfers.map((t) => t.card?.registeredCardId),
  );

  const loadTransfers = useCallback(async (): Promise<{ error: string | null; data: OwnershipTransferView[] }> => {
    if (!currentUserId) {
      setLoading(false);
      return { error: null, data: [] };
    }
    setLoading(true);
    try {
      const { error: fetchError, data } = await fetchOwnershipTransfersForUser(currentUserId);
      if (fetchError) {
        if (__DEV__) console.error('[TransactionsList] fetch failed:', fetchError);
        // Existing transfers are deliberately left untouched on failure —
        // only `error` is set, which is what switches the render below to
        // the error/Retry state; a stale-but-real list is never silently
        // wiped by a failed refresh.
        setError(fetchError);
        return { error: fetchError, data: [] };
      }
      setError(null);
      // A genuinely empty result is a legitimate, distinct success case
      // from a failed read (see fetchOwnershipTransfersForUser's own
      // error/data separation) — always committed here on success, empty
      // or not.
      setTransfers(data);
      return { error: null, data };
    } catch (e) {
      if (__DEV__) console.error('[TransactionsList] fetch threw:', e);
      const message = 'Unable to load transfers.';
      setError(message);
      return { error: message, data: [] };
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  useFocusEffect(
    useCallback(() => {
      loadTransfers();
    }, [loadTransfers]),
  );

  // P0 ownership-transfer response-reconciliation for accept/decline/cancel
  // (audit: "ownership-transfer Accept / Decline / Cancel response
  // reconciliation") — a resolved RPC error and a thrown exception from
  // acceptOwnershipTransfer/declineOwnershipTransfer/cancelOwnershipTransfer
  // can both mean either "the request never committed" OR "the server
  // committed the status change but the response was lost in transit."
  // loadTransfers() is the single existing authoritative read (no new
  // query) — reused here both to refresh the UI and to inspect the
  // acted-on transfer's real, current status. Deliberately wraps its own
  // body in try/catch so a genuinely unexpected read/reconciliation
  // exception here converts to the same neutral "status unknown" outcome
  // rather than ever propagating back out to runAction — this function
  // never itself throws, which is what guarantees runAction can only ever
  // call it once per failed RPC attempt (see runAction's own comment).
  async function reconcileTransferAfterError(
    transferId: string,
    requestedStatus: OwnershipTransferStatus,
    failureMessage: string,
  ) {
    try {
      const { error, data } = await loadTransfers();

      if (error) {
        Alert.alert(
          'Transfer status unknown',
          "We couldn't confirm whether the transfer was updated. Refresh and check your transfers before trying again.",
        );
        return;
      }

      const transfer = data.find((t) => t.id === transferId);
      if (!transfer) {
        Alert.alert(
          'Transfer status unknown',
          "We couldn't confirm whether the transfer was updated. Refresh and check your transfers before trying again.",
        );
        return;
      }

      if (transfer.status === requestedStatus) {
        // Authoritative state proves this attempt committed — loadTransfers()
        // above already refreshed the UI with the real status. No Alert,
        // matching the existing silent-success convention for
        // accept/decline/cancel today.
        return;
      }

      if (transfer.status === 'pending') {
        // Authoritative state proves the mutation did not commit — safe to
        // show today's existing failure copy.
        Alert.alert('Error', failureMessage);
        return;
      }

      // A different terminal status than the one requested — some other
      // resolution (e.g. another session) won the race. Don't claim this
      // attempt succeeded or failed; loadTransfers() above already
      // refreshed state to the real value, so no second refresh here.
      Alert.alert(
        'Transfer status changed',
        "This transfer's status changed before we could confirm the action. Review the latest transfer status.",
      );
    } catch (e) {
      if (__DEV__) console.error('[TransactionsList] reconciliation read threw:', e);
      Alert.alert(
        'Transfer status unknown',
        "We couldn't confirm whether the transfer was updated. Refresh and check your transfers before trying again.",
      );
    }
  }

  async function runAction(
    transferId: string,
    requestedStatus: OwnershipTransferStatus,
    rpcCall: () => Promise<{ error: string | null; data: unknown }>,
    failureMessage: string,
  ) {
    if (actionLoadingIds.has(transferId)) return;
    setActionLoadingIds((prev) => new Set(prev).add(transferId));
    try {
      // Scoped so a thrown RPC call and a resolved {error} both funnel
      // into exactly one reconcileTransferAfterError call below — never
      // both, and never the success-path refresh either (see below): a
      // resolved {error: null} result is definitive proof the mutation
      // committed, so nothing after this inner try/catch can trigger
      // mutation reconciliation again.
      let rpcError: string | null = null;
      try {
        const result = await rpcCall();
        rpcError = result.error;
      } catch (e) {
        if (__DEV__) console.error('[TransactionsList] action threw:', e);
        await reconcileTransferAfterError(transferId, requestedStatus, failureMessage);
        return;
      }

      if (rpcError) {
        if (__DEV__) console.error('[TransactionsList] action failed:', rpcError);
        await reconcileTransferAfterError(transferId, requestedStatus, failureMessage);
        return;
      }

      // The RPC already performed the full state change atomically
      // (including, for accept, the registered_cards ownership move,
      // collection_item_id clear, and registry_events insert — none of
      // that is duplicated here). A resolved {error: null} result IS
      // definitive proof the mutation committed — a refresh failure below
      // must never downgrade this to "unknown" or trigger mutation
      // reconciliation, only tell the user their already-completed
      // action's on-screen status may be stale. loadTransfers() catches
      // its own read failures internally and always resolves (never
      // throws), so no try/catch is needed around this call.
      const refreshResult = await loadTransfers();
      if (refreshResult.error) {
        Alert.alert(
          'Transfer updated',
          "The transfer was completed, but we couldn't refresh the latest status. Pull to refresh or reopen this screen.",
        );
      }
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
          runAction(
            transfer.id,
            'accepted',
            () => acceptOwnershipTransfer(transfer.id),
            'Unable to accept this transfer. Please try again.',
          ),
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
          runAction(
            transfer.id,
            'declined',
            () => declineOwnershipTransfer(transfer.id),
            'Unable to decline this transfer. Please try again.',
          ),
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
          runAction(
            transfer.id,
            'cancelled',
            () => cancelOwnershipTransfer(transfer.id),
            'Unable to cancel this transfer. Please try again.',
          ),
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

  if (loading) {
    return (
      <View style={styles.centerState}>
        <ActivityIndicator size="large" color={PV2.accent} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.emptyTitle}>Couldn&apos;t load transactions</Text>
        <Pressable style={styles.retryButton} onPress={loadTransfers} accessibilityRole="button" accessibilityLabel="Retry">
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const filtered = transfers.filter((t) => matchesFilter(t, filter));
  const total = transfers.length;
  const pendingCount = transfers.filter((t) => t.status === 'pending').length;

  return (
    <View style={styles.content}>
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

      {onViewAll && (
        <View style={styles.viewAllRow}>
          <TouchableOpacity
            style={styles.viewAllBtn}
            onPress={onViewAll}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Open full transfer history">
            <Text style={styles.viewAllLabel}>View All</Text>
            <IconSymbol name="chevron.right" size={14} color={PV2.link} />
          </TouchableOpacity>
        </View>
      )}

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

      {filtered.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No transactions</Text>
          <Text style={styles.emptyBody}>
            {filter === 'all' ? 'Transfer activity will show up here.' : `No ${filter} transactions yet.`}
          </Text>
        </View>
      ) : (
        filtered.map((item, index) => (
          <View key={item.id}>
            {index > 0 && <View style={styles.divider} />}
            <TransactionRow
              transfer={item}
              currentUserId={currentUserId}
              actionLoading={actionLoadingIds.has(item.id)}
              onAccept={() => handleAccept(item)}
              onDecline={() => handleDecline(item)}
              onCancel={() => handleCancel(item)}
              onPressCard={() => handleOpenRegistry(item)}
              signedImageUrl={
                item.card?.registeredCardId ? signedRegistryUrls.get(item.card.registeredCardId) : undefined
              }
            />
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  centerState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
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
  // Sits below the summary card, right-aligned — deliberately its own row
  // rather than a child of summaryCard's flex layout, so it can never
  // shrink or cover the Total/Pending stats.
  viewAllRow: {
    alignItems: 'flex-end',
    marginTop: -10,
    marginBottom: 14,
  },
  viewAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  viewAllLabel: {
    color: PV2.link,
    fontSize: 13,
    fontWeight: '600',
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
