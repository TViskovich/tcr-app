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

// One entry in a mixed folder/item grid or preview row — a child folder is
// a first-class entry alongside collection_items, never faked as one.
// Shared (exported) so app/collection/[folderId].tsx's full grid and every
// preview row below build/sort this exact same shape with the exact same
// comparator, rather than two independently-written "mostly the same"
// implementations that could drift apart.
export type CollectionGridEntry =
  | { kind: 'item'; item: CollectionItem }
  | { kind: 'folder'; folder: Folder };

// The one ordering rule for a mixed grid/preview: newest created_at first,
// exactly matching the plain created_at DESC every collection_items query
// in this file already used before folders could appear alongside items.
// `kind` never participates in the comparison — only recency decides
// position, so a folder and an item interleave by timestamp, never by type.
export function compareGridEntriesByRecency(a: CollectionGridEntry, b: CollectionGridEntry): number {
  const aTime = new Date(a.kind === 'folder' ? a.folder.created_at : a.item.created_at).getTime();
  const bTime = new Date(b.kind === 'folder' ? b.folder.created_at : b.item.created_at).getTime();
  return bTime - aTime;
}

// Direct child folders of each requested (top-level) folder, capped and
// ordered exactly like fetchPreviewItems above — same PREVIEW_ITEM_LIMIT,
// same newest-first order, same one-batched-query-per-caller-id shape (never
// one request per folder id beyond that). Capping each side to
// PREVIEW_ITEM_LIMIT independently is sufficient for a correct combined
// top-PREVIEW_ITEM_LIMIT-by-recency merge below: the final row can never
// contain more than PREVIEW_ITEM_LIMIT entries of either kind, so neither
// side ever needs to look further back than its own top PREVIEW_ITEM_LIMIT.
async function fetchChildFolderPreviews(folderIds: string[]): Promise<Record<string, Folder[]>> {
  if (!folderIds.length) return {};
  const results = await Promise.all(
    folderIds.map((id) =>
      supabase
        .from('folders')
        .select('*')
        .eq('parent_folder_id', id)
        .order('created_at', { ascending: false })
        .limit(PREVIEW_ITEM_LIMIT),
    ),
  );
  const byFolder: Record<string, Folder[]> = {};
  folderIds.forEach((id, i) => {
    byFolder[id] = (results[i].data ?? []) as Folder[];
  });
  return byFolder;
}

// Merges each folder's own preview items with its own direct child-folder
// previews into one recency-sorted, PREVIEW_ITEM_LIMIT-capped list per
// folder id — the combined cap (not one cap per kind) is what guarantees no
// slot is ever reserved for either kind; whichever entries are genuinely
// most recent fill the row, in whatever kind mix that produces.
function buildPreviewEntries(
  folderIds: string[],
  itemsByFolder: Record<string, CollectionItem[]>,
  childFoldersByFolder: Record<string, Folder[]>,
): Record<string, CollectionGridEntry[]> {
  const byFolder: Record<string, CollectionGridEntry[]> = {};
  for (const id of folderIds) {
    const combined: CollectionGridEntry[] = [
      ...(childFoldersByFolder[id] ?? []).map((folder) => ({ kind: 'folder' as const, folder })),
      ...(itemsByFolder[id] ?? []).map((item) => ({ kind: 'item' as const, item })),
    ];
    combined.sort(compareGridEntriesByRecency);
    byFolder[id] = combined.slice(0, PREVIEW_ITEM_LIMIT);
  }
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
  // Mixed item/child-folder rows for rendering (see buildPreviewEntries) —
  // kept separate from previewItems above, which stays items-only and
  // drives filteredFolders' search matching in app/(tabs)/collection.tsx
  // unchanged. Combining the two into one field would shrink the pool of
  // items available to search whenever a folder's recent activity pushes an
  // item out of the shared cap — previewItems intentionally never competes
  // with folders for its own slots.
  const [previewEntries, setPreviewEntries] = useState<Record<string, CollectionGridEntry[]>>({});
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
      // Top-level only — nested child folders (parent_folder_id set) are
      // fetched separately by useChildFolders below, scoped to whichever
      // folder is currently open. Without this filter every child folder
      // would also show up flat here, alongside its own parent.
      let query = supabase
        .from('folders')
        .select('*')
        .eq('user_id', userId)
        .is('parent_folder_id', null);
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

          // Item previews come first and stand entirely on their own — this
          // is the exact same fetchPreviewItems call this hook always made,
          // so it must keep succeeding/failing independently of anything
          // else added later. previewEntries is derived from it immediately
          // (items-only) so the preview is never left empty even if the
          // child-folder enrichment below never runs or fails.
          const itemsByFolder = await fetchPreviewItems(folderIds);
          setPreviewItems(itemsByFolder);
          setPreviewEntries(buildPreviewEntries(folderIds, itemsByFolder, {}));

          // Child-folder preview entries are additional, best-effort
          // enrichment on top of the always-reliable item previews above —
          // isolated in their own try/catch so a failure in this newer,
          // separate query (e.g. a transient network blip) can never
          // suppress the item previews that already worked before nested
          // folders existed. Previously both were awaited together via one
          // Promise.all, which meant a rejection here discarded the
          // already-successful item-preview result too and left every
          // folder's preview empty — this restores independence.
          try {
            const childFoldersByFolder = await fetchChildFolderPreviews(folderIds);
            setPreviewEntries(buildPreviewEntries(folderIds, itemsByFolder, childFoldersByFolder));
          } catch (childFolderError) {
            console.error(
              '[useFolders] child-folder preview enrichment failed (best-effort):',
              childFolderError,
            );
          }
        } catch (enrichError) {
          console.error('[useFolders] item-count/preview enrichment failed (best-effort):', enrichError);
        }
      } else {
        setItemCounts({});
        setPreviewItems({});
        setPreviewEntries({});
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

  return { folders, loading, error, refresh: load, itemCounts, previewItems, previewEntries };
}

// Direct children (one level only — never grandchildren) of one folder, for
// the folder-detail screen's own child-folder section
// (app/collection/[folderId].tsx). No privacy filtering here: RLS's
// folder_is_effectively_visible already enforces recursive ancestor privacy
// server-side for every role (owner/public/anon), so this hook simply
// renders whatever rows come back — duplicating that check client-side
// would be redundant at best and a second place for it to drift out of
// sync at worst.
export function useChildFolders(parentFolderId: string | undefined) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  // Same convention as useFolders/useItems above: captures and surfaces
  // `error` so a failed query is never indistinguishable from "this folder
  // has no child folders." On failure, `folders` is deliberately left
  // untouched so a refresh() that fails doesn't wipe an already-loaded list.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!parentFolderId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data, error: queryError } = await supabase
        .from('folders')
        .select('*')
        .eq('parent_folder_id', parentFolderId)
        .order('name', { ascending: true });

      if (queryError) {
        console.error('[useChildFolders] query failed:', queryError.message, queryError);
        setError(queryError.message);
        return;
      }

      setFolders((data ?? []) as Folder[]);
      setError(null);
    } catch (e) {
      console.error('[useChildFolders] load failed:', e);
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, [parentFolderId]);

  useEffect(() => {
    load();
  }, [load]);

  return { folders, loading, error, refresh: load };
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
export type CollectionItemWithFolderVisibility = CollectionItem & {
  // Parent folder's own is_public — needed alongside the item's own
  // is_public wherever a caller has to compute effective (most-restrictive-
  // wins) visibility, e.g. app/share-card/new.tsx deciding what's eligible
  // to post to the public feed. Not part of the shared CollectionItem type
  // itself (that's a straight collection_items row shape) — this is a
  // join result specific to this hook.
  folder_is_public: boolean;
};

// publicOnly mirrors useFolders' own option above — explicit client-side
// filter as defense-in-depth alongside items_select_public's own recursive
// folder-chain + item.is_public RLS check (supabase/migrations/
// 20260902120000_recursive_folder_hierarchy_privacy.sql), which already
// authoritatively restricts a non-owner's read to public items in public
// folder trees. Defaults to false so the existing Share Card picker call
// site (always the signed-in user's own id) is unaffected; a caller viewing
// someone else's profile (Profile V2/V3's own isOwnProfile) should pass true.
export function useAllItems(userId: string | undefined, options?: { publicOnly?: boolean }) {
  const publicOnly = options?.publicOnly ?? false;
  const [items, setItems] = useState<CollectionItemWithFolderVisibility[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    // Extends the existing select with one embedded field (folders(is_public))
    // rather than a second, separate query — every caller of this hook needs
    // the item's own privacy either way, and this is the smallest addition
    // that also gives callers the parent folder's, for computing effective
    // (most-restrictive-wins) visibility without a duplicate lookup.
    //
    // Explicit !collection_items_folder_id_fkey — folders.cover_item_id
    // (20260901120000_add_folder_cover_item_id.sql) gave PostgREST a SECOND
    // foreign-key path between collection_items and folders (alongside this
    // one, the item's actual containing folder), so a bare `folders(...)`
    // embed here is now ambiguous and fails with PGRST201. This must always
    // resolve via the item's folder_id, never via folders.cover_item_id —
    // that FK answers "which item is this folder's cover", not "which
    // folder is this item in".
    let query = supabase
      .from('collection_items')
      .select('*, folders!collection_items_folder_id_fkey(is_public)')
      .eq('user_id', userId)
      .eq('collection_status', 'active');
    if (publicOnly) query = query.eq('is_public', true);
    const { data, error: queryError } = await query.order('created_at', { ascending: false });
    if (queryError) {
      console.error('[useAllItems] query failed:', queryError.message, queryError);
      setError(queryError.message);
      setLoading(false);
      return;
    }
    let rows = (data ?? []) as (CollectionItem & { folders: { is_public: boolean } | null })[];

    // Grail-slot visibility exception (supabase/migrations/20260910120000_
    // grail_slot_visibility_exception.sql, "Grail placement = implicit
    // publish") adds a narrow OR branch to items_select_public that lets a
    // Grail-showcased item's row come back from THIS query even when its
    // folder chain isn't actually public — deliberately, so
    // profile_grail_slots' own embedded item:collection_items(*) join can
    // resolve it for the Grails showcase. That exception is scoped to
    // rendering Grails only; it must never leak into this general,
    // all-folders Items tab (collection_items.is_public defaults to true,
    // so a Grail-referenced item in an otherwise-private folder would
    // otherwise pass this query's own `.eq('is_public', true)` filter and
    // appear here regardless of its folder's real privacy). Re-derive the
    // ORIGINAL folder-chain visibility per distinct folder via the
    // ancestor-aware folder_is_effectively_visible RPC (granted to anon/
    // authenticated; takes no explicit caller argument, so it can't be
    // spoofed — see that migration's own revision note) and drop any row
    // whose folder isn't actually visible under that rule — i.e. any row
    // that only came back because of the Grail exception. A no-op, and
    // skipped entirely, when publicOnly is false (the owner's own view,
    // and the Share Card picker's call site, are unaffected). One RPC call
    // per distinct folder actually present in this result (typically a
    // handful), run in parallel — never one per item.
    if (publicOnly && rows.length) {
      const distinctFolderIds = [...new Set(rows.map((r) => r.folder_id))];
      const visibilityEntries = await Promise.all(
        distinctFolderIds.map(async (folderId) => {
          const { data: visible, error: visibilityError } = await supabase.rpc(
            'folder_is_effectively_visible',
            { target_folder_id: folderId },
          );
          if (visibilityError) {
            console.error('[useAllItems] folder_is_effectively_visible failed:', visibilityError.message, visibilityError);
          }
          // Fail closed: an RPC error drops the row rather than risking a
          // Grail-only-visible item slipping through unverified.
          return [folderId, visible === true] as const;
        }),
      );
      const folderVisibleById = new Map(visibilityEntries);
      rows = rows.filter((r) => folderVisibleById.get(r.folder_id) === true);
    }

    const withFolderVisibility = rows.map(({ folders, ...item }) => ({
      ...item,
      folder_is_public: folders?.is_public ?? false,
    }));
    setItems(await attachPrimaryImageIds(withFolderVisibility));
    setLoading(false);
  }, [userId, publicOnly]);

  useEffect(() => {
    load();
  }, [load]);

  return { items, loading, error, refresh: load };
}
