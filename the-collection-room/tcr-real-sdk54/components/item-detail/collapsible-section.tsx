import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

// Generic collapsed-by-default section — the "Additional Details" affordance
// used by the Comics form to keep specialist collector fields out of the
// default view. No such primitive existed anywhere in the app yet (see
// app/item/new.tsx's own sectionHeader convention, which is always-visible);
// this is the first one, kept small and unopinionated about its contents so
// any future category can reuse it the same way.
type Props = {
  title: string;
  children: ReactNode;
  defaultExpanded?: boolean;
};

export function CollapsibleSection({ title, children, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <View style={styles.wrap}>
      <Pressable
        style={styles.header}
        onPress={() => setExpanded((prev) => !prev)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={title}>
        <Text style={styles.headerText}>{title}</Text>
        <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>
      {expanded && <View style={styles.body}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    backgroundColor: PV2.panel,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  headerText: {
    fontSize: 13,
    fontWeight: '700',
    color: PV2.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  chevron: {
    fontSize: 15,
    color: PV2.textSecondary,
  },
  body: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PV2.border,
    paddingTop: 12,
  },
});
