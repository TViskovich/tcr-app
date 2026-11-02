import { useCallback, useEffect, useRef, useState } from 'react';

import { checkTaggingAvailable } from '@/lib/content-tags';
import { attachPrimaryImageIds } from '@/lib/item-images';
import { supabase } from '@/lib/supabase';
import type { CollectionItem, Folder } from '@/types';

// Profile V2's Tagged tab: the Items and Collections other collectors have
// tagged `profileUserId` in (collection_item_tags / folder_tags,
// supabase/migrations/20261102120000_add_collector_tagging.sql). Always the
// profile being VIEWED — the viewer only changes what RLS lets them see:
// a tag row, and the content it points to, are readable exactly when that
// item/collection is (owner, public flag, nested-folder privacy, Grails).
// The content is the original owner's; nothing is copied.
//
// Not saved content: saved_cards / saved_folders stay with the Saved screen.

type Owner = { ownerUsername: string; ownerDisplayName: string | null; ownerAvatarUrl: string | null };

export type TaggedCardEntry = CollectionItem & Owner & { taggedAt: string };
export type TaggedFolderEntry = Folder & Owner & { taggedAt: string };

type ProfileRow = { id: string; username: string; display_name: string | null; avatar_url: string | null };

export function useTaggedContent(profileUserId: string | undefined) {
  const [cards, setCards] = useState<TaggedCardEntry[]>([]);
  const [folders, setFolders] = useState<TaggedFolderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Only the latest load may commit (same mechanism as useSavedAll).
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const stale = () => controller.signal.aborted || controllerRef.current !== controller;

    try {
      // A database without the tagging migration has nothing to show — and
      // is never queried for tag tables (lib/content-tags.ts).
      if (!profileUserId || !(await checkTaggingAvailable())) {
        if (stale()) return;
        setCards([]);
        setFolders([]);
        setFailed(false);
        return;
      }
      if (stale()) return;
      setLoading(true);

      const [itemTags, folderTags] = await Promise.all([
        supabase
          .from('collection_item_tags')
          .select('item_id, created_at')
          .eq('tagged_user_id', profileUserId)
          .order('created_at', { ascending: false })
          .abortSignal(controller.signal),
        supabase
          .from('folder_tags')
          .select('folder_id, created_at')
          .eq('tagged_user_id', profileUserId)
          .order('created_at', { ascending: false })
          .abortSignal(controller.signal),
      ]);
      if (stale()) return;
      if (itemTags.error) throw itemTags.error;
      if (folderTags.error) throw folderTags.error;
      const itemRows = (itemTags.data ?? []) as { item_id: string; created_at: string }[];
      const folderRows = (folderTags.data ?? []) as { folder_id: string; created_at: string }[];

      const [itemsRes, foldersRes] = await Promise.all([
        itemRows.length
          ? supabase.from('collection_items').select('*').in('id', itemRows.map((r) => r.item_id)).abortSignal(controller.signal)
          : Promise.resolve({ data: [] as CollectionItem[], error: null }),
        folderRows.length
          ? supabase.from('folders').select('*').in('id', folderRows.map((r) => r.folder_id)).abortSignal(controller.signal)
          : Promise.resolve({ data: [] as Folder[], error: null }),
      ]);
      if (stale()) return;
      if (itemsRes.error) throw itemsRes.error;
      if (foldersRes.error) throw foldersRes.error;
      // One batched primary-image lookup for every card (as useSavedAll).
      const itemList = await attachPrimaryImageIds((itemsRes.data ?? []) as CollectionItem[]);
      const folderList = (foldersRes.data ?? []) as Folder[];
      if (stale()) return;

      const ownerIds = [...new Set([...itemList.map((i) => i.user_id), ...folderList.map((f) => f.user_id)])];
      const { data: owners } = ownerIds.length
        ? await supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', ownerIds).abortSignal(controller.signal)
        : { data: [] as ProfileRow[] };
      if (stale()) return;

      const ownerMap = new Map(((owners ?? []) as ProfileRow[]).map((p) => [p.id, p]));
      const owner = (id: string): Owner => {
        const p = ownerMap.get(id);
        return { ownerUsername: p?.username ?? '', ownerDisplayName: p?.display_name ?? null, ownerAvatarUrl: p?.avatar_url ?? null };
      };
      const itemMap = new Map(itemList.map((i) => [i.id, i]));
      const folderMap = new Map(folderList.map((f) => [f.id, f]));

      // A tag whose content didn't come back (deleted, or not visible to
      // this viewer) is simply not shown.
      setCards(
        itemRows.flatMap((r) => {
          const item = itemMap.get(r.item_id);
          return item ? [{ ...item, ...owner(item.user_id), taggedAt: r.created_at }] : [];
        }),
      );
      setFolders(
        folderRows.flatMap((r) => {
          const folder = folderMap.get(r.folder_id);
          return folder ? [{ ...folder, ...owner(folder.user_id), taggedAt: r.created_at }] : [];
        }),
      );
      setFailed(false);
    } catch (e) {
      if (stale()) return;
      if (__DEV__) console.warn('[useTaggedContent] load failed:', (e as { message?: string })?.message ?? e);
      setFailed(true);
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setLoading(false);
      }
    }
  }, [profileUserId]);

  // The caller runs `refresh` (on focus — so returning from an item whose tag
  // was removed, or whose visibility changed, shows the current state); an
  // unmount cancels whatever is in flight.
  useEffect(() => () => controllerRef.current?.abort(), []);

  return { cards, folders, loading, failed, refresh: load };
}
