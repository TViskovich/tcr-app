import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PrivateImageWarmup } from '@/components/images/private-image-warmup';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAuth } from '@/lib/auth';
import { DETAIL_IMAGE_TIER, type ImageTier } from '@/lib/image-tiers';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';
import { navigateToProfile } from '@/lib/profile-navigation';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import {
  peekCachedSignedItemImage,
  prefetchItemDetailImages,
  prefetchSignedItemImages,
  useSignedItemImages,
} from '@/hooks/use-signed-item-images';
import type { CollectibleItemType } from '@/types';

// Recent-uploads wall for the Following tab — a separate data model/layout
// from the post-based main feed (queryFeed/queryFollowingFeed in
// app/(tabs)/index.tsx, which this screen no longer uses for 'following'
// mode). Reads collection_items directly, not posts: "recently uploaded
// collection items," not "posts about items." Reuses this app's existing
// item-visibility/image/profile patterns end to end (see each import above)
// rather than inventing new ones.
//
// Visibility: relies entirely on collection_items' own RLS policy
// (items_select_public, supabase/migrations/20260910130000_fix_folders_rls_
// recursion.sql) — folder_is_effectively_visible(folder_id) AND
// (is_public = true OR user_id = auth.uid()) — rather than reimplementing
// that recursive folder-privacy check client-side. The `.eq('is_public',
// true)` filter below is a redundant, cheap pre-filter for query
// efficiency (same defense-in-depth convention as app/(tabs)/search.tsx's
// own `.eq('folders.is_public', true)`), never the actual security
// boundary. Own items are excluded automatically, not by a filter here —
// follows has CHECK(follower_id <> following_id), so followedIds can never
// contain the current user's own id.
//
// Bounded, single-page load (no infinite scroll) — see FOLLOWING_ITEMS_LIMIT.

const FOLLOWING_ITEMS_LIMIT = 60;
const COLUMN_GAP = 10;
const GRID_HORIZONTAL_PADDING = 12;

// Real categories only — this app's collection_items.item_type has exactly
// these values (supabase/migrations/20260916120000_add_collection_
// item_type.sql's own CHECK constraint). There is no "games/consoles"
// category anywhere in the schema, so none is invented here despite one
// appearing in the design reference mockup.
const ITEM_TYPE_LABEL: Record<CollectibleItemType, string> = {
  sports_card: 'Cards',
  pokemon: 'Pokémon',
  figurine: 'Figures',
  comic_book: 'Comics',
  trading_card: 'TCG',
  other: 'Other',
};

// One media-frame aspect ratio (width / height) for EVERY tile, whatever the
// category or the photo's own proportions — so every tile in the grid has
// the same media height, and rows line up. 3:4 sits between a trading card
// (~0.71) and a figure/game box (~0.8); the photo is letterboxed inside it
// via `contentFit="contain"` (see FollowingItemTile), never cropped. Never
// replaced by a real measurement, so layout is fixed from first render and
// never reflows when a photo loads.
const TILE_MEDIA_ASPECT_RATIO = 3 / 4;

// What's actually visible in the viewport on first entry to this 2-column
// masonry, confirmed on-device (~4 cards) — NOT a "roughly one screenful"
// estimate anymore. Does triple duty: (a) the initial number of tiles this
// screen actually MOUNTS on first render (see `mountCount` below — the rest
// of a cached list is deliberately kept out of the first frame's React/
// image-decode work), (b) the split point between the PRIORITY and
// BACKGROUND useSignedItemImages calls, and (c) the PrivateImageWarmup
// bound. Items are already newest-first/display-ordered by the time this
// slices them, so this approximates "what's on screen before any
// scrolling" without real viewport measurement.
const INITIAL_VISIBLE_ITEM_COUNT = 4;

// Item Detail warmup: the 'detail'-tier hero image (signed URL + bytes,
// under the exact cacheKey Item Detail reads) for the items the user is
// likely to tap, so opening one shows its sharp image at once instead of a
// loading panel. The first DETAIL_WARM_INITIAL items warm on entry; as the
// user scrolls, everything on screen plus the next row
// (DETAIL_WARM_AHEAD, one row of this 2-column grid) is kept warm. Only the
// most recent DETAIL_WARM_WINDOW are kept mounted/renewed — bytes already
// downloaded stay on disk after their warmer unmounts.
const DETAIL_WARM_INITIAL = 6;
const DETAIL_WARM_AHEAD = 2;
const DETAIL_WARM_WINDOW = 8;
// Estimated non-image height of one tile (owner row + text block + bottom
// margin — see styles.tileOwnerRow/tileTextBlock/tile), used only to work
// out roughly which tiles are on screen for the warmup above.
const TILE_CHROME_ESTIMATE = 90;

// Following tiles are small (roughly half-screen-wide) previews, so they
// request the ~500px 'preview' representation (see lib/image-tiers.ts)
// instead of the full-resolution original. Used for BOTH the signed-URL
// requests and every cacheKey below so a preview never shares an identity
// with the same image's original.
const FOLLOWING_IMAGE_TIER: ImageTier = 'preview';

type FollowingItem = {
  id: string;
  title: string | null;
  player: string | null;
  item_type: CollectibleItemType;
  created_at: string;
  user_id: string;
  primary_image_id: string | null;
  owner_username: string;
  owner_display_name: string | null;
  owner_avatar_url: string | null;
  commentCount: number;
};

// Session-scoped cache (module-level, in-memory only — deliberately NOT
// AsyncStorage) so switching feedMode away and back within the same app
// session doesn't behave like a fresh page load: app/(tabs)/index.tsx
// conditionally renders `feedMode === 'following' ? <FollowingItemsFeed/> :
// <ForYou stuff>`, which fully UNMOUNTS this component (and every bit of its
// local React state — items, sort, scroll position) the instant the user
// taps back to For You. A brand-new instance is created on the way back,
// whose own mount effect would otherwise refetch everything from scratch.
// Keyed by currentUserId, the same identity useSignedItemImages' own
// module-level cache already uses this same "outlive one component
// instance, for the life of the app session" scope for — see that file's
// own `cache` — so two different signed-in users within one session never
// share an entry. This only needs to survive a feedMode toggle, not an app
// relaunch.
type FollowingFeedSession = {
  items: FollowingItem[];
  followedCount: number;
  sort: 'newest' | 'oldest';
  scrollOffsetY: number;
  fetchedAt: number;
};

const followingFeedSessions = new Map<string, FollowingFeedSession>();

// "Fresh" window for the cache above — return to Following within this many
// ms of the last successful rows fetch and it renders with NO network
// activity at all. Past it, the cached snapshot STILL renders immediately
// (never blanked/never a skeleton), but a quiet load('background') kicks off
// behind it to catch anything new.
const FOLLOWING_FEED_FRESHNESS_MS = 45_000;

function updateSessionSnapshot(userId: string, patch: Partial<FollowingFeedSession>) {
  const existing = followingFeedSessions.get(userId);
  followingFeedSessions.set(userId, {
    items: existing?.items ?? [],
    followedCount: existing?.followedCount ?? 0,
    sort: existing?.sort ?? 'newest',
    scrollOffsetY: existing?.scrollOffsetY ?? 0,
    fetchedAt: existing?.fetchedAt ?? 0,
    ...patch,
  });
}

type FollowingRow = {
  id: string;
  title: string | null;
  player: string | null;
  item_type: string | null;
  created_at: string;
  user_id: string;
  primary_image: { id: string }[] | null;
  owner: { username: string | null; display_name: string | null; hero_display_name: string | null; avatar_url: string | null } | null;
};
type LoadRowsResult = { followedCount: number; items: FollowingItem[] };

// The followed users' newest public, active items — WITH each item's
// primary image id and owner profile — in ONE request. Embedded through
// collection_items -> profiles (owner, !inner) -> follows (!inner, filtered
// to the viewer as follower), so the follow filter, the image id and the
// owner identity all resolve server-side in the same round trip. This used
// to be three sequential round trips (follows ids -> items ->
// attachPrimaryImageIds, with owner profiles in a fourth), each one gating
// the next, and image signing could only start after the third. Same
// filters, order and limit as before; same RLS (a plain collection_items
// read). The viewer's follow COUNT (only the empty state needs it) runs in
// parallel instead of in front.
async function queryFollowingItemRows(currentUserId: string, signal: AbortSignal): Promise<LoadRowsResult> {
  const [followsRes, itemsRes] = await Promise.all([
    supabase
      .from('follows')
      .select('following_id', { count: 'exact', head: true })
      .eq('follower_id', currentUserId)
      .abortSignal(signal),
    supabase
      .from('collection_items')
      .select(
        'id, title, player, item_type, created_at, user_id, ' +
          'primary_image:collection_item_images(id), ' +
          'owner:profiles!collection_items_user_id_fkey!inner(username, display_name, hero_display_name, avatar_url, ' +
          'followers:follows!follows_following_id_fkey!inner(follower_id))',
      )
      .eq('owner.followers.follower_id', currentUserId)
      .eq('primary_image.is_primary', true)
      .eq('is_public', true)
      .eq('collection_status', 'active')
      .order('created_at', { ascending: false })
      .limit(FOLLOWING_ITEMS_LIMIT)
      .abortSignal(signal),
  ]);

  if (followsRes.error) {
    if (!signal.aborted) console.error('[FollowingItemsFeed] follows query failed:', followsRes.error.message);
    throw followsRes.error;
  }
  if (itemsRes.error) {
    if (!signal.aborted) console.error('[FollowingItemsFeed] items query failed:', itemsRes.error.message);
    throw itemsRes.error;
  }

  const items = ((itemsRes.data ?? []) as unknown as FollowingRow[]).map((row) => ({
    id: row.id,
    title: row.title ?? null,
    player: row.player ?? null,
    item_type: (row.item_type ?? 'sports_card') as CollectibleItemType,
    created_at: row.created_at,
    user_id: row.user_id,
    primary_image_id: row.primary_image?.[0]?.id ?? null,
    owner_username: row.owner?.username ?? 'user',
    owner_display_name: (row.owner?.hero_display_name || row.owner?.display_name) ?? null,
    owner_avatar_url: row.owner?.avatar_url ?? null,
    commentCount: 0,
  }));

  return { followedCount: followsRes.count ?? 0, items };
}

// item_comments counts (supabase/migrations/20260923120000_create_item_social.sql)
// — one batched query after the rows, never blocking the grid or its
// images. Counts only, since these tiles render a read-only count. Likes
// are intentionally not shown (or fetched) on this screen.
async function queryFollowingCommentCounts(itemIds: string[], signal: AbortSignal): Promise<Map<string, number>> {
  const { data } = await supabase.from('item_comments').select('item_id').in('item_id', itemIds).abortSignal(signal);
  const commentCountMap = new Map<string, number>();
  for (const row of (data ?? []) as { item_id: string }[]) {
    commentCountMap.set(row.item_id, (commentCountMap.get(row.item_id) ?? 0) + 1);
  }
  return commentCountMap;
}

// A background Following preparation (prefetchFollowingFeed) still in
// flight, per user — an initial load that starts meanwhile waits for it
// instead of running the same queries a second time.
const pendingPrefetches = new Map<string, Promise<void>>();

// Prepares the Following feed's first screen in the background, BEFORE the
// tab is opened — the head start Profile, Collections and folder screens
// get from loading during their push transition, which an in-screen tab
// toggle never has. Bounded and once per session per user: skipped if this
// user already has a Following snapshot (any age — the warm path already
// handles that) or a preparation in flight. It runs the feed's own row
// query (+ comment counts) and stores the result as the normal session
// snapshot, so opening Following within the freshness window renders it
// with no network at all (after it, the snapshot still renders at once and
// refreshes quietly, as on any return). Then it signs ONLY the first
// INITIAL_VISIBLE_ITEM_COUNT images at the feed's preview tier, through the
// shared signed-URL cache, and downloads those few into expo-image's cache
// under the tiles' own stable cacheKeys — never the rest of the feed.
// Never throws.
export function prefetchFollowingFeed(userId: string): void {
  if (followingFeedSessions.has(userId) || pendingPrefetches.has(userId)) return;
  const controller = new AbortController();
  const run = (async () => {
    try {
      const rows = await queryFollowingItemRows(userId, controller.signal);
      const counts = rows.items.length
        ? await queryFollowingCommentCounts(
            rows.items.map((i) => i.id),
            controller.signal,
          )
        : new Map<string, number>();
      // The feed loaded on its own meanwhile — its data wins.
      if (followingFeedSessions.has(userId)) return;
      const items = rows.items.map((item) => ({ ...item, commentCount: counts.get(item.id) ?? 0 }));
      updateSessionSnapshot(userId, { items, followedCount: rows.followedCount, fetchedAt: Date.now() });

      const firstImageIds = items
        .slice(0, INITIAL_VISIBLE_ITEM_COUNT)
        .map((i) => i.primary_image_id)
        .filter((id): id is string => !!id);
      await prefetchSignedItemImages(firstImageIds, FOLLOWING_IMAGE_TIER);
      await Promise.all(
        firstImageIds.map(async (imageId) => {
          // Same identity + tier keys the tiles use (servedTier when the
          // server fell back to the original), so these bytes are exactly
          // the cache entries the tiles read.
          const signed = peekCachedSignedItemImage(userId, imageId, FOLLOWING_IMAGE_TIER);
          if (!signed) return;
          try {
            const ref = await Image.loadAsync({
              uri: signed.url,
              cacheKey: itemImageCacheKey(userId, imageId, signed.servedTier ?? FOLLOWING_IMAGE_TIER),
            });
            ref.release?.();
          } catch {
            // best-effort — the tile loads it normally
          }
        }),
      );
    } catch {
      // best-effort — opening Following runs its own load
    } finally {
      pendingPrefetches.delete(userId);
    }
  })();
  pendingPrefetches.set(userId, run);
}

function FollowingItemTile({
  item,
  imageUrl,
  imageCacheKey,
  columnWidth,
  isNewest,
  onPress,
  onOwnerPress,
}: {
  item: FollowingItem;
  imageUrl: string | undefined;
  imageCacheKey: string | undefined;
  columnWidth: number;
  isNewest: boolean;
  onPress: () => void;
  onOwnerPress: () => void;
}) {
  const ownerName = item.owner_display_name || item.owner_username;
  // Player name leads; the item title (set/product) sits below it. Either
  // field may be missing — a lone value takes the lead line.
  const playerLine = item.player?.trim() || null;
  const titleLine = item.title?.trim() || null;
  const primaryLine = playerLine ?? titleLine ?? 'Untitled';
  const secondaryLine = playerLine ? titleLine : null;

  return (
    <TouchableOpacity
      style={[styles.tile, { width: columnWidth }, isNewest && styles.tileNewest]}
      onPress={onPress}
      activeOpacity={0.9}>
      <View style={styles.tileImageBox}>
        {imageUrl ? (
          // contentFit="contain", centered: the frame is the same fixed 3:4
          // box for every tile (TILE_MEDIA_ASPECT_RATIO), so the whole
          // collectible is always visible — a portrait card or comic fills
          // its height, a landscape photo or game box its width — with the
          // frame's own dark background showing in any leftover space. The
          // box never resizes to the photo. cacheKey (not the rotating
          // signed `imageUrl` alone) is what expo-image's own byte cache
          // keys on, per lib/private-image-cache-key.ts — keeps this image
          // stable across a background signed-URL re-sign, and lets it reuse
          // bytes already cached by another screen for the same photo.
          <Image
            source={{ uri: imageUrl, cacheKey: imageCacheKey }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            contentPosition="center"
            transition={200}
            cachePolicy="memory-disk"
          />
        ) : (
          // No glyph/spinner — tileImageBox's own dark backgroundColor
          // (PV2.collectorPanelBg, already close to the card's own
          // PV2.panel) already reads as a plain tile shell on its own; an
          // explicit "broken image" icon here is what previously drew
          // attention to the loading state instead of quietly blending in.
          // The real <Image> above fades in via `transition` once imageUrl
          // resolves — no separate crossfade needed here.
          <View style={StyleSheet.absoluteFill} />
        )}

        {isNewest && (
          <View style={styles.justAddedBadge}>
            <Text style={styles.justAddedText}>Just added</Text>
          </View>
        )}
      </View>

      <View style={styles.tileOwnerRow}>
        <TouchableOpacity style={styles.tileOwnerPress} onPress={onOwnerPress} activeOpacity={0.7} hitSlop={4}>
          <View style={styles.tileAvatar}>
            {item.owner_avatar_url ? (
              <Image source={{ uri: item.owner_avatar_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.tileAvatarPlaceholder]}>
                <Text style={styles.tileAvatarInitial}>{ownerName.charAt(0).toUpperCase()}</Text>
              </View>
            )}
          </View>
          <Text style={styles.tileOwnerName} numberOfLines={1}>
            {ownerName}
          </Text>
        </TouchableOpacity>
        <View style={styles.categoryPill}>
          <Text style={styles.categoryPillText}>{ITEM_TYPE_LABEL[item.item_type]}</Text>
        </View>
      </View>

      {/* Fixed height (tileTextBlock) whatever the text: player + title on
          one line each, or — when there is no player — the title alone,
          wrapping to at most two lines in the same space. */}
      <View style={styles.tileTextBlock}>
        {secondaryLine ? (
          <>
            <Text style={styles.tileTitle} numberOfLines={1}>
              {primaryLine}
            </Text>
            <Text style={styles.tileSubtitle} numberOfLines={1}>
              {secondaryLine}
            </Text>
          </>
        ) : (
          <Text style={[styles.tileTitle, styles.tileTitleTwoLine]} numberOfLines={2}>
            {primaryLine}
          </Text>
        )}
      </View>

      {/* Always rendered (fixed height) so a tile with no comments is the
          same height as one with comments; the count only shows when > 0. */}
      <View style={[styles.engagementRow, styles.engagementRowBelow]}>
        {item.commentCount > 0 && (
          <View style={styles.engagementStat}>
            <IconSymbol name="message" size={12} color={PV2.textTertiary} />
            <Text style={styles.engagementText}>{item.commentCount}</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

// Rows of placeholder tiles the skeleton shows while the first load runs.
const SKELETON_ROW_COUNT = 6;

// Approximate combined height of everything a real tile (FollowingItemTile)
// renders BELOW its image box — owner row, age, title, footer row, plus the
// tile's own marginBottom/border — so a skeleton tile's total height lines
// up with a real tile's, and content replacing the skeleton doesn't itself
// cause a further layout jump. Approximate on purpose (exact text-line
// heights vary with the system font-scale setting); close enough that the
// skeleton → content swap doesn't visibly reflow is the actual goal here,
// not pixel parity.
const SKELETON_META_HEIGHT = 118;

// Same per-row height estimate the skeleton itself uses (fixed media frame +
// SKELETON_META_HEIGHT's fixed footer) — reused here for a different
// purpose: figuring out how many items (in display order) a warm-cache
// remount needs to MOUNT UP FRONT to cover a previously-saved deep scroll
// position before `scrollTo` is called, so restoring scroll never
// snaps/jumps over a gap of not-yet-mounted content. Every row is the same
// height and holds two items, so this is whole rows × 2. Returns 0 for a
// non-positive target (nothing to cover — the ordinary top-of-feed case).
function countItemsToCoverOffset(items: FollowingItem[], columnWidth: number, targetHeight: number): number {
  if (targetHeight <= 0 || columnWidth <= 0) return 0;
  const rowHeight = columnWidth / TILE_MEDIA_ASPECT_RATIO + SKELETON_META_HEIGHT;
  return Math.min(items.length, Math.ceil(targetHeight / rowHeight) * 2);
}

function GridSkeleton({ columnWidth }: { columnWidth: number }) {
  const tileStyle = [
    styles.skeletonTile,
    { width: columnWidth, height: columnWidth / TILE_MEDIA_ASPECT_RATIO + SKELETON_META_HEIGHT },
  ];
  return (
    <View style={styles.grid}>
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, row) => (
        <View key={row} style={styles.gridRow}>
          <View style={tileStyle} />
          <View style={tileStyle} />
        </View>
      ))}
    </View>
  );
}

export function FollowingItemsFeed({
  currentUserId,
  onScroll,
  scrollEventThrottle,
}: {
  currentUserId: string | undefined;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollEventThrottle?: number;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // One-navigation-per-visit lock: a second tap (same tile, another tile, or
  // an avatar/username) that lands before the pushed screen has taken over is
  // ignored. Released when this screen regains focus (i.e. after coming back),
  // not by a timer.
  const navigatingRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      navigatingRef.current = false;
    }, []),
  );
  function navigateOnce(go: () => void) {
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    go();
  }

  // Moved up (still an ordinary unconditional hook call every render, so
  // this is safe) so columnWidth is available for the mountCount initializer
  // below, which needs it to estimate tile heights for scroll-position
  // coverage.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const columnWidth = (windowWidth - GRID_HORIZONTAL_PADDING * 2 - COLUMN_GAP) / 2;

  // Synchronous hydration from the session cache (see that type's own
  // comment above) — read once, up front, so the useState initializers just
  // below can seed real content on the very first render of a remounted
  // instance instead of the usual empty/loading defaults. Cheap (a single
  // Map.get); safe to recompute on every render even though only this
  // first-render value actually gets used by React (useState/useRef
  // initializers ignore later calls).
  const cachedSession = currentUserId ? followingFeedSessions.get(currentUserId) : undefined;

  const [items, setItems] = useState<FollowingItem[]>(() => cachedSession?.items ?? []);
  const [followedCount, setFollowedCount] = useState<number | null>(() =>
    cachedSession ? cachedSession.followedCount : null,
  );
  const [loading, setLoading] = useState(() => !cachedSession);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sort, setSort] = useState<'newest' | 'oldest'>(() => cachedSession?.sort ?? 'newest');

  // How many display-ordered items this screen actually MOUNTS right now —
  // the core of this pass's optimization. A cold/first load always starts
  // at INITIAL_VISIBLE_ITEM_COUNT (nothing to restore); a warm cached return
  // to the TOP of the feed does too, since 4 is already enough to cover a
  // scrollOffsetY of 0. A warm cached return to a DEEP scroll position needs
  // more than 4 mounted up front — otherwise there isn't enough real content
  // height to scroll to before `scrollTo` runs (see handleScrollViewLayout
  // below), which would either no-op or snap somewhere short of the real
  // saved position. countItemsToCoverOffset (defined above, mirrors the real
  // left/right masonry algorithm) estimates exactly how many are needed to
  // cover that saved offset plus one extra windowHeight of buffer, so the
  // user also sees real content immediately below the restored position
  // rather than a blank gap for the instant before the full-expansion effect
  // below fires. Number.POSITIVE_INFINITY is the "fully expanded" sentinel —
  // `displayItems.slice(0, mountCount)` below already returns the whole
  // array for it, so nothing needs to re-sync this to items.length later.
  const [mountCount, setMountCount] = useState<number>(() => {
    if (!cachedSession?.items.length) return INITIAL_VISIBLE_ITEM_COUNT;
    const needed = countItemsToCoverOffset(
      cachedSession.items,
      columnWidth,
      cachedSession.scrollOffsetY + windowHeight,
    );
    return Math.max(INITIAL_VISIBLE_ITEM_COUNT, Math.min(needed, cachedSession.items.length));
  });

  // Expands mountCount to the full list exactly once per mount, once the JS
  // thread goes idle after the critical first frame — never on an arbitrary
  // timer. This is what keeps the critical first frame (React element
  // creation + expo-image mount/decode for however many tiles are
  // requested) down to just the initial mountCount above, while still
  // showing everything a moment later with no visible extra delay.
  // requestIdleCallback/cancelIdleCallback are globally polyfilled by React
  // Native itself (react-native/Libraries/Core/setUpTimers.js) — no extra
  // dependency. requestIdleCallback returns a numeric handle, same as
  // setTimeout/setInterval, which cancelIdleCallback takes to cancel a
  // still-pending callback — mirrored below exactly like this file's other
  // effects already cancel their own pending work on cleanup.
  useEffect(() => {
    const handle = requestIdleCallback(() => {
      setMountCount(Number.POSITIVE_INFINITY);
    });
    return () => cancelIdleCallback(handle);
    // Deliberately mount-once ([]) — this screen fully remounts on every
    // feedMode toggle (see FollowingFeedSession's own comment), so "once per
    // mount" already means "once per tab switch back to Following."
  }, []);

  const controllerRef = useRef<AbortController | null>(null);
  // Mirrors `items` without forcing `load` to depend on it (which would
  // otherwise recreate `load` on every items change) — read inside `load`
  // for the 'refresh'/'background' carry-over below, always the latest
  // value regardless of when a given `load` closure was created.
  const itemsRef = useRef<FollowingItem[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' | 'background') => {
      if (!currentUserId) {
        setItems([]);
        setFollowedCount(0);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else if (mode === 'refresh') setRefreshing(true);

      // A background preparation (prefetchFollowingFeed) is already fetching
      // exactly this: wait for it rather than duplicating its queries, and
      // use its snapshot if it produced one. If it failed, fall through to
      // the normal load.
      const pendingPrefetch = mode === 'initial' ? pendingPrefetches.get(currentUserId) : undefined;
      if (pendingPrefetch) {
        await pendingPrefetch;
        if (controllerRef.current !== controller || controller.signal.aborted) return;
        const prepared = followingFeedSessions.get(currentUserId);
        if (prepared) {
          setItems(prepared.items);
          setFollowedCount(prepared.followedCount);
          setLoadError(null);
          setLoading(false);
          controllerRef.current = null;
          return;
        }
      }
      // 'background': no loading/refreshing flag at all — a stale-cache
      // quiet refresh must never blank or re-skeleton content that's
      // already correctly on screen.

      let rows: LoadRowsResult;
      try {
        rows = await queryFollowingItemRows(currentUserId, controller.signal);
      } catch (e) {
        if (controller.signal.aborted || controllerRef.current !== controller) return;
        console.error('[FollowingItemsFeed] rows load failed:', e);
        // A failed background refresh must never surface the full-screen
        // error state over content that's already showing successfully —
        // just log it and leave the existing (still valid, if aging) cached
        // content exactly as it was.
        if (mode !== 'background') {
          setLoadError(e instanceof Error ? e.message : 'Failed to load Following feed.');
        }
        controllerRef.current = null;
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (controllerRef.current !== controller || controller.signal.aborted) return;

      // Complete tiles (image id + owner) from the one request above — the
      // grid paints and its priority images start signing now. Only the
      // comment count follows; a refresh carries each still-present item's
      // known count forward so it never flickers back to 0 meanwhile.
      const previousCounts = new Map(itemsRef.current.map((i) => [i.id, i.commentCount] as const));
      setItems(rows.items.map((item) => ({ ...item, commentCount: previousCounts.get(item.id) ?? 0 })));
      setFollowedCount(rows.followedCount);
      setLoadError(null);
      setLoading(false);
      setRefreshing(false);
      updateSessionSnapshot(currentUserId, { fetchedAt: Date.now() });

      if (!rows.items.length) {
        controllerRef.current = null;
        return;
      }

      try {
        const commentCounts = await queryFollowingCommentCounts(
          rows.items.map((i) => i.id),
          controller.signal,
        );
        if (controllerRef.current === controller && !controller.signal.aborted) {
          setItems((prev) => prev.map((item) => ({ ...item, commentCount: commentCounts.get(item.id) ?? 0 })));
        }
      } catch (e) {
        if (!controller.signal.aborted && controllerRef.current === controller) {
          console.error('[FollowingItemsFeed] comment counts load failed:', e);
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [currentUserId],
  );

  useEffect(() => {
    // cachedSession is fresh: state above was already hydrated synchronously
    // from it via the useState initializers — nothing to fetch, no network
    // activity, no skeleton. Stale (or no cache at all): fetch, but only
    // show the full-screen skeleton when there was truly nothing cached to
    // show in the meantime ('initial'); a stale cache still renders
    // immediately and refreshes quietly behind it ('background').
    const isFresh = cachedSession && Date.now() - cachedSession.fetchedAt < FOLLOWING_FEED_FRESHNESS_MS;
    if (!isFresh) {
      // Mount/user-change data fetch — load's synchronous loading-flag
      // setState is the intended "start fetching" transition, not a derived
      // state sync, so the set-state-in-effect rule doesn't apply here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      load(cachedSession ? 'background' : 'initial');
    }
    return () => controllerRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  // Keeps the session cache's items/followedCount/sort in sync with every
  // state change (including a mid-pipeline partial update, so even an
  // interrupted load leaves SOMETHING useful cached) — fetchedAt and
  // scrollOffsetY are deliberately NOT touched here (see updateSessionSnapshot
  // itself): the former only advances on an actual successful rows fetch
  // (set directly in `load` above), the latter only from the scroll handler
  // below, neither of which should be reset just because a render happened.
  useEffect(() => {
    if (!currentUserId) return;
    updateSessionSnapshot(currentUserId, { items, followedCount: followedCount ?? 0, sort });
  }, [currentUserId, items, followedCount, sort]);

  // Same identity useSignedItemImages itself keys its cache by — reused here
  // only to build each priority tile's stable expo-image cacheKey (see
  // lib/private-image-cache-key.ts).
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';

  // items is always fetched newest-first (see queryFollowingItemRows's own
  // .order) regardless of the user-facing `sort` toggle below — this is
  // what "the newest item" means for the Just Added badge, independent of
  // which order the grid currently displays.
  const newestItemId = items[0]?.id ?? null;

  const displayItems = useMemo(() => (sort === 'oldest' ? [...items].reverse() : items), [items, sort]);

  // The actual set of items this render MOUNTS tiles for — see mountCount's
  // own comment above. Everything downstream (masonry assignment, image
  // priority/background split, warmup) is deliberately driven off THIS, not
  // `displayItems`, so an item beyond mountCount doesn't just skip having a
  // <FollowingItemTile/> — it also doesn't get a signed-URL request fired
  // for it yet. That request naturally starts the moment mountCount expands
  // (its id list changes identity, which is useSignedItemImages' own effect
  // dependency), so nothing is ever silently skipped, only deferred.
  const mountedDisplayItems = useMemo(
    () => (mountCount >= displayItems.length ? displayItems : displayItems.slice(0, mountCount)),
    [displayItems, mountCount],
  );

  // PRIORITY / BACKGROUND split for time-to-first-visible-image: two
  // separate useSignedItemImages calls instead of one call over all mounted
  // ids. The hook internally chunks whatever id list it's given into
  // batches of (at most) 50 — but chunks a single call by ALPHABETICALLY
  // SORTED id, not display order, so "the first tiles on screen" were never
  // actually the ones landing in the faster first batch. Slicing
  // mountedDisplayItems (this grid's real, already newest-first render
  // order, further bounded to what's actually mounted right now) BEFORE
  // handing ids to the hook guarantees the on-screen items get their own
  // small, fast batch. Both calls read/write the hook's same shared
  // module-level cache (keyed by identity+imageId) and the two id lists are
  // disjoint by construction, so this never double-fetches an id — it only
  // changes which batch an id lands in.
  const priorityImageIds = useMemo(
    () => mountedDisplayItems.slice(0, INITIAL_VISIBLE_ITEM_COUNT).map((i) => i.primary_image_id),
    [mountedDisplayItems],
  );
  const backgroundImageIds = useMemo(
    () => mountedDisplayItems.slice(INITIAL_VISIBLE_ITEM_COUNT).map((i) => i.primary_image_id),
    [mountedDisplayItems],
  );
  const { urls: priorityUrls, servedTiers: priorityServedTiers } = useSignedItemImages(
    priorityImageIds,
    FOLLOWING_IMAGE_TIER,
  );
  const { urls: backgroundUrls, servedTiers: backgroundServedTiers } = useSignedItemImages(
    backgroundImageIds,
    FOLLOWING_IMAGE_TIER,
  );
  // If the server fell back to the original for an image, key expo-image's
  // cache on the tier actually served, never on 'preview' — otherwise
  // full-size bytes would be cached under the preview identity.
  const servedTierOf = (imageId: string): ImageTier =>
    priorityServedTiers.get(imageId) ?? backgroundServedTiers.get(imageId) ?? FOLLOWING_IMAGE_TIER;

  // Bounded byte-cache warmup (components/images/private-image-warmup.tsx),
  // scoped to the priority set only — same convention as
  // ProfileV2ItemsGrid's own warmup, never a raw Image.prefetch() (no
  // cacheKey option there; it would warm a cache bucket the real tiles
  // below, which read by cacheKey, don't use).
  const priorityWarmupEntries = useMemo(
    () =>
      mountedDisplayItems.slice(0, INITIAL_VISIBLE_ITEM_COUNT).flatMap((item) => {
        const imageId = item.primary_image_id;
        const uri = imageId ? priorityUrls.get(imageId) : undefined;
        if (!imageId || !uri) return [];
        return [
          {
            id: imageId,
            uri,
            cacheKey: itemImageCacheKey(identity, imageId, priorityServedTiers.get(imageId) ?? FOLLOWING_IMAGE_TIER),
          },
        ];
      }),
    [mountedDisplayItems, priorityUrls, priorityServedTiers, identity],
  );

  const newItemsTodayCount = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return items.filter((i) => new Date(i.created_at) >= startOfToday).length;
  }, [items]);

  // Two tiles per row, in display order (left, right, left, right…) — the
  // same order the old shortest-column-first split produced once every tile
  // is the same height, but laid out as real rows so tiles always line up
  // horizontally.
  const { rows, itemTops } = useMemo(() => {
    const rows: FollowingItem[][] = [];
    // Estimated top (px, within the grid) of each tile, by display index —
    // for the detail warmup's "what's on screen" only; never affects layout.
    const itemTops: number[] = [];
    const rowPx = columnWidth / TILE_MEDIA_ASPECT_RATIO + TILE_CHROME_ESTIMATE;
    mountedDisplayItems.forEach((item, index) => {
      const rowIndex = Math.floor(index / 2);
      if (index % 2 === 0) rows.push([item]);
      else rows[rowIndex].push(item);
      itemTops.push(rowIndex * rowPx);
    });
    return { rows, itemTops };
  }, [mountedDisplayItems, columnWidth]);

  // Detail warmup window (see DETAIL_WARM_* above). warmUntil only ever
  // grows: the first DETAIL_WARM_INITIAL on entry, then "everything on
  // screen + the next row" as the user scrolls (updateWarmUntil, from the
  // scroll handler). Only the newest DETAIL_WARM_WINDOW of those are signed
  // and mounted at a time.
  const [warmUntil, setWarmUntil] = useState(DETAIL_WARM_INITIAL);
  const warmUntilRef = useRef(DETAIL_WARM_INITIAL);
  const gridTopRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const updateWarmUntil = useCallback(
    (scrollY: number) => {
      const visibleBottom = scrollY + viewportHeightRef.current - gridTopRef.current;
      let lastVisible = -1;
      itemTops.forEach((top, index) => {
        if (top < visibleBottom) lastVisible = index;
      });
      const target = lastVisible + 1 + DETAIL_WARM_AHEAD;
      if (target > warmUntilRef.current) {
        warmUntilRef.current = target;
        setWarmUntil(target);
      }
    },
    [itemTops],
  );
  const detailWarmImageIds = useMemo(
    () =>
      displayItems
        .slice(Math.max(0, warmUntil - DETAIL_WARM_WINDOW), warmUntil)
        .map((i) => i.primary_image_id)
        .filter((id): id is string => !!id),
    [displayItems, warmUntil],
  );
  // Same identity, tier and cache as Item Detail's own hero request, so
  // opening a warmed item reuses this signed URL instead of signing again.
  const { urls: detailWarmUrls, servedTiers: detailWarmServedTiers } = useSignedItemImages(
    detailWarmImageIds,
    DETAIL_IMAGE_TIER,
  );
  const detailWarmupEntries = useMemo(
    () =>
      detailWarmImageIds.map((imageId) => ({
        id: imageId,
        uri: detailWarmUrls.get(imageId),
        // Exactly the key Item Detail's hero uses (app/item/[id].tsx).
        cacheKey: itemImageCacheKey(identity, imageId, DETAIL_IMAGE_TIER, detailWarmServedTiers),
      })),
    [detailWarmImageIds, detailWarmUrls, detailWarmServedTiers, identity],
  );

  function handleSortPress() {
    Alert.alert('Sort by', undefined, [
      { text: 'Newest', onPress: () => setSort('newest') },
      { text: 'Oldest', onPress: () => setSort('oldest') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  // Scroll-position preservation — same session cache as items/sort above,
  // not persistent storage. cachedScrollOffsetRef is captured once, at
  // mount, from whatever was last recorded for this user (0 for a genuinely
  // fresh session); didRestoreScrollRef guards the one-shot scrollTo below
  // so it never fires again after the initial restore, e.g. on a later
  // relayout. Restoring on the ScrollView's own onLayout (not a plain
  // useEffect) because content height here is fully deterministic from
  // already-hydrated item data at first render (tile heights never depend
  // on image load — see TILE_MEDIA_ASPECT_RATIO), so by the time the
  // native layout pass completes, the content is already tall enough to
  // scroll to the cached offset.
  const scrollViewRef = useRef<ScrollView>(null);
  const cachedScrollOffsetRef = useRef(cachedSession?.scrollOffsetY ?? 0);
  const didRestoreScrollRef = useRef(false);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onScroll?.(event);
      if (currentUserId) {
        updateSessionSnapshot(currentUserId, { scrollOffsetY: event.nativeEvent.contentOffset.y });
      }
      updateWarmUntil(event.nativeEvent.contentOffset.y);
    },
    [onScroll, currentUserId, updateWarmUntil],
  );

  function handleScrollViewLayout(event: LayoutChangeEvent) {
    viewportHeightRef.current = event.nativeEvent.layout.height;
    if (!didRestoreScrollRef.current && cachedScrollOffsetRef.current > 0) {
      didRestoreScrollRef.current = true;
      scrollViewRef.current?.scrollTo({ y: cachedScrollOffsetRef.current, animated: false });
    }
  }

  function renderTile(item: FollowingItem) {
    const imageId = item.primary_image_id;
    const imageUrl = imageId ? (priorityUrls.get(imageId) ?? backgroundUrls.get(imageId)) : undefined;
    return (
      <FollowingItemTile
        key={item.id}
        item={item}
        imageUrl={imageUrl}
        imageCacheKey={imageId ? itemImageCacheKey(identity, imageId, servedTierOf(imageId)) : undefined}
        columnWidth={columnWidth}
        isNewest={item.id === newestItemId}
        onPress={() =>
          navigateOnce(() => {
            prefetchItemDetailImages([item.primary_image_id]);
            router.push({ pathname: '/item/[id]', params: { id: item.id } });
          })
        }
        onOwnerPress={() =>
          navigateOnce(() => navigateToProfile(router, currentUserId, item.user_id, item.owner_username))
        }
      />
    );
  }

  const bottomPadding = TAB_BAR_HEIGHT + insets.bottom + 24;

  return (
    <ScrollView
      ref={scrollViewRef}
      style={styles.container}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomPadding }]}
      onScroll={handleScroll}
      onLayout={handleScrollViewLayout}
      scrollEventThrottle={scrollEventThrottle}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('refresh')} tintColor={PV2.link} />}>
      <View style={styles.introBlock}>
        <Text
          style={styles.introTitle}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.85}>
          Fresh uploads from collectors you follow
        </Text>
        <View style={styles.introMetaRow}>
          <View style={styles.introMetaLeft}>
            <IconSymbol name="person.2.fill" size={14} color={PV2.textTertiary} />
            <Text style={styles.introMetaText}>
              {newItemsTodayCount} new item{newItemsTodayCount === 1 ? '' : 's'} today
            </Text>
          </View>
          <TouchableOpacity onPress={handleSortPress} style={styles.sortBtn} hitSlop={8}>
            <Text style={styles.sortBtnText}>Sort</Text>
            <IconSymbol name="chevron.right" size={12} color={PV2.textSecondary} style={styles.sortChevron} />
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <GridSkeleton columnWidth={columnWidth} />
      ) : loadError && items.length === 0 ? (
        <View style={styles.center}>
          <CacheCaseLogo variant="icon" size="lg" placement="emptyState" />
          <Text style={styles.emptyTitle}>Couldn&apos;t load your Following feed</Text>
          <Text style={styles.emptyBody}>{loadError}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => load('initial')}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : followedCount === 0 ? (
        <View style={styles.center}>
          <CacheCaseLogo variant="icon" size="lg" placement="emptyState" />
          <Text style={styles.emptyTitle}>Your Following feed is empty</Text>
          <Text style={styles.emptyBody}>Follow collectors to see their latest additions here.</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => router.push('/(tabs)/search')}>
            <Text style={styles.retryButtonText}>Find collectors</Text>
          </TouchableOpacity>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <CacheCaseLogo variant="icon" size="lg" placement="emptyState" />
          <Text style={styles.emptyTitle}>No recent uploads</Text>
          <Text style={styles.emptyBody}>New items from collectors you follow will show up here.</Text>
        </View>
      ) : (
        <View
          style={styles.grid}
          onLayout={(event) => {
            gridTopRef.current = event.nativeEvent.layout.y;
          }}>
          {/* Absolutely positioned/invisible (see PrivateImageWarmup itself) —
              never participates in this View's own layout. */}
          <PrivateImageWarmup entries={priorityWarmupEntries} />
          {/* Item Detail hero warmup — see DETAIL_WARM_* above. */}
          <PrivateImageWarmup entries={detailWarmupEntries} />
          {rows.map((row, rowIndex) => (
            <View key={rowIndex} style={styles.gridRow}>
              {row.map((item) => renderTile(item))}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const MINT_ACCENT = '#74F5C8'; // app/(tabs)/_layout.tsx's own Home-tab mint/green — not yet a PV2 token.

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  scrollContent: {
    paddingTop: 14,
  },
  introBlock: {
    paddingHorizontal: GRID_HORIZONTAL_PADDING + 4,
    marginBottom: 14,
  },
  // 20 → 17 (modest fixed reduction) so "Fresh uploads from collectors you
  // follow" fits on one line at this block's own horizontal padding on
  // iPhone-sized screens. adjustsFontSizeToFit/minimumFontScale on the Text
  // itself (below) is a safety net only — for a narrower device (e.g.
  // iPhone SE) or a larger system font-size setting, not the primary sizing
  // mechanism.
  introTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  introMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  introMetaLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  introMetaText: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
  sortBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: PV2.border,
    backgroundColor: PV2.collectorPanelBg,
  },
  sortBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  sortChevron: {
    transform: [{ rotate: '90deg' }],
  },
  grid: {
    paddingHorizontal: GRID_HORIZONTAL_PADDING,
  },
  // One row of two equal tiles. Default alignItems 'stretch' keeps both
  // tiles in a row the same height even if text scaling ever differs.
  gridRow: {
    flexDirection: 'row',
    gap: COLUMN_GAP,
  },
  tile: {
    marginBottom: 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  // Subtle mint outline/glow only — deliberately no gradient border, per
  // the explicit "not a large purple/pink gradient border" direction.
  tileNewest: {
    borderColor: 'rgba(116,245,200,0.55)',
    shadowColor: MINT_ACCENT,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 3,
  },
  tileImageBox: {
    width: '100%',
    aspectRatio: TILE_MEDIA_ASPECT_RATIO,
    backgroundColor: PV2.collectorPanelBg,
  },
  justAddedBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(10,10,15,0.75)',
    borderWidth: 1,
    borderColor: MINT_ACCENT,
  },
  justAddedText: {
    fontSize: 10,
    fontWeight: '700',
    color: MINT_ACCENT,
  },
  tileOwnerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  tileOwnerPress: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  tileAvatar: {
    width: 18,
    height: 18,
    borderRadius: 9,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    flexShrink: 0,
  },
  tileAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileAvatarInitial: {
    fontSize: 10,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  tileOwnerName: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  // Left: the tile's 8px gutter + a 10px inset, so player/set text sits
  // slightly right of the avatar row. Right stays at the plain 8px gutter.
  tileTextBlock: {
    paddingLeft: 18,
    paddingRight: 8,
    paddingBottom: 8,
  },
  tileSubtitle: {
    fontSize: 12,
    lineHeight: 16,
    height: 16,
    marginTop: 2,
    color: PV2.textSecondary,
  },
  tileTitle: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
    height: 18,
    color: PV2.textPrimary,
    marginTop: 3,
  },
  // Title alone (no player line): up to two lines in the same space the
  // title + subtitle pair occupies (18 + 2 + 16 + 3px margin = 39 = 36 + 3).
  tileTitleTwoLine: {
    height: 36,
  },
  categoryPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  categoryPillText: {
    fontSize: 10,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  engagementRowBelow: {
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  // Fixed height: reserved on every tile, comments or not.
  engagementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 14,
  },
  engagementStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  engagementText: {
    fontSize: 11,
    color: PV2.textTertiary,
  },
  skeletonTile: {
    borderRadius: 12,
    backgroundColor: PV2.emptyCardBg,
    marginBottom: 16,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    paddingTop: 60,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: PV2.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    marginTop: 16,
    backgroundColor: PV2.accentSoft,
    borderWidth: 1,
    borderColor: PV2.accent,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  retryButtonText: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
});
