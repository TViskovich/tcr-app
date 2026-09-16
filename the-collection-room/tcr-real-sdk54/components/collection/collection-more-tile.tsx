import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PREVIEW_CARD_ASPECT_RATIO, PREVIEW_CARD_RADIUS } from '@/components/collection/collection-preview-card';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';

type Props = {
  remainingCount: number;
  tileWidth: number;
  onPress: () => void;
  // Mirrors CollectionPreviewCard's own squareEdges/variant props exactly
  // (see that file) — this tile sits in the same row as CollectionPreviewCard
  // tiles and must match their corner/border treatment at every size, full
  // or compact.
  squareEdges?: boolean;
  variant?: 'full' | 'compact';
  testID?: string;
};

// The overflow tile for a folder preview row whose real item count exceeds
// the row's own preview limit — occupies the row's last slot in place of a
// real CollectionPreviewCard. Plain dark card, no artwork — just the
// tile's own background/border plus centered "+N more" / "View all" text.
// Tile shell (aspect ratio/radius/border/background) intentionally
// duplicates CollectionPreviewCard's own `tile`/`tileSquareEdges`/
// `compactSquareCorners` styles rather than importing them — same "kept as
// its own copy, the visual language matching is what needs to stay
// consistent, not style object identity" reasoning already used by
// horizontal-card-preview.tsx's own folderBadge. The aspect ratio and
// radius themselves ARE imported (PREVIEW_CARD_ASPECT_RATIO/
// PREVIEW_CARD_RADIUS), so this tile can never drift to a different size or
// corner radius than its neighbors even if those two values ever change.
export function CollectionMoreTile({
  remainingCount,
  tileWidth,
  onPress,
  squareEdges = false,
  variant = 'full',
  testID,
}: Props) {
  const compact = variant === 'compact';
  return (
    <Pressable
      testID={testID}
      style={({ pressed }) => [{ width: tileWidth }, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`View all — ${remainingCount} more item${remainingCount === 1 ? '' : 's'}`}>
      <View
        style={[
          styles.tile,
          squareEdges && styles.tileSquareEdges,
          compact && styles.compactSquareCorners,
          { width: tileWidth },
        ]}>
        <Text style={[styles.moreText, compact && styles.moreTextCompact]} numberOfLines={1}>
          {`+${remainingCount} more`}
        </Text>
        <Text style={[styles.viewAllText, compact && styles.viewAllTextCompact]} numberOfLines={1}>
          View all
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.85,
  },
  tile: {
    aspectRatio: PREVIEW_CARD_ASPECT_RATIO,
    borderRadius: PREVIEW_CARD_RADIUS,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 6,
  },
  tileSquareEdges: {
    borderRadius: 0,
    borderWidth: 0,
  },
  compactSquareCorners: {
    borderRadius: 0,
  },
  moreText: {
    color: PV2.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  moreTextCompact: {
    fontSize: 12,
  },
  viewAllText: {
    color: PV2.textSecondary,
    fontSize: 11,
    fontWeight: '500',
  },
  viewAllTextCompact: {
    fontSize: 10,
  },
});
