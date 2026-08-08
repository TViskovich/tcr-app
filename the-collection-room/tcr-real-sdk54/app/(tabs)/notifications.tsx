import { useCallback, useState } from 'react';
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
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { useBadgeRefresh } from '@/lib/badge-context';
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
  const { data: rows } = await supabase
    .from('notifications')
    .select('id, type, read, created_at, post_id, conversation_id, actor_id, rating_score, transfer_id, registered_card_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (!rows?.length) return [];

  const actorIds = [...new Set((rows as any[]).map((r) => r.actor_id as string))];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', actorIds);

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

  const load = useCallback(async () => {
    if (!currentUserId) { setLoading(false); return; }
    setLoading(true);
    setNotifications(await fetchNotifications(currentUserId));
    setLoading(false);
  }, [currentUserId]);

  const onRefresh = useCallback(async () => {
    if (!currentUserId) return;
    setRefreshing(true);
    setNotifications(await fetchNotifications(currentUserId));
    setRefreshing(false);
  }, [currentUserId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleMarkAllRead() {
    if (!currentUserId) return;
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', currentUserId)
      .eq('read', false);
    if (!error) {
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      refreshBadge();
    }
  }

  function handlePress(notif: NotificationItem) {
    // Mark read optimistically then persist
    if (!notif.read) {
      setNotifications((prev) =>
        prev.map((n) => (n.id === notif.id ? { ...n, read: true } : n)),
      );
      supabase
        .from('notifications')
        .update({ read: true })
        .eq('id', notif.id)
        .then(({ error }) => {
          if (error) console.error('Mark read failed:', error.message);
          else refreshBadge();
        });
    }

    switch (notif.type) {
      case 'follow':
        router.push({ pathname: '/user/[username]', params: { username: notif.actorUsername } });
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
          <TouchableOpacity
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back">
            <View style={styles.backCircle}>
              <IconSymbol name="chevron.left" size={18} color="#fff" />
            </View>
          </TouchableOpacity>
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
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      ) : notifications.length === 0 ? (
        <View style={styles.center}>
          <CacheCaseLogo variant="icon" size="lg" placement="emptyState" />
          <Text style={styles.emptyTitle}>No notifications yet</Text>
          <Text style={styles.emptyBody}>
            You'll see likes, comments, follows, and messages here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
          onScroll={navbarOnScroll}
          scrollEventThrottle={scrollEventThrottle}
          renderItem={({ item }) => (
            <NotificationRow item={item} onPress={() => handlePress(item)} />
          )}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#0a7ea4" />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  headerSide: {
    flex: 1,
  },
  headerSideRight: {
    alignItems: 'flex-end',
  },
  backCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#11181C',
  },
  markAllText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#0a7ea4',
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
    color: '#11181C',
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 15,
    color: '#687076',
    textAlign: 'center',
    lineHeight: 22,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
    backgroundColor: '#fff',
    gap: 12,
  },
  rowUnread: {
    backgroundColor: '#f0f8ff',
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: '#E3F2FD',
    flexShrink: 0,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1565C0',
  },
  rowBody: {
    flex: 1,
    gap: 3,
  },
  rowText: {
    fontSize: 14,
    color: '#333',
    lineHeight: 20,
  },
  rowActor: {
    fontWeight: '700',
    color: '#11181C',
  },
  rowTime: {
    fontSize: 12,
    color: '#aaa',
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#0a7ea4',
    flexShrink: 0,
  },
});
