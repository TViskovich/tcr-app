import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image as RNImage,
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
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { attachPrimaryImageIds } from '@/lib/item-images';
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

// Default aspect ratio (width / height) per category, used only (a) as the
// masonry column-assignment heuristic before any image has loaded, and (b)
// as a tile's own fallback while its real image is still being measured/
// resolved. Once a tile's image loads, RNImage.getSize (same technique
// components/feed/post-card.tsx already uses for its own lead-image
// measurement) replaces this with the photo's real ratio — real variation
// within a category (e.g. two differently-posed figurines) comes from that
// measurement, not from this table.
const TYPE_DEFAULT_ASPECT_RATIO: Record<CollectibleItemType, number> = {
  sports_card: 0.7,
  pokemon: 0.7,
  comic_book: 0.64,
  figurine: 0.82,
};

const MIN_TILE_ASPECT_RATIO = 0.45;
const MAX_TILE_ASPECT_RATIO = 1.6;

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

type LoadResult = { followedCount: number; items: FollowingItem[] };

async function queryFollowingItems(currentUserId: string, signal: AbortSignal): Promise<LoadResult> {
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
  if (!followedIds.length) return { followedCount: 0, items: [] };

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

  if (!itemRows?.length) return { followedCount: followedIds.length, items: [] };

  const ownerIds = [...new Set((itemRows as any[]).map((i) => i.user_id as string))];
  const itemIds = (itemRows as any[]).map((i) => i.id as string);

  const [profilesRes, likesRes, commentsRes, withPrimaryIds] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, username, display_name, hero_display_name, avatar_url')
      .in('id', ownerIds)
      .abortSignal(signal),
    // item_likes/item_comments (supabase/migrations/20260923120000_create_
    // item_social.sql) — real, existing per-item engagement, batched the
    // same way the main feed batches post likes/comments. Counts only; no
    // per-item "did I like this" lookup, since these tiles render a
    // read-only count, not a tappable like toggle.
    supabase.from('item_likes').select('item_id').in('item_id', itemIds).abortSignal(signal),
    supabase.from('item_comments').select('item_id').in('item_id', itemIds).abortSignal(signal),
    attachPrimaryImageIds(itemRows as { id: string }[]),
  ]);

  const profileMap = new Map((profilesRes.data ?? []).map((p: any) => [p.id, p]));
  const primaryIdByItemId = new Map(withPrimaryIds.map((i) => [i.id, i.primary_image_id]));

  const likeCountMap = new Map<string, number>();
  for (const row of (likesRes.data ?? []) as any[]) {
    likeCountMap.set(row.item_id, (likeCountMap.get(row.item_id) ?? 0) + 1);
  }
  const commentCountMap = new Map<string, number>();
  for (const row of (commentsRes.data ?? []) as any[]) {
    commentCountMap.set(row.item_id, (commentCountMap.get(row.item_id) ?? 0) + 1);
  }

  const items: FollowingItem[] = (itemRows as any[]).map((row) => {
    const p = profileMap.get(row.user_id) ?? {};
    return {
      id: row.id,
      title: row.title ?? null,
      item_type: (row.item_type ?? 'sports_card') as CollectibleItemType,
      created_at: row.created_at,
      user_id: row.user_id,
      primary_image_id: primaryIdByItemId.get(row.id) ?? null,
      owner_username: p.username ?? 'user',
      owner_display_name: p.hero_display_name || p.display_name || null,
      owner_avatar_url: p.avatar_url ?? null,
      likeCount: likeCountMap.get(row.id) ?? 0,
      commentCount: commentCountMap.get(row.id) ?? 0,
    };
  });

  return { followedCount: followedIds.length, items };
}

function FollowingItemTile({
  item,
  imageUrl,
  columnWidth,
  isNewest,
  onPress,
  onOwnerPress,
  onMorePress,
}: {
  item: FollowingItem;
  imageUrl: string | undefined;
  columnWidth: number;
  isNewest: boolean;
  onPress: () => void;
  onOwnerPress: () => void;
  onMorePress: () => void;
}) {
  const [measuredRatio, setMeasuredRatio] = useState<number | null>(null);

  useEffect(() => {
    setMeasuredRatio(null);
    if (!imageUrl) return;
    let cancelled = false;
    RNImage.getSize(
      imageUrl,
      (width, height) => {
        if (!cancelled && height > 0) setMeasuredRatio(width / height);
      },
      () => {
        // Leave measuredRatio null — the tile falls back to its category
        // default below, same "no broken box" convention as post-card.tsx.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  const ratio = clampTileAspectRatio(measuredRatio ?? TYPE_DEFAULT_ASPECT_RATIO[item.item_type]);
  const ownerName = item.owner_display_name || item.owner_username;

  return (
    <TouchableOpacity
      style={[styles.tile, { width: columnWidth }, isNewest && styles.tileNewest]}
      onPress={onPress}
      activeOpacity={0.9}>
      <View style={[styles.tileImageBox, { aspectRatio: ratio }]}>
        {imageUrl ? (
          <Image source={{ uri: imageUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.tileImagePlaceholder]}>
            <Text style={styles.tileImagePlaceholderEmoji}>🃏</Text>
          </View>
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

function GridSkeleton({ columnWidth }: { columnWidth: number }) {
  // Alternating tall/short placeholder ratios purely to visually hint at
  // the masonry layout underneath — discarded the instant real items
  // arrive, never real data.
  const heights = [1.4, 1.1, 1.25, 1.0, 1.5, 1.15];
  return (
    <View style={styles.gridRow}>
      {[0, 1].map((col) => (
        <View key={col} style={{ width: columnWidth }}>
          {heights.map((h, i) => (
            <View
              key={i}
              style={[
                styles.skeletonTile,
                { width: columnWidth, height: columnWidth * h },
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

  const [items, setItems] = useState<FollowingItem[]>([]);
  const [followedCount, setFollowedCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');

  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
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
      else setRefreshing(true);

      try {
        const result = await queryFollowingItems(currentUserId, controller.signal);
        if (controllerRef.current !== controller || controller.signal.aborted) return;
        setItems(result.items);
        setFollowedCount(result.followedCount);
        setLoadError(null);
      } catch (e) {
        if (controller.signal.aborted || controllerRef.current !== controller) return;
        console.error('[FollowingItemsFeed] load failed:', e);
        setLoadError(e instanceof Error ? e.message : 'Failed to load Following feed.');
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [currentUserId],
  );

  useEffect(() => {
    load('initial');
    return () => controllerRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  const { urls: signedUrls } = useSignedItemImages(items.map((i) => i.primary_image_id));

  // items is always fetched newest-first (see queryFollowingItems' own
  // .order) regardless of the user-facing `sort` toggle below — this is
  // what "the newest item" means for the Just Added badge, independent of
  // which order the grid currently displays.
  const newestItemId = items[0]?.id ?? null;

  const displayItems = useMemo(() => (sort === 'oldest' ? [...items].reverse() : items), [items, sort]);

  const newItemsTodayCount = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return items.filter((i) => new Date(i.created_at) >= startOfToday).length;
  }, [items]);

  const { width: windowWidth } = useWindowDimensions();
  const columnWidth = (windowWidth - GRID_HORIZONTAL_PADDING * 2 - COLUMN_GAP) / 2;

  const { left, right } = useMemo(() => {
    const left: FollowingItem[] = [];
    const right: FollowingItem[] = [];
    let leftHeight = 0;
    let rightHeight = 0;
    for (const item of displayItems) {
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
  }, [displayItems]);

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

  function renderColumn(column: FollowingItem[], width: number) {
    return (
      <View style={{ width }}>
        {column.map((item) => (
          <FollowingItemTile
            key={item.id}
            item={item}
            imageUrl={item.primary_image_id ? signedUrls.get(item.primary_image_id) : undefined}
            columnWidth={width}
            isNewest={item.id === newestItemId}
            onPress={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}
            onOwnerPress={() => navigateToProfile(router, currentUserId, item.user_id, item.owner_username)}
            onMorePress={() => handleMorePress(item)}
          />
        ))}
      </View>
    );
  }

  const bottomPadding = TAB_BAR_HEIGHT + insets.bottom + 24;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomPadding }]}
      onScroll={onScroll}
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
  tileImagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileImagePlaceholderEmoji: {
    fontSize: 28,
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
