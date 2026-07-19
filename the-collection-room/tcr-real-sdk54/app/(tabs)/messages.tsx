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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, Ellipse, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { LIGHT_PAGE_BACKGROUND } from '@/constants/theme';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { useMessageBadgeRefresh } from '@/lib/message-badge-context';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

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

// Two overlapping chat bubbles, each holding a faint card silhouette, with a
// few small iridescent tiles drifting between them and a soft ground shadow
// beneath — metallic white-silver surfaces with restrained cyan/lavender/pink
// accents, no gold, no glow.
function EmptyMessagesArtwork() {
  return (
    <Svg width={320} height={230} viewBox="0 0 320 230">
      <Defs>
        <LinearGradient id="bubbleRear" x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#FFFFFF" />
          <Stop offset="100%" stopColor="#E4EEF0" />
        </LinearGradient>
        <LinearGradient id="bubbleFront" x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#FFFFFF" />
          <Stop offset="100%" stopColor="#EEEAF6" />
        </LinearGradient>
        <RadialGradient id="groundShadow" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor="#1B2733" stopOpacity={0.16} />
          <Stop offset="100%" stopColor="#1B2733" stopOpacity={0} />
        </RadialGradient>
      </Defs>

      {/* Ground shadow */}
      <Ellipse cx={170} cy={207} rx={95} ry={11} fill="url(#groundShadow)" />

      {/* Rear-left bubble — tail drawn first so the body's rounded edge covers the seam */}
      <Path d="M62,151 L82,151 L54,175 Z" fill="url(#bubbleRear)" />
      <Rect
        x={35}
        y={48}
        width={155}
        height={105}
        rx={24}
        fill="url(#bubbleRear)"
        stroke="#C9D3D6"
        strokeWidth={1}
      />
      <Path
        d="M55,60 Q47,68 47,80"
        stroke="#FFFFFF"
        strokeWidth={3}
        strokeLinecap="round"
        opacity={0.6}
        fill="none"
      />
      {/* Card silhouette — no image or text, just faint frame */}
      <Rect x={90} y={68} width={46} height={66} rx={8} fill="#EDF2F3" stroke="#D3DBDD" strokeWidth={1} />
      <Rect x={95} y={73} width={36} height={56} rx={5} fill="none" stroke="#C7D0D2" strokeWidth={0.75} opacity={0.7} />

      {/* Front-right bubble */}
      <Path d="M243,181 L263,181 L271,203 Z" fill="url(#bubbleFront)" />
      <Rect
        x={130}
        y={78}
        width={155}
        height={105}
        rx={24}
        fill="url(#bubbleFront)"
        stroke="#D2CDE0"
        strokeWidth={1}
      />
      <Path
        d="M150,90 Q142,98 142,110"
        stroke="#FFFFFF"
        strokeWidth={3}
        strokeLinecap="round"
        opacity={0.6}
        fill="none"
      />
      <Rect x={185} y={98} width={46} height={66} rx={8} fill="#F1EEF7" stroke="#DAD4E8" strokeWidth={1} />
      <Rect x={190} y={103} width={36} height={56} rx={5} fill="none" stroke="#CFC8E0" strokeWidth={0.75} opacity={0.7} />
    </Svg>
  );
}

export default function MessagesScreen() {
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const refreshMessageBadge = useMessageBadgeRefresh();
  const { onScroll: navbarOnScroll, scrollEventThrottle } = useScrollResponsiveNavbar();

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

  function handleFindCollectors() {
    router.push('/(tabs)/search');
  }

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
        <View style={styles.messagesEmptyState}>
          <CacheCaseLogo
            variant="dark"
            size="lg"
            placement="emptyState"
            style={styles.messagesEmptyLogo}
          />
          <EmptyMessagesArtwork />

          <Text style={styles.messagesEmptyTitle}>No conversations yet</Text>

          <Text style={styles.messagesEmptyBody}>
            Connect with collectors and start talking cards.
          </Text>

          <TouchableOpacity
            style={styles.messagesEmptyButton}
            onPress={handleFindCollectors}
            activeOpacity={0.82}>
            <Text style={styles.messagesEmptyButtonText}>Find Collectors</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }}
          onScroll={navbarOnScroll}
          scrollEventThrottle={scrollEventThrottle}
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
    backgroundColor: LIGHT_PAGE_BACKGROUND,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: LIGHT_PAGE_BACKGROUND,
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
  messagesEmptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    transform: [{ translateY: -24 }],
  },
  messagesEmptyArtwork: {
    width: 320,
    height: 230,
    alignSelf: 'center',
  },
  messagesEmptyLogo: {
    transform: [{ translateY: -50 }],
  },
  messagesEmptyTitle: {
    marginTop: 18,
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700',
    color: '#11181C',
    textAlign: 'center',
  },
  messagesEmptyBody: {
    marginTop: 10,
    maxWidth: 330,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '400',
    color: '#687076',
    textAlign: 'center',
  },
  messagesEmptyButton: {
    marginTop: 24,
    width: 230,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#0A8BAD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  messagesEmptyButtonText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
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
