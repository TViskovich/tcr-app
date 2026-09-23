import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import { useBadgeRefresh } from '@/lib/badge-context';
import { deletePost } from '@/lib/posts';
import { navigateToProfile } from '@/lib/profile-navigation';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { CreateMenu } from '@/components/create/create-menu';
import { fetchCardShareItems, fetchGrailData, fetchPostImages, PostCard, type FeedPost } from '@/components/feed/post-card';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
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

// Posts → profiles FK goes through auth.users (not directly), so PostgREST embedded join
// silently returns null. We do explicit batch queries and merge in JS instead.
// `signal` is required — this is always invoked from loadFeed/onRefresh/
// loadMore below, each of which owns an AbortController tied to the
// screen's focus lifecycle (see the useFocusEffect cleanup further down for
// why an uncancelled request left running past a tab switch can crash with
// whatwg-fetch's status-0 RangeError).
async function queryFeed(currentUserId: string | undefined, page: number, signal: AbortSignal): Promise<FeedPost[]> {
  const sevenDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const from = page * PAGE_SIZE;

  const { data: postRows, error: postsError } = await supabase
    .from('posts')
    .select('id, user_id, item_id, post_type, image_url, content, caption, created_at')
    .in('post_type', ['item', 'text', 'rate_my_grails', 'card_share'])
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1)
    .abortSignal(signal);

  if (postsError) {
    // An aborted request resolves as an error-shaped result rather than
    // rejecting (see this function's own comment above) — expected
    // cancellation from focus-loss/request-replacement must not be logged
    // as if it were a real failure. Still thrown either way, unchanged:
    // the caller's own controller.signal.aborted check already discards
    // an aborted result correctly regardless of what's thrown here.
    if (!signal.aborted) {
      console.error('[queryFeed] posts query failed:', postsError.message, postsError);
    }
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
  const textPostIds = (postRows as any[])
    .filter((p) => p.post_type === 'text')
    .map((p) => p.id as string);

  const [profilesRes, itemsRes, likesRes, commentsRes, followsRes, grailData, cardShareMap, postImagesMap] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, username, display_name, hero_display_name, avatar_url')
      .in('id', userIds)
      .abortSignal(signal),
    itemIds.length > 0
      ? supabase.from('collection_items').select('id, name, image_url').in('id', itemIds).abortSignal(signal)
      : Promise.resolve({ data: [] }),
    supabase.from('likes').select('post_id, user_id').in('post_id', postIds).abortSignal(signal),
    supabase.from('comments').select('post_id').in('post_id', postIds).abortSignal(signal),
    currentUserId
      ? supabase.from('follows').select('following_id').eq('follower_id', currentUserId).abortSignal(signal)
      : Promise.resolve({ data: [] }),
    grailPostIds.length > 0
      ? fetchGrailData(grailPostIds, signal, currentUserId)
      : Promise.resolve({ cardsMap: new Map(), ratingTotals: new Map() }),
    // Throws on failure (see fetchCardShareItems) — not caught here, same
    // reasoning as fetchUserPosts: a card-share query failure should fail
    // this fetch loudly rather than silently render posts with missing
    // card data.
    fetchCardShareItems(cardSharePostIds, signal),
    // Same throws-loudly convention — see fetchCardShareItems's comment
    // just above.
    fetchPostImages(textPostIds, signal),
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
      // Hero/display name is what the profile screen's own identity card
      // shows as the large primary name (profile-v2-screen.tsx's own
      // `profile?.hero_display_name || profile?.display_name || ...`
      // fallback) — Feed's author row now matches that same source of
      // truth instead of the plain display_name column, falling through to
      // display_name only when no hero name is set. PostCard's own
      // `post.display_name || post.username` (unchanged) is what completes
      // the fallback chain down to username.
      display_name: profile.hero_display_name || profile.display_name || null,
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
      images: postImagesMap.get(post.id) ?? [],
    };
  });

  return sortPostsByCreatedAtDesc(posts);
}

// `signal` required — see queryFeed's comment above.
async function queryFollowingFeed(currentUserId: string | undefined, page: number, signal: AbortSignal): Promise<FeedPost[]> {
  if (!currentUserId) return [];

  const { data: followRows } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', currentUserId)
    .abortSignal(signal);

  const followedIds = ((followRows ?? []) as any[]).map((f) => f.following_id as string);
  if (!followedIds.length) return [];

  const from = page * PAGE_SIZE;

  const { data: postRows, error: postsError } = await supabase
    .from('posts')
    .select('id, user_id, item_id, post_type, image_url, content, caption, created_at')
    .in('post_type', ['item', 'text', 'rate_my_grails', 'card_share'])
    .in('user_id', followedIds)
    .order('created_at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1)
    .abortSignal(signal);

  if (postsError) {
    // Same reasoning as queryFeed's identical guard above — expected
    // cancellation must not be logged as a real failure, but still throws
    // unchanged so the caller's own abort check discards it correctly.
    if (!signal.aborted) {
      console.error('[queryFollowingFeed] posts query failed:', postsError.message, postsError);
    }
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
  const textPostIds = (postRows as any[])
    .filter((p) => p.post_type === 'text')
    .map((p) => p.id as string);

  const [profilesRes, itemsRes, likesRes, commentsRes, grailData, cardShareMap, postImagesMap] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, username, display_name, hero_display_name, avatar_url')
      .in('id', userIds)
      .abortSignal(signal),
    itemIds.length > 0
      ? supabase.from('collection_items').select('id, name, image_url').in('id', itemIds).abortSignal(signal)
      : Promise.resolve({ data: [] }),
    supabase.from('likes').select('post_id, user_id').in('post_id', postIds).abortSignal(signal),
    supabase.from('comments').select('post_id').in('post_id', postIds).abortSignal(signal),
    grailPostIds.length > 0
      ? fetchGrailData(grailPostIds, signal, currentUserId)
      : Promise.resolve({ cardsMap: new Map(), ratingTotals: new Map() }),
    fetchCardShareItems(cardSharePostIds, signal),
    fetchPostImages(textPostIds, signal),
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
      // See queryFeed's matching comment above — same hero-name-first
      // fallback, same shared source of truth as the profile screen.
      display_name: profile.hero_display_name || profile.display_name || null,
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
      images: postImagesMap.get(post.id) ?? [],
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
  const listRef = useRef<FlatList<FeedPost>>(null);

  function scrollToTop() {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }

  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [feedMode, setFeedMode] = useState<'for-you' | 'following'>('for-you');
  // Piece 6 — measured label widths for the active-tab underline below, so
  // it's sized to each tab's own text ("tab-local") instead of one fixed
  // width that only roughly fit both "For You" and "Following." Purely
  // visual; feedMode/query behavior is untouched.
  const [tabLabelWidths, setTabLabelWidths] = useState<{ forYou: number; following: number }>({
    forYou: 0,
    following: 0,
  });
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

  // Three separate controllers, one per operation below — loadFeed,
  // onRefresh, and loadMore each guard their own loading flag
  // (loading/refreshing/loadingMore) and must each independently clear
  // only their own flag when their own batch is still current, never a
  // sibling's. All three are aborted together on focus-loss/unmount (see
  // the useFocusEffect cleanup below) since nothing on screen needs any of
  // them once the tab is no longer visible — an in-flight request left
  // running past that point can have its underlying XHR connection torn
  // down by the native networking layer, and whatwg-fetch's onload handler
  // then reads xhr.status back as 0 and throws constructing a Response
  // (RangeError, status outside [200,599]) synchronously inside a bare
  // setTimeout callback, outside any promise chain — uncatchable. See
  // hooks/use-profile.ts for the full mechanism writeup.
  const loadFeedControllerRef = useRef<AbortController | null>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);

  // Feed state preservation — set right before pushing into a post's own
  // detail screen (onPostPress below), consumed the next time this screen's
  // useFocusEffect fires (i.e. the moment the user presses Back and this
  // tab regains focus). This screen is never actually unmounted by that
  // round trip — app/post/[id].tsx is a normal pushed stack screen on top
  // of (tabs), which react-navigation keeps mounted-but-unfocused beneath
  // it, not destroyed — so a plain ref surviving the trip is enough; no
  // navigation param, event bus, or persisted storage needed. Left false
  // (its default) for every OTHER way this screen can regain focus —
  // switching tabs away and back, returning from the reply composer,
  // returning from Notifications, or a fresh compose flow's router.back()
  // (app/post/new.tsx's leaveScreen) — so loadFeed() still runs in all of
  // those cases exactly as before. Only the "just went and looked at one
  // post" round trip is special-cased to skip the refetch.
  const skipNextFocusReloadRef = useRef(false);

  const loadFeed = useCallback(async () => {
    loadFeedControllerRef.current?.abort();
    const controller = new AbortController();
    loadFeedControllerRef.current = controller;

    setLoading(true);
    setPage(0);
    setHasMore(true);
    setLoadError(null);
    try {
      const data =
        feedMode === 'for-you'
          ? await queryFeed(currentUserId, 0, controller.signal)
          : await queryFollowingFeed(currentUserId, 0, controller.signal);
      // Superseded (a newer loadFeed call, or the tab lost focus) — this
      // batch's result is stale regardless of whether it actually finished
      // or carries an abort error; never let it commit over newer state.
      if (loadFeedControllerRef.current !== controller || controller.signal.aborted) return;
      setPosts(data);
      setHasMore(data.length === PAGE_SIZE);
    } catch (e) {
      if (controller.signal.aborted || loadFeedControllerRef.current !== controller) return;
      console.error('[loadFeed] failed:', e);
      setLoadError(e instanceof Error ? e.message : 'Failed to load feed.');
    } finally {
      if (loadFeedControllerRef.current === controller) {
        loadFeedControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [currentUserId, feedMode]);

  const onRefresh = useCallback(async () => {
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;

    setRefreshing(true);
    setPage(0);
    setHasMore(true);
    try {
      const data =
        feedMode === 'for-you'
          ? await queryFeed(currentUserId, 0, controller.signal)
          : await queryFollowingFeed(currentUserId, 0, controller.signal);
      if (refreshControllerRef.current !== controller || controller.signal.aborted) return;
      setPosts(data);
      setHasMore(data.length === PAGE_SIZE);
      setLoadError(null);
    } catch (e) {
      if (controller.signal.aborted || refreshControllerRef.current !== controller) return;
      console.error('[onRefresh] failed:', e);
      setLoadError(e instanceof Error ? e.message : 'Failed to load feed.');
      // Keep whatever posts were already on screen rather than clearing
      // them on a failed pull-to-refresh.
    } finally {
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
        setRefreshing(false);
      }
    }
  }, [currentUserId, feedMode]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || loading) return;
    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;

    setLoadingMore(true);
    const nextPage = page + 1;
    try {
      const data =
        feedMode === 'for-you'
          ? await queryFeed(currentUserId, nextPage, controller.signal)
          : await queryFollowingFeed(currentUserId, nextPage, controller.signal);
      if (loadMoreControllerRef.current !== controller || controller.signal.aborted) return;
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
      if (controller.signal.aborted || loadMoreControllerRef.current !== controller) return;
      console.error('[loadMore] failed:', e);
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [loadingMore, hasMore, loading, page, feedMode, currentUserId]);

  // useFocusEffect re-runs whenever loadFeed changes identity (i.e. when feedMode or
  // currentUserId changes) AND the screen is currently focused — so tab switches reload.
  // Skipped exactly once when returning from a post's own detail screen —
  // see skipNextFocusReloadRef's own comment above — so that specific
  // round trip preserves the existing list/scroll position instead of
  // popping back to a freshly reloaded, scrolled-to-top FlatList.
  useFocusEffect(
    useCallback(() => {
      if (skipNextFocusReloadRef.current) {
        skipNextFocusReloadRef.current = false;
      } else {
        loadFeed();
      }
      return () => {
        loadFeedControllerRef.current?.abort();
        refreshControllerRef.current?.abort();
        loadMoreControllerRef.current?.abort();
      };
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
        // Notify post owner — server-verified against the likes row that
        // just committed (create_or_refresh_like_notification RPC), never a
        // direct client insert. Same pattern as toggleFollow's
        // create_or_refresh_follow_notification in profile-v2-screen.tsx.
        supabase.rpc('create_or_refresh_like_notification', { p_post_id: postId }).then(({ error: e }) => {
          if (e) console.error('Like notif failed:', e.message);
        });
      }
    }
  }

  // Optimistic removal, same shape as handleLike's optimistic update above
  // — the post disappears immediately, and is spliced back into its exact
  // original position if the delete actually fails, so a failure never
  // leaves the list silently missing a post that's still really there.
  async function handleDeletePost(postId: string) {
    const index = posts.findIndex((p) => p.id === postId);
    if (index === -1) return;
    const removed = posts[index];

    setPosts((prev) => prev.filter((p) => p.id !== postId));

    const result = await deletePost(postId);
    if (result.status !== 'ok') {
      console.error('[HomeScreen] handleDeletePost failed:', result.reason);
      setPosts((prev) => {
        if (prev.some((p) => p.id === postId)) return prev; // already restored/superseded
        const next = [...prev];
        next.splice(Math.min(index, next.length), 0, removed);
        return next;
      });
      Alert.alert('Error', 'Could not delete post. Please try again.');
    }
  }

  const emptyBody =
    feedMode === 'for-you'
      ? 'Add an item to your collection and enable "Share to feed" to post here.'
      : 'Follow people to see their posts here.';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* X-style shell — Piece 1 of the feed redesign: icon row (compose /
          brand mark / notifications) plus the For You / Following tabs
          directly below, both on the same flat dark chrome with a single
          subtle divider beneath the whole thing. As of Piece 5 the page
          body below shares this same PV2.bg — no more seam. */}
      <View style={styles.header}>
        {/* Create button — opens the existing Create menu, same entry
            point as before (no new posting route). */}
        <TouchableOpacity
          onPress={() => setCreateMenuOpen(true)}
          style={styles.composeBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Create post">
          <IconSymbol name="plus" size={24} color={PV2.textPrimary} weight="semibold" />
        </TouchableOpacity>

        {/* Brand mark — compact app-header sizing, not the larger marketing
            lockup. "light" variant (light-colored logo) for this dark
            header, unlike the previous "dark" variant used on the old
            light-background header. Piece 6: size 26→28 (~7.7%) — it read
            slightly small on-device versus the mockup's visual weight;
            header paddingVertical/height untouched, so this is the only
            change. */}
        <TouchableOpacity onPress={scrollToTop} hitSlop={12} accessibilityRole="button" accessibilityLabel="Scroll to top">
          <CacheCaseLogo variant="light" size={28} />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => router.push('/(tabs)/notifications')}
          style={styles.bellBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Notifications">
          <IconSymbol name="bell.fill" size={22} color={PV2.textPrimary} />
          {notifCount > 0 && (
            <View style={styles.bellBadge}>
              <Text style={styles.bellBadgeText}>
                {notifCount > 99 ? '99+' : notifCount}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* For You / Following — same feedMode state/query behavior as
          before, restyled from the old pill/card segment to a restrained
          underline treatment. */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={styles.tabBtn}
          onPress={() => setFeedMode('for-you')}
          accessibilityRole="button"
          accessibilityState={{ selected: feedMode === 'for-you' }}>
          <Text
            style={[styles.tabText, feedMode === 'for-you' && styles.tabTextActive]}
            onLayout={(e) => {
              // Width extracted synchronously, before setState — the
              // updater below must never touch `e`/`e.nativeEvent`
              // itself, since the synthetic event can already be
              // released/pooled by the time a functional updater actually
              // runs (this was the crash: "Cannot read property 'layout'
              // of null").
              const width = e.nativeEvent.layout.width;
              setTabLabelWidths((prev) => (prev.forYou === width ? prev : { ...prev, forYou: width }));
            }}>
            For You
          </Text>
          {feedMode === 'for-you' && tabLabelWidths.forYou > 0 && (
            <View style={[styles.tabUnderline, { width: tabLabelWidths.forYou }]} />
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.tabBtn}
          onPress={() => setFeedMode('following')}
          accessibilityRole="button"
          accessibilityState={{ selected: feedMode === 'following' }}>
          <Text
            style={[styles.tabText, feedMode === 'following' && styles.tabTextActive]}
            onLayout={(e) => {
              const width = e.nativeEvent.layout.width;
              setTabLabelWidths((prev) => (prev.following === width ? prev : { ...prev, following: width }));
            }}>
            Following
          </Text>
          {feedMode === 'following' && tabLabelWidths.following > 0 && (
            <View style={[styles.tabUnderline, { width: tabLabelWidths.following }]} />
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
                onUserPress={() => navigateToProfile(router, currentUserId, item.user_id, item.username)}
                onPostPress={() => {
                  // See skipNextFocusReloadRef's own comment above — set
                  // right before the push so the focus effect that fires
                  // when this tab regains focus on the way back knows to
                  // skip its usual refetch this one time.
                  skipNextFocusReloadRef.current = true;
                  router.push({
                    pathname: '/post/[id]',
                    params: { id: item.id },
                  });
                }}
                onCommentPress={() => {
                  router.push({
                    pathname: '/post-reply/[id]',
                    params: { id: item.id },
                  });
                }}
                onLike={() => handleLike(item.id)}
                onDelete={() => handleDeletePost(item.id)}
              />
            )}
            contentContainerStyle={[styles.list, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}
            scrollEventThrottle={scrollEventThrottle}
            onScroll={navbarOnScroll}
            onEndReached={loadMore}
            onEndReachedThreshold={0.4}
            ListFooterComponent={
              loadingMore ? (
                <View style={styles.footer}>
                  <ActivityIndicator size="small" color="#0a7ea4" />
                </View>
              ) : null
            }
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          />
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
    // Piece 5 — dark-theme transition complete. Was LIGHT_PAGE_BACKGROUND
    // through Pieces 1-4 (deliberately, per the phased redesign plan); now
    // matches the header/tabs/posts' own PV2.bg, so there's no remaining
    // seam anywhere in the feed.
    backgroundColor: PV2.bg,
  },
  // Icon row — flat, edge-to-edge, no rounded container. No border here of
  // its own; the single "subtle bottom divider" the mockup calls for lives
  // on tabRow below instead, so it reads as one divider under the whole
  // header area (icon row + tabs) rather than two.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: PV2.bg,
  },
  // For You / Following — restrained underline treatment (tabUnderline
  // below) replacing the old pill/card segment control. Same feedMode
  // state/query behavior, restyle only.
  tabRow: {
    flexDirection: 'row',
    backgroundColor: PV2.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  tabBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
  },
  tabText: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  tabTextActive: {
    color: PV2.textPrimary,
  },
  // Piece 6 — height 3→2 (less heavy) and width now supplied per-instance
  // from the measured label width (tabLabelWidths) instead of one fixed
  // 56, so it reads as tied to each tab's own text ("For You" vs the
  // wider "Following") rather than a generic bar. borderRadius 1 stays
  // fully rounded for a 2px-tall bar (clamped to half the smaller
  // dimension either way).
  tabUnderline: {
    position: 'absolute',
    bottom: 0,
    height: 2,
    borderRadius: 1,
    backgroundColor: PV2.accent,
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
    color: PV2.textPrimary,
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 15,
    color: PV2.textSecondary,
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
  // Piece 3 of the X-style redesign — posts are flat/dark/borderless now
  // (see PostCard's own card style), each separated by its own bottom
  // hairline divider instead of a gap on all sides; the old
  // paddingHorizontal/gap here were what made them read as floating cards.
  // Edge-to-edge, no horizontal inset — PostCard owns its own internal
  // paddingHorizontal for header/text/media instead.
  list: {},
  footer: {
    paddingVertical: 24,
    alignItems: 'center',
  },
});
