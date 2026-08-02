import { supabase } from './supabase';
import type { OwnershipTransfer, OwnershipTransferReason, OwnershipTransferStatus, RegisteredCard } from '@/types';

// ============================================================================
// RPC wrappers — thin, never throw, mirror lib/registry-custody-status.ts's
// exact result-object convention. None of these duplicate authorization
// logic: every one of the four RPCs is SECURITY DEFINER and independently
// re-verifies caller identity, participant role, and current state
// server-side (see supabase/migrations/20260729120000_create_ownership_transfers.sql) —
// these wrappers only shape the call and the response.
// ============================================================================

export type OwnershipTransferRpcResult<T> = { error: null; data: T } | { error: string; data: null };

export async function initiateOwnershipTransfer(
  registeredCardId: string,
  recipientUsername: string,
  reason: OwnershipTransferReason | null,
): Promise<OwnershipTransferRpcResult<OwnershipTransfer>> {
  const { data, error } = await supabase.rpc('initiate_ownership_transfer', {
    p_registered_card_id: registeredCardId,
    p_recipient_username: recipientUsername,
    p_reason: reason,
  });
  if (error) return { error: error.message, data: null };
  return { error: null, data: data as OwnershipTransfer };
}

export async function acceptOwnershipTransfer(
  transferId: string,
): Promise<OwnershipTransferRpcResult<RegisteredCard>> {
  const { data, error } = await supabase.rpc('accept_ownership_transfer', { p_transfer_id: transferId });
  if (error) return { error: error.message, data: null };
  return { error: null, data: data as RegisteredCard };
}

export async function declineOwnershipTransfer(
  transferId: string,
): Promise<OwnershipTransferRpcResult<OwnershipTransfer>> {
  const { data, error } = await supabase.rpc('decline_ownership_transfer', { p_transfer_id: transferId });
  if (error) return { error: error.message, data: null };
  return { error: null, data: data as OwnershipTransfer };
}

export async function cancelOwnershipTransfer(
  transferId: string,
): Promise<OwnershipTransferRpcResult<OwnershipTransfer>> {
  const { data, error } = await supabase.rpc('cancel_ownership_transfer', { p_transfer_id: transferId });
  if (error) return { error: error.message, data: null };
  return { error: null, data: data as OwnershipTransfer };
}

// ============================================================================
// Card-scoped pending-transfer check — used by the registry detail screen to
// decide between "Transfer Card" and "View Transfer" for the owner.
// Deliberately NOT fetchOwnershipTransfersForUser below (that returns a
// user's entire transfer history across every card, sent+received); the
// registry screen only ever needs "does THIS card have a pending transfer,"
// so this is its own narrow, single-row query rather than over-fetching.
// maybeSingle() is safe (not just convenient) because
// ownership_transfers_one_pending_per_card is a real partial unique index
// (UNIQUE (registered_card_id) WHERE status = 'pending') — the same
// constraint initiate_ownership_transfer's own unique-violation catch
// relies on — so the database itself guarantees this query can never see
// more than one row.
// ============================================================================

export async function fetchPendingTransferForCard(
  registeredCardId: string,
): Promise<{ error: string | null; data: { id: string } | null }> {
  const { data, error } = await supabase
    .from('ownership_transfers')
    .select('id')
    .eq('registered_card_id', registeredCardId)
    .eq('status', 'pending')
    .maybeSingle();

  if (error) return { error: error.message, data: null };
  return { error: null, data: data as { id: string } | null };
}

// ============================================================================
// Read model — one transfer as the transactions screen needs to render it.
// ============================================================================

export type OwnershipTransferParticipant = {
  id: string;
  username: string;
  displayName: string | null;
};

// null specifically means the joined registered_cards row was hidden by
// RLS, not "no card" (every ownership_transfers row always has one) — see
// the long comment on fetchOwnershipTransfersForUser below for exactly
// when this happens and why it's expected, not a bug.
export type OwnershipTransferCardSummary = {
  ccId: string;
  title: string | null;
  subtitle: string | null;
  imageUrl: string | null;
};

export type OwnershipTransferView = {
  id: string;
  status: OwnershipTransferStatus;
  reason: OwnershipTransferReason | null;
  createdAt: string;
  card: OwnershipTransferCardSummary | null;
  sender: OwnershipTransferParticipant | null;
  recipient: OwnershipTransferParticipant | null;
  // Relative to the user this list was fetched for — 'sent' when they are
  // from_owner_id, 'received' when they are to_owner_id. Every row in a
  // given fetch has exactly one of these, since the query only ever
  // returns rows where that user is a participant.
  direction: 'sent' | 'received';
};

type RawOwnershipTransferRow = {
  id: string;
  status: OwnershipTransferStatus;
  reason: OwnershipTransferReason | null;
  created_at: string;
  from_owner_id: string;
  to_owner_id: string;
  registered_card: {
    cc_id: string;
    snapshot_title: string | null;
    snapshot_player: string | null;
    snapshot_year: number | null;
    snapshot_brand: string | null;
    snapshot_image_url: string | null;
  } | null;
};

function buildCardSummary(
  card: RawOwnershipTransferRow['registered_card'],
): OwnershipTransferCardSummary | null {
  if (!card) return null;
  const title = card.snapshot_player || card.snapshot_title || null;
  const subtitleParts = [card.snapshot_year != null ? String(card.snapshot_year) : null, card.snapshot_brand];
  return {
    ccId: card.cc_id,
    title,
    subtitle: subtitleParts.filter(Boolean).join(' ') || null,
    imageUrl: card.snapshot_image_url,
  };
}

// Fetches every ownership_transfers row where `userId` is a participant
// (sender or recipient), newest first, with the associated registered_cards
// row embedded via the direct registered_card_id -> registered_cards.id
// foreign key (one query, not one-per-row), plus a single batched
// `profiles` lookup covering every sender/recipient referenced across the
// whole result set (never one profiles query per row).
//
// A real, RLS-driven gap this project's live policies create, confirmed by
// reading registered_cards_select_visible directly: that policy allows a
// row when `visibility = 'public' OR current_owner_id = auth.uid() OR
// created_by = auth.uid()`. For a PRIVATE card with a PENDING (or
// declined/cancelled — ownership never actually moved) transfer, the
// RECIPIENT is neither the current owner (the sender still is, until
// accept) nor necessarily the original registrant, so the embedded
// registered_cards row comes back null for that participant on that row —
// PostgREST/RLS evaluates each embedded table's policy independently and
// simply omits what it can't show, rather than failing the whole query.
// This is expected, safe behavior, not a bug: it never blocks the
// accept/decline/cancel actions (those only need the transfer id), so
// `card` is treated as optional everywhere downstream, with the UI showing
// a generic "Registry Card" fallback instead of erroring. The sender's own
// view of their own sent transfers is never affected — current_owner_id
// still equals the sender for anything not yet accepted, and created_by
// (the original registrant) never changes, so both routes into the RLS
// policy stay open for them regardless of the card's visibility.
export async function fetchOwnershipTransfersForUser(
  userId: string,
): Promise<{ error: string | null; data: OwnershipTransferView[] }> {
  const { data: rows, error } = await supabase
    .from('ownership_transfers')
    .select(
      `id, status, reason, created_at, from_owner_id, to_owner_id,
       registered_card:registered_cards (
         cc_id, snapshot_title, snapshot_player, snapshot_year, snapshot_brand, snapshot_image_url
       )`,
    )
    .or(`from_owner_id.eq.${userId},to_owner_id.eq.${userId}`)
    .order('created_at', { ascending: false });

  if (error) {
    return { error: error.message, data: [] };
  }

  const transfers = (rows ?? []) as unknown as RawOwnershipTransferRow[];

  const participantIds = [...new Set(transfers.flatMap((t) => [t.from_owner_id, t.to_owner_id]))];
  const profileMap = new Map<string, OwnershipTransferParticipant>();
  if (participantIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username, display_name')
      .in('id', participantIds);
    for (const p of (profiles ?? []) as { id: string; username: string; display_name: string | null }[]) {
      profileMap.set(p.id, { id: p.id, username: p.username, displayName: p.display_name });
    }
  }

  const views: OwnershipTransferView[] = transfers.map((t) => ({
    id: t.id,
    status: t.status,
    reason: t.reason,
    createdAt: t.created_at,
    card: buildCardSummary(t.registered_card),
    sender: profileMap.get(t.from_owner_id) ?? null,
    recipient: profileMap.get(t.to_owner_id) ?? null,
    direction: t.from_owner_id === userId ? 'sent' : 'received',
  }));

  return { error: null, data: views };
}

const REASON_LABEL: Record<OwnershipTransferReason, string> = {
  sale: 'Sale',
  trade: 'Trade',
  gift: 'Gift',
  other: 'Other',
};

export function formatTransferReason(reason: OwnershipTransferReason | null): string | null {
  if (!reason) return null;
  return REASON_LABEL[reason] ?? reason;
}

const STATUS_LABEL: Record<OwnershipTransferStatus, string> = {
  pending: 'Pending',
  accepted: 'Completed',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

export function formatTransferStatus(status: OwnershipTransferStatus): string {
  return STATUS_LABEL[status] ?? status;
}

// Status-aware participant wording — "Transferred to @x" was previously
// shown for EVERY status, including declined/cancelled, which falsely
// implied the transfer had completed. Two lookup tables (one per
// direction), each a Record keyed by the real OwnershipTransferStatus
// values (pending/accepted/declined/cancelled — no invented status; the
// status BADGE separately displays "Completed" for 'accepted', but the
// underlying value is still 'accepted' here) — TypeScript's Record type
// enforces every status has wording in both directions, so this can't
// silently miss a case if a status is ever added.
//
// The cancelled wording explicitly names who cancelled (only the sender
// ever can, per cancel_ownership_transfer's own authorization) rather than
// leaving it ambiguous.
const SENT_WORDING: Record<OwnershipTransferStatus, (counterpart: string) => string> = {
  pending: (c) => `Pending transfer to ${c}`,
  accepted: (c) => `Transferred to ${c}`,
  declined: (c) => `Transfer declined by ${c}`,
  cancelled: (c) => `Transfer to ${c} cancelled by you`,
};

const RECEIVED_WORDING: Record<OwnershipTransferStatus, (counterpart: string) => string> = {
  pending: (c) => `Pending transfer from ${c}`,
  accepted: (c) => `Transferred from ${c}`,
  declined: (c) => `You declined transfer from ${c}`,
  cancelled: (c) => `Transfer from ${c} cancelled by sender`,
};

// Single formatter for the row's participant line — takes the whole
// transfer and returns the final display string, so no call site needs
// its own direction/status conditionals. Never renders a raw user id: a
// resolved participant shows as "@username"; an unresolved one (shouldn't
// happen — profiles are fully public — but handled anyway) falls back to
// a neutral, direction-appropriate phrase rather than a blank or an id.
export function formatTransferParticipantLine(transfer: OwnershipTransferView): string {
  const isSent = transfer.direction === 'sent';
  const counterpart = isSent ? transfer.recipient : transfer.sender;
  const fallback = isSent ? 'the recipient' : 'the sender';
  const counterpartLabel = counterpart ? `@${counterpart.username}` : fallback;
  const wording = isSent ? SENT_WORDING : RECEIVED_WORDING;
  return wording[transfer.status](counterpartLabel);
}
