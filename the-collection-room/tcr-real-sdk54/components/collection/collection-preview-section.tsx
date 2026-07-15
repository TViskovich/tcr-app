import { StyleSheet, View } from 'react-native';

import { CollectionHeaderRow } from '@/components/collection/collection-header-row';
import { HorizontalCardPreview } from '@/components/collection/horizontal-card-preview';
import type { CollectionItem } from '@/types';

type Props = {
  folderId: string;
  title: string;
  items: CollectionItem[];
  isExpanded: boolean;
  onToggle: () => void;
  onOpenFolder?: () => void;
  onOpenItem: (item: CollectionItem) => void;
  onAddItem: () => void;
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
}: Props) {
  return (
    <View style={styles.section}>
      <CollectionHeaderRow
        title={title}
        isExpanded={isExpanded}
        onToggle={onToggle}
        onOpenFolder={onOpenFolder}
      />

      {isExpanded && (
        <HorizontalCardPreview
          folderId={folderId}
          items={items}
          onItemPress={onOpenItem}
          onAddItem={onAddItem}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {},
});
