import { useCallback, useMemo } from 'react';

import { Alert } from 'react-native';

import { invalidateOwnProfileCache } from '@/lib/own-profile-cache';
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
  const { slots, loading, refresh, removeSlot } = useGrailSlots(userId);

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
      // The own Profile V2 screen may be holding a still-fresh cached copy
      // of these slots — mark it stale so its next focus reloads.
      invalidateOwnProfileCache(userId);
      await refresh();
    },
    [userId, slots, refresh],
  );

  // Optimistic: the item leaves every mounted Grails surface (this screen
  // and, e.g., Profile V2 underneath it) immediately, via useGrailSlots'
  // shared removeSlot — the same conditional DELETE Profile V2 uses, keyed
  // on the exact slot row this item occupies (profile_grail_slots_unique_item
  // guarantees there's at most one). Restored everywhere if it fails.
  const removeFromGrails = useCallback(
    async (itemId: string): Promise<void> => {
      if (!userId) return;
      const slot = slots.find((s) => s.entry_type === 'item' && s.item_id === itemId);
      if (!slot) {
        await refresh();
        Alert.alert('Not Found', 'This item was not found in your Grail slots.');
        return;
      }
      const outcome = await removeSlot({
        slotIndex: slot.slot_index,
        expectedSlotId: slot.id,
        expectedEntryType: 'item',
        expectedRefId: itemId,
      });
      if (outcome === 'removed') {
        // Own Profile V2's cached copy may still be "fresh" — mark it stale
        // so its next focus reconciles with Supabase in the background.
        invalidateOwnProfileCache(userId);
      } else if (outcome === 'conflict') {
        Alert.alert('Already Changed', 'That Grail slot changed or was already removed.');
      } else if (outcome === 'failed') {
        Alert.alert('Couldn’t remove from Grails. Try again.');
      }
    },
    [userId, slots, refresh, removeSlot],
  );

  return { grails, loading, isFull, isInGrails, addToGrails, removeFromGrails, refresh };
}
