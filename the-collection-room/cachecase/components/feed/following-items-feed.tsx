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
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PrivateImageWarmup } from '@/components/images/private-image-warmup';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAuth } from '@/lib/auth';
import { attachPrimaryImageIds } from '@/lib/item-images';
import type { ImageTier } from '@/lib/image-tiers';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';
import { navigateToProfile } from '@/lib/profile-navigation';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
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
// these four values (supabase/migrations/20260916120000_add_collection_
// item_type.sql's own CHECK constraint). There is no "games/consoles"
// category anywhere in the schema, so none is invented here despite one
// appearing in the design reference mockup.
const ITEM_TYPE_LABEL: Record<CollectibleItemType, string> = {
  sports_card: 'Cards',
  pokemon: 'Pokémon',
  figurine: 'Figures',
  comic_book: 'Comics',
};

// Default aspect ratio (width / height) per category — the SOLE source of a
// tile's outer height, both (a) the masonry column-assignment heuristic and
// (b) the image box's own `aspectRatio` style. Deliberately never replaced
// by a real measurement (e.g. RNImage.getSize) once the photo loads: this
// screen's masonry columns lay out every tile immediately from these fixed
// values, so an outer height that later changed post-measurement would
// reflow the column underneath it after first paint. The photo itself is
// center-cropped to fill this fixed box via `contentFit="cover"` (see
// FollowingItemTile) rather than being letterboxed inside it.
const TYPE_DEFAULT_ASPECT_RATIO: Record<CollectibleItemType, number> = {
  sports_card: 0.7,
  pokemon: 0.7,
  comic_book: 0.64,
  figurine: 0.82,
};

const MIN_TILE_ASPECT_RATIO = 0.45;
const MAX_TILE_ASPECT_RATIO = 1.6;

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

// Following tiles are small (roughly half-screen-wide) previews, so they
// request the ~500px 'preview' representation (see lib/image-tiers.ts)
// instead of the full-resolution original. Used for BOTH the signed-URL
// requests and every cacheKey below so a preview never shares an identity
// with the same image's original.
const FOLLOWING_IMAGE_TIER: ImageTier = 'preview';

function clampTileAspectRatio(ratio: number): number {
  return Math.min(MAX_TILE_ASPECT_RATIO, Math.max(MIN_TILE_ASPECT_RATIO, ratio));
}

// "2m ago" / "3h ago" / "1d ago" per the design spec — distinct from this
// app's other formatAge variants (e.g. app/post/[id].tsx's, which drops to
// an absolute "MMM d" date beyond a day) since this screen's own reference
// explicitly calls for a relative "Xd ago" step first. Falls back to an
// absolute date only past a week, matching the general convention that a
// relative age stops being useful after that.
function formatAge(iso: string): string {
  const diffSeconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diffSeconds < 3600) return `${Math.max(1, Math.floor(diffSeconds / 60))}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  if (diffSeconds < 7 * 86400) return `${Math.floor(diffSeconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

type FollowingItem = {
  id: string;
  title: string | null;
  item_type: CollectibleItemType;
  created_at: string;
  user_id: string;
  primary_image_id: string | null;
  owner_username: string;
  owner_display_name: string | null;
  owner_avatar_url: string | null;
  likeCount: number;
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

type ItemRow = { id: string; title: string | null; item_type: string | null; created_at: string; user_id: string };
type LoadRowsResult = { followedCount: number; itemRows: ItemRow[] };

// Phase 1 — ONLY the item rows themselves (plus the follows lookup they
// depend on). Deliberately does not resolve primary image ids, owner
// profiles, or like/comment counts here — every one of those is a separate,
// independently-timed step kicked off by the caller once this resolves (see
// `load` below), so a tile's title/category/age/owner-placeholder can paint
// the instant this one query settles, and image-id/signed-URL resolution for
// the first screen isn't stuck behind resolving image ids for all 60 items
// first.
async function queryFollowingItemRows(currentUserId: string, signal: AbortSignal): Promise<LoadRowsResult> {
  const { data: followRows, error: followError } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', currentUserId)
    .abortSignal(signal);

  if (followError) {
    if (!signal.aborted) console.error('[FollowingItemsFeed] follows query failed:', followError.message);
    throw followError;
  }

  const followedIds = [...new Set((followRows ?? []).map((f: any) => f.following_id as string))];
  if (!followedIds.length) return { followedCount: 0, itemRows: [] };

  const { data: itemRows, error: itemsError } = await supabase
    .from('collection_items')
    .select('id, title, item_type, created_at, user_id')
    .in('user_id', followedIds)
    .eq('is_public', true)
    .eq('collection_status', 'active')
    .order('created_at', { ascending: false })
    .limit(FOLLOWING_ITEMS_LIMIT)
    .abortSignal(signal);

  if (itemsError) {
    if (!signal.aborted) console.error('[FollowingItemsFeed] items query failed:', itemsError.message);
    throw itemsError;
  }

  return { followedCount: followedIds.length, itemRows: (itemRows ?? []) as ItemRow[] };
}

// owner_username/'user', null display name/avatar, zero counts, null
// primary_image_id — every one of those is filled in later by a separate,
// independently-timed step (queryFollowingItemsMeta, or the priority/
// background attachPrimaryImageIds calls in `load` below); a tile never
// regresses from real data back to a fallback once filled in.
//
// `previousById`, when passed, carries forward an already-resolved item's
// image id/owner/engagement fields instead of resetting them to those
// fallbacks — used by a 'refresh'/'background' reload (see `load` below) so
// re-fetching the row list doesn't itself blank out photos/metadata that
// were already showing correctly a moment ago; a genuinely new id (not in
// `previousById`) still starts from the normal placeholder fallbacks and
// resolves through the pipeline exactly like a first load.
function buildShellItems(itemRows: ItemRow[], previousById?: Map<string, FollowingItem>): FollowingItem[] {
  return itemRows.map((row) => {
    const prev = previousById?.get(row.id);
    return {
      id: row.id,
      title: row.title ?? null,
      item_type: (row.item_type ?? 'sports_card') as CollectibleItemType,
      created_at: row.created_at,
      user_id: row.user_id,
      primary_image_id: prev?.primary_image_id ?? null,
      owner_username: prev?.owner_username ?? 'user',
      owner_display_name: prev?.owner_display_name ?? null,
      owner_avatar_url: prev?.owner_avatar_url ?? null,
      likeCount: prev?.likeCount ?? 0,
      commentCount: prev?.commentCount ?? 0,
    };
  });
}

// Merges a batch of attachPrimaryImageIds results into existing items state
// by id — used for both the PRIORITY and BACKGROUND primary-image-id passes
// in `load` below, each of which only resolves a slice of the full item
// list, so this only ever touches the ids present in `resolved`.
function mergePrimaryImageIds(
  items: FollowingItem[],
  resolved: { id: string; primary_image_id: string | null }[],
): FollowingItem[] {
  const byId = new Map(resolved.map((r) => [r.id, r.primary_image_id]));
  return items.map((item) => (byId.has(item.id) ? { ...item, primary_image_id: byId.get(item.id) ?? null } : item));
}

type FollowingItemsMeta = {
  profileMap: Map<string, { username?: string; display_name?: string; hero_display_name?: string; avatar_url?: string }>;
  likeCountMap: Map<string, number>;
  commentCountMap: Map<string, number>;
};

// Phase 2 — owner profiles plus item_likes/item_comments counts
// (supabase/migrations/20260923120000_create_item_social.sql), the same
// three already-batched, already-parallel queries the old single-phase
// version ran, just no longer blocking the grid's first paint. Counts only;
// no per-item "did I like this" lookup, since these tiles render a
// read-only count, not a tappable like toggle.
async function queryFollowingItemsMeta(
  ownerIds: string[],
  itemIds: string[],
  signal: AbortSignal,
): Promise<FollowingItemsMeta> {
  const [profilesRes, likesRes, commentsRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, username, display_name, hero_display_name, avatar_url')
      .in('id', ownerIds)
      .abortSignal(signal),
    supabase.from('item_likes').select('item_id').in('item_id', itemIds).abortSignal(signal),
    supabase.from('item_comments').select('item_id').in('item_id', itemIds).abortSignal(signal),
  ]);

  const profileMap = new Map((profilesRes.data ?? []).map((p: any) => [p.id, p]));

  const likeCountMap = new Map<string, number>();
  for (const row of (likesRes.data ?? []) as any[]) {
    likeCountMap.set(row.item_id, (likeCountMap.get(row.item_id) ?? 0) + 1);
  }
  const commentCountMap = new Map<string, number>();
  for (const row of (commentsRes.data ?? []) as any[]) {
    commentCountMap.set(row.item_id, (commentCountMap.get(row.item_id) ?? 0) + 1);
  }

  return { profileMap, likeCountMap, commentCountMap };
}

function FollowingItemTile({
  item,
  imageUrl,
  imageCacheKey,
  columnWidth,
  isNewest,
  onPress,
  onOwnerPress,
  onMorePress,
}: {
  item: FollowingItem;
  imageUrl: string | undefined;
  imageCacheKey: string | undefined;
  columnWidth: number;
  isNewest: boolean;
  onPress: () => void;
  onOwnerPress: () => void;
  onMorePress: () => void;
}) {
  // Fixed at mount from the category table — never reassigned from a real
  // image measurement (see TYPE_DEFAULT_ASPECT_RATIO's own comment) so the
  // outer tile height, and therefore the column layout underneath it, is
  // stable from first render instead of jumping once the image resolves.
  const ratio = clampTileAspectRatio(TYPE_DEFAULT_ASPECT_RATIO[item.item_type]);
  const ownerName = item.owner_display_name || item.owner_username;

  return (
    <TouchableOpacity
      style={[styles.tile, { width: columnWidth }, isNewest && styles.tileNewest]}
      onPress={onPress}
      activeOpacity={0.9}>
      <View style={[styles.tileImageBox, { aspectRatio: ratio }]}>
        {imageUrl ? (
          // contentFit="cover", not "contain": the shell's aspectRatio is a
          // fixed category default rather than this photo's real ratio, so a
          // mismatched photo is center-cropped to fill the stable box rather
          // than letterboxed inside it — the box itself never resizes to
          // accommodate the photo either way. cacheKey (not the rotating
          // signed `imageUrl` alone) is what expo-image's own byte cache
          // keys on, per lib/private-image-cache-key.ts — keeps this image
          // stable across a background signed-URL re-sign, and lets it reuse
          // bytes already cached by another screen for the same photo.
          <Image
            source={{ uri: imageUrl, cacheKey: imageCacheKey }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
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

        <TouchableOpacity
          onPress={onMorePress}
          hitSlop={8}
          style={styles.tileMoreBtn}
          accessibilityRole="button"
          accessibilityLabel="Item options">
          <IconSymbol name="ellipsis" size={16} color="#fff" />
        </TouchableOpacity>

        {isNewest && (
          <View style={styles.justAddedBadge}>
            <Text style={styles.justAddedText}>Just added</Text>
          </View>
        )}
      </View>

      <TouchableOpacity style={styles.tileOwnerRow} onPress={onOwnerPress} activeOpacity={0.7} hitSlop={4}>
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

      <Text style={styles.tileAge}>{formatAge(item.created_at)}</Text>
      <Text style={styles.tileTitle} numberOfLines={1}>
        {item.title || 'Untitled'}
      </Text>

      <View style={styles.tileFooterRow}>
        <View style={styles.categoryPill}>
          <Text style={styles.categoryPillText}>{ITEM_TYPE_LABEL[item.item_type]}</Text>
        </View>

        {(item.likeCount > 0 || item.commentCount > 0) && (
          <View style={styles.engagementRow}>
            {item.likeCount > 0 && (
              <View style={styles.engagementStat}>
                <IconSymbol name="heart.fill" size={12} color={PV2.textTertiary} />
                <Text style={styles.engagementText}>{item.likeCount}</Text>
              </View>
            )}
            {item.commentCount > 0 && (
              <View style={styles.engagementStat}>
                <IconSymbol name="message" size={12} color={PV2.textTertiary} />
                <Text style={styles.engagementText}>{item.commentCount}</Text>
              </View>
            )}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

// Cycled (not chosen per-item — no real items exist yet) through this
// screen's actual category aspect ratios rather than arbitrary numbers, so
// the skeleton's own masonry hinting already matches what real tiles will
// render at.
const SKELETON_ASPECT_RATIOS = [
  TYPE_DEFAULT_ASPECT_RATIO.sports_card,
  TYPE_DEFAULT_ASPECT_RATIO.figurine,
  TYPE_DEFAULT_ASPECT_RATIO.comic_book,
  TYPE_DEFAULT_ASPECT_RATIO.pokemon,
  TYPE_DEFAULT_ASPECT_RATIO.figurine,
  TYPE_DEFAULT_ASPECT_RATIO.sports_card,
];

// Approximate combined height of everything a real tile (FollowingItemTile)
// renders BELOW its image box — owner row, age, title, footer row, plus the
// tile's own marginBottom/border — so a skeleton tile's total height lines
// up with a real tile's, and content replacing the skeleton doesn't itself
// cause a further layout jump. Approximate on purpose (exact text-line
// heights vary with the system font-scale setting); close enough that the
// skeleton → content swap doesn't visibly reflow is the actual goal here,
// not pixel parity.
const SKELETON_META_HEIGHT = 118;

// Same per-tile height estimate the skeleton itself uses (aspect-ratio-driven
// image box + SKELETON_META_HEIGHT's fixed footer) — reused here for a
// different purpose: figuring out how many items (in display order) a
// warm-cache remount needs to MOUNT UP FRONT to cover a previously-saved
// deep scroll position before `scrollTo` is called, so restoring scroll
// never snaps/jumps over a gap of not-yet-mounted content. Mirrors the real
// left/right masonry-assignment algorithm below (shortest-column-first) so
// the estimate reflects how tall the shorter column actually gets, not just
// a flat per-item average. Returns 0 for a non-positive target (nothing to
// cover — the ordinary top-of-feed case).
function countItemsToCoverOffset(items: FollowingItem[], columnWidth: number, targetHeight: number): number {
  if (targetHeight <= 0 || columnWidth <= 0) return 0;
  let leftHeight = 0;
  let rightHeight = 0;
  let count = 0;
  for (const item of items) {
    if (Math.min(leftHeight, rightHeight) >= targetHeight) break;
    const ratio = clampTileAspectRatio(TYPE_DEFAULT_ASPECT_RATIO[item.item_type]);
    const tileHeight = columnWidth / ratio + SKELETON_META_HEIGHT;
    if (leftHeight <= rightHeight) leftHeight += tileHeight;
    else rightHeight += tileHeight;
    count++;
  }
  return count;
}

function GridSkeleton({ columnWidth }: { columnWidth: number }) {
  return (
    <View style={styles.gridRow}>
      {[0, 1].map((col) => (
        <View key={col} style={{ width: columnWidth }}>
          {SKELETON_ASPECT_RATIOS.map((ratio, i) => (
            <View
              key={i}
              style={[
                styles.skeletonTile,
                { width: columnWidth, height: columnWidth / ratio + SKELETON_META_HEIGHT },
              ]}
            />
          ))}
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      // Phase 1 done — tile shells (title/category/age/owner-placeholder)
      // are ready to paint now, BEFORE any primary image id has even been
      // looked up. Stop the full-screen skeleton gate here rather than
      // waiting on anything below. `previousById` (only for 'refresh'/
      // 'background') carries forward each still-present item's
      // already-resolved fields so re-fetching the row list doesn't itself
      // blank out photos/metadata that were already correct.
      const previousById =
        mode === 'initial' ? undefined : new Map(itemsRef.current.map((i) => [i.id, i] as const));
      setItems(buildShellItems(rows.itemRows, previousById));
      setFollowedCount(rows.followedCount);
      setLoadError(null);
      setLoading(false);
      setRefreshing(false);
      updateSessionSnapshot(currentUserId, { fetchedAt: Date.now() });

      if (!rows.itemRows.length) {
        controllerRef.current = null;
        return;
      }

      // PRIORITY / BACKGROUND primary-image-id resolution: the first
      // INITIAL_VISIBLE_ITEM_COUNT item rows (this grid's real, newest-first
      // render order — the same first-4 group this screen actually mounts
      // first, see `mountCount` below) get their OWN attachPrimaryImageIds
      // call, merged into items state as soon as it resolves — not gated
      // behind the larger remaining-items call. All three requests below
      // (priority ids, background ids, owner/engagement meta) are fired
      // together, before any of them is awaited, so none sits waiting on
      // another to even start; only the ORDER they're applied to state
      // differs, favoring whichever resolves first (typically priority,
      // being the smaller request).
      const priorityRows = rows.itemRows.slice(0, INITIAL_VISIBLE_ITEM_COUNT);
      const backgroundRows = rows.itemRows.slice(INITIAL_VISIBLE_ITEM_COUNT);
      const ownerIds = [...new Set(rows.itemRows.map((r) => r.user_id))];
      const itemIds = rows.itemRows.map((r) => r.id);

      const priorityIdsPromise = attachPrimaryImageIds(priorityRows);
      const backgroundIdsPromise = attachPrimaryImageIds(backgroundRows);
      const metaPromise = queryFollowingItemsMeta(ownerIds, itemIds, controller.signal);

      try {
        const priorityWithIds = await priorityIdsPromise;
        if (controllerRef.current === controller && !controller.signal.aborted) {
          setItems((prev) => mergePrimaryImageIds(prev, priorityWithIds));
        }
      } catch (e) {
        if (!controller.signal.aborted && controllerRef.current === controller) {
          console.error('[FollowingItemsFeed] priority image-id load failed:', e);
        }
      }

      try {
        const backgroundWithIds = await backgroundIdsPromise;
        if (controllerRef.current === controller && !controller.signal.aborted) {
          setItems((prev) => mergePrimaryImageIds(prev, backgroundWithIds));
        }
      } catch (e) {
        if (!controller.signal.aborted && controllerRef.current === controller) {
          console.error('[FollowingItemsFeed] background image-id load failed:', e);
        }
      }

      try {
        const meta = await metaPromise;
        if (controllerRef.current === controller && !controller.signal.aborted) {
          setItems((prev) =>
            prev.map((item) => {
              const p = meta.profileMap.get(item.user_id);
              return {
                ...item,
                owner_username: p?.username ?? item.owner_username,
                owner_display_name: (p?.hero_display_name || p?.display_name) ?? item.owner_display_name,
                owner_avatar_url: p?.avatar_url ?? item.owner_avatar_url,
                likeCount: meta.likeCountMap.get(item.id) ?? 0,
                commentCount: meta.commentCountMap.get(item.id) ?? 0,
              };
            }),
          );
        }
      } catch (e) {
        // Non-fatal — tile shells and images already work without owner/
        // engagement metadata, so this never re-triggers the error screen.
        if (!controller.signal.aborted && controllerRef.current === controller) {
          console.error('[FollowingItemsFeed] meta load failed:', e);
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

  const { left, right } = useMemo(() => {
    const left: FollowingItem[] = [];
    const right: FollowingItem[] = [];
    let leftHeight = 0;
    let rightHeight = 0;
    for (const item of mountedDisplayItems) {
      const estimatedHeight = 1 / TYPE_DEFAULT_ASPECT_RATIO[item.item_type];
      if (leftHeight <= rightHeight) {
        left.push(item);
        leftHeight += estimatedHeight;
      } else {
        right.push(item);
        rightHeight += estimatedHeight;
      }
    }
    return { left, right };
  }, [mountedDisplayItems]);

  function handleSortPress() {
    Alert.alert('Sort by', undefined, [
      { text: 'Newest', onPress: () => setSort('newest') },
      { text: 'Oldest', onPress: () => setSort('oldest') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function handleMorePress(item: FollowingItem) {
    const ownerName = item.owner_display_name || item.owner_username;
    Alert.alert(item.title || 'Item options', undefined, [
      {
        text: `View ${ownerName}'s profile`,
        onPress: () => navigateToProfile(router, currentUserId, item.user_id, item.owner_username),
      },
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
  // on image load — see TYPE_DEFAULT_ASPECT_RATIO), so by the time the
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
    },
    [onScroll, currentUserId],
  );

  function handleScrollViewLayout() {
    if (!didRestoreScrollRef.current && cachedScrollOffsetRef.current > 0) {
      didRestoreScrollRef.current = true;
      scrollViewRef.current?.scrollTo({ y: cachedScrollOffsetRef.current, animated: false });
    }
  }

  function renderColumn(column: FollowingItem[], width: number) {
    return (
      <View style={{ width }}>
        {column.map((item) => {
          const imageId = item.primary_image_id;
          const imageUrl = imageId ? (priorityUrls.get(imageId) ?? backgroundUrls.get(imageId)) : undefined;
          return (
            <FollowingItemTile
              key={item.id}
              item={item}
              imageUrl={imageUrl}
              imageCacheKey={imageId ? itemImageCacheKey(identity, imageId, servedTierOf(imageId)) : undefined}
              columnWidth={width}
              isNewest={item.id === newestItemId}
              onPress={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}
              onOwnerPress={() => navigateToProfile(router, currentUserId, item.user_id, item.owner_username)}
              onMorePress={() => handleMorePress(item)}
            />
          );
        })}
      </View>
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
        <View style={styles.gridRow}>
          {/* Absolutely positioned/invisible (see PrivateImageWarmup itself) —
              never participates in this View's own layout. */}
          <PrivateImageWarmup entries={priorityWarmupEntries} />
          {renderColumn(left, columnWidth)}
          {renderColumn(right, columnWidth)}
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
  gridRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: GRID_HORIZONTAL_PADDING,
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
    backgroundColor: PV2.collectorPanelBg,
  },
  tileMoreBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
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
    gap: 6,
    paddingHorizontal: 8,
    paddingTop: 8,
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
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  tileAge: {
    fontSize: 11,
    color: PV2.textTertiary,
    paddingHorizontal: 8,
    marginTop: 2,
  },
  tileTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
    paddingHorizontal: 8,
    marginTop: 3,
  },
  tileFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 8,
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
  engagementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
