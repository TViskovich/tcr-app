import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { IconSymbol } from '@/components/ui/icon-symbol';
import type { CollectionItem } from '@/types';

import { PV2 } from './profile-v2-theme';

// Thumbnail frame — the 3:4 card shape every item tile in the app uses, big
// enough to tell similar cards apart. The image is fitted inside it
// (contain), never cropped, so its own proportions are kept.
const THUMB_WIDTH = 54;
const THUMB_HEIGHT = 72;

export type ListableItem = CollectionItem & { primary_image_id: string | null };

// What an item is called in a row: the player when there is one (sports
// cards), else the title — the same lead the feed's item tiles use.
export function itemName(item: ListableItem) {
  return item.player?.trim() || item.title?.trim() || 'Untitled';
}

// The item's title when the name above is the player — so a card reads as
// "Player" with "2023 Topps Chrome" in its context line.
export function secondaryTitle(item: ListableItem) {
  const title = item.title?.trim();
  return title && title !== itemName(item) ? title : null;
}

// One compact item row — thumbnail, name, context line, chevron. Shared by
// the item searches (Search Items / Search Tagged Items) and the Items tab's
// List View, so both read the same. The caller signs the thumbnail (compact
// tier, batched) and passes the resolved uri + stable cacheKey; until then
// the plain dark frame shows, same fallback as the profile grids.
export function ProfileV2ItemRow({
  item,
  imageUri,
  imageCacheKey,
  context,
  onPress,
  onLongPress,
  highlighted = false,
  trailing = 'chevron',
}: {
  item: ListableItem;
  imageUri: string | undefined;
  imageCacheKey: string | undefined;
  // Extra context after the item's own title (where it lives, when it was
  // tagged…). Empty/null for none.
  context: string | null;
  // Omitted (Edit Mode) = a static row: nothing to tap, so no navigation.
  onPress?: () => void;
  // Owner only (the Items tab's List View): enters Edit Mode; once it
  // fires, the release doesn't also open the item.
  onLongPress?: () => void;
  // Edit Mode's initially selected entry — a subtle accent outline.
  highlighted?: boolean;
  // Right-hand glyph: a chevron (search results) or three bars (the Items
  // tab's List View — the reorder handle look). The whole row is the tap
  // target either way.
  trailing?: 'chevron' | 'bars';
}) {
  const contextText = [secondaryTitle(item), context].filter(Boolean).join(' · ');
  const label = [itemName(item), contextText].filter(Boolean).join(', ');
  const style = [styles.row, highlighted && styles.rowHighlighted];
  const content = (
    <>
      <View style={styles.thumb}>
        {imageUri && (
          <Image
            source={{ uri: imageUri, cacheKey: imageCacheKey }}
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
      <IconSymbol
        name={trailing === 'bars' ? 'line.3.horizontal' : 'chevron.right'}
        size={14}
        color="rgba(255,255,255,0.28)"
      />
    </>
  );
  if (!onPress) {
    return (
      <View style={style} accessibilityLabel={label}>
        {content}
      </View>
    );
  }
  return (
    <TouchableOpacity
      style={style}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={onLongPress ? 400 : undefined}
      activeOpacity={0.65}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={onLongPress ? 'Long press to rearrange items' : undefined}>
      {content}
    </TouchableOpacity>
  );
}

export const itemRowStyles = StyleSheet.create({
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
});

// Every row is this tall (thumb + vertical padding) — Edit Mode's sortable
// list positions rows by it.
export const ITEM_ROW_HEIGHT = 72 + 8 * 2;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  rowHighlighted: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: PV2.actionPrimary,
    paddingHorizontal: 6,
    marginHorizontal: -7,
    // 1pt less padding offsets the 1pt border, so the row's height (which
    // the Edit Mode list positions by) doesn't change.
    paddingVertical: 7,
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
    color: PV2.textPrimary,
  },
  rowContext: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.50)',
  },
});
