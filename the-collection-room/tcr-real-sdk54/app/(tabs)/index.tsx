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

import { supabase } from '@/lib/supabase';

type FeedPost = {
  id: string;
  user_id: string;
  image_url: string;
  caption: string | null;
  created_at: string;
  item_name: string | null;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

function formatAge(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Posts → profiles FK goes through auth.users (not directly), so PostgREST embedded join
// silently returns null. We do two explicit queries and merge in JS instead.
async function queryFeed(): Promise<FeedPost[]> {
  const { data: postRows } = await supabase
    .from('posts')
    .select('id, user_id, item_id, image_url, caption, created_at')
    .not('item_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50);

  if (!postRows?.length) return [];

  const userIds = [...new Set((postRows as any[]).map((p) => p.user_id as string))];
  const itemIds = (postRows as any[]).map((p) => p.item_id as string);

  const [profilesRes, itemsRes] = await Promise.all([
    supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', userIds),
    supabase.from('collection_items').select('id, name').in('id', itemIds),
  ]);

  const profileMap = new Map((profilesRes.data ?? []).map((p: any) => [p.id, p]));
  const itemMap = new Map((itemsRes.data ?? []).map((i: any) => [i.id, i]));

  return (postRows as any[]).map((post) => {
    const profile = profileMap.get(post.user_id) ?? {};
    const item = itemMap.get(post.item_id) ?? {};
    return {
      id: post.id,
      user_id: post.user_id,
      image_url: post.image_url,
      caption: post.caption ?? null,
      created_at: post.created_at,
      item_name: item.name ?? null,
      username: profile.username ?? 'user',
      display_name: profile.display_name ?? null,
      avatar_url: profile.avatar_url ?? null,
    };
  });
}

export default function HomeScreen() {
  const router = useRouter();
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setPosts(await queryFeed());
    setLoading(false);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setPosts(await queryFeed());
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadFeed();
    }, [loadFeed]),
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Home</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      ) : posts.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No posts yet</Text>
          <Text style={styles.emptyBody}>
            Add an item to your collection and enable "Share to feed" to post here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <PostCard
              post={item}
              onUserPress={() =>
                router.push({
                  pathname: '/user/[username]',
                  params: { username: item.username },
                })
              }
            />
          )}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#0a7ea4" />
          }
        />
      )}
    </SafeAreaView>
  );
}

function PostCard({ post, onUserPress }: { post: FeedPost; onUserPress: () => void }) {
  const [imageError, setImageError] = useState(false);
  if (imageError) return null;

  const displayName = post.display_name || post.username;

  return (
    <View style={styles.card}>
      {/* User row — tapping navigates to their public profile */}
      <TouchableOpacity style={styles.cardHeader} onPress={onUserPress} activeOpacity={0.7}>
        <View style={styles.cardAvatar}>
          {post.avatar_url ? (
            <Image
              source={{ uri: post.avatar_url }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.cardAvatarPlaceholder]}>
              <Text style={styles.cardAvatarInitial}>
                {displayName.charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.cardUserInfo}>
          <Text style={styles.cardDisplayName} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.cardUsername}>@{post.username}</Text>
        </View>
        <Text style={styles.cardDate}>{formatAge(post.created_at)}</Text>
      </TouchableOpacity>

      {/* Post image */}
      <View style={styles.cardImageWrap}>
        <Image
          source={{ uri: post.image_url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          onError={() => setImageError(true)}
        />
      </View>

      {/* Caption, falling back to item name if no caption was written */}
      {(post.caption || post.item_name) ? (
        <View style={styles.cardBody}>
          <Text style={styles.cardCaption}>{post.caption || post.item_name}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
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
  list: {
    padding: 12,
    gap: 12,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 10,
  },
  cardAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#E3F2FD',
    flexShrink: 0,
  },
  cardAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardAvatarInitial: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1565C0',
  },
  cardUserInfo: {
    flex: 1,
    gap: 1,
  },
  cardDisplayName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#11181C',
  },
  cardUsername: {
    fontSize: 12,
    color: '#687076',
  },
  cardDate: {
    fontSize: 12,
    color: '#aaa',
    flexShrink: 0,
  },
  cardImageWrap: {
    aspectRatio: 1,
    backgroundColor: '#e9ecef',
  },
  cardBody: {
    padding: 12,
  },
  cardCaption: {
    fontSize: 14,
    fontWeight: '500',
    color: '#11181C',
  },
});
