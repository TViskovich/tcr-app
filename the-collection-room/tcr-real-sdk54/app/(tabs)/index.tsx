import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Pressable,
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
  likeCount: number;
  liked: boolean;
};

function formatAge(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Posts → profiles FK goes through auth.users (not directly), so PostgREST embedded join
// silently returns null. We do explicit batch queries and merge in JS instead.
async function queryFeed(currentUserId?: string): Promise<FeedPost[]> {
  const { data: postRows } = await supabase
    .from('posts')
    .select('id, user_id, item_id, image_url, caption, created_at')
    .not('item_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50);

  if (!postRows?.length) return [];

  const userIds = [...new Set((postRows as any[]).map((p) => p.user_id as string))];
  const itemIds = (postRows as any[]).map((p) => p.item_id as string);
  const postIds = (postRows as any[]).map((p) => p.id as string);

  const [profilesRes, itemsRes, likesRes] = await Promise.all([
    supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', userIds),
    supabase.from('collection_items').select('id, name').in('id', itemIds),
    supabase.from('likes').select('post_id, user_id').in('post_id', postIds),
  ]);

  const profileMap = new Map((profilesRes.data ?? []).map((p: any) => [p.id, p]));
  const itemMap = new Map((itemsRes.data ?? []).map((i: any) => [i.id, i]));

  // Compute like count and liked state per post from the single batch query
  const likeCountMap = new Map<string, number>();
  const likedSet = new Set<string>();
  for (const row of (likesRes.data ?? []) as any[]) {
    likeCountMap.set(row.post_id, (likeCountMap.get(row.post_id) ?? 0) + 1);
    if (row.user_id === currentUserId) likedSet.add(row.post_id);
  }

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
      likeCount: likeCountMap.get(post.id) ?? 0,
      liked: likedSet.has(post.id),
    };
  });
}

export default function HomeScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;

  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setPosts(await queryFeed(currentUserId));
    setLoading(false);
  }, [currentUserId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setPosts(await queryFeed(currentUserId));
    setRefreshing(false);
  }, [currentUserId]);

  useFocusEffect(
    useCallback(() => {
      loadFeed();
    }, [loadFeed]),
  );

  async function handleLike(postId: string) {
    if (!currentUserId) return;
    const post = posts.find((p) => p.id === postId);
    if (!post) return;
    const wasLiked = post.liked;

    // Optimistic update first so the UI responds immediately
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId
          ? { ...p, liked: !wasLiked, likeCount: wasLiked ? p.likeCount - 1 : p.likeCount + 1 }
          : p,
      ),
    );

    // Supabase JS v2 is lazy — query only executes when awaited or .then()'d
    if (wasLiked) {
      const { error } = await supabase.from('likes').delete().eq('user_id', currentUserId).eq('post_id', postId);
      if (error) console.error('Unlike failed:', error.message);
    } else {
      const { error } = await supabase.from('likes').insert({ user_id: currentUserId, post_id: postId });
      if (error) console.error('Like failed:', error.message);
    }
  }

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
              onLike={() => handleLike(item.id)}
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

function PostCard({
  post,
  onUserPress,
  onLike,
}: {
  post: FeedPost;
  onUserPress: () => void;
  onLike: () => void;
}) {
  const [imageError, setImageError] = useState(false);
  const scaleAnim = useRef(new Animated.Value(1)).current;

  function handleLikeTap() {
    // Quick pop up, then spring back
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 1.4, duration: 80, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 10 }),
    ]).start();
    onLike();
  }

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

      {/* Caption + like button */}
      <View style={styles.cardBody}>
        {(post.caption || post.item_name) ? (
          <Text style={styles.cardCaption}>{post.caption || post.item_name}</Text>
        ) : null}
        <View style={styles.cardActions}>
          <Pressable onPress={handleLikeTap} hitSlop={8} style={styles.likeBtn}>
            <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
              <Text style={[styles.likeEmoji, !post.liked && styles.likeEmojiDim]}>🔥</Text>
            </Animated.View>
            <Text style={[styles.likeCount, post.liked && styles.likeCountActive]}>
              {post.likeCount}
            </Text>
          </Pressable>
        </View>
      </View>
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
    gap: 8,
  },
  cardCaption: {
    fontSize: 14,
    fontWeight: '500',
    color: '#11181C',
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  likeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 2,
  },
  likeEmoji: {
    fontSize: 20,
  },
  likeEmojiDim: {
    opacity: 0.25,
  },
  likeCount: {
    fontSize: 14,
    fontWeight: '500',
    color: '#687076',
    minWidth: 16,
  },
  likeCountActive: {
    color: '#E65100',
  },
});
