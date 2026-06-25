import { StyleSheet, Text, View } from 'react-native';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { GrailsSlot } from '@/components/profile/grails-slot';
import type { ShowcaseItem } from '@/types';

type Props = {
  grails: ShowcaseItem[];
  editable?: boolean;
  onItemPress: (item: ShowcaseItem) => void;
};

const COLS = 3;
const MAX_SLOTS = 9;

export function GrailsGrid({ grails, editable = false, onItemPress }: Props) {
  // ── Zero state ────────────────────────────────────────────────
  if (grails.length === 0) {
    if (!editable) return null;

    return (
      <View style={styles.container}>
        <SectionHeader count={0} editable />
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>Showcase your favorite cards here.</Text>
          <Text style={styles.emptyBody}>Add your first Grail from any item page.</Text>
        </View>
      </View>
    );
  }

  // ── Grid ──────────────────────────────────────────────────────
  const slots = grails.slice(0, MAX_SLOTS);

  // Invisible spacers fill incomplete last row so space-between stays aligned.
  const remainder = slots.length % COLS;
  const spacers = remainder === 0 ? 0 : COLS - remainder;

  return (
    <View style={styles.container}>
      <SectionHeader count={grails.length} editable={editable} />
      <View style={styles.grid}>
        {slots.map((item) => (
          <GrailsSlot
            key={item.id}
            item={item}
            onPress={() => onItemPress(item)}
          />
        ))}
        {Array.from({ length: spacers }).map((_, i) => (
          <View key={`spacer-${i}`} style={styles.spacer} />
        ))}
      </View>
    </View>
  );
}

function SectionHeader({ count, editable }: { count: number; editable: boolean }) {
  return (
    <View style={styles.header}>
      <IconSymbol name="crown.fill" size={18} color="#C9952C" />
      <Text style={styles.headerTitle}>Grails</Text>
      {editable && count > 0 && (
        <Text style={styles.headerCount}>{count} / 9</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#11181C',
    flex: 1,
  },
  headerCount: {
    fontSize: 13,
    color: '#687076',
    fontWeight: '500',
  },
  // 3-column grid: space-between distributes the ~4% gap evenly between columns.
  // spacer Views (same width as cells) keep alignment on incomplete last rows.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 5,
  },
  spacer: {
    width: '32%',
  },
  emptyState: {
    paddingVertical: 20,
    paddingHorizontal: 4,
    gap: 6,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#11181C',
  },
  emptyBody: {
    fontSize: 14,
    color: '#687076',
    lineHeight: 20,
  },
});
