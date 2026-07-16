import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';
import type { CollectionItem, Folder } from '@/types';

// For folders with cover_source = 'first_card', fetches the oldest item's image_url
// and splices it into cover_image_url so FolderCard renders the right image.
export async function resolveCovers(folders: Folder[]): Promise<Folder[]> {
  const firstCardIds = folders.filter(f => f.cover_source === 'first_card').map(f => f.id);
  if (!firstCardIds.length) return folders;

  const { data: items } = await supabase
    .from('collection_items')
    .select('folder_id, image_url')
    .in('folder_id', firstCardIds)
    .order('created_at', { ascending: false });

  const firstByFolder = new Map<string, string | null>();
  for (const item of (items ?? []) as { folder_id: string; image_url: string | null }[]) {
    if (!firstByFolder.has(item.folder_id)) {
      firstByFolder.set(item.folder_id, item.image_url);
    }
  }

  return folders.map(f =>
    f.cover_source === 'first_card'
      ? { ...f, cover_image_url: firstByFolder.get(f.id) ?? null }
      : f,
  );
}

// Preview rows only ever show the latest few items per folder — capping
// each folder's own query (rather than one unlimited query across all
// folder ids) means a folder with hundreds of items never pulls more than
// this many rows just to populate its horizontal preview row.
const PREVIEW_ITEM_LIMIT = 10;

async function fetchPreviewItems(folderIds: string[]): Promise<Record<string, CollectionItem[]>> {
  if (!folderIds.length) return {};
  const results = await Promise.all(
    folderIds.map(id =>
      supabase
        .from('collection_items')
        .select('*')
        .eq('folder_id', id)
        .order('created_at', { ascending: false })
        .limit(PREVIEW_ITEM_LIMIT),
    ),
  );
  const byFolder: Record<string, CollectionItem[]> = {};
  folderIds.forEach((id, i) => {
    byFolder[id] = (results[i].data ?? []) as CollectionItem[];
  });
  return byFolder;
}

export function useFolders(userId: string | undefined) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({});
  const [previewItems, setPreviewItems] = useState<Record<string, CollectionItem[]>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from('folders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    const resolved = await resolveCovers((data ?? []) as Folder[]);
    const sorted = resolved.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    setFolders(sorted);

    // Batch item count for all folders in a single query
    const folderIds = resolved.map(f => f.id);
    if (folderIds.length) {
      const { data: rows } = await supabase
        .from('collection_items')
        .select('folder_id')
        .in('folder_id', folderIds);
      const counts: Record<string, number> = {};
      for (const row of (rows ?? []) as { folder_id: string }[]) {
        counts[row.folder_id] = (counts[row.folder_id] ?? 0) + 1;
      }
      setItemCounts(counts);

      setPreviewItems(await fetchPreviewItems(folderIds));
    } else {
      setItemCounts({});
      setPreviewItems({});
    }

    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { folders, loading, refresh: load, itemCounts, previewItems };
}

// Route-param sentinel for "no player set" — never shown to the user (mapped
// to the "Other" label everywhere it's displayed).
export const NO_PLAYER_KEY = '__none__';

export type PlayerGroup = {
  key: string;
  label: string;
  items: CollectionItem[];
};

// Auto-grouped by collection_items.player (no schema change, no new table —
// reads the existing field rather than a managed grouping entity). Items
// with no player collect into one trailing "Other" group, shown only if any
// exist. Order: groups first seen in `items`' own order (typically
// newest-first from useItems), "Other" always last. Shared by the folder
// detail screen (app/collection/[folderId].tsx) and the Collection page's
// horizontal preview row so both group identically.
export function groupItemsByPlayer(items: CollectionItem[]): PlayerGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, PlayerGroup>();

  for (const item of items) {
    const trimmed = item.player?.trim();
    const key = trimmed || NO_PLAYER_KEY;
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: trimmed || 'Other', items: [] };
      byKey.set(key, group);
      order.push(key);
    }
    group.items.push(item);
  }

  order.sort((a, b) => (a === NO_PLAYER_KEY ? 1 : b === NO_PLAYER_KEY ? -1 : 0));
  return order.map((key) => byKey.get(key)!);
}

// Client-side match against already-loaded item data (title/player/team/
// brand) — no new query, matches this app's existing "filter what's already
// fetched" search convention (e.g. app/(tabs)/search.tsx's own card search
// runs against Supabase directly, but this is for filtering data already in
// memory on the Collection page and the folder detail screen). Empty query
// matches everything.
export function itemMatchesSearch(item: CollectionItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.title, item.player, item.team, item.brand]
    .filter((field): field is string => !!field)
    .some((field) => field.toLowerCase().includes(q));
}

export function useItems(folderId: string | undefined) {
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!folderId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from('collection_items')
      .select('*')
      .eq('folder_id', folderId)
      .order('created_at', { ascending: false });
    setItems(data ?? []);
    setLoading(false);
  }, [folderId]);

  useEffect(() => {
    load();
  }, [load]);

  return { items, loading, refresh: load };
}
