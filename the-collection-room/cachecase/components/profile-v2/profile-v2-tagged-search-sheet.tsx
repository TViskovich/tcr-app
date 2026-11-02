import type { TaggedCardEntry } from '@/hooks/use-tagged-content';

import { ItemSearchSheet } from './profile-v2-item-search-sheet';

// "Tagged Oct 12" (with the year when it isn't this one).
function taggedOn(taggedAt: string) {
  const date = new Date(taggedAt);
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
// the cards that tab renders (ProfileV2Tagged's useTaggedContent rows,
// handed up as they load), so eligibility and visibility are the tab's own:
// items other collectors tagged this profile in, each re-read under RLS
// (deleted or now-private ones are already gone). Tagged collections aren't
// items and aren't searched here. Context line: whose item it is and when
// it was tagged.
// Same sheet, matching and result rows as Search Items (ItemSearchSheet).
export function ProfileV2TaggedSearchSheet({
  visible,
  items,
  onClose,
  onSelect,
}: {
  visible: boolean;
  items: TaggedCardEntry[];
  onClose: () => void;
  onSelect: (item: TaggedCardEntry) => void;
}) {
  return (
    <ItemSearchSheet
      visible={visible}
      items={items}
      placeholder="Search tagged items"
      context={(item) =>
        [item.ownerUsername ? `@${item.ownerUsername}'s` : null, taggedOn(item.taggedAt)].filter(Boolean).join(' · ') ||
        null
      }
      onClose={onClose}
      onSelect={onSelect}
    />
  );
}
