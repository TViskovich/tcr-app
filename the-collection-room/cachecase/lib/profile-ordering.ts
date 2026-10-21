import { supabase } from '@/lib/supabase';

// Saves for Profile V2's Edit Mode drag-and-drop — the only write paths for
// the two orders added by supabase/migrations/20261026120000_add_profile_
// ordering.sql. Both RPCs validate ownership. Collections: the whole
// sibling group, which must be EXACTLY the current set. Items: one move
// between two neighbours, which must still be adjacent. Either way a
// stale request fails rather than half-applying.

export type OrderSaveResult = { ok: true } | { ok: false; stale: boolean; message: string };

function toResult(error: { message: string } | null): OrderSaveResult {
  if (!error) return { ok: true };
  const stale = /does not match/i.test(error.message);
  return {
    ok: false,
    stale,
    message: stale
      ? 'Something changed since this list loaded, so the new order wasn’t saved. It’s been put back — refresh and try again.'
      : 'Couldn’t save the new order, so it’s been put back. Please try again.',
  };
}

// One sibling group of collections: parentFolderId null = the owner's
// top-level collections. Never changes a collection's parent.
export async function saveFolderOrder(parentFolderId: string | null, folderIds: string[]): Promise<OrderSaveResult> {
  const { error } = await supabase.rpc('reorder_folders', {
    p_parent_folder_id: parentFolderId,
    p_folder_ids: folderIds,
  });
  if (error) console.error('[profile-ordering] reorder_folders failed:', error.message, error);
  return toResult(error);
}

// A drag moves exactly one entry. Given the order before and after the
// drop, which item moved and what its new neighbours are (null = it's now
// first / last). Null when nothing moved.
export function describeMove(
  previous: string[],
  next: string[],
): { itemId: string; afterId: string | null; beforeId: string | null } | null {
  let first = 0;
  while (first < previous.length && previous[first] === next[first]) first++;
  if (first === previous.length) return null;
  let last = previous.length - 1;
  while (last > first && previous[last] === next[last]) last--;
  // Moved down: the item that left `first` now sits at `last`. Otherwise it
  // moved up into `first`.
  const itemId = next[last] === previous[first] ? previous[first] : next[first];
  const index = next.indexOf(itemId);
  return { itemId, afterId: next[index - 1] ?? null, beforeId: next[index + 1] ?? null };
}

// The owner's profile-wide item order — saves one drop as a single move:
// the item lands between its two new neighbours (move_profile_item checks
// they're still adjacent, so a drop made against an outdated list fails as
// stale instead of landing somewhere unexpected). Scales to any number of
// items: nothing else is sent or validated. Never changes an item's
// collection or its per-collection order.
export async function saveProfileItemMove(previous: string[], next: string[]): Promise<OrderSaveResult> {
  const move = describeMove(previous, next);
  if (!move) return { ok: true };
  const { error } = await supabase.rpc('move_profile_item', {
    p_item_id: move.itemId,
    p_after_item_id: move.afterId,
    p_before_item_id: move.beforeId,
  });
  if (error) console.error('[profile-ordering] move_profile_item failed:', error.message, error);
  return toResult(error);
}
