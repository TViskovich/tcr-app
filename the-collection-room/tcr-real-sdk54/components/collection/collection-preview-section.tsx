import { StyleSheet, View } from 'react-native';

import { CollectionHeaderRow } from '@/components/collection/collection-header-row';
import { HorizontalCardPreview } from '@/components/collection/horizontal-card-preview';
import type { CollectionItem } from '@/types';

type Props = {
  folderId: string;
  title: string;
  items: CollectionItem[];
  isExpanded: boolean;
  // Only reachable via the "full" variant's collapse chevron — the
  // "compact" variant never renders that control, so its callers don't
  // need to pass this.
  onToggle?: () => void;
  // Opens the folder itself — used only by CollectionHeaderRow's own
  // title/chevron tap now. Preview-tile taps open the specific item
  // instead (see onOpenItem below).
  onOpenFolder: () => void;
  // Opens a specific card's item-detail page — one real preview tile in
  // the expanded HorizontalCardPreview below is one distinct
  // CollectionItem, so tapping it should land on that item, not the
  // folder it lives in.
  onOpenItem: (item: CollectionItem) => void;
  onAddItem: () => void;
  // "compact" shrinks dimensions/typography AND drops the collapse
  // chevron entirely — its rows are always expanded (see
  // components/profile-v2/profile-v2-collections.tsx). Same structure,
  // same navigation behavior as "full" (the default) otherwise.
  variant?: 'full' | 'compact';
};

// One collection's title/chevron row (CollectionHeaderRow) plus its
// collapsible horizontal preview. No data fetching of its own — folder/item
// data and navigation/toggle targets come from the caller
// (app/(tabs)/collection.tsx). Inter-section spacing is the vertical list's
// own ItemSeparatorComponent, not a margin baked in here, so it stays
// consistent regardless of what wraps this.
//
// Plain conditional mount, not a measured/animated height collapse: an
// earlier version wrapped HorizontalCardPreview in an Animated.View whose
// `height` was driven by a `contentHeight` shared value measured via
// onLayout *on a child of that same wrapper*. Since the wrapper started at
// height 0 (before anything had measured), Yoga never gave that child real
// space to lay out in, so onLayout kept reporting 0, contentHeight never
// left 0, and the row stayed invisible even when expanded — a measurement
// deadlock, not a state bug. Rendering plainly here is reliable; the
// height/opacity collapse animation can come back later measured from an
// unconstrained (not already height-clipped) copy.
export function CollectionPreviewSection({
  folderId,
  title,
  items,
  isExpanded,
  onToggle,
  onOpenFolder,
  onOpenItem,
  onAddItem,
  variant = 'full',
}: Props) {
  return (
    <View style={styles.section}>
      <CollectionHeaderRow
        title={title}
        isExpanded={isExpanded}
        onToggle={onToggle}
        onOpenFolder={onOpenFolder}
        variant={variant}
      />

      {isExpanded && (
        <HorizontalCardPreview
          folderId={folderId}
          items={items}
          onOpenItem={onOpenItem}
          onAddItem={onAddItem}
          variant={variant}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {},
});
