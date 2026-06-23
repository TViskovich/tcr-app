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

import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

type NotificationItem = {
  id: string;
  type: 'follow' | 'like' | 'comment' | 'message';
  read: boolean;
  created_at: string;
  post_id: string | null;
  conversation_id: string | null;
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

function notifLabel(type: string): string {
  switch (type) {
    case 'follow':  return 'started following you.';
    case 'like':    return 'liked your post.';
    case 'comment': return 'commented on your post.';
    case 'message': return 'sent you a message.';
    default:        return 'interacted with you.';
  }
}

async function fetchNotifications(userId: string): Promise<NotificationItem[]> {
  const { data: rows } = await supabase
    .from('notifications')
    .select('id, type, read, created_at, post_id, conversation_id, actor_id')
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
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
            <Text style={styles.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowText} numberOfLines={2}>
          <Text style={styles.rowActor}>{displayName}</Text>
          {' '}{notifLabel(item.type)}
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
        });
    }

    switch (notif.type) {
      case 'follow':
        router.push({ pathname: '/user/[username]', params: { username: notif.actorUsername } });
        break;
      case 'like':
      case 'comment':
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
    }
  }

  const hasUnread = notifications.some((n) => !n.read);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Notifications</Text>
        {hasUnread && (
          <TouchableOpacity onPress={handleMarkAllRead} hitSlop={8}>
            <Text style={styles.markAllText}>Mark all read</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      ) : notifications.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No notifications yet</Text>
          <Text style={styles.emptyBody}>
            You'll see likes, comments, follows, and messages here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
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
