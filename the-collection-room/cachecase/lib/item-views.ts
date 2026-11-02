import { supabase } from '@/lib/supabase';

// Item view tracking — the client half of supabase/migrations/
// 20261101120000_add_item_view_tracking.sql. The database decides
// everything that matters (who the viewer is, owner exclusion, visibility,
// the 30-minute dedupe window); this module only makes the calls.

// When view tracking started. Views before it were never recorded, so
// "Most Viewed" reflects views since then only — shown with that sort.
export const VIEW_TRACKING_SINCE = 'November 2026';

// Records that the signed-in user opened an item's detail screen. Fire-and-
// forget: never throws, never awaited by the screen, and a failure (offline,
// not deployed yet, ...) is silently ignored — analytics must never disturb
// Item Detail. Repeats within 30 minutes, the owner's own views and items
// the viewer can't see are simply not counted by the database.
export function recordItemView(itemId: string): void {
  supabase.rpc('record_item_view', { p_item_id: itemId }).then(
    () => {},
    () => {},
  );
}

const VIEW_COUNTS_PAGE_SIZE = 1000;
// Safety cap on paging (10,000 viewed items); far beyond any real profile.
const VIEW_COUNTS_MAX_PAGES = 10;

// Authoritative view totals for one profile's items, as the Items tab shows
// them to the signed-in viewer. Only items with at least one view are
// returned — any other item has 0. Throws on a request error.
export async function fetchProfileItemViewCounts(ownerId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let page = 0; page < VIEW_COUNTS_MAX_PAGES; page++) {
    const { data, error } = await supabase.rpc('profile_item_view_counts', {
      p_owner_id: ownerId,
      p_limit: VIEW_COUNTS_PAGE_SIZE,
      p_offset: page * VIEW_COUNTS_PAGE_SIZE,
    });
    if (error) throw error;
    const rows = (data ?? []) as { item_id: string; view_count: number }[];
    for (const row of rows) counts.set(row.item_id, Number(row.view_count));
    if (rows.length < VIEW_COUNTS_PAGE_SIZE) break;
  }
  return counts;
}
