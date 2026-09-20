import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { useBadgeRefresh } from '@/lib/badge-context';
import { navigateToProfile } from '@/lib/profile-navigation';
import { supabase } from '@/lib/supabase';

type NotificationType =
  | 'follow'
  | 'like'
  | 'comment'
  | 'message'
  | 'grail_rating'
  | 'ownership_transfer_requested'
  | 'ownership_transfer_accepted'
  | 'ownership_transfer_declined'
  | 'ownership_transfer_cancelled';

// Ownership Transfer Notifications Phase 1 — these four are always
// server-inserted inside the transfer RPCs (never client-inserted, unlike
// every other type above), and are the only types that use
// transferId/registeredCardId for navigation instead of post_id/
// conversation_id.
function isTransferNotification(type: NotificationType): boolean {
  return (
    type === 'ownership_transfer_requested' ||
    type === 'ownership_transfer_accepted' ||
    type === 'ownership_transfer_declined' ||
    type === 'ownership_transfer_cancelled'
  );
}

type NotificationItem = {
  id: string;
  type: NotificationType;
  read: boolean;
  created_at: string;
  post_id: string | null;
  conversation_id: string | null;
  ratingScore: number | null;
  transferId: string | null;
  registeredCardId: string | null;
  actorId: string;
  actorUsername: string;
  actorDisplayName: string | null;
  actorAvatarUrl: string | null;
};

function formatAge(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function notifLabel(item: NotificationItem): string {
  switch (item.type) {
    case 'follow':       return 'started following you.';
    case 'like':          return 'liked your post.';
    case 'comment':       return 'commented on your post.';
    case 'message':       return 'sent you a message.';
    case 'grail_rating':  return `rated your Grails ${item.ratingScore ?? '?'}/10.`;
    // Ownership Transfer Notifications Phase 1 — deliberately generic
    // Phase 1 copy: no CC ID, no transfer reason (both approved
    // explicitly against including). Card identity isn't included because
    // it can't be guaranteed safe/available for every participant in
    // every status (see the RLS-embed-null edge case already documented
    // on fetchOwnershipTransfersForUser in lib/ownership-transfer.ts).
    case 'ownership_transfer_requested':  return 'wants to transfer a card to you.';
    case 'ownership_transfer_accepted':   return 'accepted your card transfer.';
    case 'ownership_transfer_declined':   return 'declined your card transfer.';
    case 'ownership_transfer_cancelled':  return 'cancelled a card transfer.';
    default:               return 'interacted with you.';
  }
}

async function fetchNotifications(userId: string): Promise<NotificationItem[]> {
  const { data: rows, error } = await supabase
    .from('notifications')
    .select('id, type, read, created_at, post_id, conversation_id, actor_id, rating_score, transfer_id, registered_card_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);

  // Critical — this is the actual result set. A failure here must never be
  // represented as "no notifications," so it's thrown rather than
  // swallowed into [].
  if (error) throw new Error(error.message);

  if (!rows?.length) return [];

  const actorIds = [...new Set((rows as any[]).map((r) => r.actor_id as string))];
  // Best-effort — the notification rows above are already valid on their
  // own; a failure here only degrades the actor username/display
  // name/avatar to the existing 'user'/null fallback below, it must never
  // fail the whole notifications fetch.
  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', actorIds);
  if (profileError) {
    console.error('[Notifications] actor profile enrichment failed (best-effort):', profileError.message, profileError);
  }

  const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));

  return (rows as any[]).map((r) => {
    const p = profileMap.get(r.actor_id) ?? {};
    return {
      id: r.id,
      type: r.type,
      read: r.read,
      created_at: r.created_at,
      post_id: r.post_id ?? null,
      conversation_id: r.conversation_id ?? null,
      ratingScore: r.rating_score ?? null,
      transferId: r.transfer_id ?? null,
      registeredCardId: r.registered_card_id ?? null,
      actorId: r.actor_id,
      actorUsername: p.username ?? 'user',
      actorDisplayName: p.display_name ?? null,
      actorAvatarUrl: p.avatar_url ?? null,
    };
  });
}

function NotificationRow({
  item,
  onPress,
}: {
  item: NotificationItem;
  onPress: () => void;
}) {
  const displayName = item.actorDisplayName || item.actorUsername;
  // Ownership Transfer Notifications Phase 1 — the approved copy shows the
  // actor's @username (not their display name) for transfer rows, e.g.
  // "@test2 wants to transfer a card to you." — every other notification
  // type keeps its existing display-name-first convention unchanged.
  // actorUsername already falls back to the literal string 'user' (never
  // a raw id) when a profile lookup somehow doesn't resolve — see
  // fetchNotifications above — so this can never render a UUID.
  const actorLabel = isTransferNotification(item.type) ? `@${item.actorUsername}` : displayName;
  return (
    <TouchableOpacity
      style={[styles.row, !item.read && styles.rowUnread]}
      onPress={onPress}
      activeOpacity={0.7}>
      <View style={styles.avatar}>
        {item.actorAvatarUrl ? (
          <Image
            source={{ uri: item.actorAvatarUrl }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
            <Text style={styles.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowText} numberOfLines={2}>
          <Text style={styles.rowActor}>{actorLabel}</Text>
          {' '}{notifLabel(item)}
        </Text>
        <Text style={styles.rowTime}>{formatAge(item.created_at)}</Text>
      </View>
      {!item.read && <View style={styles.unreadDot} />}
    </TouchableOpacity>
  );
}

export default function NotificationsScreen() {
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const router = useRouter();
  const { refresh: refreshBadge } = useBadgeRefresh();
  const { onScroll: navbarOnScroll, scrollEventThrottle } = useScrollResponsiveNavbar();

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Distinct from "notifications.length === 0" — only a real query failure
  // sets this, never a legitimate empty inbox. On failure, `notifications`
  // is deliberately left untouched (never reset to []) so a failed load or
  // refresh doesn't wipe an already-loaded list off screen.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Request-identity guard — plain incrementing counter, not
  // AbortController: load() fires on every focus (no debounce) and
  // onRefresh() fires on pull-to-refresh, both writing the same
  // notifications/loading/refreshing/loadError state, so a slower older
  // call (e.g. rapidly leaving and re-entering this screen, or a refresh
  // racing a focus-triggered load) must never win and overwrite a newer
  // call's result. Shared between load and onRefresh on purpose — either
  // can supersede the other, they write the same state.
  const loadRequestIdRef = useRef(0);
  // Mark-read reliability guards — refs only, no loading/disabled UI exists
  // for either mutation today and none is being added here. markingReadRef
  // tracks which individual notification ids currently have an in-flight
  // mark-read mutation (a Set, since multiple rows can be mid-mutation at
  // once); markingAllReadRef is a single in-flight flag for the bulk
  // mutation. Both exist purely to block duplicate concurrent mutations for
  // the same action, not to drive rendering.
  const markingReadRef = useRef<Set<string>>(new Set());
  const markingAllReadRef = useRef(false);

  const load = useCallback(async () => {
    if (!currentUserId) { setLoading(false); return; }

    const requestId = ++loadRequestIdRef.current;
    const isCurrent = () => loadRequestIdRef.current === requestId;

    setLoading(true);
    try {
      const result = await fetchNotifications(currentUserId);
      if (!isCurrent()) return;
      setNotifications(result);
      setLoadError(null);
    } catch (e) {
      if (!isCurrent()) return;
      // A thrown exception (fetchNotifications now throws on a real query
      // error) — never touches `notifications`, so previously-loaded data
      // survives a failed load/refresh here too.
      console.error('[Notifications] load failed:', e);
      setLoadError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      // A superseded request must never clear loading out from under
      // whichever newer request is now responsible for it.
      if (isCurrent()) setLoading(false);
    }
  }, [currentUserId]);

  const onRefresh = useCallback(async () => {
    if (!currentUserId) return;

    const requestId = ++loadRequestIdRef.current;
    const isCurrent = () => loadRequestIdRef.current === requestId;

    setRefreshing(true);
    try {
      const result = await fetchNotifications(currentUserId);
      if (!isCurrent()) return;
      setNotifications(result);
      setLoadError(null);
    } catch (e) {
      if (!isCurrent()) return;
      console.error('[Notifications] refresh failed:', e);
      // Existing notifications are deliberately left untouched — only a
      // failed refresh's own error is surfaced, never a wiped list.
      setLoadError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      if (isCurrent()) setRefreshing(false);
    }
  }, [currentUserId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleMarkAllRead() {
    if (!currentUserId) return;
    if (markingAllReadRef.current) return;
    markingAllReadRef.current = true;
    try {
      // No .select() and no row-count inspection here on purpose: this
      // UPDATE's own WHERE clause (user_id + read=false) already guarantees
      // that "no unread rows remain for this user" holds on any
      // error === null result, regardless of how many rows it actually
      // touched — zero affected rows (e.g. another session already marked
      // everything read) is a legitimate outcome, not a failure signal.
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('user_id', currentUserId)
        .eq('read', false);

      if (error) {
        console.error('[Notifications] mark all read failed:', error.message, error);
        return;
      }

      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      refreshBadge();
    } catch (e) {
      console.error('[Notifications] mark all read threw:', e);
    } finally {
      markingAllReadRef.current = false;
    }
  }

  // Reconciliation for the single-notification mark-read mutation's
  // ambiguous outcomes (a resolved error with status === 0, or a thrown
  // exception) — both can mean either "the UPDATE never committed" or "it
  // committed but the response was lost," and the two are indistinguishable
  // without an authoritative re-read. Scoped by id and user_id (defense in
  // depth, matching the mutation itself). Catches its own failure so it can
  // never recurse into a second reconciliation attempt.
  async function reconcileNotificationRead(notifId: string, userId: string) {
    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('read')
        .eq('id', notifId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        console.error('[Notifications] mark-read reconciliation failed:', error.message, error);
        setNotifications((prev) =>
          prev.map((n) => (n.id === notifId ? { ...n, read: false } : n)),
        );
        return;
      }

      if (data === null) {
        console.error('[Notifications] mark-read reconciliation found no row:', { notifId });
        setNotifications((prev) =>
          prev.map((n) => (n.id === notifId ? { ...n, read: false } : n)),
        );
        return;
      }

      if (data.read) {
        // UPDATE actually committed — local read:true (already set
        // optimistically) was correct all along, just confirm the badge.
        refreshBadge();
        return;
      }

      setNotifications((prev) =>
        prev.map((n) => (n.id === notifId ? { ...n, read: false } : n)),
      );
    } catch (e) {
      console.error('[Notifications] mark-read reconciliation threw:', e);
      setNotifications((prev) =>
        prev.map((n) => (n.id === notifId ? { ...n, read: false } : n)),
      );
    }
  }

  // Full mark-read mutation lifecycle for a single notification — always
  // invoked fire-and-forget from handlePress (never awaited there), so
  // navigation is never blocked on it. markingReadRef is acquired by the
  // caller before this runs and is released here on every exit path.
  async function markNotificationRead(notifId: string, userId: string) {
    try {
      const { error, status } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('id', notifId)
        .eq('user_id', userId);

      if (!error) {
        refreshBadge();
        return;
      }

      if (status !== 0) {
        // Definitive server rejection — the request reached PostgREST and
        // was explicitly refused, so the UPDATE never committed. No
        // reconciliation needed; we already know the outcome.
        console.error('[Notifications] mark read failed:', error.message, error);
        setNotifications((prev) =>
          prev.map((n) => (n.id === notifId ? { ...n, read: false } : n)),
        );
        return;
      }

      // status === 0 — a network-origin error (see mark-read reliability
      // audit): the response never arrived, so whether the UPDATE committed
      // is genuinely unknown. Reconcile instead of guessing.
      console.error('[Notifications] mark read ambiguous (network):', error.message, error);
      await reconcileNotificationRead(notifId, userId);
    } catch (e) {
      // A thrown exception at this call site is ambiguous for the same
      // reason as status === 0 — reconcile rather than assuming failure.
      console.error('[Notifications] mark read threw:', e);
      await reconcileNotificationRead(notifId, userId);
    } finally {
      markingReadRef.current.delete(notifId);
    }
  }

  function handlePress(notif: NotificationItem) {
    // Mark read optimistically then persist — fire-and-forget on purpose:
    // navigation below must happen immediately regardless of this
    // mutation's outcome. markingReadRef is the synchronous re-entry guard,
    // acquired here (before the optimistic update) so a rapid re-tap on the
    // same row can't issue a second concurrent mutation for the same id.
    if (!notif.read && currentUserId && !markingReadRef.current.has(notif.id)) {
      markingReadRef.current.add(notif.id);
      setNotifications((prev) =>
        prev.map((n) => (n.id === notif.id ? { ...n, read: true } : n)),
      );
      void markNotificationRead(notif.id, currentUserId);
    }

    switch (notif.type) {
      case 'follow':
        navigateToProfile(router, currentUserId, notif.actorId, notif.actorUsername);
        break;
      case 'like':
      case 'comment':
      case 'grail_rating':
        if (notif.post_id) router.push({ pathname: '/post/[id]', params: { id: notif.post_id } });
        break;
      case 'message':
        if (notif.conversation_id) {
          router.push({
            pathname: '/conversation/[id]',
            params: {
              id: notif.conversation_id,
              otherUsername: notif.actorUsername,
              otherDisplayName: notif.actorDisplayName ?? '',
            },
          });
        }
        break;
      // Ownership Transfer Notifications Phase 1 — always the signed-in
      // user's OWN session id for /transactions/[userId], never
      // notif.user_id (not even present on NotificationItem — every row
      // fetched here already belongs to the signed-in user by construction
      // of fetchNotifications' own query, but the route itself still only
      // ever trusts the live session, matching
      // app/transactions/[userId].tsx's own isOwnRoute guard).
      case 'ownership_transfer_requested':
      case 'ownership_transfer_declined':
      case 'ownership_transfer_cancelled':
        if (currentUserId) {
          router.push({ pathname: '/transactions/[userId]', params: { userId: currentUserId } });
        }
        break;
      case 'ownership_transfer_accepted':
        if (notif.registeredCardId) {
          router.push({ pathname: '/registry/[id]', params: { id: notif.registeredCardId } });
        } else if (currentUserId) {
          router.push({ pathname: '/transactions/[userId]', params: { userId: currentUserId } });
        }
        break;
    }
  }

  const hasUnread = notifications.some((n) => !n.read);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerSide}>
          <BackButton fallbackHref="/(tabs)" />
        </View>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={[styles.headerSide, styles.headerSideRight]}>
          {hasUnread && (
            <TouchableOpacity onPress={handleMarkAllRead} hitSlop={8}>
              <Text style={styles.markAllText}>Mark all read</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      ) : notifications.length === 0 && loadError ? (
        // Real query/network failure with nothing already on screen —
        // distinct from the legitimate empty inbox below. Retry calls the
        // same load() the focus effect uses.
        <View style={styles.center}>
          <CacheCaseLogo variant="icon" size="lg" placement="emptyState" />
          <Text style={styles.emptyTitle}>Couldn&apos;t load notifications</Text>
          <Text style={styles.emptyBody}>Check your connection and try again.</Text>
          <TouchableOpacity style={styles.retryButton} onPress={load}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : notifications.length === 0 ? (
        <View style={styles.center}>
          <CacheCaseLogo variant="icon" size="lg" placement="emptyState" />
          <Text style={styles.emptyTitle}>No notifications yet</Text>
          <Text style={styles.emptyBody}>
            You&apos;ll see likes, comments, follows, and messages here.
          </Text>
        </View>
      ) : (
        <>
          {loadError && (
            // Failed refresh with notifications already on screen — kept
            // visible below (never cleared/replaced), just flagged with
            // this lightweight inline row. Retry calls onRefresh().
            <View style={styles.refreshErrorRow}>
              <Text style={styles.refreshErrorText} numberOfLines={1}>
                Couldn&apos;t refresh notifications
              </Text>
              <TouchableOpacity onPress={onRefresh} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.refreshErrorRetry}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}
          <FlatList
            data={notifications}
            keyExtractor={(item) => item.id}
            onScroll={navbarOnScroll}
            scrollEventThrottle={scrollEventThrottle}
            renderItem={({ item }) => (
              <NotificationRow item={item} onPress={() => handlePress(item)} />
            )}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PV2.link} />
            }
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  headerSide: {
    flex: 1,
  },
  headerSideRight: {
    alignItems: 'flex-end',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  markAllText: {
    fontSize: 14,
    fontWeight: '500',
    color: PV2.link,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: PV2.textPrimary,
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 15,
    color: PV2.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  // Full-panel error-state Retry button — same accentSoft-fill +
  // accent-border convention as app/collection/[folderId].tsx's own
  // emptyButton.
  retryButton: {
    marginTop: 16,
    backgroundColor: PV2.accentSoft,
    borderWidth: 1,
    borderColor: PV2.accent,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  retryButtonText: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  // Inline banner for a failed refresh when notifications are already on
  // screen — same accentSoft-fill / accent-tinted-border convention as
  // app/collection/[folderId].tsx's own refreshErrorRow.
  refreshErrorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: PV2.accentSoft,
    borderWidth: 1,
    borderColor: 'rgba(232,24,26,0.35)',
  },
  refreshErrorText: {
    flex: 1,
    fontSize: 13,
    color: PV2.textSecondary,
    marginRight: 12,
  },
  refreshErrorRetry: {
    fontSize: 13,
    fontWeight: '700',
    color: PV2.accent,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
    backgroundColor: PV2.bg,
    gap: 12,
  },
  // Unread rows get a faint tint of the app's own accent rather than the
  // previous light-mode pale blue — reads as "highlighted" against the
  // dark background the same way the light version did against white.
  rowUnread: {
    backgroundColor: PV2.accentSoft,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    flexShrink: 0,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 18,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  rowBody: {
    flex: 1,
    gap: 3,
  },
  rowText: {
    fontSize: 14,
    color: PV2.textSecondary,
    lineHeight: 20,
  },
  rowActor: {
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  rowTime: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: PV2.accent,
    flexShrink: 0,
  },
});
