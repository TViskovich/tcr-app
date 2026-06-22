import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';
import type { CollectionItem, Folder } from '@/types';

export function useFolders(userId: string | undefined) {
  const [folders, setFolders] = useState<Folder[]>([]);
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
    setFolders(data ?? []);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { folders, loading, refresh: load };
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
