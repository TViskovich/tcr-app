import { StyleSheet, Text, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

export type MetadataRow = {
  label: string;
  value: string | null | undefined;
};

type Props = {
  rows: MetadataRow[];
};

// Apple Settings-style list — thin dividers, no card/panel background.
// Rows with an empty value are hidden entirely rather than shown blank.
export function ItemMetadataSection({ rows }: Props) {
  const visibleRows = rows.filter((row): row is MetadataRow & { value: string } => !!row.value);
  if (visibleRows.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {visibleRows.map((row, index) => (
        <View key={row.label} style={[styles.row, index > 0 && styles.rowDivider]}>
          <Text style={styles.label}>{row.label}</Text>
          <Text style={styles.value} numberOfLines={1}>
            {row.value}
          </Text>
        </View>
      ))}
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
});
