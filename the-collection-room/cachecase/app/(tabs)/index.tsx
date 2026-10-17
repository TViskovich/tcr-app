import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import { useBadgeRefresh } from '@/lib/badge-context';
import { invalidateOwnProfileCache } from '@/lib/own-profile-cache';
import { deletePost, repostPost, undoRepost } from '@/lib/posts';
import { navigateToProfile } from '@/lib/profile-navigation';
import { registerTabReselect, type ScrollToTopHandle } from '@/lib/scroll-to-top';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { CreateMenu } from '@/components/create/create-menu';
import { FindUserDropdown } from '@/components/feed/find-user-dropdown';
import { FollowingItemsFeed, prefetchFollowingFeed } from '@/components/feed/following-items-feed';
import { MessagesInbox } from '@/components/messages/messages-inbox';
import { prefetchInbox } from '@/lib/dm-inbox';
import { RepostMenu } from '@/components/feed/repost-menu';
import {
  FEED_POST_SELECT,
  FEED_POST_TYPES,
  hydrateFeedPosts,
  PostCard,
  removeOwnRepost,
  setRepostState,
  type FeedPost,
} from '@/components/feed/post-card';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useHomeTabActivity } from '@/hooks/use-home-tab-activity';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import type { HomeTabKey } from '@/lib/home-tab-activity';

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
    .select(FEED_POST_SELECT)
    .in('post_type', [...FEED_POST_TYPES])
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1)
    .abortSignal(signal);

  if (postsError) {
    // An aborted request (superseded load or lost focus) is expected, not
    // an error worth logging — the caller's own aborted-signal check
    // discards it either way.
    if (!signal.aborted) {
      console.error('[queryFeed] posts query failed:', postsError.message, postsError);
    }
    throw postsError;
  }

  // Shared with a profile's Posts tab (fetchUserPosts) — every post type,
  // reposts included, hydrates the same way everywhere.
  const posts = await hydrateFeedPosts((postRows ?? []) as any, signal, currentUserId);
  return sortPostsByCreatedAtDesc(posts);
}

// Home's three tabs. The internal keys predate the current labels and are
// kept as-is so every existing feedMode check keeps working: 'for-you' is
// the Stack (social posts) feed, 'following' the Arrivals (recently added
// items) grid, and 'messages' the DM inbox.
type FeedMode = 'for-you' | 'following' | 'messages';
const HOME_TABS: { key: FeedMode; label: string }[] = [
  { key: 'for-you', label: 'Stack' },
  { key: 'following', label: 'Arrivals' },
  { key: 'messages', label: 'Messages' },
];
// Which "new activity" dot (hooks/use-home-tab-activity.ts) each tab shows.
const FEED_MODE_ACTIVITY: Record<FeedMode, HomeTabKey> = {
  'for-you': 'stack',
  following: 'arrivals',
  messages: 'messages',
};
// Left-to-right page order of the horizontal Home pager — same order as
// the top tabs above.
const HOME_PAGES = HOME_TABS.map((t) => t.key);
const LAST_PAGE = HOME_PAGES.length - 1;

function clampPage(index: number) {
  'worklet';
  return Math.min(Math.max(index, 0), LAST_PAGE);
}

export default function HomeScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const { count: notifCount } = useBadgeRefresh();

  const { onScroll: navbarOnScroll, scrollEventThrottle } = useScrollResponsiveNavbar();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<FeedPost>>(null);

  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  // Find User (long-press the logo): where the logo's bottom-center sits on
  // screen when it opened (null = closed) — the dropdown anchors to it.
  const [findUserAnchor, setFindUserAnchor] = useState<{ x: number; y: number } | null>(null);
  const logoRef = useRef<View>(null);

  function openFindUser() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    const fallback = { x: 0, y: 0 };
    if (!logoRef.current) {
      setFindUserAnchor(fallback);
      return;
    }
    logoRef.current.measureInWindow((x, y, width, height) => {
      setFindUserAnchor(width > 0 ? { x: x + width / 2, y: y + height } : fallback);
    });
  }
  // The entry whose Repost control opened the Repost / Quote menu (null =
  // closed). The menu acts on its ORIGINAL (a repost's repostOf).
  const [repostMenuFor, setRepostMenuFor] = useState<FeedPost | null>(null);
  const repostMenuOriginal = repostMenuFor ? (repostMenuFor.repostOf ?? repostMenuFor) : null;
  const [feedMode, setFeedMode] = useState<FeedMode>('for-you');
  const followingFeedRef = useRef<ScrollToTopHandle>(null);
  const messagesInboxRef = useRef<ScrollToTopHandle>(null);

  // Scrolls whichever section is on screen back to its top — never changes
  // the selected section. Pure scroll: no reload, no pull-to-refresh.
  const scrollActivePaneToTop = useCallback(() => {
    if (feedMode === 'for-you') listRef.current?.scrollToOffset({ offset: 0, animated: true });
    else if (feedMode === 'following') followingFeedRef.current?.scrollToTop();
    else messagesInboxRef.current?.scrollToTop();
  }, [feedMode]);

  // Tapping the Home icon while already on Home (app/(tabs)/_layout.tsx ->
  // requestTabReselect('home')) scrolls the visible section to the top and
  // stays on it, however many times it's tapped. Only that explicit tap
  // reaches this — coming back to Home from another tab, an item, profile,
  // conversation or the background never does, so the selected section and
  // every section's scroll position stay put then.
  useFocusEffect(
    useCallback(
      () =>
        registerTabReselect('home', () => {
          scrollActivePaneToTop();
          return true;
        }),
      [scrollActivePaneToTop],
    ),
  );

  // New-activity dots on the top tabs. Home's own focus gates both the
  // (focus-triggered, throttled) freshness check and what counts as
  // "viewing" a section.
  const [homeFocused, setHomeFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setHomeFocused(true);
      return () => setHomeFocused(false);
    }, []),
  );
  const tabActivity = useHomeTabActivity({
    userId: currentUserId,
    activeTab: FEED_MODE_ACTIVITY[feedMode],
    homeFocused,
  });

  // ── Horizontal section pager (Stack ⇄ Arrivals ⇄ Messages) ──
  // A native paging ScrollView, one screen-wide page per section. feedMode
  // is the SETTLED section: it changes on a tab tap or once a swipe comes
  // to rest, and it is what gates Stack's focus reload, Messages' polling
  // (via `active`) and the Home reselect above. highlightedMode is only the
  // label tint, which follows the finger and flips at the halfway point.
  // The underline tracks the pager offset continuously on the UI thread.
  const { width: pageWidth } = useWindowDimensions();
  const pagerRef = useAnimatedRef<Animated.ScrollView>();
  const pagerX = useSharedValue(0);
  const userPaging = useSharedValue(false);
  const highlightedPage = useSharedValue(0);
  const [highlightedMode, setHighlightedMode] = useState<FeedMode>('for-you');

  // Sections mount the first time they are visited (tapped, or revealed by
  // a swipe) and then stay mounted, so each keeps its own vertical scroll
  // position and nothing refetches on the way back. Lazy so opening Home
  // never starts Arrivals' or Messages' requests on its own.
  const mountedMask = useSharedValue(1);
  const [mountedPages, setMountedPages] = useState<ReadonlySet<FeedMode>>(() => new Set(['for-you']));
  const mountPageAt = useCallback(
    (index: number) => {
      const mode = HOME_PAGES[clampPage(index)];
      mountedMask.set((m) => m | (1 << clampPage(index)));
      setMountedPages((prev) => (prev.has(mode) ? prev : new Set(prev).add(mode)));
    },
    [mountedMask],
  );
  const highlightPageAt = useCallback((index: number) => {
    setHighlightedMode(HOME_PAGES[clampPage(index)]);
  }, []);
  const settlePageAt = useCallback(
    (index: number) => {
      const mode = HOME_PAGES[clampPage(index)];
      mountPageAt(index);
      setHighlightedMode(mode);
      setFeedMode(mode);
    },
    [mountPageAt],
  );

  // Page a tab tap is scrolling to (-1 = none). A tap settles feedMode only
  // when the pager actually arrives there (see onScroll below) — the same
  // point a swipe settles at. Settling at tap time instead flipped
  // feedMode, and with it Arrivals' `active`, at the START of the animation:
  // the first visit's deferred grid expansion, image signing/warmup and any
  // stale-data refresh all landed on top of the programmatic scroll, which
  // is what made the first Stack → Arrivals tap stutter.
  const pendingTargetPage = useSharedValue(-1);

  function selectFeedMode(mode: FeedMode) {
    const index = HOME_PAGES.indexOf(mode);
    const targetX = index * pageWidth;
    // Immediate feedback: label tint, and the page mounted so it's there to
    // scroll onto (Arrivals usually already is — pre-mounted, inactive).
    highlightedPage.set(index);
    setHighlightedMode(mode);
    mountPageAt(index);
    if (Math.abs(pagerX.get() - targetX) < 1) {
      // Already there — no scroll will happen to settle on.
      pendingTargetPage.set(-1);
      settlePageAt(index);
      return;
    }
    pendingTargetPage.set(index);
    pagerRef.current?.scrollTo({ x: targetX, animated: true });
  }

  const pagerScrollHandler = useAnimatedScrollHandler({
    onBeginDrag: () => {
      userPaging.set(true);
      // A finger takes over from an in-flight tab-tap scroll: the swipe's
      // own end decides where it settles.
      pendingTargetPage.set(-1);
    },
    onScroll: (e) => {
      pagerX.set(e.contentOffset.x);
      // A tab tap's programmatic scroll has reached its page: settle now,
      // after the animation, exactly like a swipe does on momentum end.
      const pending = pendingTargetPage.get();
      if (pending >= 0 && pageWidth > 0 && Math.abs(e.contentOffset.x - pending * pageWidth) < 1) {
        pendingTargetPage.set(-1);
        runOnJS(settlePageAt)(pending);
        return;
      }
      // Label tint / lazy mounting follow the user's own swipe only — a tab
      // tap (selectFeedMode) has already set both for its target and
      // shouldn't flash the sections it passes over.
      if (!userPaging.get() || pageWidth <= 0) return;
      const position = e.contentOffset.x / pageWidth;
      const nearest = clampPage(Math.round(position));
      if (nearest !== highlightedPage.get()) {
        highlightedPage.set(nearest);
        runOnJS(highlightPageAt)(nearest);
      }
      // Mount a section as soon as the swipe starts revealing it.
      const left = clampPage(Math.floor(position));
      const right = clampPage(Math.ceil(position));
      if (!(mountedMask.get() & (1 << left))) runOnJS(mountPageAt)(left);
      if (!(mountedMask.get() & (1 << right))) runOnJS(mountPageAt)(right);
    },
    onEndDrag: (e) => {
      // Released exactly on a page boundary: paging produces no momentum
      // phase, so settle here.
      if (pageWidth <= 0) return;
      const page = Math.round(e.contentOffset.x / pageWidth);
      if (Math.abs(e.contentOffset.x - page * pageWidth) < 1) {
        userPaging.set(false);
        runOnJS(settlePageAt)(page);
      }
    },
    onMomentumEnd: (e) => {
      userPaging.set(false);
      // Also reached by the end of a tab tap's scroll on platforms that
      // report it; settling the same page twice is a no-op.
      pendingTargetPage.set(-1);
      if (pageWidth <= 0) return;
      const page = clampPage(Math.round(e.contentOffset.x / pageWidth));
      highlightedPage.set(page);
      runOnJS(settlePageAt)(page);
    },
  });

  // Each tab button's frame within tabRow (the underline's positioning
  // parent) — with tabLabelWidths below, gives each tab's underline span.
  const [tabFrames, setTabFrames] = useState<Partial<Record<FeedMode, { x: number; width: number }>>>({});
  // Piece 6 — measured label widths for the active-tab underline below, so
  // it's sized to each tab's own text ("tab-local") instead of one fixed
  // width. Purely visual; feedMode/query behavior is untouched.
  const [tabLabelWidths, setTabLabelWidths] = useState<Record<FeedMode, number>>({
    'for-you': 0,
    following: 0,
    messages: 0,
  });
  const underlineStops = HOME_TABS.every(({ key }) => tabFrames[key] && tabLabelWidths[key] > 0)
    ? HOME_TABS.map(({ key }) => {
        const frame = tabFrames[key]!;
        return { left: frame.x + (frame.width - tabLabelWidths[key]) / 2, width: tabLabelWidths[key] };
      })
    : null;
  const underlineStyle = useAnimatedStyle(() => {
    if (!underlineStops || pageWidth <= 0) return { opacity: 0 };
    const input = underlineStops.map((_, i) => i * pageWidth);
    const x = pagerX.get();
    return {
      opacity: 1,
      width: interpolate(x, input, underlineStops.map((u) => u.width), Extrapolation.CLAMP),
      transform: [{ translateX: interpolate(x, input, underlineStops.map((u) => u.left), Extrapolation.CLAMP) }],
    };
  });
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  // Distinct from "posts.length === 0" (the empty state below) — a failed
  // query must never look identical to "you have no posts." queryFeed
  // throws on a genuine query failure (it used to silently swallow it), so
  // this needs to be caught here rather than left as an unhandled rejection
  // that would also leave loading/refreshing spinners stuck on forever.
  // (For-you mode only now — Following mode's own error state lives inside
  // FollowingItemsFeed.)
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

  // Mirrors feedMode for the focus effect below, which must NOT re-run when
  // feedMode changes (a For You <-> Following toggle is not a refresh).
  const feedModeRef = useRef(feedMode);
  useEffect(() => {
    feedModeRef.current = feedMode;
  }, [feedMode]);

  // Which user the current `posts` were loaded for, and whether that load
  // ever succeeded. Once posts exist for the current user, loadFeed refreshes
  // quietly (stale-while-revalidate) instead of blanking the list behind the
  // full-screen loader.
  const loadedForUserRef = useRef<string | undefined | null>(null);

  const loadFeed = useCallback(async () => {
    loadFeedControllerRef.current?.abort();
    const controller = new AbortController();
    loadFeedControllerRef.current = controller;

    const quiet = loadedForUserRef.current === currentUserId;
    if (!quiet) {
      setLoading(true);
      setPage(0);
      setHasMore(true);
    }
    setLoadError(null);
    try {
      const data = await queryFeed(currentUserId, 0, controller.signal);
      // Superseded (a newer loadFeed call, or the tab lost focus) — this
      // batch's result is stale regardless of whether it actually finished
      // or carries an abort error; never let it commit over newer state.
      if (loadFeedControllerRef.current !== controller || controller.signal.aborted) return;
      if (quiet) {
        // Fresh page-0 rows replace their stale copies and new ones slot in
        // by created_at; already-paginated older posts (and page/hasMore)
        // stay, so the list and scroll position aren't disturbed.
        setPosts((prev) => {
          const freshIds = new Set(data.map((p) => p.id));
          return sortPostsByCreatedAtDesc([...data, ...prev.filter((p) => !freshIds.has(p.id))]);
        });
      } else {
        setPosts(data);
        setHasMore(data.length === PAGE_SIZE);
      }
      loadedForUserRef.current = currentUserId;
    } catch (e) {
      if (controller.signal.aborted || loadFeedControllerRef.current !== controller) return;
      console.error('[loadFeed] failed:', e);
      // A failed quiet refresh keeps the posts already on screen.
      if (!quiet) setLoadError(e instanceof Error ? e.message : 'Failed to load feed.');
    } finally {
      if (loadFeedControllerRef.current === controller) {
        loadFeedControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [currentUserId]);

  const onRefresh = useCallback(async () => {
    // See loadFeed's identical guard above — Following mode has its own
    // pull-to-refresh inside FollowingItemsFeed now.
    if (feedMode !== 'for-you') return;

    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;

    setRefreshing(true);
    setPage(0);
    setHasMore(true);
    try {
      const data = await queryFeed(currentUserId, 0, controller.signal);
      if (refreshControllerRef.current !== controller || controller.signal.aborted) return;
      setPosts(data);
      setHasMore(data.length === PAGE_SIZE);
      setLoadError(null);
      loadedForUserRef.current = currentUserId;
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
    // Following mode has no post pagination anymore — see loadFeed's
    // identical guard above.
    if (feedMode !== 'for-you') return;
    if (loadingMore || !hasMore || loading) return;
    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;

    setLoadingMore(true);
    const nextPage = page + 1;
    try {
      const data = await queryFeed(currentUserId, nextPage, controller.signal);
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

  // useFocusEffect re-runs on real screen focus (and if currentUserId
  // changes) — NOT on feedMode changes: loadFeed no longer depends on
  // feedMode, so toggling For You <-> Following never reloads. A real focus
  // still refreshes, quietly when posts are already loaded (see loadFeed).
  // Skipped exactly once when returning from a post's own detail screen —
  // see skipNextFocusReloadRef's own comment above — so that specific
  // round trip preserves the existing list/scroll position instead of
  // popping back to a freshly reloaded, scrolled-to-top FlatList.
  useFocusEffect(
    useCallback(() => {
      if (skipNextFocusReloadRef.current) {
        skipNextFocusReloadRef.current = false;
      } else if (feedModeRef.current === 'for-you') {
        loadFeed();
      }
      return () => {
        loadFeedControllerRef.current?.abort();
        refreshControllerRef.current?.abort();
        loadMoreControllerRef.current?.abort();
      };
    }, [loadFeed]),
  );

  // Originals with a repost/undo request in flight — a double tap while
  // one is pending is ignored (the server is idempotent too: one repost per
  // user per original).
  const repostInFlightRef = useRef(new Set<string>());

  // Following head start: once For You's first load has settled, prepare
  // Following's first screen in the background at the next idle moment
  // (prefetchFollowingFeed — bounded: one row query + comment counts, then
  // only the first few preview images). Never before For You is on screen,
  // never in front of an interaction, and at most once per signed-in user
  // per session (the function itself also skips when Following already has
  // data or a preparation running). Following opened earlier still loads on
  // its own, or joins this if it's in flight.
  //
  // Once that preparation settles, the Arrivals PAGE is pre-mounted too
  // (still off-screen, `active={false}`): it renders its first tiles from
  // the snapshot just prepared — images already signed and downloaded — so
  // the first Stack → Arrivals swipe no longer mounts a whole feed mid-
  // gesture (which is what made that first transition janky while later
  // ones were smooth). No extra requests: everything costly inside it waits
  // for its first visit (see FollowingItemsFeed's `active`).
  //
  // The Messages tab's inbox is warmed in the same idle slot
  // (prefetchInbox, lib/dm-inbox.ts): one inbox query in the background, so
  // opening Messages shows the list immediately instead of a skeleton. Same
  // once-per-user-per-session rule; never conversation histories or photos.
  // Messages itself stays lazily mounted.
  const followingPrefetchedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentUserId || loading || followingPrefetchedForRef.current === currentUserId) return;
    const userId = currentUserId;
    const handle = requestIdleCallback(() => {
      followingPrefetchedForRef.current = userId;
      prefetchFollowingFeed(userId).then(() => {
        // Still at the next idle moment, so the mount never lands on top of
        // something the user just started.
        requestIdleCallback(() => mountPageAt(HOME_PAGES.indexOf('following')));
      });
      prefetchInbox(userId);
    });
    return () => cancelIdleCallback(handle);
  }, [currentUserId, loading, mountPageAt]);

  // Repost / undo repost of an entry's ORIGINAL (a repost's own repostOf).
  // Optimistic count/state; rolled back if the request fails. A new repost
  // appears as its own feed entry on the quiet refresh that follows; an
  // undo removes the user's repost entry once confirmed.
  async function handleRepost(entry: FeedPost) {
    if (!currentUserId) return;
    const original = entry.repostOf ?? entry;
    if (repostInFlightRef.current.has(original.id)) return;
    repostInFlightRef.current.add(original.id);
    const undo = !!original.repostedByMe;
    setPosts((prev) => setRepostState(prev, original.id, !undo));
    try {
      const result = undo ? await undoRepost(currentUserId, original.id) : await repostPost(currentUserId, original.id);
      if (result.status !== 'ok') {
        setPosts((prev) => setRepostState(prev, original.id, undo));
        Alert.alert(
          undo ? 'Couldn’t remove repost' : 'Couldn’t repost',
          result.reason === 'not_found' ? 'This post is no longer available.' : 'Please try again.',
        );
        return;
      }
      if (undo) setPosts((prev) => removeOwnRepost(prev, original.id, currentUserId));
      // The reposter's own Profile Posts tab now differs.
      invalidateOwnProfileCache(currentUserId);
      if (!undo) loadFeed();
    } finally {
      repostInFlightRef.current.delete(original.id);
    }
  }

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
      return;
    }
    // Deleting your own repost un-reposts its original.
    if (removed.repostOf) {
      const originalId = removed.repostOf.id;
      setPosts((prev) => setRepostState(prev, originalId, false));
    }
    // Mark the own-profile cache stale — PostCard's own delete affordance
    // is owner-gated, so a reachable delete is always the signed-in user's
    // own post, and it no longer shows on their Profile Posts tab. See
    // lib/own-profile-cache.ts's own invalidateOwnProfileCache comment.
    if (currentUserId) invalidateOwnProfileCache(currentUserId);
  }

  // For You only now — Following renders FollowingItemsFeed, which owns
  // its own empty/error states below.
  const emptyBody = 'Add an item to your collection and enable "Share to feed" to post here.';

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
        {/* Tap: scroll the visible section to top. Long press: Find User. A press
            that becomes a long press never also fires onPress. */}
        <TouchableOpacity
          onPress={scrollActivePaneToTop}
          onLongPress={openFindUser}
          delayLongPress={350}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Scroll to top"
          accessibilityHint="Long press to find a user"
          accessibilityActions={[{ name: 'longpress', label: 'Find user' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'longpress') openFindUser();
          }}>
          <View ref={logoRef} collapsable={false}>
            <CacheCaseLogo variant="light" size={28} />
          </View>
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

      {/* Stack / Arrivals / Messages — same feedMode state/query behavior
          as before, in the restrained underline treatment; tabBtn's flex: 1
          spaces the three evenly. Tapping pages the pager below; the single
          underline slides with it (underlineStyle). */}
      <View style={styles.tabRow}>
        {HOME_TABS.map(({ key, label }) => (
          <TouchableOpacity
            key={key}
            style={styles.tabBtn}
            onPress={() => selectFeedMode(key)}
            onLayout={(e) => {
              const { x, width } = e.nativeEvent.layout;
              setTabFrames((prev) =>
                prev[key]?.x === x && prev[key]?.width === width ? prev : { ...prev, [key]: { x, width } },
              );
            }}
            accessibilityRole="button"
            accessibilityLabel={tabActivity[FEED_MODE_ACTIVITY[key]] ? `${label}, new activity` : label}
            accessibilityState={{ selected: feedMode === key }}>
            {/* Shrink-wrapped to the label, so the dot (absolutely placed
                beside it) never shifts the label off-center or changes the
                measured width the underline uses. */}
            <View style={styles.tabLabelWrap}>
            <Text
              style={[styles.tabText, highlightedMode === key && styles.tabTextActive]}
              onLayout={(e) => {
                // Width extracted synchronously, before setState — the
                // updater below must never touch `e`/`e.nativeEvent`
                // itself, since the synthetic event can already be
                // released/pooled by the time a functional updater actually
                // runs (this was the crash: "Cannot read property 'layout'
                // of null").
                const width = e.nativeEvent.layout.width;
                setTabLabelWidths((prev) => (prev[key] === width ? prev : { ...prev, [key]: width }));
              }}>
              {label}
            </Text>
            {tabActivity[FEED_MODE_ACTIVITY[key]] && <View style={styles.tabActivityDot} pointerEvents="none" />}
            </View>
          </TouchableOpacity>
        ))}
        <Animated.View style={[styles.tabUnderline, underlineStyle]} pointerEvents="none" />
      </View>

      {/* Horizontal pager — one full-width page per section, Stack ⇄
          Arrivals ⇄ Messages. Native iOS paging physics; vertical lists
          inside each page scroll independently (UIScrollView direction
          locking). No bounce at the ends, so a left swipe on the last page
          (Messages) is left to its rows' swipe-to-delete. Every visited
          section stays mounted, so its scroll position survives both
          swiping away and leaving Home for another tab. */}
      <Animated.ScrollView
        ref={pagerRef}
        style={styles.feedBody}
        horizontal
        pagingEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        scrollsToTop={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScroll={pagerScrollHandler}
        scrollEventThrottle={16}>
      <View
        style={[styles.page, { width: pageWidth }]}
        accessibilityElementsHidden={feedMode !== 'for-you'}
        importantForAccessibility={feedMode !== 'for-you' ? 'no-hide-descendants' : 'auto'}>
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
                // A repost shows its ORIGINAL post's author and content, so
                // the author/source links follow item.repostOf; the
                // "reposted" line opens the reposter (item itself).
                onUserPress={() => {
                  const shown = item.repostOf ?? item;
                  navigateToProfile(router, currentUserId, shown.user_id, shown.username);
                }}
                onReposterPress={() => navigateToProfile(router, currentUserId, item.user_id, item.username)}
                onRepost={() => setRepostMenuFor(item)}
                onOpenQuoted={(quotedId) => {
                  skipNextFocusReloadRef.current = true;
                  router.push({ pathname: '/post/[id]', params: { id: quotedId } });
                }}
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
                // Share Card post: same navigation, opening Post Detail's
                // carousel on the card that was tapped.
                onCardSharePress={(cardIndex) => {
                  skipNextFocusReloadRef.current = true;
                  router.push({
                    pathname: '/post/[id]',
                    params: { id: item.id, cardIndex: String(cardIndex) },
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
                onSourceOwnerPress={
                  (item.repostOf ?? item).sourceOwner
                    ? () => {
                        const owner = (item.repostOf ?? item).sourceOwner!;
                        navigateToProfile(router, currentUserId, owner.id, owner.username);
                      }
                    : undefined
                }
                onSourceItemPress={
                  (item.repostOf ?? item).item_id
                    ? () => router.push({ pathname: '/item/[id]', params: { id: (item.repostOf ?? item).item_id! } })
                    : undefined
                }
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
      </View>

      <View
        style={[styles.page, { width: pageWidth }]}
        accessibilityElementsHidden={feedMode !== 'following'}
        importantForAccessibility={feedMode !== 'following' ? 'no-hide-descendants' : 'auto'}>
        {mountedPages.has('following') && (
          // Arrivals: entirely separate data model/layout — recently
          // uploaded collection items from followed collectors, not posts.
          // Owns its own loading/error/empty states and data fetching;
          // nothing in the Stack page (posts/loading/loadError/FlatList)
          // applies to it.
          <FollowingItemsFeed
            ref={followingFeedRef}
            active={feedMode === 'following'}
            currentUserId={currentUserId}
            onScroll={navbarOnScroll}
            scrollEventThrottle={scrollEventThrottle}
          />
        )}
      </View>

      <View
        style={[styles.page, { width: pageWidth }]}
        accessibilityElementsHidden={feedMode !== 'messages'}
        importantForAccessibility={feedMode !== 'messages' ? 'no-hide-descendants' : 'auto'}>
        {mountedPages.has('messages') && (
          // The same inbox the /(tabs)/messages route renders. Stays
          // mounted once visited, but its focus-driven load and 5s polling
          // run only while it is the settled section (`active`) — and, as
          // before, stop when a conversation is pushed over Home.
          <MessagesInbox ref={messagesInboxRef} embedded active={feedMode === 'messages'} />
        )}
      </View>
      </Animated.ScrollView>

      <RepostMenu
        visible={!!repostMenuOriginal}
        reposted={!!repostMenuOriginal?.repostedByMe}
        onRepost={() => {
          const entry = repostMenuFor;
          setRepostMenuFor(null);
          if (entry) handleRepost(entry);
        }}
        onQuote={() => {
          const original = repostMenuOriginal;
          setRepostMenuFor(null);
          if (original) router.push({ pathname: '/quote/[id]', params: { id: original.id } });
        }}
        onClose={() => setRepostMenuFor(null)}
      />

      <FindUserDropdown
        visible={findUserAnchor !== null}
        anchor={findUserAnchor && findUserAnchor.y > 0 ? findUserAnchor : null}
        currentUserId={currentUserId}
        onClose={() => setFindUserAnchor(null)}
      />

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
  tabLabelWrap: {
    position: 'relative',
  },
  // "New activity" dot beside a tab label — the theme's light-blue
  // accent, small enough to read as a hint in both the active (white) and
  // inactive (muted) label states. Absolutely placed past the label's right
  // edge, roughly at cap height.
  tabActivityDot: {
    position: 'absolute',
    top: 2,
    right: -9,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: PV2.actionPrimary,
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
    left: 0,
    height: 2,
    borderRadius: 1,
    backgroundColor: PV2.actionPrimary,
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
  // The horizontal section pager under the tabs.
  feedBody: {
    flex: 1,
  },
  // One pager page (width set inline to the screen width); stretches to
  // the pager's full height.
  page: {
    alignSelf: 'stretch',
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
