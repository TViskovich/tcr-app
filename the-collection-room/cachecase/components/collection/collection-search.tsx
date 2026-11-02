import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { supabase } from '@/lib/supabase';

// Search one collector's collections — nested ones at every level — by
// name, description and genre, shared by Profile V2's two long-press entry
// points on the Collection pill: a visitor's Search Collections sheet
// (components/profile-v2/profile-v2-collection-search-sheet.tsx) and the
// owner's Add menu (components/collection/collection-add-menu.tsx).
//
// The search itself runs in the database (search_profile_collections —
// supabase/migrations/20261031160000_add_profile_collection_search.sql):
// it walks the folder tree server-side with the same visibility rules as
// loadCollectionPaths below, matches with the same normalization as item
// search, and returns only matching collections with their path labels,
// a page at a time — the tree is never loaded just to search it. Until that
// migration is deployed, the hook falls back to the original client-side
// name search over loadSearchableCollections.

// Folder rows only — no items, images or covers.
const PAGE_SIZE = 1000;
// Safety cap on paging (10,000 collections); far beyond any real profile.
const MAX_PAGES = 10;

type FolderRow = { id: string; name: string; parent_folder_id: string | null; is_public: boolean };
export type CollectionSearchResult = { id: string; name: string; path: string[] };

// Every collection of `ownerId` this viewer may see, with its parent path
// (ancestor names, root first). The query runs as the viewer, so RLS
// (folders_select_public) decides what comes back.
//
// For a visitor (includePrivate false), RLS already drops every collection
// that isn't effectively visible — a private one, or anything under a
// private ancestor — but it also lets through a private collection that's
// showcased as a Grail (folder_is_grail_showcased). So a collection is only
// kept when it AND every ancestor came back and are public. That keeps
// private names out of both results and breadcrumb paths, and matches the
// public Collection tab (useFolders' publicOnly).
//
// For the owner (includePrivate true), RLS returns all of their own
// collections, private ones included, and all of them are searchable. Either
// way a collection whose ancestor didn't come back is dropped, never shown
// with a broken path.
async function loadSearchableCollections(
  ownerId: string,
  includePrivate: boolean,
): Promise<CollectionSearchResult[]> {
  const paths = await loadCollectionPaths(ownerId, includePrivate);
  const results: CollectionSearchResult[] = [];
  for (const [id, fullPath] of paths) {
    results.push({ id, name: fullPath[fullPath.length - 1], path: fullPath.slice(0, -1) });
  }
  const sortKey = (r: CollectionSearchResult) => [...r.path, r.name].join('\u0000').toLocaleLowerCase();
  return results.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

// Every searchable collection of `ownerId` (same rules as above), keyed by
// id → its full name path, root first, ending with its own name. Also what
// Search Items shows under each item, so an item's context line follows the
// exact same privacy rule — a private collection's name never appears.
export async function loadCollectionPaths(ownerId: string, includePrivate: boolean): Promise<Map<string, string[]>> {
  const rows: FolderRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from('folders')
      .select('id, name, parent_folder_id, is_public')
      .eq('user_id', ownerId)
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as FolderRow[]));
    if ((data?.length ?? 0) < PAGE_SIZE) break;
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  // null = not searchable (missing, not public for a visitor, an ancestor
  // that isn't searchable, or a cycle).
  const pathCache = new Map<string, string[] | null>();
  function searchablePath(id: string, seen: Set<string>): string[] | null {
    if (pathCache.has(id)) return pathCache.get(id)!;
    const row = byId.get(id);
    if (!row || (!includePrivate && !row.is_public) || seen.has(id)) return null;
    seen.add(id);
    const parentPath = row.parent_folder_id ? searchablePath(row.parent_folder_id, seen) : [];
    const path = parentPath && (row.parent_folder_id ? [...parentPath, byId.get(row.parent_folder_id)!.name] : []);
    pathCache.set(id, path);
    return path;
  }

  const paths = new Map<string, string[]>();
  for (const row of rows) {
    const path = searchablePath(row.id, new Set());
    if (path) paths.set(row.id, [...path, row.name]);
  }
  return paths;
}

// loadCollectionPaths as a hook, for item rows' "where it lives" line
// (Search Items, the Items tab's List View). Loads whenever `enabled` turns
// on (each sheet open / list shown), keeping the last map for the same
// owner meanwhile. A failure just leaves rows without that line.
export function useCollectionPathMap(ownerId: string, includePrivate: boolean, enabled: boolean) {
  const key = `${ownerId}:${includePrivate}`;
  const [paths, setPaths] = useState<{ key: string; map: Map<string, string[]> } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadCollectionPaths(ownerId, includePrivate)
      .then((map) => {
        if (!cancelled) setPaths({ key: `${ownerId}:${includePrivate}`, map });
      })
      .catch((e: unknown) => {
        console.error('[collection-search] collection paths failed:', e);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, ownerId, includePrivate]);
  return paths?.key === key ? paths.map : null;
}

export type CollectionSearch = ReturnType<typeof useCollectionSearch>;

const SEARCH_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

// PostgREST's "function not found" — the migration isn't deployed here yet.
function isMissingFunction(error: { code?: string } | null | undefined) {
  return error?.code === 'PGRST202';
}

async function searchCollectionsPage(
  ownerId: string,
  query: string,
  includePrivate: boolean,
  offset: number,
): Promise<CollectionSearchResult[]> {
  const { data, error } = await supabase.rpc('search_profile_collections', {
    p_owner_id: ownerId,
    p_query: query,
    p_include_private: includePrivate,
    p_limit: SEARCH_PAGE_SIZE,
    p_offset: offset,
  });
  if (error) throw error;
  return ((data ?? []) as { folder_id: string; name: string; path: string[] | null }[]).map((row) => ({
    id: row.folder_id,
    name: row.name,
    path: row.path ?? [],
  }));
}

type ServerResults = {
  key: string; // `${ownerId}:${includePrivate}:${query}`
  results: CollectionSearchResult[];
  hasMore: boolean;
  failed: boolean;
};

// Query + results state. Nothing is listed until there's a real query: an
// empty or whitespace-only one matches nothing. Each query is searched
// after a short pause in typing; loadMore fetches the next page (wire it to
// the list's onEndReached). Responses for an older query are dropped.
// `load` (called by the callers when the search opens) only matters for the
// pre-migration fallback, which preloads the collection list.
export function useCollectionSearch(ownerId: string | undefined, { includePrivate }: { includePrivate: boolean }) {
  const [query, setQuery] = useState('');
  const [server, setServer] = useState<ServerResults | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  // Pre-migration fallback: the original client-side list.
  const [legacy, setLegacy] = useState<{ key: string; list: CollectionSearchResult[] } | null>(null);
  const [legacyFailed, setLegacyFailed] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const generationRef = useRef(0);
  const loadingPageRef = useRef(false);
  const serverRef = useRef<ServerResults | null>(null);
  useEffect(() => {
    serverRef.current = server;
  }, [server]);

  const ownerKey = `${ownerId ?? ''}:${includePrivate}`;
  const trimmed = query.trim();
  const queryKey = `${ownerKey}:${trimmed}`;

  const loadLegacy = useCallback(() => {
    if (!ownerId) return;
    loadSearchableCollections(ownerId, includePrivate)
      .then((list) => {
        setLegacy({ key: `${ownerId}:${includePrivate}`, list });
        setLegacyFailed(false);
      })
      .catch((e: unknown) => {
        console.error('[collection-search] load failed:', e);
        setLegacyFailed(true);
      });
  }, [ownerId, includePrivate]);

  const fetchPage = useCallback(
    async (generation: number, key: string, owner: string, q: string, offset: number, previous: CollectionSearchResult[]) => {
      loadingPageRef.current = true;
      setPageLoading(true);
      try {
        const page = await searchCollectionsPage(owner, q, includePrivate, offset);
        if (generation !== generationRef.current) return;
        setServer({ key, results: [...previous, ...page], hasMore: page.length === SEARCH_PAGE_SIZE, failed: false });
      } catch (e) {
        if (generation !== generationRef.current) return;
        if (isMissingFunction(e as { code?: string })) {
          setUnsupported(true);
          loadLegacy();
          return;
        }
        console.error('[collection-search] search failed:', e);
        setServer((prev) =>
          prev && prev.key === key && prev.results.length > 0
            ? { ...prev, hasMore: false }
            : { key, results: [], hasMore: false, failed: true },
        );
      } finally {
        if (generation === generationRef.current) {
          loadingPageRef.current = false;
          setPageLoading(false);
        }
      }
    },
    [includePrivate, loadLegacy],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    loadingPageRef.current = false;
    if (!trimmed || !ownerId || unsupported) return;
    const timer = setTimeout(() => void fetchPage(generation, queryKey, ownerId, trimmed, 0, []), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [queryKey, ownerId, trimmed, unsupported, fetchPage, retryCount]);

  const loadMore = useCallback(() => {
    const current = serverRef.current;
    if (!current || current.failed || !current.hasMore || loadingPageRef.current || !ownerId) return;
    const q = current.key.slice(ownerKey.length + 1);
    void fetchPage(generationRef.current, current.key, ownerId, q, current.results.length, current.results);
  }, [fetchPage, ownerId, ownerKey]);

  // No synchronous state updates — safe to call from an effect.
  const load = useCallback(() => {
    if (unsupported) loadLegacy();
  }, [unsupported, loadLegacy]);

  const retry = useCallback(() => {
    if (unsupported) {
      setLegacyFailed(false);
      loadLegacy();
    } else {
      setServer(null);
      setRetryCount((n) => n + 1);
    }
  }, [unsupported, loadLegacy]);

  const needle = trimmed.toLocaleLowerCase();
  const legacyList = legacy?.key === ownerKey ? legacy.list : null;
  const legacyMatches = useMemo(
    () => (legacyList && needle ? legacyList.filter((c) => c.name.toLocaleLowerCase().includes(needle)) : []),
    [legacyList, needle],
  );
  const active = server?.key === queryKey ? server : null;

  if (unsupported) {
    return {
      query,
      setQuery,
      needle,
      list: legacyList,
      matches: legacyMatches,
      failed: legacyFailed,
      searching: !!needle && !legacyList && !legacyFailed,
      hasMore: false,
      load,
      loadMore,
      retry,
    };
  }
  return {
    query,
    setQuery,
    needle,
    // The server search has no up-front list; kept for callers' "show the
    // error state" check (null + failed).
    list: null as CollectionSearchResult[] | null,
    matches: active && !active.failed ? active.results : [],
    failed: !!active?.failed,
    searching: !!needle && !!ownerId && (!active || pageLoading),
    hasMore: !!active?.hasMore,
    load,
    loadMore,
    retry,
  };
}

// True while the software keyboard is up — lets a bottom sheet drop its
// home-indicator inset while it's sitting on the keyboard.
export function useKeyboardShown() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setShown(true));
    const hide = Keyboard.addListener(hideEvent, () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

// The results area under a search field: a load/search error with Retry
// (so a failure never just looks like an empty search), nothing for an
// empty query, a spinner while the first page is on its way, "No
// collections found", or the matches — name plus parent path, so same-named
// collections can be told apart. Scrolls within whatever height it's given,
// fetching the next page near the end.
export function CollectionSearchResults({
  search,
  onSelect,
}: {
  search: CollectionSearch;
  onSelect: (collection: CollectionSearchResult) => void;
}) {
  const { failed, needle, matches, retry, searching, loadMore } = search;

  if (failed) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>Couldn&apos;t search collections.</Text>
        <TouchableOpacity style={styles.retryButton} onPress={retry} activeOpacity={0.8}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!needle) return null;
  if (matches.length === 0 && searching) return <ActivityIndicator style={styles.state} color={PV2.link} />;
  if (matches.length === 0) return <Text style={[styles.state, styles.stateText]}>No collections found</Text>;

  return (
    <FlatList
      data={matches}
      keyExtractor={(c) => c.id}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
      ItemSeparatorComponent={() => <View style={styles.divider} />}
      renderItem={({ item }) => (
        <TouchableOpacity
          style={styles.row}
          onPress={() => onSelect(item)}
          activeOpacity={0.65}
          accessibilityRole="button"
          accessibilityLabel={[...item.path, item.name].join(', ')}>
          <IconSymbol name="folder.fill" size={18} color={PV2.textSecondary} />
          <View style={styles.rowText}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.name}
            </Text>
            {item.path.length > 0 && (
              <Text style={styles.rowPath} numberOfLines={1}>
                {item.path.join(' › ')}
              </Text>
            )}
          </View>
          <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  state: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  stateText: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  retryText: {
    fontSize: 13,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    paddingVertical: 10,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  rowPath: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.50)',
  },
});
