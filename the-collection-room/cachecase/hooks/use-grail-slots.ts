import { useCallback, useEffect, useRef, useState } from 'react';

import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import type { CollectionItem, Folder, GrailSlot, GrailSlotConflict, GrailSlotEntryType } from '@/types';

// The identity + current source a caller last saw for one occupied slot —
// what replaceGrailSlot and removeGrailSlot both re-verify, in their own
// single conditional statement, immediately before writing.
export type ExpectedGrailSlot = {
  slotIndex: number;
  expectedSlotId: string;
  expectedEntryType: GrailSlotEntryType;
  expectedRefId: string;
};

// The canonical, polymorphic hook backing the profile-tab 9-slot "Grail"
// grid (components/profile-v2/profile-v2-grid.tsx / profile-v2-screen.tsx)
// and, indirectly, the item-only hooks/use-grails.ts shim used by
// app/rate-my-grails/new.tsx, app/grails/[userId].tsx, and app/item/[id].tsx.
// See supabase/migrations/20260723_create_profile_grail_slots.sql for the
// table this reads/writes.

// Every collection-slot preview shows at most this many images —
// generous enough for a slow crossfade rotation, capped so a folder with
// hundreds of items never inflates a slot's in-memory image list.
const PREVIEW_IMAGE_LIMIT = 6;

// Not every 23505 on this table means the same thing — classify by which
// constraint actually fired, using the Postgres error's own message/
// details text (Postgres includes the constraint name in both). Shared by
// insertGrailSlot (a plain INSERT hitting a constraint) and
// replaceGrailSlot (a conditional UPDATE hitting one) — the constraint
// names Postgres reports are identical regardless of statement type.
// Unknown 23505s (a
// constraint added later that this code doesn't know about, a wording
// change in a future Postgres version) intentionally fall through to
// null — callers show a generic save-failure message rather than guessing.
export function classifyGrailSlotConflict(
  error: Pick<PostgrestError, 'code' | 'message' | 'details'> | null | undefined,
): GrailSlotConflict {
  if (!error || error.code !== '23505') return null;
  const text = `${error.message ?? ''}\n${error.details ?? ''}`;
  if (text.includes('profile_grail_slots_unique_item') || text.includes('profile_grail_slots_unique_collection')) {
    return 'duplicate_source';
  }
  // The table's own UNIQUE (user_id, slot_index) has no explicit name in
  // the migration, so Postgres auto-names it
  // "profile_grail_slots_user_id_slot_index_key" — matched here rather
  // than assumed, since that's the literal string Postgres puts in the
  // error text.
  if (text.includes('profile_grail_slots_user_id_slot_index_key')) {
    return 'slot_conflict';
  }
  return null;
}

function buildPayload(userId: string, slotIndex: number, entryType: GrailSlotEntryType, refId: string) {
  return {
    user_id: userId,
    slot_index: slotIndex,
    entry_type: entryType,
    item_id: entryType === 'item' ? refId : null,
    collection_id: entryType === 'collection' ? refId : null,
  };
}

// Strict insert, never upsert — for filling a slot expected to be empty
// (hooks/use-grails.ts's addToGrails, an automatic lowest-empty-slot
// fill). If another write took that exact slot_index between the caller
// computing it and this request reaching Postgres, .insert() fails on the
// table's own UNIQUE(user_id, slot_index) (→ slot_conflict) instead of
// silently overwriting whatever just landed there, which .upsert()'s
// onConflict path would do.
export async function insertGrailSlot(
  userId: string,
  slotIndex: number,
  entryType: GrailSlotEntryType,
  refId: string,
): Promise<{ error: string | null; conflict: GrailSlotConflict }> {
  const { error } = await supabase
    .from('profile_grail_slots')
    .insert(buildPayload(userId, slotIndex, entryType, refId));

  if (error) {
    console.error('[use-grail-slots] insertGrailSlot failed:', error.message, error);
    return { error: error.message, conflict: classifyGrailSlotConflict(error) };
  }
  return { error: null, conflict: null };
}

// A defensively-typed GrailSlot can theoretically have entry_type set but
// its corresponding id column null (shouldn't happen given the table's
// own CHECK constraint, but this reads the row as loaded client-side, not
// as guaranteed-valid) — this is the one place that resolves "the actual
// id this slot's entry_type points at," returning null rather than a
// cast that would silently paper over that case.
export function expectedRefIdForSlot(slot: GrailSlot): string | null {
  return slot.entry_type === 'item' ? slot.item_id : slot.collection_id;
}

// The only way a filled slot's source ever changes. A single conditional
// UPDATE, not a read-then-write and not an upsert — the WHERE clause IS
// the concurrency check: it matches the exact row (id + user_id +
// slot_index) AND the exact source the caller last saw (entry_type + the
// matching item_id/collection_id, with the *other* source column
// required to still be null). If anything about that has changed since
// the caller loaded it — a different item/collection now occupies the
// slot, the slot was removed, another replace already landed — the WHERE
// clause matches zero rows and nothing is overwritten.
export async function replaceGrailSlot(
  userId: string,
  expected: ExpectedGrailSlot,
  newEntryType: GrailSlotEntryType,
  newRefId: string,
): Promise<{ error: string | null; conflict: GrailSlotConflict }> {
  let query = supabase
    .from('profile_grail_slots')
    .update({
      entry_type: newEntryType,
      item_id: newEntryType === 'item' ? newRefId : null,
      collection_id: newEntryType === 'collection' ? newRefId : null,
    })
    .eq('id', expected.expectedSlotId)
    .eq('user_id', userId)
    .eq('slot_index', expected.slotIndex)
    .eq('entry_type', expected.expectedEntryType);

  query =
    expected.expectedEntryType === 'item'
      ? query.eq('item_id', expected.expectedRefId).is('collection_id', null)
      : query.eq('collection_id', expected.expectedRefId).is('item_id', null);

  const { data: updatedRows, error } = await query.select('id');

  if (error) {
    // A real Postgres failure — most relevantly, the NEW source
    // (newRefId) colliding with profile_grail_slots_unique_item/
    // _unique_collection because it's already assigned to a different
    // slot.
    console.error('[use-grail-slots] replaceGrailSlot failed:', error.message, error);
    return { error: error.message, conflict: classifyGrailSlotConflict(error) };
  }

  if (!updatedRows || updatedRows.length === 0) {
    // No Postgres error, but the WHERE clause matched nothing — the
    // expected row/source is no longer what it was. Synthesized as the
    // same slot_conflict shape callers already handle from a real 23505,
    // so this doesn't need its own separate code path downstream.
    console.error('[use-grail-slots] replaceGrailSlot matched zero rows for', expected);
    return { error: 'That Grail slot changed.', conflict: 'slot_conflict' };
  }

  return { error: null, conflict: null };
}

// Same optimistic-concurrency shape as replaceGrailSlot, for the same
// reason: a single conditional DELETE whose WHERE clause matches the
// exact row + exact source the caller captured before confirming, so a
// slot that changed out from under a confirmation dialog can never have
// whatever NOW occupies it deleted instead.
export async function removeGrailSlot(
  userId: string,
  expected: ExpectedGrailSlot,
): Promise<{ error: string | null; conflict: GrailSlotConflict }> {
  let query = supabase
    .from('profile_grail_slots')
    .delete()
    .eq('id', expected.expectedSlotId)
    .eq('user_id', userId)
    .eq('slot_index', expected.slotIndex)
    .eq('entry_type', expected.expectedEntryType);

  query =
    expected.expectedEntryType === 'item'
      ? query.eq('item_id', expected.expectedRefId).is('collection_id', null)
      : query.eq('collection_id', expected.expectedRefId).is('item_id', null);

  const { data: deletedRows, error } = await query.select('id');

  if (error) {
    console.error('[use-grail-slots] removeGrailSlot failed:', error.message, error);
    return { error: error.message, conflict: null };
  }

  if (!deletedRows || deletedRows.length === 0) {
    console.error('[use-grail-slots] removeGrailSlot matched zero rows for', expected);
    return { error: 'That Grail slot changed or was already removed.', conflict: 'slot_conflict' };
  }

  return { error: null, conflict: null };
}

// The single query behind useGrailSlots' load(). folders <-> collection_items
// has two foreign keys (collection_items.folder_id and folders.cover_item_id),
// so the folder's items are embedded through folder_id explicitly.
const GRAIL_SLOTS_SELECT =
  '*, item:collection_items(*, primary_image:collection_item_images(id)), ' +
  'collection:folders(*, preview_items:collection_items!collection_items_folder_id_fkey(id, primary_image:collection_item_images(id)))';

type EmbeddedPrimaryImage = { id: string }[] | null | undefined;
type RawGrailSlotRow = Omit<GrailSlot, 'item' | 'collection'> & {
  item?: (CollectionItem & { primary_image?: EmbeddedPrimaryImage }) | null;
  collection?: (Folder & { preview_items?: { id: string; primary_image?: EmbeddedPrimaryImage }[] | null }) | null;
};

// Raw embedded row -> the exact GrailSlot shape consumers (and the
// own-profile cache) have always seen: item.primary_image_id on item slots;
// previewImageIds + collectionItemCount on collection slots. The embedding
// helper keys are stripped so nothing new leaks into cached payloads.
function toGrailSlot(row: RawGrailSlotRow): GrailSlot {
  const { item, collection, ...rest } = row;
  const slot: GrailSlot = { ...rest };

  if (item !== undefined) {
    if (item) {
      const { primary_image, ...itemRest } = item;
      slot.item = { ...itemRest, primary_image_id: primary_image?.[0]?.id ?? null };
    } else {
      slot.item = null;
    }
  }

  if (collection !== undefined) {
    if (collection) {
      const { preview_items, ...folderRest } = collection;
      slot.collection = folderRest;
      if (row.entry_type === 'collection' && row.collection_id) {
        const previewItems = preview_items ?? [];
        // collectionItemCount counts every active item in the folder (not
        // just imaged ones) so "N items" matches the folder's real size,
        // matching how the main Collection page counts items.
        const seen = new Set<string>();
        const previewImageIds: string[] = [];
        for (const previewItem of previewItems) {
          const primaryImageId = previewItem.primary_image?.[0]?.id;
          if (!primaryImageId || seen.has(primaryImageId)) continue;
          seen.add(primaryImageId);
          previewImageIds.push(primaryImageId);
          if (previewImageIds.length >= PREVIEW_IMAGE_LIMIT) break;
        }
        slot.previewImageIds = previewImageIds;
        slot.collectionItemCount = previewItems.length;
      }
    } else {
      slot.collection = null;
    }
  }

  return slot;
}

// ── Optimistic removal, shared across every mounted useGrailSlots ──
//
// Several screens can have the same user's slots loaded at once (Profile V2
// stays mounted under an item's detail screen, for example), each in its own
// hook instance. A removal is applied to all of them immediately, before the
// DELETE round trip, and rolled back on failure — so no surface waits on the
// network or a refetch, and none disagrees with another.
//
// removedSlotIds holds slot row ids whose DELETE is in flight or has
// succeeded. A deleted row's id never comes back (re-adding inserts a new
// row), so every load() filters these out for the rest of the session — a
// refresh that started before the DELETE committed can't resurrect it.
const removedSlotIds = new Set<string>();
const inFlightRemovals = new Set<string>();

export type GrailSlotsEvent =
  | { type: 'remove'; userId: string; slotId: string }
  | { type: 'restore'; userId: string; slot: GrailSlot }
  | { type: 'reload'; userId: string };

const grailSlotsListeners = new Set<(event: GrailSlotsEvent) => void>();

function emitGrailSlotsEvent(event: GrailSlotsEvent) {
  grailSlotsListeners.forEach((listener) => listener(event));
}

// For lightweight Grails views that aren't a full useGrailSlots instance
// (hooks/use-item-grail-membership.ts) — the same event stream and the same
// removed-id filter, so they stay in step with every full instance.
export function subscribeGrailSlotsEvents(listener: (event: GrailSlotsEvent) => void): () => void {
  grailSlotsListeners.add(listener);
  return () => {
    grailSlotsListeners.delete(listener);
  };
}

export function isGrailSlotRemoved(slotId: string): boolean {
  return removedSlotIds.has(slotId);
}

// removed: the DELETE committed (local state already reflects it).
// failed: the DELETE errored; the slot has been restored everywhere.
// conflict: the slot changed or was already gone server-side; every
//   instance is reloading to show the real state.
// in_flight: a removal of this exact slot is already running; ignored.
export type RemoveGrailSlotOutcome = 'removed' | 'failed' | 'conflict' | 'in_flight';

// The shared optimistic removal behind useGrailSlots().removeSlot and
// useItemGrailMembership: the slot disappears from every mounted Grails view
// at once, then the existing conditional DELETE (removeGrailSlot) runs.
// `previous` is the caller's full copy of the slot, used to restore it
// everywhere on failure; a caller without one passes null and every view
// reloads instead.
export async function removeGrailSlotOptimistically(
  userId: string,
  expected: ExpectedGrailSlot,
  previous: GrailSlot | null,
): Promise<RemoveGrailSlotOutcome> {
  const slotId = expected.expectedSlotId;
  if (inFlightRemovals.has(slotId)) return 'in_flight';

  inFlightRemovals.add(slotId);
  removedSlotIds.add(slotId);
  emitGrailSlotsEvent({ type: 'remove', userId, slotId });

  let result: { error: string | null; conflict: GrailSlotConflict };
  try {
    result = await removeGrailSlot(userId, expected);
  } catch (e) {
    console.error('[useGrailSlots] removeSlot threw:', e);
    result = { error: 'threw', conflict: null };
  } finally {
    inFlightRemovals.delete(slotId);
  }

  if (!result.error) return 'removed';

  removedSlotIds.delete(slotId);
  if (result.conflict === 'slot_conflict' || !previous) {
    // Unknown current state — show whatever the server has now.
    emitGrailSlotsEvent({ type: 'reload', userId });
    return result.conflict === 'slot_conflict' ? 'conflict' : 'failed';
  }
  emitGrailSlotsEvent({ type: 'restore', userId, slot: previous });
  return 'failed';
}

// `seed`, when given (own-profile local cache — see lib/own-profile-cache.ts,
// own-profile only), hydrates `slots` synchronously at mount, for this exact
// `userId`, so load() below treats it as "already has data" (a background,
// non-blanking refresh) rather than a first load. Read once, at mount only.
export function useGrailSlots(
  userId: string | undefined,
  seed?: GrailSlot[] | null,
  skipInitialLoad?: boolean,
) {
  const [slots, setSlots] = useState<GrailSlot[]>(() => seed ?? []);
  const [loading, setLoading] = useState(() => !seed);
  const [error, setError] = useState<string | null>(null);
  const skipInitialLoadRef = useRef(skipInitialLoad ?? false);

  // Last successfully committed slots (and for which user), plus a sequence
  // number so an older, slower load can never overwrite a newer one. A
  // refresh (e.g. on returning from an item's detail screen) is
  // stale-while-revalidate: once slots exist for this user they stay on
  // screen — `loading` (which blanks the whole grid) is only raised for a
  // genuine first load — and a failed refresh keeps the slots (and image
  // ids) already shown.
  const slotsRef = useRef<{ userId: string | undefined; slots: GrailSlot[] }>(
    seed ? { userId, slots: seed } : { userId: undefined, slots: [] },
  );
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    if (!userId) {
      setSlots([]);
      setLoading(false);
      setError(null);
      return;
    }
    const seq = ++loadSeqRef.current;
    const hasData = slotsRef.current.userId === userId;
    if (!hasData) setLoading(true);
    try {
      await runLoad(seq);
    } catch (e) {
      // Never leave the grid stuck in its loading state over an unexpected
      // throw — whatever was already loaded stays as it was.
      console.error('[useGrailSlots] load threw:', e);
    } finally {
      if (loadSeqRef.current === seq) setLoading(false);
    }

    async function runLoad(loadSeq: number) {
    // One request for everything the grid needs — slots, each item slot's
    // item + primary image id, each collection slot's folder + its active
    // items (manual sort_order) + their primary image ids. Previously this
    // was up to four sequential round trips (slots, item image ids, folder
    // previews, preview image ids). Same rows and same RLS as those separate
    // queries: embedded resources are filtered by the same policies, and the
    // embedded filters below only trim embedded rows, never parent slots.
    // Signed image URLs are still resolved afterwards, by the renderer, via
    // useSignedItemImages and its own caches — slots render without
    // waiting on them.
    const { data, error: queryError } = await supabase
      .from('profile_grail_slots')
      .select(GRAIL_SLOTS_SELECT)
      .eq('user_id', userId)
      .eq('item.primary_image.is_primary', true)
      .eq('collection.preview_items.collection_status', 'active')
      .eq('collection.preview_items.primary_image.is_primary', true)
      .order('slot_index', { ascending: true })
      // Manual folder ordering (supabase/migrations/
      // 20260912120000_add_collection_item_manual_ordering.sql) — a
      // Grail-showcased collection's preview is "this folder's items in
      // order", same as every other consumer of that ordering.
      .order('sort_order', { referencedTable: 'collection.preview_items', ascending: true });

    if (loadSeqRef.current !== loadSeq) return;
    if (queryError) {
      console.error('[useGrailSlots] query failed:', queryError.message, queryError);
      setError(queryError.message);
      // Deliberately does not touch `slots` here — whatever was already
      // loaded (from a prior successful call) stays exactly as it was,
      // rather than a failed refresh wiping good data back to [].
      return;
    }

    const nextSlots = ((data ?? []) as unknown as RawGrailSlotRow[])
      .filter((s) => !removedSlotIds.has(s.id))
      .map(toGrailSlot);
    setError(null);

    slotsRef.current = { userId, slots: nextSlots };
    setSlots(nextSlots);
    }
  }, [userId]);

  // skipInitialLoad, when true, suppresses exactly this ONE automatic call
  // (captured once, at mount — a later change to the prop is ignored, same
  // as a seed); every subsequent invocation of `load` (a real userId
  // change, or the caller's own explicit refresh()) runs normally. Used by
  // Profile V2's own-profile freshness gate (see
  // components/profile-v2/profile-v2-screen.tsx) so a fresh local cache can
  // skip the redundant network round trip its own seed already made
  // unnecessary.
  useEffect(() => {
    if (skipInitialLoadRef.current) {
      skipInitialLoadRef.current = false;
      return;
    }
    load();
  }, [load]);

  // Persists a manual reorder (reorder_grail_slots RPC — see its migration)
  // and then applies the same permutation locally, so the grid updates in
  // place: the slot rows keep their ids/images/signed URLs and only their
  // slot_index changes, with no reload, blanking or image remount. The RPC
  // reuses the caller's occupied slot indexes in ascending order.
  const reorder = useCallback(async (orderedSlotIds: string[]): Promise<{ error: string | null }> => {
    const { error: rpcError } = await supabase.rpc('reorder_grail_slots', { p_slot_ids: orderedSlotIds });
    if (rpcError) {
      console.error('[useGrailSlots] reorder failed:', rpcError.message, rpcError);
      return { error: rpcError.message };
    }
    setSlots((prev) => {
      const indexes = prev.map((s) => s.slot_index).sort((a, b) => a - b);
      const byId = new Map(prev.map((s) => [s.id, s]));
      const next = orderedSlotIds.flatMap((id, i) => {
        const slot = byId.get(id);
        return slot ? [{ ...slot, slot_index: indexes[i] }] : [];
      });
      next.sort((a, b) => a.slot_index - b.slot_index);
      slotsRef.current = { userId, slots: next };
      return next;
    });
    return { error: null };
  }, [userId]);

  // Applies optimistic removals/rollbacks from any instance (including this
  // one) to this instance's slots.
  useEffect(() => {
    if (!userId) return;
    const listener = (event: GrailSlotsEvent) => {
      if (event.userId !== userId) return;
      if (event.type === 'reload') {
        load();
        return;
      }
      setSlots((prev) => {
        let next: GrailSlot[];
        if (event.type === 'remove') {
          if (!prev.some((s) => s.id === event.slotId)) return prev;
          next = prev.filter((s) => s.id !== event.slotId);
        } else {
          if (prev.some((s) => s.id === event.slot.id)) return prev;
          next = [...prev, event.slot].sort((a, b) => a.slot_index - b.slot_index);
        }
        slotsRef.current = { userId, slots: next };
        return next;
      });
    };
    grailSlotsListeners.add(listener);
    return () => {
      grailSlotsListeners.delete(listener);
    };
  }, [userId, load]);

  // Optimistic remove: the slot disappears everywhere at once, then the
  // existing conditional DELETE (removeGrailSlot) runs. A removal leaves
  // that slot_index empty — other slots keep their indexes, exactly as the
  // server does (no compaction). No refetch on success: the conditional
  // DELETE matched exactly the row shown, so local state already equals
  // the server's.
  const removeSlot = useCallback(
    async (expected: ExpectedGrailSlot): Promise<RemoveGrailSlotOutcome> => {
      if (!userId) return 'failed';
      const previous = slotsRef.current.slots.find((s) => s.id === expected.expectedSlotId) ?? null;
      return removeGrailSlotOptimistically(userId, expected, previous);
    },
    [userId],
  );

  return { slots, loading, error, refresh: load, reorder, removeSlot };
}
