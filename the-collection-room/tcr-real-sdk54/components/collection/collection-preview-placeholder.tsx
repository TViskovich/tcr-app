import { Pressable, StyleSheet } from 'react-native';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import {
  PREVIEW_CARD_ASPECT_RATIO,
  PREVIEW_CARD_RADIUS,
} from '@/components/collection/collection-preview-card';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';

type Props = {
  tileWidth: number;
  onPress: () => void;
};

// A generated, local-only "empty slot" shell — distinct from a real item
// with a missing/failed image (that's still CollectionPreviewCard, still
// tappable, still opens the item). This component carries no item data of
// its own, and its tap always leads to adding a new card to the folder,
// never to opening an existing item. Same width/height/aspect-ratio/radius
// as a real preview card so it slots in seamlessly, but flatter/lower-
// contrast surface + the CacheCase mark as a watermark so it reads as
// intentionally empty rather than a failed image.
export function CollectionPreviewPlaceholder({ tileWidth, onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.tile, { width: tileWidth }, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Add a card">
      <CacheCaseLogo variant="icon" size={22} style={styles.mark} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    aspectRatio: PREVIEW_CARD_ASPECT_RATIO,
    borderRadius: PREVIEW_CARD_RADIUS,
    // Deliberately flatter than CollectionPreviewCard's PV2.collectorPanelBg
    // — these are the theme's own purpose-built "this is intentionally
    // empty" tokens, not new hex values.
    backgroundColor: PV2.emptyCardBg,
    borderWidth: 1,
    borderColor: PV2.dividerColor,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.7,
  },
  mark: {
    opacity: 0.14,
  },
});
