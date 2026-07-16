import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';

type Props = {
  width: number;
  height?: number;
  aspectRatio?: number;
  borderRadius: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

// Pure visual "intentionally empty" shell — dark surface, subtle border, a
// low-opacity CacheCase watermark centered inside. No Pressable, no onPress:
// purely decorative. This is the shared primitive behind every branded
// placeholder in the app — CollectionPreviewPlaceholder (Collection page's
// horizontal preview rows, which adds its own "tap to add a card" behavior
// on top of this) and the group/item grid placeholders on the folder detail
// screen (app/collection/[folderId].tsx, which use this directly since those
// are explicitly non-interactive).
export function CacheCasePlaceholderShell({
  width,
  height,
  aspectRatio,
  borderRadius,
  accessibilityLabel = 'Empty slot',
  style,
}: Props) {
  return (
    <View
      style={[styles.tile, { width, height, aspectRatio, borderRadius }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      accessibilityLabel={accessibilityLabel}>
      <CacheCaseLogo variant="icon" size={22} style={styles.mark} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
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
  mark: {
    opacity: 0.14,
  },
});
