import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import {
  formatTransferParticipantLine,
  formatTransferReason,
  formatTransferStatus,
  type OwnershipTransferView,
} from '@/lib/ownership-transfer';

function formatTransferDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

type Props = {
  transfer: OwnershipTransferView;
  currentUserId: string | undefined;
  // True while THIS row's own action is in flight — gates all three
  // buttons on this row only, never a screen-wide flag, so acting on one
  // row never disables another.
  actionLoading?: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
  onCancel?: () => void;
  // Registry navigation — only ever invoked when transfer.card resolved
  // (see the tappability gate below); the caller (app/transactions/
  // [userId].tsx) owns the actual router.push, matching this component's
  // existing convention of staying purely presentational and reporting
  // intent via callback props (onAccept/onDecline/onCancel), never
  // importing expo-router itself.
  onPressCard?: () => void;
  // Resolved by the caller (TransactionsList) via useSignedRegistryImages,
  // shared across every visible row rather than re-signed per row. This is
  // the card's own immutable snapshot (registered_cards.snapshot_image_
  // storage_path via get-registry-snapshot-image-url), never the raw
  // legacy transfer.card.imageUrl field and never derived from the current
  // live collection item — undefined while still resolving/unavailable,
  // in which case this row falls back to the existing icon placeholder.
  signedImageUrl?: string;
};

export function TransactionRow({
  transfer,
  currentUserId,
  actionLoading,
  onAccept,
  onDecline,
  onCancel,
  onPressCard,
  signedImageUrl,
}: Props) {
  // Tracks a URL that failed to actually load (e.g. expired between
  // resolution and render) so the row falls back to the placeholder
  // instead of a permanently blank <Image> — reset automatically whenever
  // a different signedImageUrl comes in, since that's a fresh attempt.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const isPending = transfer.status === 'pending';
  // Direction is already computed relative to whichever user this list was
  // fetched for (see fetchOwnershipTransfersForUser) — but the actual
  // button-gating below re-derives isSender/isRecipient from the raw
  // participant ids rather than trusting `direction` alone, so a row never
  // shows a mutation control to the wrong person even if this component
  // were ever reused with a differently-scoped list.
  const isSender = !!currentUserId && transfer.sender?.id === currentUserId;
  const isRecipient = !!currentUserId && transfer.recipient?.id === currentUserId;

  const participantLine = formatTransferParticipantLine(transfer);

  const cardTitle = transfer.card?.title ?? 'Registry Card';
  const reasonLabel = formatTransferReason(transfer.reason);

  // Tappable exactly when the embedded registered_cards row resolved —
  // i.e. transfer.card is non-null. This already covers every status
  // (pending/accepted/declined/cancelled all become tappable the moment
  // the card is visible) and correctly stays non-tappable for the
  // documented RLS-embed-null case (see fetchOwnershipTransfersForUser's
  // own long comment) without any separate check.
  const registeredCardId = transfer.card?.registeredCardId ?? null;

  const cardContent = (
    <>
      <View style={styles.thumb}>
        {signedImageUrl && signedImageUrl !== failedUrl ? (
          <Image
            source={{ uri: signedImageUrl }}
            style={styles.thumbImage}
            contentFit="cover"
            onError={() => setFailedUrl(signedImageUrl)}
          />
        ) : (
          <IconSymbol name="rectangle.stack.fill" size={15} color={PV2.textTertiary} />
        )}
      </View>

      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {cardTitle}
        </Text>
        {/* cc_id only ever shown when the card actually resolved — never
            fabricated, and the raw registered_cards.id is never rendered
            here (only ever used as a navigation param — see
            OwnershipTransferCardSummary's own comment in
            lib/ownership-transfer.ts). */}
        {transfer.card?.ccId && (
          <Text style={styles.ccId} numberOfLines={1}>
            {transfer.card.ccId}
          </Text>
        )}
        {/* No numberOfLines cap here (unlike title/ccId above) — the
            actor-clarifying suffix ("cancelled by you"/"cancelled by
            sender") sits AFTER the interpolated @username, so a
            tail-ellipsis truncation could hide exactly the disambiguating
            text formatTransferParticipantLine exists to show, for a long
            username (no app-enforced max length on username). Letting
            this one line wrap is cheaper than that risk. */}
        <Text style={styles.direction}>{participantLine}</Text>
        <View style={styles.metaRow}>
          <Text style={styles.date}>{formatTransferDate(transfer.createdAt)}</Text>
          {reasonLabel && (
            <>
              <Text style={styles.metaDot}>·</Text>
              <Text style={styles.reason}>{reasonLabel}</Text>
            </>
          )}
        </View>
      </View>

      <View style={[styles.statusPill, !isPending && styles.statusPillResolved]}>
        <Text style={[styles.statusPillText, !isPending && styles.statusPillTextResolved]}>
          {formatTransferStatus(transfer.status)}
        </Text>
      </View>
    </>
  );

  return (
    <View style={styles.row}>
      {/* A separate pressable content area, not the whole row — the
          actionsRow below is already a sibling, never nested inside this,
          so there is no ambiguous Pressable-in-Pressable bubbling for
          Accept/Decline/Cancel to fight with. When the card didn't
          resolve (RLS-hidden), this renders as a plain, non-interactive
          View with no button role advertised, rather than a dead-looking
          button. */}
      {registeredCardId ? (
        <TouchableOpacity
          style={styles.mainRow}
          onPress={onPressCard}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Open registry card ${transfer.card?.ccId ?? ''}`}>
          {cardContent}
        </TouchableOpacity>
      ) : (
        <View style={styles.mainRow}>{cardContent}</View>
      )}

      {/* Actions only ever render for a pending transfer, and only for the
          one relevant participant — a non-participant (shouldn't be
          possible, since the list itself is already scoped to
          from/to_owner_id = the signed-in user) sees no buttons at all,
          matching a resolved transfer's own no-buttons state. */}
      {isPending && (isRecipient || isSender) && (
        <View style={styles.actionsRow}>
          {isRecipient && (
            <>
              <TouchableOpacity
                style={[styles.actionBtn, styles.acceptBtn]}
                onPress={onAccept}
                disabled={actionLoading}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Accept transfer">
                {actionLoading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.acceptBtnText}>Accept</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, styles.declineBtn]}
                onPress={onDecline}
                disabled={actionLoading}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Decline transfer">
                <Text style={styles.declineBtnText}>Decline</Text>
              </TouchableOpacity>
            </>
          )}
          {isSender && (
            <TouchableOpacity
              style={[styles.actionBtn, styles.declineBtn]}
              onPress={onCancel}
              disabled={actionLoading}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Cancel transfer">
              {actionLoading ? (
                <ActivityIndicator size="small" color={PV2.accent} />
              ) : (
                <Text style={styles.declineBtnText}>Cancel</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const THUMB_SIZE = 44;

const styles = StyleSheet.create({
  row: {
    paddingVertical: 12,
    gap: 10,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  ccId: {
    color: PV2.textTertiary,
    fontSize: 11,
  },
  direction: {
    color: PV2.textTertiary,
    fontSize: 12,
    marginTop: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  date: {
    color: PV2.textTertiary,
    fontSize: 11,
  },
  metaDot: {
    color: PV2.textTertiary,
    fontSize: 11,
  },
  reason: {
    color: PV2.textTertiary,
    fontSize: 11,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: PV2.accentSoft,
  },
  statusPillResolved: {
    backgroundColor: PV2.emptyCardBg,
  },
  statusPillText: {
    color: PV2.accent,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  statusPillTextResolved: {
    color: PV2.textTertiary,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingLeft: THUMB_SIZE + 12,
  },
  actionBtn: {
    minHeight: 36,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptBtn: {
    backgroundColor: PV2.accent,
  },
  acceptBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  declineBtn: {
    borderWidth: 1,
    borderColor: PV2.accent,
    backgroundColor: 'transparent',
  },
  declineBtnText: {
    color: PV2.accent,
    fontSize: 13,
    fontWeight: '700',
  },
});
