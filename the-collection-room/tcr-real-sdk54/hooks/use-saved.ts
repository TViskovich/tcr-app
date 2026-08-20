import { useCallback, useEffect, useRef, useState } from 'react';

import { attachPrimaryImageIds } from '@/lib/item-images';
import { supabase } from '@/lib/supabase';
import type { CollectionItem, Folder } from '@/types';

// ─── Hydrated row types returned by useSavedAll ───────────────────────────────

export type SavedFolderEntry = Folder & {
  savedAt: string;
  ownerUsername: string;
  ownerDisplayName: string | null;
  ownerAvatarUrl: string | null;
};

export type SavedCardEntry = CollectionItem & {
  savedAt: string;
  ownerUsername: string;
  ownerDisplayName: string | null;
  ownerAvatarUrl: string | null;
};

export type SavedGrailsEntry = {
  ownerId: string;
  savedAt: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

// ─── Single-item save hooks (for save/unsave buttons on each page) ─────────────

// Internal generic — the three named exports below are the public API.
function useSavedEntity(
  table: string,
  idColumn: string,
  entityId: string | null | undefined,
  currentUserId: string | undefined,
) {
  const [isSaved, setIsSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // An in-flight request left running past the point this hook's owning
  // screen unmounts or entityId/currentUserId changes can have its
  // underlying XHR connection torn down by the native networking layer and
  // crash with whatwg-fetch's status-0 RangeError — see
  // hooks/use-profile.ts for the full mechanism writeup.
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!entityId || !currentUserId) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    supabase
      .from(table)
      .select(idColumn)
      .eq('user_id', currentUserId)
      .eq(idColumn, entityId)
      .abortSignal(controller.signal)
      .maybeSingle()
      .then(({ data }) => {
        if (abortControllerRef.current !== controller || controller.signal.aborted) return;
        setIsSaved(!!data);
      });

    return () => {
      controller.abort();
    };
  }, [table, idColumn, entityId, currentUserId]);

  async function toggle() {
    if (!entityId || !currentUserId || saving) return;
    setSaving(true);
    if (isSaved) {
      await supabase.from(table).delete()
        .eq('user_id', currentUserId).eq(idColumn, entityId);
      setIsSaved(false);
    } else {
      await supabase.from(table).insert({ user_id: currentUserId, [idColumn]: entityId });
      setIsSaved(true);
    }
    setSaving(false);
  }

  return { isSaved, saving, toggle };
}

export function useSavedFolder(folderId: string | null | undefined, currentUserId: string | undefined) {
  return useSavedEntity('saved_folders', 'folder_id', folderId, currentUserId);
}

export function useSavedCard(itemId: string | null | undefined, currentUserId: string | undefined) {
  return useSavedEntity('saved_cards', 'item_id', itemId, currentUserId);
}

export function useSavedGrails(ownerId: string | null | undefined, currentUserId: string | undefined) {
  return useSavedEntity('saved_grails', 'owner_id', ownerId, currentUserId);
}

// ─── Combined hook for the Saved screen ──────────────────────────────────────

export function useSavedAll(currentUserId: string | undefined) {
  const [folders, setFolders] = useState<SavedFolderEntry[]>([]);
  const [cards, setCards] = useState<SavedCardEntry[]>([]);
  const [grails, setGrails] = useState<SavedGrailsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Holds the AbortController for whichever load() batch is currently
  // "active" (the only one allowed to commit state) — same mechanism as
  // hooks/use-profile.ts. refresh() (exposed below) reuses this same load,
  // so there's only ever one flag/one controller to guard, unlike screens
  // with a separate pull-to-refresh operation.
  const abortControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    if (!currentUserId) {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      setFolders([]);
      setCards([]);
      setGrails([]);
      setLoading(false);
      return;
    }
    setLoading(true);

    try {
      // Round 1: fetch all three save lists in parallel
      const [foldersRes, cardsRes, grailsRes] = await Promise.all([
        supabase
          .from('saved_folders')
          .select('folder_id, created_at')
          .eq('user_id', currentUserId)
          .order('created_at', { ascending: false })
          .abortSignal(controller.signal),
        supabase
          .from('saved_cards')
          .select('item_id, created_at')
          .eq('user_id', currentUserId)
          .order('created_at', { ascending: false })
          .abortSignal(controller.signal),
        supabase
          .from('saved_grails')
          .select('owner_id, created_at')
          .eq('user_id', currentUserId)
          .order('created_at', { ascending: false })
          .abortSignal(controller.signal),
      ]);

      if (abortControllerRef.current !== controller || controller.signal.aborted) return;

      const folderRows = (foldersRes.data ?? []) as { folder_id: string; created_at: string }[];
      const cardRows   = (cardsRes.data  ?? []) as { item_id: string;   created_at: string }[];
      const grailRows  = (grailsRes.data ?? []) as { owner_id: string;  created_at: string }[];

      // Round 2: entity fetches for folders/cards + grails profiles — all parallel.
      // Grails owner IDs are already known from Round 1, so their profile fetch
      // starts at the same time as the folder and card entity fetches.
      const grailOwnerIds = [...new Set(grailRows.map(r => r.owner_id))];

      const [folderData, cardData, grailProfileData] = await Promise.all([
        folderRows.length
          ? supabase
              .from('folders')
              .select('*')
              .in('id', folderRows.map(r => r.folder_id))
              .eq('is_public', true)
              .abortSignal(controller.signal)
          : Promise.resolve({ data: [] as Folder[] }),
        cardRows.length
          ? supabase
              .from('collection_items')
              .select('*')
              .in('id', cardRows.map(r => r.item_id))
              .abortSignal(controller.signal)
          : Promise.resolve({ data: [] as CollectionItem[] }),
        grailOwnerIds.length
          ? supabase
              .from('profiles')
              .select('id, username, display_name, avatar_url')
              .in('id', grailOwnerIds)
              .abortSignal(controller.signal)
          : Promise.resolve({ data: [] as any[] }),
      ]);

      if (abortControllerRef.current !== controller || controller.signal.aborted) return;

      const folderList = (folderData.data ?? []) as Folder[];
      // Attaches primary_image_id (item-images beta privacy hardening,
      // Phase 3C) in one batched query — never one per saved card.
      const cardList = await attachPrimaryImageIds((cardData.data ?? []) as CollectionItem[]);

      if (abortControllerRef.current !== controller || controller.signal.aborted) return;

      // Round 3: one combined profile query for all folder and card owners.
      // Set deduplication means a shared owner is fetched only once even if
      // they appear in both lists.
      const entityOwnerIds = [...new Set([
        ...folderList.map(f => f.user_id),
        ...cardList.map(i => i.user_id),
      ])];

      const { data: entityProfileRows } = entityOwnerIds.length
        ? await supabase
            .from('profiles')
            .select('id, username, display_name, avatar_url')
            .in('id', entityOwnerIds)
            .abortSignal(controller.signal)
        : { data: [] as any[] };

      if (abortControllerRef.current !== controller || controller.signal.aborted) return;

      // Build lookup maps then assemble the three result arrays.
      const entityProfileMap = new Map((entityProfileRows ?? []).map((p: any) => [p.id, p]));
      const grailProfileMap  = new Map((grailProfileData.data ?? []).map((p: any) => [p.id, p]));
      const folderMap        = new Map(folderList.map(f => [f.id, f]));
      const cardMap          = new Map(cardList.map(i => [i.id, i]));

      setFolders(
        folderRows
          .map(r => {
            const folder = folderMap.get(r.folder_id);
            if (!folder) return null; // deleted or became private
            const p: any = entityProfileMap.get(folder.user_id) ?? {};
            return {
              ...folder,
              savedAt: r.created_at,
              ownerUsername: p.username ?? '',
              ownerDisplayName: p.display_name ?? null,
              ownerAvatarUrl: p.avatar_url ?? null,
            };
          })
          .filter((x): x is SavedFolderEntry => x !== null),
      );

      setCards(
        cardRows
          .map(r => {
            const item = cardMap.get(r.item_id);
            if (!item) return null; // deleted
            const p: any = entityProfileMap.get(item.user_id) ?? {};
            return {
              ...item,
              savedAt: r.created_at,
              ownerUsername: p.username ?? '',
              ownerDisplayName: p.display_name ?? null,
              ownerAvatarUrl: p.avatar_url ?? null,
            };
          })
          .filter((x): x is SavedCardEntry => x !== null),
      );

      setGrails(
        grailRows
          .map(r => {
            const p: any = grailProfileMap.get(r.owner_id);
            if (!p) return null; // account deleted
            return {
              ownerId: r.owner_id,
              savedAt: r.created_at,
              username: p.username,
              displayName: p.display_name ?? null,
              avatarUrl: p.avatar_url ?? null,
            };
          })
          .filter((x): x is SavedGrailsEntry => x !== null),
      );
    } catch (e) {
      if (controller.signal.aborted || abortControllerRef.current !== controller) return;
      if (__DEV__) console.error('[useSavedAll] load failed:', e);
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [currentUserId]);

  useEffect(() => {
    load();
    return () => abortControllerRef.current?.abort();
  }, [load]);

  return { folders, cards, grails, loading, refresh: load };
}
