import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { IconSymbol } from '@/components/ui/icon-symbol';
import {
  TransferRecipientPicker,
  type TransferRecipientProfile,
} from '@/components/registry/transfer-recipient-picker';
import { useSignedRegistryImages } from '@/hooks/use-signed-registry-images';
import { useAuth } from '@/lib/auth';
import { formatCustodyStatus, updateRegistryCustodyStatus } from '@/lib/registry-custody-status';
import { getRegistryPublicUrl } from '@/lib/registry-links';
import { fetchPendingTransferForCard, formatTransferReason, initiateOwnershipTransfer } from '@/lib/ownership-transfer';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { CollectionItem, CustodyStatus, OwnershipTransferReason, RegisteredCard, RegisteredCardStatus } from '@/types';

type RegisteredCardWithItem = RegisteredCard & {
  collection_item: CollectionItem | null;
};

// registered_cards.current_owner_id has no FK relationship to
// public.profiles (it references auth.users(id) — see RegisteredCard's own
// comment in types/index.ts), so it can't be embedded in the query above.
// Fetched separately, same pattern as app/item/[id].tsx's ownerProfile.
type OwnerProfile = {
  username: string;
  display_name: string | null;
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

const STATUS_LABEL: Record<RegisteredCardStatus, string> = {
  owner_registered: 'Active',
  active: 'Active',
  inactive: 'Inactive',
  owner_account_deleted: 'Owner account deleted',
};

// Status-only — the owner/date facts already live in the info panel above,
// this describes the health of the registry ID itself, not who owns it or
// when it was registered.
function buildStatusSentence(status: RegisteredCardStatus): string {
  if (status === 'owner_registered' || status === 'active') {
    return 'This Registry ID is active and in good standing.';
  }
  if (status === 'inactive') {
    return 'This Registry ID is currently inactive.';
  }
  if (status === 'owner_account_deleted') {
    return 'This Registry ID remains valid, but the owning account has been deleted.';
  }
  return `This Registry ID's status is ${STATUS_LABEL[status]}.`;
}

// Same identity logic as app/item/[id].tsx's buildIdentity — player is the
// primary title, falling back to the item's own title. Kept in sync
// deliberately rather than imported.
function buildTitle(item: CollectionItem): string {
  return item.player?.trim() || item.title?.trim() || 'Untitled Item';
}

// year + brand + item title, e.g. "2018 Donruss Rated Rookie" — each part
// included only when present/non-empty. item.title is appended last, and
// only when it differs from the main title buildTitle() already displays
// (e.g. when player is set, item.title is often a distinct card
// designation like "Rated Rookie" rather than a duplicate of the player
// name) — this is what surfaces the card's own title without ever
// duplicating what's already shown above it.
function buildSubtitle(item: CollectionItem): string | null {
  const mainTitle = buildTitle(item);
  const brand = item.brand?.trim() || null;
  const itemTitle = item.title?.trim() || null;

  const parts: (string | null)[] = [item.year != null ? String(item.year) : null, brand];
  if (itemTitle && itemTitle !== mainTitle) {
    parts.push(itemTitle);
  }

  return parts.filter(Boolean).join(' ') || null;
}

// Canonical certificate identity (registered_cards.snapshot_* — set once by
// register_card at registration, never touched by later collection_item
// edits or by ownership-transfer's collection_item_id clearing). A linked
// collection_item is an owner-specific organizational connection, not the
// source of truth — buildTitle/buildSubtitle above remain purely as the
// legacy fallback for records with no snapshot data, never consulted when
// a snapshot value already exists.
function buildSnapshotTitle(record: RegisteredCard): string | null {
  return record.snapshot_player?.trim() || record.snapshot_title?.trim() || null;
}

function buildSnapshotSubtitle(record: RegisteredCard): string | null {
  const mainTitle = buildSnapshotTitle(record);
  const brand = record.snapshot_brand?.trim() || null;
  const snapshotTitle = record.snapshot_title?.trim() || null;

  if (record.snapshot_year == null && !brand && !snapshotTitle) {
    return null;
  }

  const parts: (string | null)[] = [record.snapshot_year != null ? String(record.snapshot_year) : null, brand];
  if (snapshotTitle && snapshotTitle !== mainTitle) {
    parts.push(snapshotTitle);
  }

  return parts.filter(Boolean).join(' ') || null;
}

// Registry Custody Status v1 — full option list in a fixed, deliberate
// order (not derived from the CustodyStatus union's declaration order,
// though it happens to match) so the picker's layout never silently
// reorders if the type's declaration order ever changes.
const CUSTODY_STATUS_OPTIONS: CustodyStatus[] = [
  'owned',
  'in_transfer',
  'on_loan',
  'submitted_for_grading',
  'missing',
  'stolen',
  'destroyed',
  'archived',
];

// Requires an Alert.alert confirmation before applying — matches the
// approved product spec exactly.
const CUSTODY_STATUS_REQUIRES_CONFIRMATION = new Set<CustodyStatus>(['missing', 'stolen', 'destroyed', 'archived']);

// Rendered with PV2.accent in the picker — this app's design system
// (components/profile-v2/profile-v2-theme.ts) has no separate warning/
// error token distinct from its one existing accent red, so this reuses
// that rather than introducing a new color. Deliberately a narrower set
// than CUSTODY_STATUS_REQUIRES_CONFIRMATION (excludes 'archived', which is
// a routine/expected end state, not a severe one).
const CUSTODY_STATUS_SEVERE = new Set<CustodyStatus>(['missing', 'stolen', 'destroyed']);

// Ownership Transfer Phase 2 — fixed, deliberate order, same convention as
// CUSTODY_STATUS_OPTIONS above. No value here that isn't already part of
// the canonical OwnershipTransferReason union (types/index.ts) — this is a
// picker over existing values, never a place that invents new ones.
const TRANSFER_REASON_OPTIONS: OwnershipTransferReason[] = ['sale', 'trade', 'gift', 'other'];

// Minimal registry detail screen — Phase 2B1 scope. Reached from the item-
// detail "View Registry" action once a card is registered. No verification
// scoring — those are later CacheCase Registry sub-phases. Fetches fresh by
// id (same convention as every other detail route in this app —
// item/[id].tsx, collection/[folderId].tsx, post/[id].tsx,
// conversation/[id].tsx all re-fetch by id rather than trusting only
// passed params) so it also works if reached via a future direct link, not
// just via in-app navigation.
export default function RegistryDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;

  const [record, setRecord] = useState<RegisteredCardWithItem | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // Distinct from notFound: a genuine query failure (network/RLS/etc.)
  // must never be presented as "this record doesn't exist," which would
  // hide the actual cause.
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isQrModalVisible, setIsQrModalVisible] = useState(false);
  const [isCustodyModalVisible, setIsCustodyModalVisible] = useState(false);
  const [updatingCustodyStatus, setUpdatingCustodyStatus] = useState(false);
  // Tracks a resolved signed URL that failed to actually load (e.g. expired
  // between resolution and render) so the hero image falls back to the
  // existing placeholder instead of a permanently blank <Image> — reset
  // automatically whenever a different URL comes in.
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);

  // Ownership Transfer Phase 2 state — all owner-only, all scoped to this
  // one card. pendingTransferId is intentionally just an id, not a full
  // OwnershipTransferView: this screen never displays transfer details
  // (sender/recipient/reason/etc.) inline, only whether one exists, so it
  // never needs more than fetchPendingTransferForCard already returns.
  const [pendingTransferLoading, setPendingTransferLoading] = useState(false);
  const [pendingTransferId, setPendingTransferId] = useState<string | null>(null);
  const [pendingTransferError, setPendingTransferError] = useState<string | null>(null);
  const [isTransferModalVisible, setIsTransferModalVisible] = useState(false);
  const [selectedRecipient, setSelectedRecipient] = useState<TransferRecipientProfile | null>(null);
  const [selectedReason, setSelectedReason] = useState<OwnershipTransferReason | null>(null);
  const [submittingTransfer, setSubmittingTransfer] = useState(false);

  // Public QR payload — built only from the public cc_id, never
  // record.id/collection_item_id/current_owner_id. null whenever no real
  // base URL is configured or cc_id is somehow blank; see
  // lib/registry-links.ts for why no fallback domain is used. Computed
  // here (not after the early returns below) so the guard effect right
  // after it can reference it unconditionally, per the rules of hooks —
  // every hook in this component runs on every render, regardless of
  // loading/error/not-found state.
  const registryPublicUrl = record ? getRegistryPublicUrl(record.cc_id) : null;

  // The card's own immutable registry snapshot — never derived from the
  // current live collection item, so this stays correct as a historical
  // record even after custody/ownership changes. Computed unconditionally
  // (not after the early returns below), same rules-of-hooks reasoning as
  // registryPublicUrl above.
  const { urls: signedRegistryUrls } = useSignedRegistryImages([record?.id]);
  const signedImageUrl = record ? signedRegistryUrls.get(record.id) : undefined;

  // Owner check, computed unconditionally (not after the loading/error/
  // not-found early returns below) so the pending-transfer effect further
  // down — which must also run on every render per the rules of hooks —
  // can use it. Same shape as app/item/[id].tsx's isOwner: session id
  // compared directly against the record's own current_owner_id.
  const isOwner = !!record && !!currentUserId && record.current_owner_id === currentUserId;

  // Guards against the modal staying open if the public URL becomes
  // unavailable out from under it (e.g. the record reloads for a
  // different id while the modal happened to still be open).
  useEffect(() => {
    if (!registryPublicUrl && isQrModalVisible) {
      setIsQrModalVisible(false);
    }
  }, [registryPublicUrl, isQrModalVisible]);

  // Extracted as a stable callback (not a plain useEffect body) so it can
  // be re-run from useFocusEffect below, not just on mount/id-change —
  // needed so returning here from app/claim-card/[id].tsx after a
  // successful claim always re-fetches record.collection_item_id and
  // flips the panel below from "Add to My Collection" to "View in My
  // Collection" without requiring a separate signal to be passed back.
  // Same "reload on every focus" convention already used by
  // app/transactions/[userId].tsx and app/(tabs)/notifications.tsx.
  const load = useCallback(async () => {
    if (!id) {
      // No route parameter at all — nothing to query. Without this,
      // loading (which starts true) would never resolve.
      setLoading(false);
      setNotFound(true);
      return;
    }

    setLoading(true);
    setNotFound(false);
    setFetchError(null);
    // Clears any previously loaded record so stale registry data can't
    // remain visible while navigating from one registry page to another.
    setRecord(null);
    setOwnerProfile(null);

    const { data, error } = await supabase
      .from('registered_cards')
      .select('*, collection_item:collection_items!registered_cards_collection_item_id_fkey(*)')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[RegistryDetail] load failed:', error.message, error);
      setFetchError(error.message);
      setLoading(false);
      return;
    }

    if (!data) {
      setNotFound(true);
      setLoading(false);
      return;
    }

    const row = data as unknown as RegisteredCardWithItem;
    setRecord(row);

    // Best-effort — a missing/failed owner lookup shouldn't block showing
    // the registry record itself (e.g. current_owner_id is null when the
    // owning account was deleted, per registered_cards' own SET NULL
    // design).
    if (row.current_owner_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('username, display_name')
        .eq('id', row.current_owner_id)
        .maybeSingle();
      if (profile) setOwnerProfile(profile as OwnerProfile);
    }

    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Ownership Transfer Phase 2 — owner-only pending-transfer check.
  // Deliberately a separate effect/query from the record load above (see
  // fetchPendingTransferForCard's own comment in lib/ownership-transfer.ts
  // for why this is its own narrow query, not fetchOwnershipTransfersForUser).
  // checkPendingTransfer is extracted as a stable callback so both this
  // effect and the error state's "Retry" button below can call it.
  const checkPendingTransfer = useCallback(async (registeredCardId: string) => {
    setPendingTransferLoading(true);
    setPendingTransferError(null);
    const { error, data } = await fetchPendingTransferForCard(registeredCardId);
    if (error) {
      if (__DEV__) console.error('[RegistryDetail] pending-transfer check failed:', error);
      setPendingTransferError(error);
      setPendingTransferId(null);
      setPendingTransferLoading(false);
      return;
    }
    setPendingTransferId(data?.id ?? null);
    setPendingTransferLoading(false);
  }, []);

  useEffect(() => {
    // Non-owners never run this query at all — not just "don't show the
    // button," the network call itself never happens. Also resets to a
    // clean not-loaded state whenever the record or the ownership relationship
    // changes (different card navigated to, or this viewer's ownership of
    // the current card changed), so stale pending state from a previous
    // card/owner can never leak into the new one.
    if (!record || !isOwner) {
      setPendingTransferLoading(false);
      setPendingTransferId(null);
      setPendingTransferError(null);
      return;
    }
    checkPendingTransfer(record.id);
    // record?.id below IS the intended dependency, matching this effect's
    // own "different card navigated to" comment above: the rule doesn't
    // recognize record?.id in this array as satisfying the record.id read
    // above (an optional-chain vs. plain-member-expression mismatch — a
    // known eslint-plugin-react-hooks limitation, not a real missing
    // dependency), and adding the full `record` object instead would make
    // this re-run on every unrelated setRecord update (e.g. the
    // partial-field merge elsewhere in this file), triggering an
    // unnecessary pending-transfer network re-check each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id, isOwner, checkPendingTransfer]);

  function handleQrPanelPress() {
    if (!registryPublicUrl) return;
    setIsQrModalVisible(true);
  }

  function closeQrModal() {
    setIsQrModalVisible(false);
  }

  // Owner-only entry point — the row this opens from is itself only
  // rendered as pressable when isOwner is true (see the JSX below), so
  // this guard is defense in depth, not the only gate.
  function handleCustodyStatusPress() {
    if (!record || !isOwner) return;
    setIsCustodyModalVisible(true);
  }

  function closeCustodyModal() {
    // Don't allow dismissing mid-request — avoids the sheet closing while
    // a submission is still in flight, which would strand the loading
    // indicator with no way to see its outcome.
    if (updatingCustodyStatus) return;
    setIsCustodyModalVisible(false);
  }

  // The only function that actually calls the RPC. Never called directly
  // from a row's onPress — always through handleSelectCustodyStatus below,
  // so the confirmation gate can never be bypassed.
  async function applyCustodyStatus(newStatus: CustodyStatus) {
    if (!record || updatingCustodyStatus || newStatus === record.custody_status) return;

    setUpdatingCustodyStatus(true);
    try {
      const { data, error } = await updateRegistryCustodyStatus(record.id, newStatus);
      if (error) {
        Alert.alert('Update failed', error);
        return;
      }
      // Not an optimistic update — this only runs after the RPC has
      // already confirmed success, using its own RETURNING row as the
      // authoritative source. Merged onto the existing joined record
      // (which also carries collection_item, not returned by the RPC)
      // rather than re-running the full load() query, avoiding a second
      // network round-trip and a full-page loading-state flash for what
      // is otherwise a small, already-confirmed field change.
      setRecord((prev) => (prev ? { ...prev, ...data } : prev));
      setIsCustodyModalVisible(false);
    } catch (e) {
      Alert.alert('Update failed', e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setUpdatingCustodyStatus(false);
    }
  }

  // Confirmation gate. Missing/Stolen/Destroyed/Archived require an
  // explicit Alert.alert confirmation (matching this app's existing
  // Alert.alert confirmation pattern, e.g. app/item/[id].tsx's delete and
  // register-with-CacheCase flows) before applyCustodyStatus ever runs;
  // every other status applies immediately on tap.
  function handleSelectCustodyStatus(newStatus: CustodyStatus) {
    if (!record || updatingCustodyStatus || newStatus === record.custody_status) return;

    if (CUSTODY_STATUS_REQUIRES_CONFIRMATION.has(newStatus)) {
      Alert.alert(
        `Change custody status to ${formatCustodyStatus(newStatus)}?`,
        'This action will be permanently recorded in the registry history.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Change', style: 'destructive', onPress: () => applyCustodyStatus(newStatus) },
        ],
      );
      return;
    }

    applyCustodyStatus(newStatus);
  }

  // Ownership Transfer Phase 2 — owner-only entry points. Gated the same
  // defense-in-depth way as handleCustodyStatusPress: the row that opens
  // this is itself only rendered when isOwner and the pending-transfer
  // check has resolved cleanly with no pending transfer (see the JSX
  // below) — this guard re-checks the same three pending-state fields
  // explicitly rather than trusting only the render gate, matching this
  // file's own established double-gating convention.
  function handleOpenTransferModal() {
    if (!record || !isOwner || pendingTransferLoading || pendingTransferError || pendingTransferId) return;
    setSelectedRecipient(null);
    setSelectedReason(null);
    setIsTransferModalVisible(true);
  }

  function closeTransferModal() {
    // Same "don't allow dismissing mid-request" rule as closeCustodyModal —
    // covers both the backdrop tap and the hardware/gesture back action
    // (onRequestClose), so neither can race a resolving RPC call.
    if (submittingTransfer) return;
    setIsTransferModalVisible(false);
  }

  // Deliberately does NOT navigate — the registry screen never duplicates
  // transfer-management UI (accept/decline/cancel, transfer details, etc.);
  // that all already exists on the Transactions screen. This just gets the
  // owner there.
  function handleViewTransfer() {
    if (!currentUserId) return;
    router.push({ pathname: '/transactions/[userId]', params: { userId: currentUserId } });
  }

  // Recipient Claim / Add to Collection Flow — owner-only, unlinked-only
  // entry into the dedicated claim route (app/claim-card/[id].tsx). Never
  // navigates when already linked; the "View in My Collection" branch
  // below goes straight to the linked item instead.
  function handleOpenClaim() {
    if (!record || !isOwner || record.collection_item_id) return;
    router.push({ pathname: '/claim-card/[id]', params: { id: record.id } });
  }

  function handleViewInCollection() {
    if (!record?.collection_item_id) return;
    router.push({ pathname: '/item/[id]', params: { id: record.collection_item_id } });
  }

  async function reconcilePendingTransferAfterError(
    cardId: string,
    recipientId: string,
    recipientUsername: string,
    originalErrorMessage: string,
  ) {
    try {
      const { error, data } = await fetchPendingTransferForCard(cardId);

      if (error) {
        console.error('[RegistryDetail] transfer reconciliation read failed:', error);
        Alert.alert(
          'Transfer status unknown',
          "We couldn't confirm whether the transfer was sent. Refresh and check your transfers before trying again.",
        );
        return;
      }

      if (!data) {
        Alert.alert('Unable to send transfer', originalErrorMessage);
        return;
      }

      if (data.to_owner_id === recipientId) {
        setIsTransferModalVisible(false);
        setSelectedRecipient(null);
        setSelectedReason(null);
        setPendingTransferId(data.id);
        Alert.alert('Transfer Sent', `Transfer request sent to @${recipientUsername}.`);
        return;
      }

      console.error(
        '[RegistryDetail] transfer reconciliation found a mismatched pending transfer:',
        {
          expectedRecipientId: recipientId,
          actualToOwnerId: data.to_owner_id,
        },
      );

      setIsTransferModalVisible(false);
      setSelectedRecipient(null);
      setSelectedReason(null);
      setPendingTransferId(data.id);

      Alert.alert(
        'Transfer status changed',
        'A different pending transfer now exists for this card. Refresh and review the transfer before trying again.',
      );
    } catch (e) {
      console.error('[RegistryDetail] transfer reconciliation read threw:', e);
      Alert.alert(
        'Transfer status unknown',
        "We couldn't confirm whether the transfer was sent. Refresh and check your transfers before trying again.",
      );
    }
  }

  async function handleSendTransfer() {
    // Guards against a double-submit from a rapid double-tap: the button
    // is also `disabled={submittingTransfer}`, but this is the actual
    // enforcement point — a disabled prop alone doesn't stop a second
    // onPress already queued before the first render update lands. The
    // database's own partial unique index
    // (ownership_transfers_one_pending_per_card) is the final backstop
    // regardless: even if two calls somehow both reached the RPC, only
    // one can succeed — the second surfaces as the ordinary "This card
    // already has a pending transfer" error below, never a duplicate row.
    if (!record || !selectedRecipient || submittingTransfer) return;

    const cardId = record.id;
    const recipientId = selectedRecipient.id;
    const recipientUsername = selectedRecipient.username;

    setSubmittingTransfer(true);
    try {
      // Kept as one result object (not destructured into separate
      // `data`/`error` bindings) so the error check below narrows
      // `result.data` via the OwnershipTransferRpcResult discriminated
      // union — splitting it into two independent bindings loses that
      // narrowing, since TS can't relate two separate variables back to
      // the same union.
      const result = await initiateOwnershipTransfer(cardId, recipientUsername, selectedReason);

      // Narrows via equality against the literal `null` discriminant, not
      // truthiness — OwnershipTransferRpcResult's failure member types
      // `error` as plain `string` (not a literal), so `if (result.error)`
      // doesn't reliably eliminate that member for TS's discriminated-
      // union narrowing, which is exactly what produced a "possibly null"
      // error on result.data below on the first pass here.
      if (result.error !== null) {
        console.error('[RegistryDetail] initiate_ownership_transfer failed:', result.error);
        await reconcilePendingTransferAfterError(cardId, recipientId, recipientUsername, result.error);
        return;
      }

      setIsTransferModalVisible(false);
      setSelectedRecipient(null);
      setSelectedReason(null);
      // Merges the RPC's own returned row directly — same "no full
      // refetch for an already-confirmed change" convention as
      // applyCustodyStatus above. Flips the panel from "Transfer Card"
      // to "View Transfer" immediately, without a second network
      // round-trip. Does not touch ownership or insert any registry
      // event — initiate_ownership_transfer only ever creates the
      // pending row itself; both of those only happen later, inside
      // accept_ownership_transfer.
      setPendingTransferId(result.data.id);
      Alert.alert('Transfer Sent', `Transfer request sent to @${recipientUsername}.`);
    } catch (e) {
      console.error('[RegistryDetail] initiate_ownership_transfer threw:', e);
      await reconcilePendingTransferAfterError(
        cardId,
        recipientId,
        recipientUsername,
        e instanceof Error ? e.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setSubmittingTransfer(false);
    }
  }

  const headerBackLeft = () => <BackButton fallbackHref="/(tabs)" />;

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Registry', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      </>
    );
  }

  if (fetchError) {
    return (
      <>
        <Stack.Screen options={{ title: 'Registry', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Could not load this registry record.</Text>
        </View>
      </>
    );
  }

  if (notFound || !record) {
    return (
      <>
        <Stack.Screen options={{ title: 'Registry', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Registry record not found.</Text>
        </View>
      </>
    );
  }

  const item = record.collection_item;
  // Snapshot-first: only falls back to the linked collection_item when no
  // snapshot identity field exists at all (legacy records registered
  // before Phase S2, or a card with no linked item) — never the reverse.
  // hasSnapshotIdentity gates the subtitle fallback specifically, since
  // buildSnapshotSubtitle() can legitimately return null (e.g. only
  // snapshot_player is set) even though canonical snapshot identity does
  // exist — that case must still not fall through to the owner-specific
  // linked item's subtitle.
  const hasSnapshotIdentity =
    !!record.snapshot_player?.trim() ||
    !!record.snapshot_title?.trim() ||
    record.snapshot_year != null ||
    !!record.snapshot_brand?.trim() ||
    !!record.snapshot_team?.trim() ||
    !!record.snapshot_image_url;
  const snapshotTitle = buildSnapshotTitle(record);
  const snapshotSubtitle = buildSnapshotSubtitle(record);
  // The card's own immutable snapshot only — never item?.image_url (the
  // current live collection item), which would silently make a historical
  // registry record track present-day ownership/content instead of what
  // was actually registered. signedImageUrl is undefined while resolving
  // or when the snapshot isn't authorized/ready, in which case no image
  // renders at all (existing placeholder-less behavior below), same as
  // when there was never a snapshot to begin with.
  const image = signedImageUrl && signedImageUrl !== failedImageUrl ? signedImageUrl : null;
  const title = snapshotTitle || (item ? buildTitle(item) : null);
  const subtitle = hasSnapshotIdentity ? snapshotSubtitle : item ? buildSubtitle(item) : null;
  const ownerName = ownerProfile?.display_name || ownerProfile?.username || 'Unavailable';
  const yearValue = record.snapshot_year ?? item?.year ?? null;
  const teamValue = record.snapshot_team?.trim() || item?.team?.trim() || null;
  const hasYear = yearValue != null;
  const hasTeam = !!teamValue;
  const statusLabel = STATUS_LABEL[record.status];
  const statusSentence = buildStatusSentence(record.status);
  const custodyStatusLabel = formatCustodyStatus(record.custody_status);
  // 70% of window width, capped so it stays reasonable on tablets; large
  // enough for comfortable phone-to-phone scanning without hardcoding an
  // oversized fixed value.
  const modalQrSize = Math.min(windowWidth * 0.62, 250);

  return (
    <>
      <Stack.Screen options={{ title: record.cc_id, headerLeft: headerBackLeft }} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}>
        {image && (
          <View style={styles.imageWrap}>
            <Image
              source={{ uri: image }}
              style={styles.image}
              contentFit="cover"
              onError={() => setFailedImageUrl(image)}
            />
          </View>
        )}

        <View style={styles.certificateHeader}>
          <Text style={styles.registryLabel}>CacheCase Registry</Text>
          <Text style={styles.certificateLabel}>Certificate ID</Text>
          <Text style={styles.ccId}>{record.cc_id}</Text>
        </View>
        <View style={styles.statusRow}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>Registered</Text>
        </View>

        {title && (
          <Text style={styles.itemTitle} numberOfLines={2}>
            {title}
          </Text>
        )}
        {subtitle && (
          <Text style={styles.itemSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}

        <View style={styles.infoPanel}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Registered</Text>
            <Text style={styles.infoValue}>{formatDate(record.created_at)}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Current owner</Text>
            <Text style={styles.infoValue} numberOfLines={1}>
              {ownerName}
            </Text>
          </View>
          <View style={[styles.infoRow, !hasYear && !hasTeam && styles.infoRowLast]}>
            <Text style={styles.infoLabel}>Custody Status</Text>
            {isOwner ? (
              <Pressable
                onPress={handleCustodyStatusPress}
                hitSlop={8}
                style={({ pressed }) => [styles.custodyValueRow, pressed && styles.custodyValueRowPressed]}
                accessibilityRole="button"
                accessibilityLabel={`Custody status: ${custodyStatusLabel}. Change custody status.`}>
                <Text style={styles.infoValue}>{custodyStatusLabel}</Text>
                <IconSymbol name="chevron.right" size={14} color={PV2.textTertiary} />
              </Pressable>
            ) : (
              <Text style={styles.infoValue}>{custodyStatusLabel}</Text>
            )}
          </View>
          {hasYear && (
            <View style={[styles.infoRow, !hasTeam && styles.infoRowLast]}>
              <Text style={styles.infoLabel}>Year</Text>
              <Text style={styles.infoValue}>{yearValue}</Text>
            </View>
          )}
          {hasTeam && (
            <View style={[styles.infoRow, styles.infoRowLast]}>
              <Text style={styles.infoLabel}>Team</Text>
              <Text style={styles.infoValue}>{teamValue}</Text>
            </View>
          )}
        </View>

        <View style={styles.statusPanel}>
          <Text style={styles.statusPanelHeader}>Registry Status</Text>
          <View style={styles.statusPanelRow}>
            <View style={styles.statusPanelDot} />
            <Text style={styles.statusPanelLabel}>{statusLabel}</Text>
          </View>
          <Text style={styles.statusPanelSentence}>{statusSentence}</Text>
        </View>

        {/* Ownership Transfer Phase 2 — owner-only, four distinct states.
            Non-owners see none of this (matches the custody-status row's
            own non-owner treatment). Loading shows a plain spinner with no
            button underneath it, so there's never a flash of the wrong
            action. An error never falls back to an active "Transfer Card"
            button — initiation can't proceed from an unknown pending
            state — only a generic retry, and the underlying query message
            is never shown to the user, only logged in dev. */}
        {isOwner && (
          <>
            {pendingTransferLoading ? (
              <View style={styles.transferLoadingPanel}>
                <ActivityIndicator size="small" color={PV2.textTertiary} />
              </View>
            ) : pendingTransferError ? (
              <View style={styles.transferErrorPanel}>
                <Text style={styles.transferErrorText}>Couldn&apos;t check transfer status.</Text>
                <Pressable
                  onPress={() => checkPendingTransfer(record.id)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Retry checking transfer status">
                  <Text style={styles.transferErrorRetry}>Retry</Text>
                </Pressable>
              </View>
            ) : pendingTransferId ? (
              <Pressable
                style={({ pressed }) => [styles.historyButton, pressed && styles.historyButtonPressed]}
                onPress={handleViewTransfer}
                accessibilityRole="button"
                accessibilityLabel="View pending transfer">
                <Text style={styles.historyButtonText}>View Transfer</Text>
                <IconSymbol name="chevron.right" size={16} color={PV2.textSecondary} />
              </Pressable>
            ) : (
              <Pressable
                style={({ pressed }) => [styles.historyButton, pressed && styles.historyButtonPressed]}
                onPress={handleOpenTransferModal}
                accessibilityRole="button"
                accessibilityLabel="Transfer this card to another user">
                <Text style={styles.historyButtonText}>Transfer Card</Text>
                <IconSymbol name="chevron.right" size={16} color={PV2.textSecondary} />
              </Pressable>
            )}
          </>
        )}

        {/* Recipient Claim / Add to Collection Flow — owner-only. Unlinked
            shows the explicit "not linked yet" caption plus the action;
            linked shows a plain "View in My Collection" shortcut. Both
            reuse the historyButton visual family, same as the transfer
            panel above. */}
        {isOwner && (
          <>
            {record.collection_item_id ? (
              <Pressable
                style={({ pressed }) => [styles.historyButton, pressed && styles.historyButtonPressed]}
                onPress={handleViewInCollection}
                accessibilityRole="button"
                accessibilityLabel="View in My Collection">
                <Text style={styles.historyButtonText}>View in My Collection</Text>
                <IconSymbol name="chevron.right" size={16} color={PV2.textSecondary} />
              </Pressable>
            ) : (
              <View style={styles.claimPanel}>
                <Text style={styles.claimPanelCaption}>This card is not linked to your collection yet.</Text>
                <Pressable
                  style={({ pressed }) => [styles.claimButton, pressed && styles.claimButtonPressed]}
                  onPress={handleOpenClaim}
                  accessibilityRole="button"
                  accessibilityLabel="Add to My Collection">
                  <Text style={styles.claimButtonText}>Add to My Collection</Text>
                </Pressable>
              </View>
            )}
          </>
        )}

        <Pressable
          style={({ pressed }) => [styles.historyButton, pressed && styles.historyButtonPressed]}
          onPress={() => router.push({ pathname: '/registry-history/[id]', params: { id: record.id } })}
          accessibilityRole="button"
          accessibilityLabel="View Registry History">
          <Text style={styles.historyButtonText}>View Registry History</Text>
          <IconSymbol name="chevron.right" size={16} color={PV2.textSecondary} />
        </Pressable>

        <View style={styles.qrPanel}>
          <Text style={styles.qrPanelHeader}>Public Registry Link</Text>
          {registryPublicUrl ? (
            <>
              <Pressable
                style={({ pressed }) => [styles.qrCard, pressed && styles.qrCardPressed]}
                onPress={handleQrPanelPress}
                accessibilityRole="button"
                accessibilityLabel="Open large QR code for scanning">
                <QRCode value={registryPublicUrl} size={160} color="#000000" backgroundColor="#FFFFFF" />
              </Pressable>
              <Text style={styles.qrCcIdLabel}>{record.cc_id}</Text>
            </>
          ) : (
            <View style={styles.qrUnavailable}>
              <Text style={styles.qrUnavailableText}>Public registry link unavailable</Text>
            </View>
          )}
        </View>
      </ScrollView>

      <Modal
        visible={isQrModalVisible && !!registryPublicUrl}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeQrModal}>
        <View style={styles.qrModalRoot}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={closeQrModal}
            accessibilityRole="button"
            accessibilityLabel="Close QR code"
          />

          <View style={[styles.qrModalCard, { marginBottom: Math.max(insets.bottom, 12) }]}>
            <TouchableOpacity
              style={styles.qrModalCloseButton}
              onPress={closeQrModal}
              accessibilityRole="button"
              accessibilityLabel="Close">
              <IconSymbol name="xmark" size={18} color={PV2.textPrimary} />
            </TouchableOpacity>

            {registryPublicUrl && (
              <QRCode value={registryPublicUrl} size={modalQrSize} color="#000000" backgroundColor="#FFFFFF" />
            )}
            <Text style={styles.qrModalCcId}>{record.cc_id}</Text>
            {title && (
              <Text style={styles.qrModalTitle} numberOfLines={2}>
                {title}
              </Text>
            )}
            <Text style={styles.qrModalInstruction}>Scan to view this CacheCase registry record.</Text>
          </View>
        </View>
      </Modal>

      {/* Custody status picker — same bottom-sheet shell shape as
          components/create/create-menu.tsx (backdrop dismiss, drag handle,
          divided rows), styled with this screen's own PV2 tokens rather
          than that component's separate hardcoded palette, so it reads as
          native to this screen. Only ever opened via handleCustodyStatusPress,
          which is itself only reachable through the owner-gated row above. */}
      <Modal
        visible={isCustodyModalVisible}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={closeCustodyModal}>
        <View style={styles.custodyModalBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={closeCustodyModal}
            accessibilityRole="button"
            accessibilityLabel="Close custody status picker"
          />

          <View style={[styles.custodySheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.custodySheetHandle} />
            <Text style={styles.custodySheetTitle}>Custody Status</Text>

            {CUSTODY_STATUS_OPTIONS.map((option, index) => {
              const isCurrent = option === record.custody_status;
              const isSevere = CUSTODY_STATUS_SEVERE.has(option);
              return (
                <View key={option}>
                  {index > 0 && <View style={styles.custodySheetDivider} />}
                  <Pressable
                    disabled={isCurrent || updatingCustodyStatus}
                    onPress={() => handleSelectCustodyStatus(option)}
                    style={({ pressed }) => [
                      styles.custodySheetRow,
                      pressed && !isCurrent && styles.custodySheetRowPressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: isCurrent || updatingCustodyStatus, selected: isCurrent }}>
                    <Text
                      style={[
                        styles.custodySheetRowText,
                        isSevere && styles.custodySheetRowTextSevere,
                        isCurrent && styles.custodySheetRowTextCurrent,
                      ]}>
                      {formatCustodyStatus(option)}
                    </Text>
                    {isCurrent && <Text style={styles.custodySheetCurrentLabel}>Current</Text>}
                  </Pressable>
                </View>
              );
            })}

            {updatingCustodyStatus && (
              <View style={styles.custodySheetLoadingWrap}>
                <ActivityIndicator size="small" color={PV2.link} />
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* Transfer Card sheet — same bottom-sheet shell as the custody
          modal above. Two internal steps in one sheet (recipient search,
          then reason + send) rather than two separate modals, since the
          whole flow is short. Only ever opened via handleOpenTransferModal,
          itself only reachable through the owner-gated, no-pending-transfer
          panel button above. */}
      <Modal
        visible={isTransferModalVisible}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={closeTransferModal}>
        <View style={styles.custodyModalBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={closeTransferModal}
            accessibilityRole="button"
            accessibilityLabel="Close transfer sheet"
          />

          <View style={[styles.custodySheet, styles.transferSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.custodySheetHandle} />
            <Text style={styles.custodySheetTitle}>Transfer Card</Text>

            {!selectedRecipient ? (
              <TransferRecipientPicker excludeUserId={currentUserId ?? ''} onSelect={setSelectedRecipient} />
            ) : (
              <>
                <View style={styles.selectedRecipientRow}>
                  <View style={styles.selectedRecipientBody}>
                    <Text style={styles.selectedRecipientName} numberOfLines={1}>
                      {selectedRecipient.display_name || selectedRecipient.username}
                    </Text>
                    <Text style={styles.selectedRecipientUsername} numberOfLines={1}>
                      @{selectedRecipient.username}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => setSelectedRecipient(null)}
                    disabled={submittingTransfer}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Change recipient">
                    <Text style={styles.changeRecipientText}>Change</Text>
                  </Pressable>
                </View>

                <Text style={styles.reasonLabel}>Reason (optional)</Text>
                <View style={styles.reasonPillRow}>
                  {TRANSFER_REASON_OPTIONS.map((reason) => {
                    const active = selectedReason === reason;
                    return (
                      <Pressable
                        key={reason}
                        disabled={submittingTransfer}
                        onPress={() => setSelectedReason(active ? null : reason)}
                        style={[styles.reasonPill, active && styles.reasonPillActive]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}>
                        <Text style={[styles.reasonPillText, active && styles.reasonPillTextActive]}>
                          {formatTransferReason(reason)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Pressable
                  style={({ pressed }) => [
                    styles.sendTransferBtn,
                    pressed && !submittingTransfer && styles.sendTransferBtnPressed,
                  ]}
                  onPress={handleSendTransfer}
                  disabled={submittingTransfer}
                  accessibilityRole="button"
                  accessibilityLabel="Send transfer request">
                  {submittingTransfer ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.sendTransferBtnText}>Send Transfer Request</Text>
                  )}
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.bg,
  },
  errorText: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  scroll: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 24,
    alignItems: 'center',
  },
  imageWrap: {
    width: 200,
    aspectRatio: 5 / 7,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: PV2.panel,
    marginBottom: 20,
  },
  image: {
    flex: 1,
  },
  certificateHeader: {
    width: '100%',
    marginTop: 16,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(160,140,220,0.38)',
    backgroundColor: 'rgba(160,140,220,0.10)',
    alignItems: 'center',
  },
  registryLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
  },
  certificateLabel: {
    marginTop: 10,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
  },
  ccId: {
    marginTop: 4,
    fontSize: 20,
    fontWeight: '700',
    color: PV2.textPrimary,
    letterSpacing: 1.2,
    fontVariant: ['tabular-nums'],
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(52,199,89,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(52,199,89,0.35)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#34C759',
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  itemTitle: {
    marginTop: 16,
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  itemSubtitle: {
    marginTop: 4,
    fontSize: 13,
    color: PV2.textTertiary,
    textAlign: 'center',
  },
  infoPanel: {
    width: '100%',
    marginTop: 24,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  infoRowLast: {
    borderBottomWidth: 0,
  },
  infoLabel: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  custodyValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  custodyValueRowPressed: {
    opacity: 0.6,
  },
  statusPanel: {
    width: '100%',
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  statusPanelHeader: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
  },
  statusPanelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  statusPanelDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#34C759',
  },
  statusPanelLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  statusPanelSentence: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 18,
    color: PV2.textSecondary,
  },
  historyButton: {
    width: '100%',
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  historyButtonPressed: {
    opacity: 0.8,
  },
  historyButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  transferLoadingPanel: {
    width: '100%',
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingVertical: 14,
    alignItems: 'center',
  },
  transferErrorPanel: {
    width: '100%',
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  transferErrorText: {
    fontSize: 13,
    color: PV2.textTertiary,
    flex: 1,
  },
  transferErrorRetry: {
    fontSize: 13,
    fontWeight: '700',
    color: PV2.link,
    marginLeft: 12,
  },
  claimPanel: {
    width: '100%',
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  claimPanelCaption: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  claimButton: {
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: PV2.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  claimButtonPressed: {
    opacity: 0.85,
  },
  claimButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  qrPanel: {
    width: '100%',
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  qrPanelHeader: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
  },
  // White card so the QR keeps full black-on-white contrast regardless of
  // the surrounding dark theme — required for the code to stay reliably
  // scannable.
  qrCard: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  qrCardPressed: {
    opacity: 0.85,
  },
  qrCcIdLabel: {
    marginTop: 10,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.5,
    color: PV2.textSecondary,
  },
  qrUnavailable: {
    marginTop: 12,
    paddingVertical: 24,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  qrUnavailableText: {
    fontSize: 13,
    color: PV2.textTertiary,
    textAlign: 'center',
  },
  qrModalRoot: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  // Only the QRCode component itself (its own backgroundColor="#FFFFFF"
  // prop, set directly on <QRCode>, not a style here) stays white — required
  // for scanner contrast, same reasoning as qrCard above. This sheet
  // wrapping it is now dark/PV2-themed like the rest of the app; the QR's
  // own white square still renders on top of it either way.
  qrModalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: PV2.panel,
    borderRadius: 24,
    paddingTop: 12,
    paddingBottom: 24,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  qrModalCloseButton: {
    alignSelf: 'flex-end',
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: PV2.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  qrModalCcId: {
    marginTop: 18,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 1,
    color: PV2.textPrimary,
  },
  qrModalTitle: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  qrModalInstruction: {
    marginTop: 14,
    fontSize: 12,
    color: PV2.textSecondary,
    textAlign: 'center',
    lineHeight: 17,
  },
  custodyModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  custodySheet: {
    backgroundColor: PV2.panel,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    borderBottomWidth: 0,
    paddingTop: 12,
    paddingHorizontal: 20,
  },
  custodySheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: PV2.dividerColor,
    alignSelf: 'center',
    marginBottom: 16,
  },
  custodySheetTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
    marginBottom: 4,
  },
  custodySheetDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: PV2.dividerColor,
  },
  custodySheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  custodySheetRowPressed: {
    opacity: 0.6,
  },
  custodySheetRowText: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  custodySheetRowTextSevere: {
    color: PV2.accent,
  },
  custodySheetRowTextCurrent: {
    color: PV2.textPrimary,
    fontWeight: '700',
  },
  custodySheetCurrentLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: PV2.textTertiary,
  },
  custodySheetLoadingWrap: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  transferSheet: {
    paddingBottom: 4,
  },
  selectedRecipientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 4,
    marginBottom: 16,
  },
  selectedRecipientBody: {
    flex: 1,
    gap: 1,
  },
  selectedRecipientName: {
    fontSize: 14,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  selectedRecipientUsername: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
  changeRecipientText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.link,
    marginLeft: 12,
  },
  reasonLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
    marginBottom: 8,
  },
  reasonPillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
  },
  reasonPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  reasonPillActive: {
    backgroundColor: PV2.accent,
    borderColor: PV2.accent,
  },
  reasonPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  reasonPillTextActive: {
    color: '#fff',
  },
  sendTransferBtn: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: PV2.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  sendTransferBtnPressed: {
    opacity: 0.85,
  },
  sendTransferBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
