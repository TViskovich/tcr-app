import { useCallback, useEffect, useState } from 'react';

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

export function useSavedFolder(folderId: string | null | undefined, currentUserId: string | undefined) {
  const [isSaved, setIsSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!folderId || !currentUserId) return;
    supabase
      .from('saved_folders')
      .select('folder_id')
      .eq('user_id', currentUserId)
      .eq('folder_id', folderId)
      .maybeSingle()
      .then(({ data }) => setIsSaved(!!data));
  }, [folderId, currentUserId]);

  async function toggle() {
    if (!folderId || !currentUserId || saving) return;
    setSaving(true);
    if (isSaved) {
      await supabase.from('saved_folders').delete()
        .eq('user_id', currentUserId).eq('folder_id', folderId);
      setIsSaved(false);
    } else {
      await supabase.from('saved_folders').insert({ user_id: currentUserId, folder_id: folderId });
      setIsSaved(true);
    }
    setSaving(false);
  }

  return { isSaved, saving, toggle };
}

export function useSavedCard(itemId: string | null | undefined, currentUserId: string | undefined) {
  const [isSaved, setIsSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!itemId || !currentUserId) return;
    supabase
      .from('saved_cards')
      .select('item_id')
      .eq('user_id', currentUserId)
      .eq('item_id', itemId)
      .maybeSingle()
      .then(({ data }) => setIsSaved(!!data));
  }, [itemId, currentUserId]);

  async function toggle() {
    if (!itemId || !currentUserId || saving) return;
    setSaving(true);
    if (isSaved) {
      await supabase.from('saved_cards').delete()
        .eq('user_id', currentUserId).eq('item_id', itemId);
      setIsSaved(false);
    } else {
      await supabase.from('saved_cards').insert({ user_id: currentUserId, item_id: itemId });
      setIsSaved(true);
    }
    setSaving(false);
  }

  return { isSaved, saving, toggle };
}

export function useSavedGrails(ownerId: string | null | undefined, currentUserId: string | undefined) {
  const [isSaved, setIsSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!ownerId || !currentUserId) return;
    supabase
      .from('saved_grails')
      .select('owner_id')
      .eq('user_id', currentUserId)
      .eq('owner_id', ownerId)
      .maybeSingle()
      .then(({ data }) => setIsSaved(!!data));
  }, [ownerId, currentUserId]);

  async function toggle() {
    if (!ownerId || !currentUserId || saving) return;
    setSaving(true);
    if (isSaved) {
      await supabase.from('saved_grails').delete()
        .eq('user_id', currentUserId).eq('owner_id', ownerId);
      setIsSaved(false);
    } else {
      await supabase.from('saved_grails').insert({ user_id: currentUserId, owner_id: ownerId });
      setIsSaved(true);
    }
    setSaving(false);
  }

  return { isSaved, saving, toggle };
}

// ─── Combined hook for the Saved screen ──────────────────────────────────────

export function useSavedAll(currentUserId: string | undefined) {
  const [folders, setFolders] = useState<SavedFolderEntry[]>([]);
  const [cards, setCards] = useState<SavedCardEntry[]>([]);
  const [grails, setGrails] = useState<SavedGrailsEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!currentUserId) {
      setFolders([]);
      setCards([]);
      setGrails([]);
      setLoading(false);
      return;
    }
    setLoading(true);

    // Round 1: fetch all three save lists in parallel
    const [foldersRes, cardsRes, grailsRes] = await Promise.all([
      supabase
        .from('saved_folders')
        .select('folder_id, created_at')
        .eq('user_id', currentUserId)
        .order('created_at', { ascending: false }),
      supabase
        .from('saved_cards')
        .select('item_id, created_at')
        .eq('user_id', currentUserId)
        .order('created_at', { ascending: false }),
      supabase
        .from('saved_grails')
        .select('owner_id, created_at')
        .eq('user_id', currentUserId)
        .order('created_at', { ascending: false }),
    ]);

    const folderRows = (foldersRes.data ?? []) as { folder_id: string; created_at: string }[];
    const cardRows   = (cardsRes.data  ?? []) as { item_id: string;   created_at: string }[];
    const grailRows  = (grailsRes.data ?? []) as { owner_id: string;  created_at: string }[];

    // Round 2: hydrate each type in parallel
    await Promise.all([
      // ── Folders ──────────────────────────────────────────────────────────────
      (async () => {
        if (!folderRows.length) { setFolders([]); return; }

        const { data: folderData } = await supabase
          .from('folders')
          .select('*')
          .in('id', folderRows.map(r => r.folder_id))
          .eq('is_public', true); // silently drop private folders

        const folderList = (folderData ?? []) as Folder[];
        if (!folderList.length) { setFolders([]); return; }

        const ownerIds = [...new Set(folderList.map(f => f.user_id))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url')
          .in('id', ownerIds);

        const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
        const folderMap  = new Map(folderList.map(f => [f.id, f]));

        setFolders(
          folderRows
            .map(r => {
              const folder = folderMap.get(r.folder_id);
              if (!folder) return null; // deleted or became private
              const p: any = profileMap.get(folder.user_id) ?? {};
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
      })(),

      // ── Cards ─────────────────────────────────────────────────────────────────
      (async () => {
        if (!cardRows.length) { setCards([]); return; }

        const { data: itemData } = await supabase
          .from('collection_items')
          .select('*')
          .in('id', cardRows.map(r => r.item_id));

        const itemList = (itemData ?? []) as CollectionItem[];
        if (!itemList.length) { setCards([]); return; }

        const ownerIds = [...new Set(itemList.map(i => i.user_id))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url')
          .in('id', ownerIds);

        const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
        const itemMap    = new Map(itemList.map(i => [i.id, i]));

        setCards(
          cardRows
            .map(r => {
              const item = itemMap.get(r.item_id);
              if (!item) return null; // deleted
              const p: any = profileMap.get(item.user_id) ?? {};
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
      })(),

      // ── Grails ────────────────────────────────────────────────────────────────
      (async () => {
        if (!grailRows.length) { setGrails([]); return; }

        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url')
          .in('id', grailRows.map(r => r.owner_id));

        const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));

        setGrails(
          grailRows
            .map(r => {
              const p: any = profileMap.get(r.owner_id);
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
      })(),
    ]);

    setLoading(false);
  }, [currentUserId]);

  useEffect(() => { load(); }, [load]);

  return { folders, cards, grails, loading, refresh: load };
}
