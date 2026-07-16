import { Pressable, StyleSheet } from 'react-native';

import { CacheCasePlaceholderShell } from '@/components/collection/cachecase-placeholder-shell';
import {
  PREVIEW_CARD_ASPECT_RATIO,
  PREVIEW_CARD_RADIUS,
} from '@/components/collection/collection-preview-card';

type Props = {
  tileWidth: number;
  onPress: () => void;
};

// A generated, local-only "empty slot" shell — distinct from a real item
// with a missing/failed image (that's still CollectionPreviewCard, still
// tappable, still opens the item). This component carries no item data of
// its own, and its tap always leads to adding a new card to the folder,
// never to opening an existing item. The visual shell itself (dimensions,
// surface, watermark) lives in CacheCasePlaceholderShell, shared with the
// non-tappable placeholders on the folder detail screen — only the
// Pressable/onPress wrapper is specific to this preview-row usage.
export function CollectionPreviewPlaceholder({ tileWidth, onPress }: Props) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Add a card">
      {({ pressed }) => (
        <CacheCasePlaceholderShell
          width={tileWidth}
          aspectRatio={PREVIEW_CARD_ASPECT_RATIO}
          borderRadius={PREVIEW_CARD_RADIUS}
          style={pressed && styles.pressed}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.7,
  },
});
