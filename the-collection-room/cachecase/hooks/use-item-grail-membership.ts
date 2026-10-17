import { useCallback, useEffect, useRef, useState } from 'react';

import { Alert } from 'react-native';

import { invalidateOwnProfileCache } from '@/lib/own-profile-cache';
import { supabase } from '@/lib/supabase';
import type { GrailSlot } from '@/types';

import {
  type ExpectedGrailSlot,
  insertGrailSlot,
  isGrailSlotRemoved,
  removeGrailSlotOptimistically,
  replaceGrailSlot,
  requestGrailSlotsReload,
  subscribeGrailSlotsEvents,
} from './use-grail-slots';

// Item Detail's Add/Remove Grails control. Needs only the signed-in user's
// slot rows — which slot holds this item (to remove it), which indexes are
// taken (Add fills the lowest empty one), and whether all 9 are full — so it
// reads just those five scalar columns (at most 9 rows), never the full
// Grails payload (embedded items, folders, preview items, image ids) that
// useGrailSlots loads for rendering the grid.
//
// Same return shape as hooks/use-grails.ts's useGrails, so Item Detail's
// call sites are unchanged. Stays in step with every full Grails view via
// use-grail-slots' shared event stream: removals from anywhere (Profile V2,
// this screen) apply here immediately, and removal itself goes through the
// same shared optimistic path, so other open surfaces update immediately too.
type SlotRow = Pick<GrailSlot, 'id' | 'slot_index' | 'entry_type' | 'item_id' | 'collection_id'>;

const SLOT_ROW_COLUMNS = 'id, slot_index, entry_type, item_id, collection_id';
const MAX_GRAIL_SLOTS = 9;
const EMPTY_ROWS: SlotRow[] = [];

type FetchResult = { ok: true; rows: SlotRow[] } | { ok: false };

async function fetchSlotRows(userId: string): Promise<FetchResult> {
  const { data, error } = await supabase
    .from('profile_grail_slots')
    .select(SLOT_ROW_COLUMNS)
    .eq('user_id', userId)
    .order('slot_index', { ascending: true });
  if (error) {
    console.error('[useItemGrailMembership] load failed:', error.message, error);
    return { ok: false };
  }
  // Same removed-id filter as the full loader: a removal still in flight
  // (or already committed) is never resurrected by a read that raced it.
  return { ok: true, rows: ((data ?? []) as SlotRow[]).filter((r) => !isGrailSlotRemoved(r.id)) };
}

export function useItemGrailMembership(userId: string | undefined) {
  // Rows are stored with the user they belong to, so after an account switch
  // nothing from the previous account is ever reported (it reads as
  // "loading" until the new user's rows arrive).
  const [state, setState] = useState<{ userId: string; rows: SlotRow[] } | null>(null);
  const stateRef = useRef<{ userId: string; rows: SlotRow[] } | null>(null);
  const loadSeqRef = useRef(0);

  // Latest rows for the CURRENT user only — what add/remove/event handling
  // read, so they never act on a previous account's rows.
  const currentRows = useCallback(
    () => (stateRef.current && stateRef.current.userId === userId ? stateRef.current.rows : EMPTY_ROWS),
    [userId],
  );

  const rows = state && state.userId === userId ? state.rows : EMPTY_ROWS;
  const loading = !!userId && state?.userId !== userId;

  const commit = useCallback(
    (next: SlotRow[]) => {
      if (!userId) return;
      stateRef.current = { userId, rows: next };
      setState(stateRef.current);
    },
    [userId],
  );

  const applyResult = useCallback(
    (result: FetchResult) => {
      if (result.ok) commit(result.rows);
      // Failed first load: settle as "not in Grails" so the control isn't
      // stuck; otherwise keep what's known. The next focus retries.
      else if (currentRows().length === 0) commit([]);
    },
    [commit, currentRows],
  );

  const load = useCallback(async () => {
    if (!userId) return;
    const seq = ++loadSeqRef.current;
    const result = await fetchSlotRows(userId);
    if (loadSeqRef.current === seq) applyResult(result);
  }, [userId, applyResult]);

  useEffect(() => {
    if (!userId) return;
    const seq = ++loadSeqRef.current;
    fetchSlotRows(userId).then((result) => {
      if (loadSeqRef.current === seq) applyResult(result);
    });
  }, [userId, applyResult]);

  // Removals/rollbacks/reloads from any Grails surface, including this one.
  useEffect(() => {
    if (!userId) return;
    return subscribeGrailSlotsEvents((event) => {
      if (event.userId !== userId) return;
      if (event.type === 'reload') {
        load();
      } else if (event.type === 'remove') {
        if (currentRows().some((r) => r.id === event.slotId)) {
          commit(currentRows().filter((r) => r.id !== event.slotId));
        }
      } else if (!currentRows().some((r) => r.id === event.slot.id)) {
        const { id, slot_index, entry_type, item_id, collection_id } = event.slot;
        commit(
          [...currentRows(), { id, slot_index, entry_type, item_id, collection_id }].sort(
            (a, b) => a.slot_index - b.slot_index,
          ),
        );
      }
    });
  }, [userId, load, commit, currentRows]);

  const isFull = rows.length >= MAX_GRAIL_SLOTS;

  const isInGrails = useCallback(
    (itemId: string) => rows.some((r) => r.entry_type === 'item' && r.item_id === itemId),
    [rows],
  );

  // Unchanged semantics from useGrails.addToGrails: strict INSERT into the
  // lowest empty slot_index, same conflict handling and alerts. Afterwards
  // only this lightweight list is re-read (to learn the new row's id) —
  // never the full Grails payload.
  const addToGrails = useCallback(
    async (itemId: string): Promise<void> => {
      if (!userId) return;
      const taken = new Set(currentRows().map((r) => r.slot_index));
      let nextIndex = 0;
      while (taken.has(nextIndex) && nextIndex < MAX_GRAIL_SLOTS) nextIndex++;
      if (nextIndex >= MAX_GRAIL_SLOTS) {
        Alert.alert('Grails Full', 'You already have 9 Grails. Remove one to add another.');
        return;
      }

      const { error, conflict } = await insertGrailSlot(userId, nextIndex, 'item', itemId);
      if (error) {
        await load();
        if (conflict === 'duplicate_source') {
          Alert.alert('Already in Grails', 'This item is already in another Grail slot.');
        } else if (conflict === 'slot_conflict') {
          Alert.alert('Try Again', 'That Grail slot changed. Please try again.');
        } else {
          Alert.alert('Error', 'Could not add to Grails. Please try again.');
        }
        return;
      }
      // The own Profile V2 screen may be holding a still-fresh cached copy
      // of these slots — mark it stale so its next focus reloads.
      invalidateOwnProfileCache(userId);
      await load();
    },
    [userId, load, currentRows],
  );

  // Optimistic, via the shared path: this button and every open Grails
  // surface update immediately; rollback/reload on failure is handled there.
  // No full slot copy exists here, so a failure reloads the views instead of
  // restoring a cached copy.
  const removeFromGrails = useCallback(
    async (itemId: string): Promise<void> => {
      if (!userId) return;
      const row = currentRows().find((r) => r.entry_type === 'item' && r.item_id === itemId);
      if (!row) {
        await load();
        Alert.alert('Not Found', 'This item was not found in your Grail slots.');
        return;
      }
      const outcome = await removeGrailSlotOptimistically(
        userId,
        { slotIndex: row.slot_index, expectedSlotId: row.id, expectedEntryType: 'item', expectedRefId: itemId },
        null,
      );
      if (outcome === 'removed') {
        invalidateOwnProfileCache(userId);
      } else if (outcome === 'conflict') {
        Alert.alert('Already Changed', 'That Grail slot changed or was already removed.');
      } else if (outcome === 'failed') {
        // Instant local rollback; the shared path's reload event re-reads
        // the real state everywhere as well.
        if (!currentRows().some((r) => r.id === row.id)) {
          commit([...currentRows(), row].sort((a, b) => a.slot_index - b.slot_index));
        }
        Alert.alert('Couldn’t remove from Grails. Try again.');
      }
    },
    [userId, load, commit, currentRows],
  );

  // "Replace a Grail" (all 9 full): points the chosen slot at `itemId`
  // through the existing replaceGrailSlot — one conditional UPDATE of that
  // one row, matched on the exact slot id/index/source the picker showed, so
  // the other eight rows are never touched and a slot that changed
  // meanwhile is never overwritten. The replaced item/collection itself is
  // untouched (the slot row only points at it), so it stays in its own
  // collection. The table's unique (user_id, item_id) index rules out the
  // item ending up in two slots; RLS (profile_grail_slots_update_own)
  // requires the caller to own both the slot and the item.
  //
  // Local state changes only after the server confirms — a failure leaves
  // the button and every Grails view exactly as they were. Resolves true on
  // success.
  const replaceGrail = useCallback(
    async (itemId: string, expected: ExpectedGrailSlot): Promise<boolean> => {
      if (!userId) return false;
      if (currentRows().some((r) => r.entry_type === 'item' && r.item_id === itemId)) {
        Alert.alert('Already in Grails', 'This item is already in your Grails.');
        return false;
      }
      const { error, conflict } = await replaceGrailSlot(userId, expected, 'item', itemId);
      if (error) {
        if (conflict === 'duplicate_source') {
          Alert.alert('Already in Grails', 'This item is already in another Grail slot.');
        } else if (conflict === 'slot_conflict') {
          Alert.alert('Try Again', 'That Grail slot changed. Please choose again.');
        } else {
          Alert.alert('Couldn’t Replace', 'Your Grails weren’t changed. Please try again.');
        }
        // A conflict means what's on screen is out of date — re-read it
        // everywhere (including the open picker). A plain failure changed
        // nothing, so there's nothing to re-read.
        if (conflict) requestGrailSlotsReload(userId);
        return false;
      }
      // Same row id and slot_index — only its source changed.
      commit(
        currentRows().map((r) =>
          r.id === expected.expectedSlotId ? { ...r, entry_type: 'item', item_id: itemId, collection_id: null } : r,
        ),
      );
      invalidateOwnProfileCache(userId);
      requestGrailSlotsReload(userId);
      return true;
    },
    [userId, commit, currentRows],
  );

  return { loading, isFull, isInGrails, addToGrails, removeFromGrails, replaceGrail, refresh: load };
}
