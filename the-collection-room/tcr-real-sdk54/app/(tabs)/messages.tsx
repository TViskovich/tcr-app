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
import { useMessageBadgeRefresh } from '@/lib/message-badge-context';
import { supabase } from '@/lib/supabase';

type ConversationItem = {
  id: string;
  otherUserId: string;
  otherUsername: string;
  otherDisplayName: string | null;
  otherAvatarUrl: string | null;
  lastMessageBody: string | null;
  lastMessageAt: string;
};

function formatTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// 3 sequential round-trips:
//   1. my participation rows → convIds
//   2. parallel: all participants + conversations + recent messages
//   3. profiles for the other users
async function loadInbox(currentUserId: string): Promise<ConversationItem[]> {
  const { data: myRows } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', currentUserId);

  if (!myRows?.length) return [];

  const convIds = (myRows as any[]).map((r) => r.conversation_id as string);

  const [allParticipantsRes, conversationsRes, messagesRes] = await Promise.all([
    supabase
      .from('conversation_participants')
      .select('conversation_id, user_id')
      .in('conversation_id', convIds),
    supabase
      .from('conversations')
      .select('id, last_message_at')
      .in('id', convIds),
    supabase
      .from('messages')
      .select('conversation_id, body, created_at')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false })
      .limit(200),
  ]);

  // Map: conversation_id → other user_id
  const convOtherUserMap = new Map<string, string>();
  for (const row of (allParticipantsRes.data ?? []) as any[]) {
    if (row.user_id !== currentUserId) {
      convOtherUserMap.set(row.conversation_id, row.user_id);
    }
  }

  const otherUserIds = [...new Set([...convOtherUserMap.values()])];
  const { data: profilesData } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', otherUserIds);

  const profileMap = new Map((profilesData ?? []).map((p: any) => [p.id, p]));

  // Messages are DESC — first seen per conversation_id is the latest
  const latestMsgMap = new Map<string, any>();
  for (const msg of (messagesRes.data ?? []) as any[]) {
    if (!latestMsgMap.has(msg.conversation_id)) {
      latestMsgMap.set(msg.conversation_id, msg);
    }
  }

  const convLastAtMap = new Map<string, string>(
    (conversationsRes.data ?? []).map((c: any) => [c.id, c.last_message_at]),
  );

  return convIds
    .map((convId) => {
      const otherUserId = convOtherUserMap.get(convId) ?? '';
      const p = profileMap.get(otherUserId) ?? {};
      const lastMsg = latestMsgMap.get(convId);
      return {
        id: convId,
        otherUserId,
        otherUsername: p.username ?? 'user',
        otherDisplayName: p.display_name ?? null,
        otherAvatarUrl: p.avatar_url ?? null,
        lastMessageBody: lastMsg?.body ?? null,
        lastMessageAt: lastMsg?.created_at ?? convLastAtMap.get(convId) ?? new Date().toISOString(),
      };
    })
    .sort(
      (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
    );
}

export default function MessagesScreen() {
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const router = useRouter();
  const refreshMessageBadge = useMessageBadgeRefresh();

  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!currentUserId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setConversations(await loadInbox(currentUserId));
    setLoading(false);
  }, [currentUserId]);

  const onRefresh = useCallback(async () => {
    if (!currentUserId) return;
    setRefreshing(true);
    setConversations(await loadInbox(currentUserId));
    refreshMessageBadge();
    setRefreshing(false);
  }, [currentUserId, refreshMessageBadge]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Messages</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      ) : conversations.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No messages yet</Text>
          <Text style={styles.emptyBody}>
            Visit someone's profile and tap Message to start a conversation.
          </Text>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <ConversationRow
              item={item}
              onPress={() =>
                router.push({
                  pathname: '/conversation/[id]',
                  params: {
                    id: item.id,
                    otherUsername: item.otherUsername,
                    otherDisplayName: item.otherDisplayName ?? '',
                  },
                })
              }
            />
          )}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#0a7ea4" />
          }
        />
      )}
    </SafeAreaView>
  );
}

function ConversationRow({
  item,
  onPress,
}: {
  item: ConversationItem;
  onPress: () => void;
}) {
  const displayName = item.otherDisplayName || item.otherUsername;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.avatar}>
        {item.otherAvatarUrl ? (
          <Image
            source={{ uri: item.otherAvatarUrl }}
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
        <Text style={styles.rowName} numberOfLines={1}>{displayName}</Text>
        <Text style={styles.rowPreview} numberOfLines={1}>
          {item.lastMessageBody ?? 'New conversation'}
        </Text>
      </View>

      <Text style={styles.rowTime}>{formatTime(item.lastMessageAt)}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#11181C',
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
    fontSize: 20,
    fontWeight: '700',
    color: '#1565C0',
  },
  rowBody: {
    flex: 1,
    marginLeft: 12,
    gap: 3,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#11181C',
  },
  rowPreview: {
    fontSize: 14,
    color: '#687076',
  },
  rowTime: {
    fontSize: 12,
    color: '#aaa',
    marginLeft: 8,
    flexShrink: 0,
  },
});
