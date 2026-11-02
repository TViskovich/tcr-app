import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';

import { useCollectionPathMap } from '@/components/collection/collection-search';
import { SEARCH_BAR_BORDER } from '@/components/collection/collection-search-bar';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { fetchSearchedItems, useProfileItemSearch } from '@/hooks/use-item-search';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { ITEM_TYPE_LABEL } from '@/lib/dm-attachments';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
import { fetchProfileItemViewCounts, VIEW_TRACKING_SINCE } from '@/lib/item-views';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';
import type { CollectibleItemType } from '@/types';

import { type AnchorRect, ItemSearchFilterMenu } from './item-search-filter-menu';
import { itemName, itemRowStyles, type ListableItem, ProfileV2ItemRow } from './profile-v2-item-row';
import { ProfileV2SearchSheet, type SearchSheetToggle } from './profile-v2-search-sheet';
import { PV2 } from './profile-v2-theme';

// Rows rendered (and thumbnails signed) at a time; scrolling to the end shows
// the next step, so a broad query never signs hundreds of images at once.
const MAX_RESULTS = 60;
// The search field's own height (collection-search-bar.tsx: 7 + 22 + 7 +
// its 1pt border top and bottom), so the filter pill beside it lines up.
const FILTER_BUTTON_HEIGHT = 38;

export type SearchableItem = ListableItem;

// Search Items' display-only sort orders — they never touch the collector's
// saved manual order (profile_sort_order). Name A–Z is the default and the
// order results always had.
type ItemSort = 'name_asc' | 'name_desc' | 'newest' | 'oldest' | 'most_viewed';
const SORTS: { value: ItemSort; label: string }[] = [
  { value: 'name_asc', label: 'Name A–Z' },
  { value: 'name_desc', label: 'Name Z–A' },
  { value: 'newest', label: 'Newest Added' },
  { value: 'oldest', label: 'Oldest Added' },
  { value: 'most_viewed', label: 'Most Viewed' },
];
const DEFAULT_SORT: ItemSort = 'name_asc';

// Every comparison ends on the id, so equal names/dates/view counts always
// come out in the same order.
function byName(a: SearchableItem, b: SearchableItem) {
  return itemName(a).localeCompare(itemName(b)) || a.id.localeCompare(b.id);
}
function byAdded(a: SearchableItem, b: SearchableItem) {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

// Profile V2's item search sheet — shared by Search Items (the Items pill)
// and Search Tagged Items (the Tagged pill). Same sheet as Search
// Collections (ProfileV2SearchSheet). Searches only the `items` it's given,
// so each caller decides eligibility (and the caller's own data source has
// already applied RLS/visibility). Nothing shows until there's a real
// query; matching is case-insensitive and partial on the player/title, plus
// — when `searchOwnerId` is given — the database's metadata search over
// that profile's items (hooks/use-item-search.ts: every category's details,
// paged as the list scrolls). A server match not (yet) in `items` — the
// list still loading, or a stale cached copy — is fetched by id; the search
// RPC already applied the same visibility rule as the caller's list, and
// the fetch runs under the viewer's RLS too. Each
// result is a ProfileV2ItemRow: the item's primary-image thumbnail (compact
// signed tier — never the full-resolution image or its gallery), its name,
// and the caller's context line.
export function ItemSearchSheet<T extends SearchableItem>({
  visible,
  items,
  placeholder,
  context,
  toggle,
  searchOwnerId,
  onClose,
  onSelect,
}: {
  visible: boolean;
  items: T[];
  placeholder: string;
  // Extra context after the item's own title (e.g. where it lives, or when
  // it was tagged). Empty/null for none.
  context: (item: T) => string | null;
  // Optional switch row under the field while the query is empty (the Items
  // tab's "List View" switch).
  toggle?: SearchSheetToggle;
  // The profile whose items `items` are: turns on metadata search for them.
  // Omitted (e.g. Tagged items, which span several owners): name-only.
  searchOwnerId?: string;
  onClose: () => void;
  onSelect: (item: T) => void;
}) {
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const [query, setQueryState] = useState('');
  const [shownCount, setShownCount] = useState(MAX_RESULTS);
  const needle = query.trim().toLocaleLowerCase();
  const server = useProfileItemSearch(visible ? searchOwnerId : undefined, query);

  // Sort and item-type filter — only for a profile's own items
  // (searchOwnerId), the Search Items sheet. Changing either away from its
  // default lists results even with no query, so they also work as a way
  // to browse. Reset whenever the sheet closes.
  const sortAndFilter = !!searchOwnerId;
  const [sort, setSortState] = useState<ItemSort>(DEFAULT_SORT);
  const [typeFilter, setTypeFilterState] = useState<CollectibleItemType | 'all'>('all');
  // Most Viewed's authoritative totals (lib/item-views.ts), fetched each
  // time that sort is chosen. Items without a row have 0 views.
  const [viewCounts, setViewCounts] = useState<
    { status: 'loading' } | { status: 'ready'; counts: Map<string, number> } | { status: 'failed' } | null
  >(null);
  const browsing = !!needle || typeFilter !== 'all' || sort !== DEFAULT_SORT;
  // The filter dropdown (item-search-filter-menu.tsx), anchored to the
  // filter button beside the search field; null = closed.
  const filterButtonRef = useRef<View>(null);
  const [filterAnchor, setFilterAnchor] = useState<AnchorRect | null>(null);
  function openFilterMenu() {
    filterButtonRef.current?.measureInWindow((x, y, width, height) => setFilterAnchor({ x, y, width, height }));
  }
  // Only the latest view-totals request may set them (Most Viewed chosen
  // twice quickly: the older response can't overwrite the newer).
  const viewCountsRequestRef = useRef(0);

  // A new query starts again from the first step of rows.
  function setQuery(next: string) {
    setQueryState(next);
    setShownCount(MAX_RESULTS);
  }

  function setSort(next: ItemSort) {
    setSortState(next);
    setShownCount(MAX_RESULTS);
    if (next === 'most_viewed' && searchOwnerId) {
      const request = ++viewCountsRequestRef.current;
      setViewCounts({ status: 'loading' });
      fetchProfileItemViewCounts(searchOwnerId)
        .then((counts) => {
          if (request === viewCountsRequestRef.current) setViewCounts({ status: 'ready', counts });
        })
        .catch((e: unknown) => {
          if (__DEV__) console.warn('[ItemSearchSheet] view counts failed:', e);
          if (request === viewCountsRequestRef.current) setViewCounts({ status: 'failed' });
        });
    }
  }

  function setTypeFilter(next: CollectibleItemType | 'all') {
    setTypeFilterState(next);
    setShownCount(MAX_RESULTS);
  }

  // Type chips only when the profile actually spans more than one type.
  const presentTypes = useMemo(
    () =>
      sortAndFilter
        ? (Array.from(new Set(items.map((item) => item.item_type).filter(Boolean))) as CollectibleItemType[])
        : [],
    [sortAndFilter, items],
  );

  // Server matches missing from `items`, fetched by id (see above). Keyed
  // by the match set, so a new query never shows the previous one's rows.
  const [extraRows, setExtraRows] = useState<{ ids: Set<string>; rows: T[] } | null>(null);
  const missingIds = useMemo(() => {
    if (!searchOwnerId || !server.matchIds) return [];
    const have = new Set(items.map((item) => item.id));
    return [...server.matchIds].filter((id) => !have.has(id));
  }, [searchOwnerId, server.matchIds, items]);
  const missingKey = missingIds.join(',');
  useEffect(() => {
    if (!missingKey || !server.matchIds) return;
    const matchIds = server.matchIds;
    let cancelled = false;
    fetchSearchedItems(missingKey.split(','))
      .then((rows) => {
        if (!cancelled) setExtraRows({ ids: matchIds, rows: rows as unknown as T[] });
      })
      .catch((e: unknown) => {
        if (__DEV__) console.warn('[ItemSearchSheet] fetching matched items failed:', e);
      });
    return () => {
      cancelled = true;
    };
  }, [missingKey, server.matchIds]);

  const counts = viewCounts?.status === 'ready' ? viewCounts.counts : null;
  const allMatches = useMemo(() => {
    if (!browsing) return [];
    const serverIds = server.matchIds;
    const have = new Set(items.map((item) => item.id));
    const extras =
      needle && extraRows && extraRows.ids === serverIds ? extraRows.rows.filter((row) => !have.has(row.id)) : [];
    const filtered = [...items, ...extras].filter(
      (item) =>
        (typeFilter === 'all' || item.item_type === typeFilter) &&
        (!needle ||
          [item.player, item.title].some((field) => field?.toLocaleLowerCase().includes(needle)) ||
          !!serverIds?.has(item.id)),
    );
    switch (sort) {
      case 'name_desc':
        return filtered.sort((a, b) => byName(b, a));
      case 'newest':
        return filtered.sort((a, b) => byAdded(b, a));
      case 'oldest':
        return filtered.sort(byAdded);
      case 'most_viewed':
        // Highest total first; equal totals (including every 0) by name,
        // then id. Without totals (loading/failed) this is just A–Z.
        return filtered.sort((a, b) => (counts?.get(b.id) ?? 0) - (counts?.get(a.id) ?? 0) || byName(a, b));
      default:
        return filtered.sort(byName);
    }
  }, [browsing, items, needle, typeFilter, sort, counts, server.matchIds, extraRows]);
  // A query's metadata matches arrive from the server a page at a time, in
  // name order — fine for the default A–Z, but any other order (Z–A, dates,
  // Most Viewed) is only correct once EVERY match is known: a later page can
  // hold an item that belongs at the top. So with a query and a non-default
  // sort, the remaining pages (ids only) are fetched straight away, and
  // results show once they're all in. A failed or unavailable server search
  // counts as complete (local name matches only), as before.
  const sortNeedsAllMatches = !!needle && sort !== DEFAULT_SORT;
  const { hasMore: serverHasMore, searching: serverSearching, loadMore: loadMoreMatches } = server;
  const matchesComplete = !sortNeedsAllMatches || (server.matchIds ? !serverHasMore : !serverSearching);
  useEffect(() => {
    if (sortNeedsAllMatches && serverHasMore && !serverSearching) loadMoreMatches();
  }, [sortNeedsAllMatches, serverHasMore, serverSearching, loadMoreMatches]);

  const matches = allMatches.slice(0, shownCount);
  const moreToShow = allMatches.length > shownCount || server.hasMore;

  function handleEndReached() {
    if (allMatches.length > shownCount) setShownCount((count) => count + MAX_RESULTS);
    server.loadMore();
  }

  // Only the rows actually shown, at the compact preview tier.
  const { urls, servedTiers } = useSignedItemImages(
    matches.map((item) => item.primary_image_id),
    COMPACT_IMAGE_TIER,
  );

  // Most Viewed's one-line status above the results (totals loading /
  // failed / what they cover) — only while that sort is chosen.
  const viewsNote =
    sortAndFilter && sort === 'most_viewed' ? (
      <Text style={styles.note}>
        {viewCounts?.status === 'loading'
          ? 'Loading views…'
          : viewCounts?.status === 'failed'
            ? 'Couldn’t load views — showing A–Z.'
            : `Views by other collectors since ${VIEW_TRACKING_SINCE}.`}
      </Text>
    ) : null;

  const filtersActive = sort !== DEFAULT_SORT || typeFilter !== 'all';
  const filterButton = sortAndFilter ? (
    <Pressable
      ref={filterButtonRef}
      onPress={openFilterMenu}
      hitSlop={6}
      style={[styles.filterButton, filtersActive && styles.filterButtonActive]}
      accessibilityRole="button"
      accessibilityLabel="Sort and filter"
      accessibilityState={{ expanded: !!filterAnchor }}>
      {/* Sliders + chevron in a pill: reads as a dropdown, distinct from
          the profile's round sliders-only Settings button. */}
      <IconSymbol
        name="slider.horizontal.3"
        size={17}
        color={filtersActive ? PV2.actionPrimary : PV2.textSecondary}
      />
      <IconSymbol
        name={filterAnchor ? 'chevron.up' : 'chevron.down'}
        size={14}
        color={filtersActive ? PV2.actionPrimary : PV2.textSecondary}
      />
    </Pressable>
  ) : null;

  const filterMenu = sortAndFilter ? (
    <ItemSearchFilterMenu
      anchor={filterAnchor}
      onClose={() => setFilterAnchor(null)}
      sortOptions={SORTS}
      sort={sort}
      onSort={setSort}
      typeOptions={[
        { value: 'all' as const, label: 'All Types' },
        ...presentTypes.map((t) => ({ value: t, label: ITEM_TYPE_LABEL[t] })),
      ]}
      type={typeFilter}
      onType={setTypeFilter}
      // View = the Items tab's existing Grid/List preference (the List View
      // switch this sheet used to show under the field).
      viewOptions={
        toggle
          ? [
              { value: 'grid' as const, label: 'Grid' },
              { value: 'list' as const, label: 'List' },
            ]
          : undefined
      }
      view={toggle ? (toggle.value ? 'list' : 'grid') : undefined}
      onView={toggle ? (value) => toggle.onChange(value === 'list') : undefined}
    />
  ) : null;

  let results: React.ReactNode = null;
  if (browsing && !matchesComplete) {
    results = <Text style={styles.state}>Finding all matches…</Text>;
  } else if (browsing && matches.length === 0) {
    results = <Text style={styles.state}>{needle && server.searching ? 'Searching…' : 'No items found'}</Text>;
  } else if (browsing) {
    results = (
      <FlatList
        data={matches}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ItemSeparatorComponent={() => <View style={itemRowStyles.divider} />}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          moreToShow ? (
            <Text style={styles.more}>
              Showing {matches.length} of {allMatches.length}
              {needle && server.hasMore ? '+' : ''} — scroll for more, or keep typing to narrow it down.
            </Text>
          ) : null
        }
        renderItem={({ item }) => {
          const imageId = item.primary_image_id;
          return (
            <ProfileV2ItemRow
              item={item}
              imageUri={imageId ? urls.get(imageId) : undefined}
              imageCacheKey={imageId ? itemImageCacheKey(identity, imageId, COMPACT_IMAGE_TIER, servedTiers) : undefined}
              context={context(item)}
              onPress={() => {
                Keyboard.dismiss();
                setQuery('');
                onSelect(item);
              }}
            />
          );
        }}
      />
    );
  }

  return (
    <ProfileV2SearchSheet
      visible={visible}
      query={query}
      onChangeQuery={setQuery}
      placeholder={placeholder}
      // With the filter menu, Grid/List lives in its View submenu instead of
      // the switch row under the field.
      toggle={sortAndFilter ? undefined : toggle}
      fieldAccessory={filterButton}
      overlay={filterMenu}
      onClose={() => {
        setQuery('');
        setSortState(DEFAULT_SORT);
        setTypeFilterState('all');
        setViewCounts(null);
        setFilterAnchor(null);
        onClose();
      }}>
      {viewsNote}
      {results}
    </ProfileV2SearchSheet>
  );
}

type Props = {
  visible: boolean;
  ownerId: string;
  ownerName: string;
  isOwnProfile: boolean;
  // This profile's Items tab rows (Profile's own useAllItems — every
  // collection, nested ones included, publicOnly for a visitor, and RLS-
  // limited either way). Searching exactly these means Search Items finds
  // exactly what the Items grid shows the viewer, and nothing more.
  items: SearchableItem[];
  toggle?: SearchSheetToggle;
  onClose: () => void;
  onSelect: (item: SearchableItem) => void;
};

// Profile V2: long-press the Items pill (while Items is the active tab) →
// search this profile's items by name, for the owner and visitors alike.
// Context line: where the item lives (same loader and privacy rules as
// Search Collections, so a visitor never sees a private collection's name).
// Choosing one opens the normal Item Detail screen, which decides what the
// signed-in viewer can do there.
export function ProfileV2ItemSearchSheet({
  visible,
  ownerId,
  ownerName,
  isOwnProfile,
  items,
  toggle,
  onClose,
  onSelect,
}: Props) {
  const pathMap = useCollectionPathMap(ownerId, isOwnProfile, visible);
  return (
    <ItemSearchSheet
      visible={visible}
      items={items}
      searchOwnerId={ownerId}
      placeholder={isOwnProfile ? 'Search your items' : `Search ${ownerName}'s items`}
      context={(item) => pathMap?.get(item.folder_id)?.join(' › ') ?? null}
      toggle={toggle}
      onClose={onClose}
      onSelect={onSelect}
    />
  );
}

const styles = StyleSheet.create({
  // Same height and outline as the search field beside it
  // (collection-search-bar.tsx), square.
  // A pill (like the profile's tab pills) with the search field's own
  // height, outline and fill, so the two read as one control row.
  filterButton: {
    flexDirection: 'row',
    gap: 6,
    height: FILTER_BUTTON_HEIGHT,
    paddingHorizontal: 14,
    borderRadius: FILTER_BUTTON_HEIGHT / 2,
    borderWidth: SEARCH_BAR_BORDER,
    borderColor: PV2.border,
    backgroundColor: PV2.emptyCardBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterButtonActive: {
    borderColor: PV2.actionPrimary,
    backgroundColor: PV2.actionPrimarySoft,
  },
  note: {
    flexShrink: 0,
    fontSize: 12,
    color: PV2.textTertiary,
    paddingBottom: 8,
  },
  state: {
    paddingVertical: 32,
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  more: {
    paddingVertical: 14,
    fontSize: 12,
    color: PV2.textTertiary,
    textAlign: 'center',
  },
});
