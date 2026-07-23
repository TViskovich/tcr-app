import { useCallback, useMemo } from 'react';

import { Alert } from 'react-native';

import { supabase } from '@/lib/supabase';
import type { CollectionItem, ShowcaseItem } from '@/types';

import { insertGrailSlot, useGrailSlots } from './use-grail-slots';

// Item-only compatibility view over the canonical profile_grail_slots
// table (hooks/use-grail-slots.ts / supabase/migrations/
// 20260723_create_profile_grail_slots.sql). Exported name and return
// shape are unchanged from before this table existed — every consumer
// (app/rate-my-grails/new.tsx, app/grails/[userId].tsx via
// components/profile/grails-grid.tsx & grails-slot.tsx, app/item/[id].tsx)
// keeps working with zero code changes of its own; they transparently
// only ever see entry_type: 'item' slots, translated back into the
// pre-existing ShowcaseItem shape. note/badge_type are always null here —
// confirmed unread by every consumer before this shim was written.
export function useGrails(userId: string | undefined) {
  const { slots, loading, refresh } = useGrailSlots(userId);

  const grails: ShowcaseItem[] = useMemo(
    () =>
      slots
        .filter((s): s is typeof s & { item: CollectionItem; item_id: string } => s.entry_type === 'item' && !!s.item)
        .map((s) => ({
          id: s.id,
          user_id: s.user_id,
          item_id: s.item_id,
          display_order: s.slot_index,
          note: null,
          badge_type: null,
          added_at: s.created_at,
          item: s.item,
        })),
    [slots],
  );

  // All 9 physical slots, any type — a collection slot occupies a
  // position too, so this means "no empty slot anywhere," not "9 items."
  const isFull = slots.length >= 9;

  function isInGrails(itemId: string): boolean {
    return slots.some((s) => s.entry_type === 'item' && s.item_id === itemId);
  }

  // Recomputes the lowest empty slot_index from the current render's
  // `slots` (via the dependency array) every time this is called — never
  // a captured/stale array from an earlier render. Uses insertGrailSlot
  // (a strict INSERT), not setGrailSlot (upsert) — this is an automatic
  // fill into a slot expected to be empty, not a deliberate Replace, so a
  // slot that got claimed between the computation above and the request
  // landing must surface as slot_conflict, never silently overwrite
  // whatever's now there.
  const addToGrails = useCallback(
    async (itemId: string): Promise<void> => {
      if (!userId) return;
      const taken = new Set(slots.map((s) => s.slot_index));
      let nextIndex = 0;
      while (taken.has(nextIndex) && nextIndex < 9) nextIndex++;
      if (nextIndex >= 9) {
        // Should already be prevented by the item-detail button's own
        // isFull-disabled state — handled defensively anyway.
        Alert.alert('Grails Full', 'You already have 9 Grails. Remove one to add another.');
        return;
      }

      const { error, conflict } = await insertGrailSlot(userId, nextIndex, 'item', itemId);
      if (error) {
        if (conflict === 'duplicate_source') {
          // Shouldn't be reachable from this button (isInGrails already
          // gates it) — handled defensively rather than assumed
          // unreachable. Refresh first so local state reflects the item's
          // real (already-occupied) slot before the alert is shown.
          await refresh();
          Alert.alert('Already in Grails', 'This item is already in another Grail slot.');
        } else if (conflict === 'slot_conflict') {
          // Someone/something else claimed nextIndex between the
          // computation above and this request landing. Refresh so the
          // grid reflects reality, but do not overwrite what's now in
          // that slot and do not automatically retry into a different
          // slot in this first version — the user can just tap Add again.
          await refresh();
          Alert.alert('Try Again', 'That Grail slot changed. Please try again.');
        } else {
          Alert.alert('Error', 'Could not add to Grails. Please try again.');
        }
        return;
      }
      await refresh();
    },
    [userId, slots, refresh],
  );

  // Deletes by (user_id, item_id) directly — not by first computing which
  // slot_index the item occupies and clearing that slot. More defensive
  // of the two equivalent approaches: removes every row matching this
  // user+item regardless of how many there are, rather than trusting
  // there's exactly one (which profile_grail_slots_unique_item should
  // guarantee, but this doesn't rely on that guarantee holding).
  // .select('id') makes the zero-row case distinguishable from a real
  // success — a request that returns no error but deletes nothing (e.g.
  // the row was already gone) must not be reported as a successful
  // removal.
  const removeFromGrails = useCallback(
    async (itemId: string): Promise<void> => {
      if (!userId) return;
      const { data: deletedRows, error } = await supabase
        .from('profile_grail_slots')
        .delete()
        .eq('user_id', userId)
        .eq('item_id', itemId)
        .select('id');

      if (error) {
        console.error('[useGrails] removeFromGrails failed:', error.message, error);
        Alert.alert('Error', 'Could not remove from Grails. Please try again.');
        return;
      }

      if (!deletedRows || deletedRows.length === 0) {
        console.error('[useGrails] removeFromGrails deleted zero rows for', { userId, itemId });
        await refresh();
        Alert.alert('Not Found', 'This item was not found in your Grail slots.');
        return;
      }

      await refresh();
    },
    [userId, refresh],
  );

  return { grails, loading, isFull, isInGrails, addToGrails, removeFromGrails, refresh };
}
