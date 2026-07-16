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

import { useSharedValue, withSpring } from 'react-native-reanimated';

import { useAuth } from '@/lib/auth';
import { useBadgeRefresh } from '@/lib/badge-context';
import { supabase } from '@/lib/supabase';
import { useTabVisibility } from '@/lib/tab-visibility-context';
import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { CacheCaseRefreshControl, PULL_THRESHOLD } from '@/components/feed/cachecase-refresh-control';
import { GrailsPostBody } from '@/components/feed/grails-post-body';
import { CreateMenu } from '@/components/create/create-menu';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useGrailRating } from '@/hooks/use-grail-rating';
import type { RateMyGrailCard } from '@/types';

type FeedPost = {
  id: string;
  user_id: string;
  post_type: 'item' | 'text' | 'rate_my_grails';
  image_url: string | null;
  content: string | null;
  caption: string | null;
  created_at: string;
  item_name: string | null;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  likeCount: number;
  liked: boolean;
  commentCount: number;
  isFollowing: boolean;
  grailCards: RateMyGrailCard[];
  avgRating: number | null;
  ratingCount: number;
  myRating: number | null;
};

// Shared by queryFeed/queryFollowingFeed — batch-fetches the grail snapshot
// rows + ratings for whichever of the given posts are Rate My Grails posts,
// keyed by post_id, so both queries build FeedPost the same way.
async function fetchGrailData(postIds: string[], currentUserId?: string) {
  const [cardsRes, ratingsRes] = await Promise.all([
    supabase
      .from('rate_my_grail_cards')
      .select('id, post_id, item_id, snapshot_image_url, snapshot_title, snapshot_subtitle, display_order')
      .in('post_id', postIds)
      .order('display_order', { ascending: true }),
    supabase.from('grail_ratings').select('post_id, rater_user_id, score').in('post_id', postIds),
  ]);

  const cardsMap = new Map<string, RateMyGrailCard[]>();
  for (const row of (cardsRes.data ?? []) as any[]) {
    const list = cardsMap.get(row.post_id) ?? [];
    list.push(row as RateMyGrailCard);
    cardsMap.set(row.post_id, list);
  }

  const ratingTotals = new Map<string, { sum: number; count: number; mine: number | null }>();
  for (const row of (ratingsRes.data ?? []) as any[]) {
    const entry = ratingTotals.get(row.post_id) ?? { sum: 0, count: 0, mine: null };
    entry.sum += row.score;
    entry.count += 1;
    if (row.rater_user_id === currentUserId) entry.mine = row.score;
    ratingTotals.set(row.post_id, entry);
  }

  return { cardsMap, ratingTotals };
}

function formatAge(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Canonical feed chronology — every dataset this screen renders (initial
// load, refresh, pagination merges) must end up sorted strictly by the post
// record's own created_at, newest first, regardless of post type. Missing/
// malformed timestamps sort to the bottom (0), never the top. Returns a new
// array — never mutates the one passed in.
function sortPostsByCreatedAtDesc(list: FeedPost[]): FeedPost[] {
  return [...list].sort((a, b) => {
    const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
    return bTime - aTime;
  });
}

const PAGE_SIZE = 20;

// Temporary: feed tabs replaced by a centered wordmark for branding purposes.
// The segmented control below is untouched — flip this back to true to restore
// it, no other changes needed.
const SHOW_FEED_SEGMENT = false;

// Posts → profiles FK goes through auth.users (not directly), so PostgREST embedded join
// silently returns null. We do explicit batch queries and merge in JS instead.
async function queryFeed(currentUserId?: string, page = 0): Promise<FeedPost[]> {
  const sevenDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const from = page * PAGE_SIZE;

  const { data: postRows } = await supabase
    .from('posts')
    .select('id, user_id, item_id, post_type, image_url, content, caption, created_at')
    .in('post_type', ['item', 'text', 'rate_my_grails'])
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (!postRows?.length) return [];

  const userIds = [...new Set((postRows as any[]).map((p) => p.user_id as string))];
  // Text/rate_my_grails posts have no item_id — filter nulls before querying collection_items.
  const itemIds = [...new Set((postRows as any[]).map((p) => p.item_id).filter(Boolean) as string[])];
  const postIds = (postRows as any[]).map((p) => p.id as string);
  const grailPostIds = (postRows as any[])
    .filter((p) => p.post_type === 'rate_my_grails')
    .map((p) => p.id as string);

  const [profilesRes, itemsRes, likesRes, commentsRes, followsRes, grailData] = await Promise.all([
    supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', userIds),
    itemIds.length > 0
      ? supabase.from('collection_items').select('id, name, image_url').in('id', itemIds)
      : Promise.resolve({ data: [] }),
    supabase.from('likes').select('post_id, user_id').in('post_id', postIds),
    supabase.from('comments').select('post_id').in('post_id', postIds),
    currentUserId
      ? supabase.from('follows').select('following_id').eq('follower_id', currentUserId)
      : Promise.resolve({ data: [] }),
    grailPostIds.length > 0
      ? fetchGrailData(grailPostIds, currentUserId)
      : Promise.resolve({ cardsMap: new Map(), ratingTotals: new Map() }),
  ]);

  const profileMap = new Map((profilesRes.data ?? []).map((p: any) => [p.id, p]));
  const itemMap = new Map((itemsRes.data ?? []).map((i: any) => [i.id, i]));

  const likeCountMap = new Map<string, number>();
  const likedSet = new Set<string>();
  for (const row of (likesRes.data ?? []) as any[]) {
    likeCountMap.set(row.post_id, (likeCountMap.get(row.post_id) ?? 0) + 1);
    if (row.user_id === currentUserId) likedSet.add(row.post_id);
  }

  const commentCountMap = new Map<string, number>();
  for (const row of (commentsRes.data ?? []) as any[]) {
    commentCountMap.set(row.post_id, (commentCountMap.get(row.post_id) ?? 0) + 1);
  }

  const followedSet = new Set<string>(
    ((followsRes.data ?? []) as any[]).map((f) => f.following_id as string),
  );

  const { cardsMap, ratingTotals } = grailData;

  const posts = (postRows as any[]).map((post) => {
    const profile = profileMap.get(post.user_id) ?? {};
    const item = post.item_id ? (itemMap.get(post.item_id) ?? {}) : {};
    const rating = ratingTotals.get(post.id);
    return {
      id: post.id,
      user_id: post.user_id,
      post_type: (post.post_type ?? 'item') as 'item' | 'text' | 'rate_my_grails',
      image_url: post.image_url ?? (item as any).image_url ?? null,
      content: post.content ?? null,
      caption: post.caption ?? null,
      created_at: post.created_at,
      item_name: (item as any).name ?? null,
      username: profile.username ?? 'user',
      display_name: profile.display_name ?? null,
      avatar_url: profile.avatar_url ?? null,
      likeCount: likeCountMap.get(post.id) ?? 0,
      liked: likedSet.has(post.id),
      commentCount: commentCountMap.get(post.id) ?? 0,
      isFollowing: followedSet.has(post.user_id),
      grailCards: cardsMap.get(post.id) ?? [],
      avgRating: rating ? rating.sum / rating.count : null,
      ratingCount: rating?.count ?? 0,
      myRating: rating?.mine ?? null,
    };
  });

  return sortPostsByCreatedAtDesc(posts);
}

async function queryFollowingFeed(currentUserId?: string, page = 0): Promise<FeedPost[]> {
  if (!currentUserId) return [];

  const { data: followRows } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', currentUserId);

  const followedIds = ((followRows ?? []) as any[]).map((f) => f.following_id as string);
  if (!followedIds.length) return [];

  const from = page * PAGE_SIZE;

  const { data: postRows } = await supabase
    .from('posts')
    .select('id, user_id, item_id, post_type, image_url, content, caption, created_at')
    .in('post_type', ['item', 'text', 'rate_my_grails'])
    .in('user_id', followedIds)
    .order('created_at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (!postRows?.length) return [];

  const userIds = [...new Set((postRows as any[]).map((p) => p.user_id as string))];
  const itemIds = [...new Set((postRows as any[]).map((p) => p.item_id).filter(Boolean) as string[])];
  const postIds = (postRows as any[]).map((p) => p.id as string);
  const grailPostIds = (postRows as any[])
    .filter((p) => p.post_type === 'rate_my_grails')
    .map((p) => p.id as string);

  const [profilesRes, itemsRes, likesRes, commentsRes, grailData] = await Promise.all([
    supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', userIds),
    itemIds.length > 0
      ? supabase.from('collection_items').select('id, name, image_url').in('id', itemIds)
      : Promise.resolve({ data: [] }),
    supabase.from('likes').select('post_id, user_id').in('post_id', postIds),
    supabase.from('comments').select('post_id').in('post_id', postIds),
    grailPostIds.length > 0
      ? fetchGrailData(grailPostIds, currentUserId)
      : Promise.resolve({ cardsMap: new Map(), ratingTotals: new Map() }),
  ]);

  const profileMap = new Map((profilesRes.data ?? []).map((p: any) => [p.id, p]));
  const itemMap = new Map((itemsRes.data ?? []).map((i: any) => [i.id, i]));

  const likeCountMap = new Map<string, number>();
  const likedSet = new Set<string>();
  for (const row of (likesRes.data ?? []) as any[]) {
    likeCountMap.set(row.post_id, (likeCountMap.get(row.post_id) ?? 0) + 1);
    if (row.user_id === currentUserId) likedSet.add(row.post_id);
  }

  const commentCountMap = new Map<string, number>();
  for (const row of (commentsRes.data ?? []) as any[]) {
    commentCountMap.set(row.post_id, (commentCountMap.get(row.post_id) ?? 0) + 1);
  }

  const { cardsMap, ratingTotals } = grailData;

  // Query already orders by created_at DESC; wrapped in the same canonical
  // sort as queryFeed so both paths share one ordering guarantee.
  return sortPostsByCreatedAtDesc((postRows as any[]).map((post) => {
    const profile = profileMap.get(post.user_id) ?? {};
    const item = post.item_id ? (itemMap.get(post.item_id) ?? {}) : {};
    const rating = ratingTotals.get(post.id);
    return {
      id: post.id,
      user_id: post.user_id,
      post_type: (post.post_type ?? 'item') as 'item' | 'text' | 'rate_my_grails',
      image_url: post.image_url ?? (item as any).image_url ?? null,
      content: post.content ?? null,
      caption: post.caption ?? null,
      created_at: post.created_at,
      item_name: (item as any).name ?? null,
      username: profile.username ?? 'user',
      display_name: profile.display_name ?? null,
      avatar_url: profile.avatar_url ?? null,
      likeCount: likeCountMap.get(post.id) ?? 0,
      liked: likedSet.has(post.id),
      commentCount: commentCountMap.get(post.id) ?? 0,
      isFollowing: true,
      grailCards: cardsMap.get(post.id) ?? [],
      avgRating: rating ? rating.sum / rating.count : null,
      ratingCount: rating?.count ?? 0,
      myRating: rating?.mine ?? null,
    };
  }));
}

export default function HomeScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const { count: notifCount } = useBadgeRefresh();

  const { translateY } = useTabVisibility();
  const lastScrollY = useRef(0);
  const tabBarHidden = useRef(false);
  const pullProgress = useSharedValue(0);

  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [feedMode, setFeedMode] = useState<'for-you' | 'following'>('for-you');
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setPage(0);
    setHasMore(true);
    const data =
      feedMode === 'for-you'
        ? await queryFeed(currentUserId, 0)
        : await queryFollowingFeed(currentUserId, 0);
    setPosts(data);
    setHasMore(data.length === PAGE_SIZE);
    setLoading(false);
  }, [currentUserId, feedMode]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setPage(0);
    setHasMore(true);
    const data =
      feedMode === 'for-you'
        ? await queryFeed(currentUserId, 0)
        : await queryFollowingFeed(currentUserId, 0);
    setPosts(data);
    setHasMore(data.length === PAGE_SIZE);
    setRefreshing(false);
  }, [currentUserId, feedMode]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || loading) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    const data =
      feedMode === 'for-you'
        ? await queryFeed(currentUserId, nextPage)
        : await queryFollowingFeed(currentUserId, nextPage);
    if (data.length > 0) {
      // Merge, dedupe by post ID (a page boundary can shift if a new post
      // lands mid-fetch), then re-sort globally — appending pages blindly
      // would only be valid if both halves were already perfectly ordered
      // and non-overlapping.
      setPosts((prev) => {
        const seenIds = new Set(prev.map((p) => p.id));
        const merged = [...prev, ...data.filter((p) => !seenIds.has(p.id))];
        return sortPostsByCreatedAtDesc(merged);
      });
    }
    setPage(nextPage);
    setHasMore(data.length === PAGE_SIZE);
    setLoadingMore(false);
  }, [loadingMore, hasMore, loading, page, feedMode, currentUserId]);

  // useFocusEffect re-runs whenever loadFeed changes identity (i.e. when feedMode or
  // currentUserId changes) AND the screen is currently focused — so tab switches reload.
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
      if (error) {
        console.error('Unlike failed:', error.message);
      } else {
        // Remove the like notification this user previously created
        supabase.from('notifications').delete()
          .eq('actor_id', currentUserId).eq('post_id', postId).eq('type', 'like')
          .then(({ error: e }) => { if (e) console.error('Like notif delete failed:', e.message); });
      }
    } else {
      const { error } = await supabase.from('likes').insert({ user_id: currentUserId, post_id: postId });
      if (error) {
        console.error('Like failed:', error.message);
      } else if (post.user_id !== currentUserId) {
        // Notify post owner (unique index makes this idempotent)
        supabase.from('notifications').insert({
          user_id: post.user_id,
          actor_id: currentUserId,
          type: 'like',
          post_id: postId,
        }).then(({ error: e }) => {
          if (e && e.code !== '23505') console.error('Like notif failed:', e.message);
        });
      }
    }
  }

  const emptyBody =
    feedMode === 'for-you'
      ? 'Add an item to your collection and enable "Share to feed" to post here.'
      : 'Follow people to see their posts here.';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        {/* Create button — opens the Create menu */}
        <TouchableOpacity
          onPress={() => setCreateMenuOpen(true)}
          style={styles.composeBtn}
          hitSlop={8}>
          <IconSymbol name="plus" size={26} color="#11181C" weight="semibold" />
        </TouchableOpacity>

        {SHOW_FEED_SEGMENT ? (
          <View style={styles.headerSegment}>
            <TouchableOpacity
              style={[styles.segmentBtn, feedMode === 'for-you' && styles.segmentBtnActive]}
              onPress={() => setFeedMode('for-you')}>
              <Text style={[styles.segmentText, feedMode === 'for-you' && styles.segmentTextActive]}>
                For You
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segmentBtn, feedMode === 'following' && styles.segmentBtnActive]}
              onPress={() => setFeedMode('following')}>
              <Text style={[styles.segmentText, feedMode === 'following' && styles.segmentTextActive]}>
                Following
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <CacheCaseLogo variant="dark" size={35} />
        )}
        <TouchableOpacity
          onPress={() => router.push('/(tabs)/notifications')}
          style={styles.bellBtn}
          hitSlop={8}>
          <IconSymbol name="bell.fill" size={24} color="#11181C" />
          {notifCount > 0 && (
            <View style={styles.bellBadge}>
              <Text style={styles.bellBadgeText}>
                {notifCount > 99 ? '99+' : notifCount}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      ) : posts.length === 0 ? (
        <View style={styles.center}>
          <CacheCaseLogo variant="icon" size="lg" placement="emptyState" />
          <Text style={styles.emptyTitle}>No posts yet</Text>
          <Text style={styles.emptyBody}>{emptyBody}</Text>
        </View>
      ) : (
        <View style={styles.listWrap}>
          <FlatList
            data={posts}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <PostCard
                post={item}
                currentUserId={currentUserId}
                onUserPress={() =>
                  router.push({
                    pathname: '/user/[username]',
                    params: { username: item.username },
                  })
                }
                onPostPress={() =>
                  router.push({
                    pathname: '/post/[id]',
                    params: { id: item.id },
                  })
                }
                onLike={() => handleLike(item.id)}
              />
            )}
            contentContainerStyle={styles.list}
            scrollEventThrottle={16}
            onScroll={(e) => {
              const y = e.nativeEvent.contentOffset.y;
              const dy = y - lastScrollY.current;
              // Hide on scroll down (past 80px), show on scroll up
              if (dy > 6 && y > 80 && !tabBarHidden.current) {
                tabBarHidden.current = true;
                translateY.value = withSpring(102, { damping: 20, stiffness: 200 });
              } else if (dy < -6 && tabBarHidden.current) {
                tabBarHidden.current = false;
                translateY.value = withSpring(0, { damping: 20, stiffness: 200 });
              }
              lastScrollY.current = y;

              // Overscroll-only (y < 0, iOS pull bounce) drives the custom
              // refresh icon below — purely visual, doesn't touch refresh logic.
              pullProgress.value = y < 0 ? Math.min(1.15, -y / PULL_THRESHOLD) : 0;
            }}
            onEndReached={loadMore}
            onEndReachedThreshold={0.4}
            ListFooterComponent={
              loadingMore ? (
                <View style={styles.footer}>
                  <ActivityIndicator size="small" color="#0a7ea4" />
                </View>
              ) : null
            }
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                // True alpha-transparent tint is unreliable on iOS — UIRefreshControl
                // can still paint its spinner glyph even at tintColor alpha 0. Camouflaging
                // against the screen's real background color hides it completely instead.
                tintColor="#f8f9fa"
                colors={['#f8f9fa']}
                progressBackgroundColor="#f8f9fa"
              />
            }
          />
          <CacheCaseRefreshControl pullProgress={pullProgress} refreshing={refreshing} />
        </View>
      )}

      <CreateMenu
        visible={createMenuOpen}
        onClose={() => setCreateMenuOpen(false)}
      />
    </SafeAreaView>
  );
}

function PostCard({
  post,
  currentUserId,
  onUserPress,
  onPostPress,
  onLike,
}: {
  post: FeedPost;
  currentUserId: string | undefined;
  onUserPress: () => void;
  onPostPress: () => void;
  onLike: () => void;
}) {
  const [imageError, setImageError] = useState(false);
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const isTextPost = post.post_type === 'text';
  const isRateMyGrails = post.post_type === 'rate_my_grails';

  const rating = useGrailRating({
    postId: post.id,
    postOwnerId: post.user_id,
    currentUserId,
    initialAvg: post.avgRating,
    initialCount: post.ratingCount,
    initialMyRating: post.myRating,
  });

  function handleLikeTap() {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 1.4, duration: 80, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 10 }),
    ]).start();
    onLike();
  }

  // Only hide on image error for item posts — text posts have no image to fail.
  if (imageError && !isTextPost) return null;

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
              transition={200}
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

      {/* Post body — text block for text posts, grails grid for Rate My Grails, image otherwise */}
      {isTextPost ? (
        <TouchableOpacity style={styles.cardTextWrap} onPress={onPostPress} activeOpacity={0.95}>
          <Text style={styles.cardTextContent}>{post.content}</Text>
        </TouchableOpacity>
      ) : isRateMyGrails ? (
        <View style={styles.cardGrailsWrap}>
          <GrailsPostBody
            cards={post.grailCards}
            caption={post.caption}
            avg={rating.avg}
            count={rating.count}
            myRating={rating.myRating}
            isOwner={rating.isOwner}
            submitting={rating.submitting}
            onRate={rating.submitRating}
          />
        </View>
      ) : (
        <TouchableOpacity style={styles.cardImageWrap} onPress={onPostPress} activeOpacity={0.95}>
          <Image
            source={{ uri: post.image_url! }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
            onError={() => setImageError(true)}
          />
        </TouchableOpacity>
      )}

      {/* Caption + actions — caption only shown for item posts (Rate My Grails
          renders its own caption inside GrailsPostBody, above) */}
      <View style={styles.cardBody}>
        {!isTextPost && !isRateMyGrails && (post.caption || post.item_name) ? (
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

          {/* Comment count — tapping also opens post detail */}
          <TouchableOpacity onPress={onPostPress} hitSlop={8} style={styles.commentBtn}>
            <Text style={styles.commentIcon}>💬</Text>
            <Text style={styles.commentCount}>{post.commentCount}</Text>
          </TouchableOpacity>
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
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  headerSegment: {
    flexDirection: 'row',
    gap: 4,
  },
  segmentBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
  },
  segmentBtnActive: {
    backgroundColor: '#11181C',
  },
  segmentText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#687076',
  },
  segmentTextActive: {
    color: '#fff',
  },
  composeBtn: {
    position: 'absolute',
    left: 16,
    padding: 2,
  },
  bellBtn: {
    position: 'absolute',
    right: 16,
    padding: 2,
  },
  bellBadge: {
    position: 'absolute',
    top: -2,
    right: -4,
    backgroundColor: '#e53935',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  bellBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 12,
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
  listWrap: {
    flex: 1,
  },
  list: {
    padding: 12,
    gap: 12,
  },
  footer: {
    paddingVertical: 24,
    alignItems: 'center',
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
    backgroundColor: '#1A1A1A',
  },
  cardAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#333333',
    flexShrink: 0,
  },
  cardAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardAvatarInitial: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  cardUserInfo: {
    flex: 1,
    gap: 1,
  },
  cardDisplayName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  cardUsername: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.60)',
  },
  cardDate: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.45)',
    flexShrink: 0,
  },
  cardImageWrap: {
    aspectRatio: 5 / 7,
    backgroundColor: '#e9ecef',
  },
  cardGrailsWrap: {
    padding: 10,
    backgroundColor: '#1A1A1A',
  },
  cardTextWrap: {
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 16,
    paddingVertical: 20,
    minHeight: 80,
  },
  cardTextContent: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.90)',
    lineHeight: 24,
  },
  cardBody: {
    padding: 12,
    gap: 8,
    backgroundColor: '#1A1A1A',
  },
  cardCaption: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.85)',
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
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
    color: 'rgba(255,255,255,0.50)',
    minWidth: 16,
  },
  likeCountActive: {
    color: '#FF7043',
  },
  commentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 2,
  },
  commentIcon: {
    fontSize: 18,
    opacity: 0.55,
  },
  commentCount: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.50)',
    minWidth: 16,
  },
});
