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

export function useFolders(userId: string | undefined) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({});
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
    setFolders(resolved);

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
    } else {
      setItemCounts({});
    }

    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { folders, loading, refresh: load, itemCounts };
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
