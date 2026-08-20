import { useCallback, useEffect, useState } from 'react';

import { attachPrimaryImageIds } from '@/lib/item-images';
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
    .eq('collection_status', 'active')
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
        .eq('collection_status', 'active')
        .order('created_at', { ascending: false })
        .limit(PREVIEW_ITEM_LIMIT),
    ),
  );
  // One flat batched primary_image_id lookup across every folder's preview
  // items combined — not one per folder — then re-split back by folder.
  const allItems = results.flatMap((r) => (r.data ?? []) as CollectionItem[]);
  const withPrimaryIds = await attachPrimaryImageIds(allItems);
  const byItemId = new Map(withPrimaryIds.map((i) => [i.id, i]));

  const byFolder: Record<string, CollectionItem[]> = {};
  folderIds.forEach((id, i) => {
    byFolder[id] = ((results[i].data ?? []) as CollectionItem[]).map(
      (item) => byItemId.get(item.id) ?? item,
    );
  });
  return byFolder;
}

// publicOnly restricts the folder list (and everything derived from it —
// item counts, preview items) to folders.is_public = true, for viewing
// someone else's profile — the account owner still sees every folder,
// public or private, so the default (false) preserves existing behavior
// for every current call site.
export function useFolders(userId: string | undefined, options?: { publicOnly?: boolean }) {
  const publicOnly = options?.publicOnly ?? false;
  const [folders, setFolders] = useState<Folder[]>([]);
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({});
  const [previewItems, setPreviewItems] = useState<Record<string, CollectionItem[]>>({});
  const [loading, setLoading] = useState(true);
  // Captures and surfaces `error` (unlike a plain `{ data }` destructure) so
  // a failed query is never indistinguishable from "you have zero
  // collections" — same convention as useAllItems below. Only the primary
  // folders query can set this; on failure, `folders` is deliberately left
  // untouched (never reset to []) so a refresh() that fails doesn't wipe an
  // already-loaded list off screen. Callers should pair `error` with
  // `folders.length > 0` to tell "still showing last known-good data" apart
  // from "nothing to show yet."
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      let query = supabase
        .from('folders')
        .select('*')
        .eq('user_id', userId);
      if (publicOnly) query = query.eq('is_public', true);
      const { data, error: queryError } = await query.order('created_at', { ascending: false });

      if (queryError) {
        console.error('[useFolders] query failed:', queryError.message, queryError);
        setError(queryError.message);
        return;
      }

      const resolved = await resolveCovers((data ?? []) as Folder[]);
      const sorted = resolved.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      );
      setFolders(sorted);
      setError(null);

      // Item counts + preview thumbnails are best-effort enrichment on top
      // of an already-successful folder load, isolated in their own
      // try/catch: a failure here must never flip the hook's main `error`
      // (that would make a genuinely successful folder load look failed)
      // and must never wipe previously-good counts/previews back to bogus
      // zeros/empties — setItemCounts/setPreviewItems below are simply
      // skipped on failure, so whatever was already there survives. Only a
      // legitimately-empty folder list (folderIds.length === 0, the `else`
      // below) clears them, which is correct — there's genuinely nothing
      // left to enrich.
      const folderIds = resolved.map(f => f.id);
      if (folderIds.length) {
        try {
          const { data: rows, error: countsError } = await supabase
            .from('collection_items')
            .select('folder_id')
            .eq('collection_status', 'active')
            .in('folder_id', folderIds);

          if (countsError) {
            console.error('[useFolders] item-count query failed (best-effort):', countsError.message, countsError);
          } else {
            const counts: Record<string, number> = {};
            for (const row of (rows ?? []) as { folder_id: string }[]) {
              counts[row.folder_id] = (counts[row.folder_id] ?? 0) + 1;
            }
            setItemCounts(counts);
          }

          setPreviewItems(await fetchPreviewItems(folderIds));
        } catch (enrichError) {
          console.error('[useFolders] item-count/preview enrichment failed (best-effort):', enrichError);
        }
      } else {
        setItemCounts({});
        setPreviewItems({});
      }
    } catch (e) {
      // A thrown exception from the primary folders query (as opposed to a
      // {data, error}-shaped result) — same defensive shape as
      // messages.tsx/use-profile.ts's load(). Never touches `folders`, so
      // previously-loaded data survives a failed refresh here too.
      console.error('[useFolders] load failed:', e);
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, [userId, publicOnly]);

  useEffect(() => {
    load();
  }, [load]);

  return { folders, loading, error, refresh: load, itemCounts, previewItems };
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
  // Same convention as useFolders/useAllItems above: captures and surfaces
  // `error` so a failed query is never indistinguishable from "this folder
  // has zero cards." On failure, `items` is deliberately left untouched
  // (never reset to []) so a refresh() that fails doesn't wipe an
  // already-loaded grid off screen.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!folderId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data, error: queryError } = await supabase
        .from('collection_items')
        .select('*')
        .eq('folder_id', folderId)
        .eq('collection_status', 'active')
        .order('created_at', { ascending: false });

      if (queryError) {
        console.error('[useItems] query failed:', queryError.message, queryError);
        setError(queryError.message);
        return;
      }

      setItems(await attachPrimaryImageIds((data ?? []) as CollectionItem[]));
      setError(null);
    } catch (e) {
      // A thrown exception (as opposed to a {data, error}-shaped result) —
      // same defensive shape as useFolders' load(). Never touches `items`,
      // so previously-loaded data survives a failed refresh here too.
      console.error('[useItems] load failed:', e);
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => {
    load();
  }, [load]);

  return { items, loading, error, refresh: load };
}

// Flat, all-folders view of a user's own collection_items — unlike
// useItems above, not scoped to one folder. Powers the Share Card picker
// (app/share-card/new.tsx), which needs to offer every card the user owns
// regardless of which folder it's filed under. Captures and surfaces
// `error` (unlike a plain `{ data }` destructure) so a failed query is
// never indistinguishable from "you have zero cards."
export function useAllItems(userId: string | undefined) {
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: queryError } = await supabase
      .from('collection_items')
      .select('*')
      .eq('user_id', userId)
      .eq('collection_status', 'active')
      .order('created_at', { ascending: false });
    if (queryError) {
      console.error('[useAllItems] query failed:', queryError.message, queryError);
      setError(queryError.message);
      setLoading(false);
      return;
    }
    setItems(await attachPrimaryImageIds((data ?? []) as CollectionItem[]));
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { items, loading, error, refresh: load };
}
