import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { GrailsSlot } from '@/components/profile/grails-slot';
import type { ShowcaseItem } from '@/types';

type Props = {
  grails: ShowcaseItem[];
  editable?: boolean;
  onItemPress: (item: ShowcaseItem) => void;
};

const COLS = 3;
const GAP = 2;
const H_PADDING = 16;
const MAX_SLOTS = 9;

export function GrailsGrid({ grails, editable = false, onItemPress }: Props) {
  const { width: screenWidth } = useWindowDimensions();

  // ── Zero state ────────────────────────────────────────────────
  // Own profile: show a prompt. Visitor profile: hide entirely.
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
  const cellSize = Math.floor((screenWidth - H_PADDING * 2 - GAP * (COLS - 1)) / COLS);

  // Only render filled slots — never show empty placeholders.
  const slots = grails.slice(0, MAX_SLOTS);

  // Pad the row if the last row is incomplete, so cells don't stretch.
  // We add invisible spacer Views for missing slots in the last row.
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
            size={cellSize}
            onPress={() => onItemPress(item)}
          />
        ))}
        {Array.from({ length: spacers }).map((_, i) => (
          <View
            key={`spacer-${i}`}
            style={{ width: cellSize, height: cellSize * (4 / 3) }}
          />
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
    paddingHorizontal: H_PADDING,
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GAP,
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
