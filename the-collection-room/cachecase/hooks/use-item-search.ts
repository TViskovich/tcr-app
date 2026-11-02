import { useCallback, useEffect, useRef, useState } from 'react';

import { attachPrimaryImageIds } from '@/lib/item-images';
import { supabase } from '@/lib/supabase';
import type { CollectionItem } from '@/types';

// Item metadata search — the client half of supabase/migrations/
// 20261031140000_add_collection_item_search.sql (Collection Search) and
// 20261031150000_add_profile_item_search.sql (Profile Items). The database
// does the matching (titles plus every category's details: a comic's
// characters and printing, a Pokémon card's set and rarity, a sneaker's
// colorway, ...), under the caller's own RLS, with one shared normalization
// and matching rule, and returns matching item ids one page at a time in a
// stable order. These hooks only debounce, page and guard against stale
// responses; they never filter items themselves.
//
// Each search surface is a SCOPE — one RPC plus the id it is scoped to.
// Adding a surface means adding a scoped RPC and a scope here, never a
// second matching algorithm.

const PAGE_SIZE = 100;
const DEBOUNCE_MS = 250;

type ItemSearchScope = 'collection' | 'profile';

const SCOPE_RPC: Record<ItemSearchScope, { fn: string; idParam: string }> = {
  // One collection's own active items, in the folder's order.
  collection: { fn: 'search_collection_items', idParam: 'p_folder_id' },
  // One profile's active items across all its collections, by name — the
  // owner's private items included, a visitor's view limited to the Items
  // tab's public set.
  profile: { fn: 'search_profile_items', idParam: 'p_owner_id' },
};

// One page of matching item ids for a scope. Throws on a request error.
export async function searchItemIds(
  scope: ItemSearchScope,
  scopeId: string,
  query: string,
  offset: number,
  limit = PAGE_SIZE,
): Promise<string[]> {
  const { fn, idParam } = SCOPE_RPC[scope];
  const { data, error } = await supabase.rpc(fn, {
    [idParam]: scopeId,
    p_query: query,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  return ((data ?? []) as { item_id: string }[]).map((row) => row.item_id);
}

// Rows (with primary image ids) for matched ids a caller doesn't have loaded
// yet — e.g. its list is still loading, or came from a stale cache. The ids
// come from a scoped search RPC, which already applied that scope's
// visibility rule; this read runs as the caller too, so RLS applies again.
// Active items only; at most 150 ids per call (one request).
export async function fetchSearchedItems(ids: string[]): Promise<(CollectionItem & { primary_image_id: string | null })[]> {
  const wanted = ids.slice(0, 150);
  if (!wanted.length) return [];
  const { data, error } = await supabase
    .from('collection_items')
    .select('*')
    .in('id', wanted)
    .eq('collection_status', 'active');
  if (error) throw error;
  return attachPrimaryImageIds((data ?? []) as CollectionItem[]);
}

type SearchState = {
  // The scope id and (trimmed) query these results belong to — results for
  // any other pair are ignored, so a new query never shows stale matches.
  scopeId: string;
  query: string;
  ids: Set<string>;
  nextOffset: number;
  hasMore: boolean;
  // The request failed: no server matches for this pair (see matchIds).
  failed: boolean;
};

export type ItemSearchResult = {
  // Matching item ids known so far (every page loaded). Null while there is
  // no query, before the first page arrives, or when the search request
  // failed (e.g. the migration isn't deployed yet) — callers then keep their
  // own local name matching.
  matchIds: Set<string> | null;
  // True until the first page of the current query arrives, and while a
  // further page is loading.
  searching: boolean;
  // More matches exist on the server than matchIds holds.
  hasMore: boolean;
  // Fetches the next page (wire it to the list's onEndReached). No-op while
  // a page is loading or when every match is already known.
  loadMore: () => void;
};

function useScopedItemSearch(scope: ItemSearchScope, scopeId: string | undefined, query: string): ItemSearchResult {
  const trimmed = query.trim();
  const [state, setState] = useState<SearchState | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  // Bumped for every new query/scope; a response for an older one is dropped.
  const generationRef = useRef(0);
  const loadingPageRef = useRef(false);
  const stateRef = useRef<SearchState | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const fetchPage = useCallback(
    async (generation: number, id: string, q: string, offset: number, previous: Set<string> | null) => {
      loadingPageRef.current = true;
      setPageLoading(true);
      try {
        const page = await searchItemIds(scope, id, q, offset);
        if (generation !== generationRef.current) return;
        const ids = new Set(previous ?? []);
        for (const itemId of page) ids.add(itemId);
        setState({ scopeId: id, query: q, ids, nextOffset: offset + page.length, hasMore: page.length === PAGE_SIZE, failed: false });
      } catch (e) {
        if (generation !== generationRef.current) return;
        if (__DEV__) console.warn(`[useItemSearch:${scope}] search failed:`, e instanceof Error ? e.message : e);
        // Keep any pages already loaded for this query, but stop paging.
        setState((prev) =>
          prev && prev.scopeId === id && prev.query === q && !prev.failed
            ? { ...prev, hasMore: false }
            : { scopeId: id, query: q, ids: new Set(), nextOffset: 0, hasMore: false, failed: true },
        );
      } finally {
        if (generation === generationRef.current) {
          loadingPageRef.current = false;
          setPageLoading(false);
        }
      }
    },
    [scope],
  );

  // New query or scope: search after a short pause in typing. Results for
  // the previous pair are simply ignored below (see `active`).
  useEffect(() => {
    const generation = ++generationRef.current;
    loadingPageRef.current = false;
    if (!trimmed || !scopeId) return;
    const timer = setTimeout(() => void fetchPage(generation, scopeId, trimmed, 0, null), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [scopeId, trimmed, fetchPage]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (!current || current.failed || !current.hasMore || loadingPageRef.current) return;
    void fetchPage(generationRef.current, current.scopeId, current.query, current.nextOffset, current.ids);
  }, [fetchPage]);

  const active = state && scopeId && state.scopeId === scopeId && state.query === trimmed ? state : null;
  return {
    matchIds: active && !active.failed ? active.ids : null,
    searching: !!trimmed && !!scopeId && (!active || pageLoading),
    hasMore: !!active?.hasMore,
    loadMore,
  };
}

// Collection Search: matches among one collection's own active items.
export function useCollectionItemSearch(folderId: string | undefined, query: string): ItemSearchResult {
  return useScopedItemSearch('collection', folderId, query);
}

// Profile Items search: matches among one profile's active items (pass
// undefined to switch it off).
export function useProfileItemSearch(ownerId: string | undefined, query: string): ItemSearchResult {
  return useScopedItemSearch('profile', ownerId, query);
}
