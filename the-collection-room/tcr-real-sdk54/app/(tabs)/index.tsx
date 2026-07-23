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

import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSharedValue } from 'react-native-reanimated';

import { LIGHT_PAGE_BACKGROUND } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { useBadgeRefresh } from '@/lib/badge-context';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { CacheCaseRefreshControl, PULL_THRESHOLD } from '@/components/feed/cachecase-refresh-control';
import { CreateMenu } from '@/components/create/create-menu';
import { fetchCardShareItems, fetchGrailData, PostCard, type FeedPost } from '@/components/feed/post-card';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';

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

  const { data: postRows, error: postsError } = await supabase
    .from('posts')
    .select('id, user_id, item_id, post_type, image_url, content, caption, created_at')
    .in('post_type', ['item', 'text', 'rate_my_grails', 'card_share'])
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (postsError) {
    console.error('[queryFeed] posts query failed:', postsError.message, postsError);
    throw postsError;
  }

  if (!postRows?.length) return [];

  const userIds = [...new Set((postRows as any[]).map((p) => p.user_id as string))];
  // Text/rate_my_grails/card_share posts have no item_id — filter nulls before querying collection_items.
  const itemIds = [...new Set((postRows as any[]).map((p) => p.item_id).filter(Boolean) as string[])];
  const postIds = (postRows as any[]).map((p) => p.id as string);
  const grailPostIds = (postRows as any[])
    .filter((p) => p.post_type === 'rate_my_grails')
    .map((p) => p.id as string);
  const cardSharePostIds = (postRows as any[])
    .filter((p) => p.post_type === 'card_share')
    .map((p) => p.id as string);

  const [profilesRes, itemsRes, likesRes, commentsRes, followsRes, grailData, cardShareMap] = await Promise.all([
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
    // Throws on failure (see fetchCardShareItems) — not caught here, same
    // reasoning as fetchUserPosts: a card-share query failure should fail
    // this fetch loudly rather than silently render posts with missing
    // card data.
    fetchCardShareItems(cardSharePostIds),
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
      post_type: (post.post_type ?? 'item') as 'item' | 'text' | 'rate_my_grails' | 'card_share',
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
      cardShareItems: cardShareMap.get(post.id) ?? [],
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

  const { data: postRows, error: postsError } = await supabase
    .from('posts')
    .select('id, user_id, item_id, post_type, image_url, content, caption, created_at')
    .in('post_type', ['item', 'text', 'rate_my_grails', 'card_share'])
    .in('user_id', followedIds)
    .order('created_at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (postsError) {
    console.error('[queryFollowingFeed] posts query failed:', postsError.message, postsError);
    throw postsError;
  }

  if (!postRows?.length) return [];

  const userIds = [...new Set((postRows as any[]).map((p) => p.user_id as string))];
  const itemIds = [...new Set((postRows as any[]).map((p) => p.item_id).filter(Boolean) as string[])];
  const postIds = (postRows as any[]).map((p) => p.id as string);
  const grailPostIds = (postRows as any[])
    .filter((p) => p.post_type === 'rate_my_grails')
    .map((p) => p.id as string);
  const cardSharePostIds = (postRows as any[])
    .filter((p) => p.post_type === 'card_share')
    .map((p) => p.id as string);

  const [profilesRes, itemsRes, likesRes, commentsRes, grailData, cardShareMap] = await Promise.all([
    supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', userIds),
    itemIds.length > 0
      ? supabase.from('collection_items').select('id, name, image_url').in('id', itemIds)
      : Promise.resolve({ data: [] }),
    supabase.from('likes').select('post_id, user_id').in('post_id', postIds),
    supabase.from('comments').select('post_id').in('post_id', postIds),
    grailPostIds.length > 0
      ? fetchGrailData(grailPostIds, currentUserId)
      : Promise.resolve({ cardsMap: new Map(), ratingTotals: new Map() }),
    fetchCardShareItems(cardSharePostIds),
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
      post_type: (post.post_type ?? 'item') as 'item' | 'text' | 'rate_my_grails' | 'card_share',
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
      cardShareItems: cardShareMap.get(post.id) ?? [],
    };
  }));
}

export default function HomeScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const { count: notifCount } = useBadgeRefresh();

  const { onScroll: navbarOnScroll, scrollEventThrottle } = useScrollResponsiveNavbar();
  const insets = useSafeAreaInsets();
  const pullProgress = useSharedValue(0);
  const listRef = useRef<FlatList<FeedPost>>(null);

  function scrollToTop() {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }

  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [feedMode, setFeedMode] = useState<'for-you' | 'following'>('for-you');
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  // Distinct from "posts.length === 0" (the empty state below) — a failed
  // query must never look identical to "you have no posts." queryFeed/
  // queryFollowingFeed now throw on a genuine query failure (they used to
  // silently swallow it), so this needs to be caught here rather than left
  // as an unhandled rejection that would also leave loading/refreshing
  // spinners stuck on forever.
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setPage(0);
    setHasMore(true);
    setLoadError(null);
    try {
      const data =
        feedMode === 'for-you'
          ? await queryFeed(currentUserId, 0)
          : await queryFollowingFeed(currentUserId, 0);
      setPosts(data);
      setHasMore(data.length === PAGE_SIZE);
    } catch (e) {
      console.error('[loadFeed] failed:', e);
      setLoadError(e instanceof Error ? e.message : 'Failed to load feed.');
    } finally {
      setLoading(false);
    }
  }, [currentUserId, feedMode]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setPage(0);
    setHasMore(true);
    try {
      const data =
        feedMode === 'for-you'
          ? await queryFeed(currentUserId, 0)
          : await queryFollowingFeed(currentUserId, 0);
      setPosts(data);
      setHasMore(data.length === PAGE_SIZE);
      setLoadError(null);
    } catch (e) {
      console.error('[onRefresh] failed:', e);
      setLoadError(e instanceof Error ? e.message : 'Failed to load feed.');
      // Keep whatever posts were already on screen rather than clearing
      // them on a failed pull-to-refresh.
    } finally {
      setRefreshing(false);
    }
  }, [currentUserId, feedMode]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || loading) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    try {
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
    } catch (e) {
      // A failed next-page fetch shouldn't disturb the posts already
      // loaded and visible — just log it and let the user retry by
      // scrolling again (hasMore/page are untouched on failure).
      console.error('[loadMore] failed:', e);
    } finally {
      setLoadingMore(false);
    }
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
          <TouchableOpacity onPress={scrollToTop} hitSlop={12} accessibilityRole="button" accessibilityLabel="Scroll to top">
            <CacheCaseLogo variant="dark" size={35} />
          </TouchableOpacity>
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
      ) : loadError && posts.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Couldn&apos;t load your feed</Text>
          <Text style={styles.emptyBody}>{loadError}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={loadFeed}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
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
            ref={listRef}
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
                onPostPress={() => {
                  // DEBUG (temporary — see post-detail nav/comment fix;
                  // remove once verified against a running app).
                  console.log('[Feed][DEBUG] onPostPress', {
                    sourceScreen: 'app/(tabs)/index.tsx (main feed)',
                    destinationRoute: '/post/[id]',
                    postIdPassed: item.id,
                  });
                  router.push({
                    pathname: '/post/[id]',
                    params: { id: item.id },
                  });
                }}
                onLike={() => handleLike(item.id)}
              />
            )}
            contentContainerStyle={[styles.list, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}
            scrollEventThrottle={scrollEventThrottle}
            onScroll={(e) => {
              // Shared navbar hide/show-on-scroll behavior (see
              // hooks/use-scroll-responsive-navbar.ts — this screen is its
              // source-of-truth implementation, now extracted there).
              navbarOnScroll(e);

              // Overscroll-only (y < 0, iOS pull bounce) drives the custom
              // refresh icon below — purely visual, doesn't touch refresh logic.
              const y = e.nativeEvent.contentOffset.y;
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
                tintColor={LIGHT_PAGE_BACKGROUND}
                colors={[LIGHT_PAGE_BACKGROUND]}
                progressBackgroundColor={LIGHT_PAGE_BACKGROUND}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: LIGHT_PAGE_BACKGROUND,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: LIGHT_PAGE_BACKGROUND,
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
  retryButton: {
    marginTop: 16,
    backgroundColor: '#0a7ea4',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  listWrap: {
    flex: 1,
  },
  list: {
    paddingHorizontal: 12,
    paddingTop: 12,
    gap: 12,
  },
  footer: {
    paddingVertical: 24,
    alignItems: 'center',
  },
});
