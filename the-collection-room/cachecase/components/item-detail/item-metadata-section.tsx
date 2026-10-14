import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

export type MetadataRow = {
  label: string;
  value: string | null | undefined;
};

type Props = {
  rows: MetadataRow[];
};

// How many populated rows show before the rest move behind
// "Additional Details".
const PRIMARY_ROW_COUNT = 5;

// Apple Settings-style list — thin dividers, no card/panel background.
// Rows with an empty value are hidden entirely rather than shown blank, and
// only those populated rows count: the first PRIMARY_ROW_COUNT of them (in
// the caller's own field order) always show; any beyond that sit behind an
// "Additional Details" toggle right after the last one, expanding in place
// below it. Collapsed on mount — callers key this by item id, so opening a
// different item always starts collapsed.
export function ItemMetadataSection({ rows }: Props) {
  const [expanded, setExpanded] = useState(false);
  const visibleRows = rows.filter(
    (row): row is MetadataRow & { value: string } => !!row.value && row.value.trim() !== '',
  );
  if (visibleRows.length === 0) return null;

  const primaryRows = visibleRows.slice(0, PRIMARY_ROW_COUNT);
  const additionalRows = visibleRows.slice(PRIMARY_ROW_COUNT);

  const renderRow = (row: MetadataRow & { value: string }, divider: boolean) => (
    <View key={row.label} style={[styles.row, divider && styles.rowDivider]}>
      <Text style={styles.label}>{row.label}</Text>
      {/* Wraps rather than truncating, so long values (key descriptions,
          character lists) stay fully readable. */}
      <Text style={styles.value}>{row.value}</Text>
    </View>
  );

  return (
    <View style={styles.wrap}>
      {primaryRows.map((row, index) => renderRow(row, index > 0))}

      {additionalRows.length > 0 && (
        <>
          <Pressable
            style={({ pressed }) => [styles.row, styles.rowDivider, styles.toggleRow, pressed && styles.togglePressed]}
            onPress={() => setExpanded((open) => !open)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={expanded ? 'Hide Additional Details' : 'Additional Details'}>
            <Text style={styles.toggleText}>{expanded ? 'Hide Additional Details' : 'Additional Details'}</Text>
            <IconSymbol name={expanded ? 'chevron.up' : 'chevron.down'} size={14} color={PV2.actionPrimary} />
          </Pressable>
          {expanded && (
            <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
              {additionalRows.map((row) => renderRow(row, true))}
            </Animated.View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 20,
    paddingHorizontal: 20,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 11,
    gap: 12,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PV2.dividerColor,
  },
  label: {
    fontSize: 14,
    color: PV2.textTertiary,
    flex: 1,
  },
  value: {
    fontSize: 14,
    fontWeight: '500',
    color: PV2.textPrimary,
    flex: 1,
    textAlign: 'right',
  },
  // Same row footprint/divider as a metadata row, so the toggle reads as
  // part of the list; the whole row is the tap target.
  // Chevron sits right after the label, not pushed to the far edge.
  toggleRow: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 6,
  },
  togglePressed: {
    opacity: 0.6,
  },
  toggleText: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.actionPrimary,
  },
});
