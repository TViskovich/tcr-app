import { useEffect, useMemo, useState } from 'react';
import { FlatList, Keyboard, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { loadCollectionPaths } from '@/components/collection/collection-search';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';
import type { CollectionItem } from '@/types';

import { ProfileV2SearchSheet } from './profile-v2-search-sheet';
import { PV2 } from './profile-v2-theme';

// Thumbnail frame — the 3:4 card shape every item tile in the app uses, big
// enough to tell similar cards apart. The image is fitted inside it
// (contain), never cropped, so its own proportions are kept.
const THUMB_WIDTH = 54;
const THUMB_HEIGHT = 72;
// Rows rendered (and thumbnails signed) per query; a broader query asks the
// user to keep typing instead of signing hundreds of images at once.
const MAX_RESULTS = 60;

export type SearchableItem = CollectionItem & { primary_image_id: string | null };

// What a result is called: the player when there is one (sports cards),
// else the title — the same lead the feed's item tiles use.
export function itemName(item: SearchableItem) {
  return item.player?.trim() || item.title?.trim() || 'Untitled';
}

// The item's title when the name above is the player — so a card reads as
// "Player" with "2023 Topps Chrome" in its context line.
function secondaryTitle(item: SearchableItem) {
  const title = item.title?.trim();
  return title && title !== itemName(item) ? title : null;
}

// Profile V2's item search sheet — shared by Search Items (the Items pill)
// and Search Tagged Items (the Tagged pill). Same sheet as Search
// Collections (ProfileV2SearchSheet). Searches only the `items` it's given,
// so each caller decides eligibility (and the caller's own data source has
// already applied RLS/visibility). Nothing shows until there's a real
// query; matching is case-insensitive and partial on the player/title. Each
// result: the item's primary-image thumbnail (compact signed tier — never
// the full-resolution image or its gallery), its name, and the caller's
// context line.
export function ItemSearchSheet<T extends SearchableItem>({
  visible,
  items,
  placeholder,
  context,
  onClose,
  onSelect,
}: {
  visible: boolean;
  items: T[];
  placeholder: string;
  // Extra context after the item's own title (e.g. where it lives, or when
  // it was tagged). Empty/null for none.
  context: (item: T) => string | null;
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
        ItemSeparatorComponent={() => <View style={styles.divider} />}
        ListFooterComponent={
          allMatches.length > MAX_RESULTS ? (
            <Text style={styles.more}>Showing {MAX_RESULTS} of {allMatches.length} — keep typing to narrow it down.</Text>
          ) : null
        }
        renderItem={({ item }) => {
          const imageId = item.primary_image_id;
          const uri = imageId ? urls.get(imageId) : undefined;
          const contextText = [secondaryTitle(item), context(item)].filter(Boolean).join(' · ');
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() => {
                Keyboard.dismiss();
                setQuery('');
                onSelect(item);
              }}
              activeOpacity={0.65}
              accessibilityRole="button"
              accessibilityLabel={[itemName(item), contextText].filter(Boolean).join(', ')}>
              {/* Same fallback as the profile grids: the plain dark frame
                  shows until (or if never) the signed thumbnail resolves. */}
              <View style={styles.thumb}>
                {uri && imageId && (
                  <Image
                    source={{ uri, cacheKey: itemImageCacheKey(identity, imageId, COMPACT_IMAGE_TIER, servedTiers) }}
                    style={StyleSheet.absoluteFill}
                    contentFit="contain"
                    transition={150}
                    cachePolicy="memory-disk"
                  />
                )}
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={2}>
                  {itemName(item)}
                </Text>
                {!!contextText && (
                  <Text style={styles.rowContext} numberOfLines={1}>
                    {contextText}
                  </Text>
                )}
              </View>
              <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />
            </TouchableOpacity>
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
  onClose: () => void;
  onSelect: (item: SearchableItem) => void;
};

// Profile V2: long-press the Items pill (while Items is the active tab) →
// search this profile's items by name, for the owner and visitors alike.
// Context line: where the item lives. Choosing one opens the normal Item
// Detail screen, which decides what the signed-in viewer can do there.
export function ProfileV2ItemSearchSheet({ visible, ownerId, ownerName, isOwnProfile, items, onClose, onSelect }: Props) {
  // Collection name paths for each result's context line — the same loader
  // and privacy rules as Search Collections, so a visitor never sees a
  // private collection's name. Loaded as the sheet opens.
  const pathsKey = `${ownerId}:${isOwnProfile}`;
  const [paths, setPaths] = useState<{ key: string; map: Map<string, string[]> } | null>(null);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    loadCollectionPaths(ownerId, isOwnProfile)
      .then((map) => {
        if (!cancelled) setPaths({ key: `${ownerId}:${isOwnProfile}`, map });
      })
      .catch((e: unknown) => {
        // Context only — results still show, just without where they live.
        console.error('[ProfileV2ItemSearchSheet] collection paths failed:', e);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, ownerId, isOwnProfile]);
  const pathMap = paths?.key === pathsKey ? paths.map : null;

  return (
    <ItemSearchSheet
      visible={visible}
      items={items}
      placeholder={isOwnProfile ? 'Search your items' : `Search ${ownerName}'s items`}
      context={(item) => pathMap?.get(item.folder_id)?.join(' › ') ?? null}
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
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  thumb: {
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  rowContext: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.50)',
  },
});
