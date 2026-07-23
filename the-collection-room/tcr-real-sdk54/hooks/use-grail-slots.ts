import { useCallback, useEffect, useState } from 'react';

import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import type { GrailSlot, GrailSlotConflict, GrailSlotEntryType } from '@/types';

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

export function useGrailSlots(userId: string | undefined) {
  const [slots, setSlots] = useState<GrailSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setSlots([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const { data, error: queryError } = await supabase
      .from('profile_grail_slots')
      .select('*, item:collection_items(*), collection:folders(*)')
      .eq('user_id', userId)
      .order('slot_index', { ascending: true });

    if (queryError) {
      console.error('[useGrailSlots] query failed:', queryError.message, queryError);
      setError(queryError.message);
      setLoading(false);
      // Deliberately does not touch `slots` here — whatever was already
      // loaded (from a prior successful call) stays exactly as it was,
      // rather than a failed refresh wiping good data back to [].
      return;
    }

    let nextSlots = (data ?? []) as GrailSlot[];
    setError(null);

    // One uncapped, narrow-column query covering every collection slot's
    // folder at once — not a per-folder query (N+1) and not a single
    // global .limit() (which could let one busy folder starve another's
    // share of the cap). Every row for the batch's folders comes back;
    // capping/counting happens per-folder, client-side, below.
    const collectionIds = Array.from(
      new Set(
        nextSlots
          .filter((s) => s.entry_type === 'collection' && s.collection_id)
          .map((s) => s.collection_id as string),
      ),
    );

    if (collectionIds.length) {
      const { data: previewRows, error: previewError } = await supabase
        .from('collection_items')
        .select('folder_id, image_url, created_at')
        .in('folder_id', collectionIds)
        .order('created_at', { ascending: false });

      if (previewError) {
        // Preview images are a UX nicety layered on top of already-valid
        // slot data — a failed preview query must not block the slots
        // themselves (the label/count still renders from the joined
        // collection row) from showing.
        console.error('[useGrailSlots] preview query failed:', previewError.message, previewError);
      } else {
        const byFolder = new Map<string, { image_url: string | null }[]>();
        for (const row of (previewRows ?? []) as { folder_id: string; image_url: string | null }[]) {
          const list = byFolder.get(row.folder_id);
          if (list) list.push(row);
          else byFolder.set(row.folder_id, [row]);
        }

        nextSlots = nextSlots.map((slot) => {
          if (slot.entry_type !== 'collection' || !slot.collection_id) return slot;
          const rows = byFolder.get(slot.collection_id) ?? [];
          // collectionItemCount counts every row in the folder (not just
          // imaged ones) so "N items" always matches the folder's real
          // size, matching how the main Collection page counts items.
          const collectionItemCount = rows.length;
          const seen = new Set<string>();
          const previewImages: string[] = [];
          for (const row of rows) {
            const url = row.image_url?.trim();
            if (!url || seen.has(url)) continue;
            seen.add(url);
            previewImages.push(url);
            if (previewImages.length >= PREVIEW_IMAGE_LIMIT) break;
          }
          return { ...slot, previewImages, collectionItemCount };
        });
      }
    }

    setSlots(nextSlots);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { slots, loading, error, refresh: load };
}
