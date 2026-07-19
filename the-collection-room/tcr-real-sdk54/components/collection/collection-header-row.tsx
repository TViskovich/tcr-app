import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';

// Shared by collection-header-row.tsx and horizontal-card-preview.tsx so
// the title row and the preview row below it line up on the same left
// edge — deliberately its own value (not app/(tabs)/collection.tsx's
// PAGE_PADDING), matching this app's existing convention of a tighter,
// separate inset for list content vs. the page header.
export const SECTION_GUTTER = 18;
// Used instead of SECTION_GUTTER when variant="compact" (see
// components/profile-v2/profile-v2-collections.tsx) — the profile tab's
// own established horizontal inset, slightly tighter than the full
// Collection page's since it sits inside an already-padded section.
export const COMPACT_SECTION_GUTTER = 16;

// Shared with collection-preview-section.tsx's collapse animation so the
// chevron rotation and the preview row's open/close stay in lockstep even
// though each animates its own independent shared value.
export const SECTION_TOGGLE_DURATION_MS = 220;
export const SECTION_TOGGLE_EASING = Easing.out(Easing.cubic);

type Props = {
  title: string;
  isExpanded: boolean;
  // Only used to drive the far-right collapse chevron, which the compact
  // (profile) variant doesn't render — optional so compact callers don't
  // need to wire a handler that would never be reachable.
  onToggle?: () => void;
  // Tapping the title (or the solid arrow right beside it) opens the full
  // folder — a separate touch target from the collapse chevron, which sits
  // at the far right of the row.
  onOpenFolder?: () => void;
  // "compact" only shrinks dimensions/typography EXCEPT for the far-right
  // collapse chevron, which it omits entirely (see
  // components/profile-v2/profile-v2-collections.tsx) — the profile
  // version's category rows are always expanded and don't support
  // collapsing. Everything else (title, left nav chevron, tap targets) is
  // the same structure/interactions as "full" (the default).
  variant?: 'full' | 'compact';
};

// The title row above each collection's horizontal preview. No enclosing
// container — everything sits directly on the page background. In the
// "full" variant there are two distinct arrows with two distinct jobs: a
// solid "chevron.right" glyph right beside the title is part of the
// title's own tap target and opens the full folder; the thin rotating '›'
// at the far right of the row toggles the preview open/closed. The
// "compact" variant renders only the first — its rows are always expanded,
// so there's no collapse control to show.
export function CollectionHeaderRow({
  title,
  isExpanded,
  onToggle,
  onOpenFolder,
  variant = 'full',
}: Props) {
  const compact = variant === 'compact';
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(isExpanded ? 1 : 0);

  useEffect(() => {
    const target = isExpanded ? 1 : 0;
    progress.value = reducedMotion
      ? target
      : withTiming(target, { duration: SECTION_TOGGLE_DURATION_MS, easing: SECTION_TOGGLE_EASING });
  }, [isExpanded, reducedMotion, progress]);

  // 0deg (pointing right) collapsed → 90deg (pointing down) expanded, the
  // same '›' glyph rotated rather than swapping glyphs.
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${progress.value * 90}deg` }],
  }));

  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      <Pressable
        style={({ pressed }) => [styles.titleTouch, pressed && styles.pressed]}
        onPress={onOpenFolder}
        accessibilityRole="button"
        accessibilityLabel={`Open ${title} collection`}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 6 }}>
        <Text style={[styles.title, compact && styles.titleCompact]} numberOfLines={1}>
          {title}
        </Text>
        <IconSymbol
          name="chevron.right"
          size={compact ? 14 : 16}
          color={PV2.textSecondary}
          style={styles.openIcon}
        />
      </Pressable>

      {!compact && (
        <Pressable
          style={({ pressed }) => [styles.chevronTouch, pressed && styles.pressed]}
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={`${isExpanded ? 'Collapse' : 'Expand'} ${title}`}
          accessibilityState={{ expanded: isExpanded }}
          // Grows the touch target without visually enlarging the compact
          // chevron glyph itself.
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Animated.Text style={[styles.chevron, chevronStyle]}>{'›'}</Animated.Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SECTION_GUTTER,
    marginBottom: 10,
  },
  rowCompact: {
    paddingHorizontal: COMPACT_SECTION_GUTTER,
    marginBottom: 6,
  },
  pressed: {
    opacity: 0.7,
  },
  titleTouch: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  openIcon: {
    marginLeft: 6,
  },
  // Pushed to the far right of the row (justify-content:space-between on
  // the row handles this), clearly separated from the title group.
  chevronTouch: {},
  title: {
    flexShrink: 1,
    color: PV2.textPrimary,
    fontSize: 20,
    fontWeight: '700',
  },
  titleCompact: {
    fontSize: 16,
  },
  chevron: {
    color: PV2.textTertiary,
    fontSize: 18,
    fontWeight: '700',
  },
});
