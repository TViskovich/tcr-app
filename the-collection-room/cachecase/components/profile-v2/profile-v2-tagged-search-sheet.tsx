import type { SavedCardEntry } from '@/hooks/use-saved';

import { ItemSearchSheet } from './profile-v2-item-search-sheet';

// "Tagged Oct 12" (with the year when it isn't this one).
function taggedOn(savedAt: string) {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) return null;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `Tagged ${date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })}`;
}

// Profile V2: long-press the Tagged pill — own profile only, while Tagged is
// the active tab — to search the items in the Tagged tab. `items` is exactly
// the cards that tab renders (ProfileV2Tagged's own useSavedAll rows, handed
// up as they load), so eligibility and visibility are the tab's own: the
// signed-in user's saved cards, each re-read under RLS (deleted or now-
// private ones are already gone). Saved collections aren't items and aren't
// searched here. Context line: whose item it is and when it was tagged.
// Same sheet, matching and result rows as Search Items (ItemSearchSheet).
export function ProfileV2TaggedSearchSheet({
  visible,
  items,
  onClose,
  onSelect,
}: {
  visible: boolean;
  items: SavedCardEntry[];
  onClose: () => void;
  onSelect: (item: SavedCardEntry) => void;
}) {
  return (
    <ItemSearchSheet
      visible={visible}
      items={items}
      placeholder="Search tagged items"
      context={(item) =>
        [item.ownerUsername ? `@${item.ownerUsername}'s` : null, taggedOn(item.savedAt)].filter(Boolean).join(' · ') ||
        null
      }
      onClose={onClose}
      onSelect={onSelect}
    />
  );
}
