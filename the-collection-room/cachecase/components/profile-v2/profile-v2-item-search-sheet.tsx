import { useMemo, useState } from 'react';
import { FlatList, Keyboard, StyleSheet, Text, View } from 'react-native';

import { useCollectionPathMap } from '@/components/collection/collection-search';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';

import { itemName, itemRowStyles, type ListableItem, ProfileV2ItemRow } from './profile-v2-item-row';
import { ProfileV2SearchSheet, type SearchSheetToggle } from './profile-v2-search-sheet';
import { PV2 } from './profile-v2-theme';

// Rows rendered (and thumbnails signed) per query; a broader query asks the
// user to keep typing instead of signing hundreds of images at once.
const MAX_RESULTS = 60;

export type SearchableItem = ListableItem;

// Profile V2's item search sheet — shared by Search Items (the Items pill)
// and Search Tagged Items (the Tagged pill). Same sheet as Search
// Collections (ProfileV2SearchSheet). Searches only the `items` it's given,
// so each caller decides eligibility (and the caller's own data source has
// already applied RLS/visibility). Nothing shows until there's a real
// query; matching is case-insensitive and partial on the player/title. Each
// result is a ProfileV2ItemRow: the item's primary-image thumbnail (compact
// signed tier — never the full-resolution image or its gallery), its name,
// and the caller's context line.
export function ItemSearchSheet<T extends SearchableItem>({
  visible,
  items,
  placeholder,
  context,
  toggle,
  onClose,
  onSelect,
}: {
  visible: boolean;
  items: T[];
  placeholder: string;
  // Extra context after the item's own title (e.g. where it lives, or when
  // it was tagged). Empty/null for none.
  context: (item: T) => string | null;
  // Optional switch row under the field while the query is empty (the Items
  // tab's "List View" switch).
  toggle?: SearchSheetToggle;
  onClose: () => void;
  onSelect: (item: T) => void;
}) {
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();

  const allMatches = useMemo(() => {
    if (!needle) return [];
    return items
      .filter((item) => [item.player, item.title].some((field) => field?.toLocaleLowerCase().includes(needle)))
      .sort((a, b) => itemName(a).localeCompare(itemName(b)));
  }, [items, needle]);
  const matches = allMatches.slice(0, MAX_RESULTS);

  // Only the rows actually shown, at the compact preview tier.
  const { urls, servedTiers } = useSignedItemImages(
    matches.map((item) => item.primary_image_id),
    COMPACT_IMAGE_TIER,
  );

  let body: React.ReactNode = null;
  if (needle && matches.length === 0) {
    body = <Text style={styles.state}>No items found</Text>;
  } else if (needle) {
    body = (
      <FlatList
        data={matches}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ItemSeparatorComponent={() => <View style={itemRowStyles.divider} />}
        ListFooterComponent={
          allMatches.length > MAX_RESULTS ? (
            <Text style={styles.more}>Showing {MAX_RESULTS} of {allMatches.length} — keep typing to narrow it down.</Text>
          ) : null
        }
        renderItem={({ item }) => {
          const imageId = item.primary_image_id;
          return (
            <ProfileV2ItemRow
              item={item}
              imageUri={imageId ? urls.get(imageId) : undefined}
              imageCacheKey={imageId ? itemImageCacheKey(identity, imageId, COMPACT_IMAGE_TIER, servedTiers) : undefined}
              context={context(item)}
              onPress={() => {
                Keyboard.dismiss();
                setQuery('');
                onSelect(item);
              }}
            />
          );
        }}
      />
    );
  }

  return (
    <ProfileV2SearchSheet
      visible={visible}
      query={query}
      onChangeQuery={setQuery}
      placeholder={placeholder}
      toggle={toggle}
      onClose={() => {
        setQuery('');
        onClose();
      }}>
      {body}
    </ProfileV2SearchSheet>
  );
}

type Props = {
  visible: boolean;
  ownerId: string;
  ownerName: string;
  isOwnProfile: boolean;
  // This profile's Items tab rows (Profile's own useAllItems — every
  // collection, nested ones included, publicOnly for a visitor, and RLS-
  // limited either way). Searching exactly these means Search Items finds
  // exactly what the Items grid shows the viewer, and nothing more.
  items: SearchableItem[];
  toggle?: SearchSheetToggle;
  onClose: () => void;
  onSelect: (item: SearchableItem) => void;
};

// Profile V2: long-press the Items pill (while Items is the active tab) →
// search this profile's items by name, for the owner and visitors alike.
// Context line: where the item lives (same loader and privacy rules as
// Search Collections, so a visitor never sees a private collection's name).
// Choosing one opens the normal Item Detail screen, which decides what the
// signed-in viewer can do there.
export function ProfileV2ItemSearchSheet({
  visible,
  ownerId,
  ownerName,
  isOwnProfile,
  items,
  toggle,
  onClose,
  onSelect,
}: Props) {
  const pathMap = useCollectionPathMap(ownerId, isOwnProfile, visible);
  return (
    <ItemSearchSheet
      visible={visible}
      items={items}
      placeholder={isOwnProfile ? 'Search your items' : `Search ${ownerName}'s items`}
      context={(item) => pathMap?.get(item.folder_id)?.join(' › ') ?? null}
      toggle={toggle}
      onClose={onClose}
      onSelect={onSelect}
    />
  );
}

const styles = StyleSheet.create({
  state: {
    paddingVertical: 32,
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  more: {
    paddingVertical: 14,
    fontSize: 12,
    color: PV2.textTertiary,
    textAlign: 'center',
  },
});
