import { Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { CollectionItem, Folder, GrailSlot } from '@/types';

import { GrailSlotPreview } from './grail-slot-preview';
import { PV2 } from './profile-v2-theme';

const SLOT_COUNT = 9;
const COLS = 3;

const GRID_HORIZONTAL_MARGIN = 3;
const GRID_GAP = 2;
const GRID_WIDTH = Dimensions.get('window').width - GRID_HORIZONTAL_MARGIN * 2;

// Three columns of square cells and two row gaps. Because three cells
// span GRID_WIDTH across each row, the full 3-row grid height is
// effectively GRID_WIDTH — used so the initial-error state reserves the
// same approximate height as the normal loaded/loading grid, and Retry
// succeeding doesn't visibly jump the rest of the profile layout.
const GRID_HEIGHT = GRID_WIDTH;

type Props = {
  slots: GrailSlot[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  // Owner-only affordances (empty-slot "+", long-press Replace/Remove) are
  // gated per-slot inside GrailSlotPreview itself — passed through here,
  // not branched on at this level.
  isOwnProfile: boolean;
  onPressEmpty: (slotIndex: number) => void;
  onPressItem: (item: CollectionItem) => void;
  onPressCollection: (collection: Folder) => void;
  onReplace: (slotIndex: number) => void;
  onRemove: (slotIndex: number) => void;
};

export function ProfileV2Grid({
  slots,
  loading,
  error,
  onRetry,
  isOwnProfile,
  onPressEmpty,
  onPressItem,
  onPressCollection,
  onReplace,
  onRemove,
}: Props) {
  // State: initial load failed, nothing loaded yet — never render 9 empty
  // owner-editable "+" slots for a failed query, which would misrepresent
  // an error as "you have no Grails."
  if (!loading && error && slots.length === 0) {
    return (
      <View style={styles.errorState}>
        <Text style={styles.errorTitle}>Couldn&apos;t load Grails</Text>
        <TouchableOpacity style={styles.retryButton} onPress={onRetry} activeOpacity={0.8}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Slot-index-addressed, not positional — a user with only slots 0/3/7
  // filled sees gaps exactly there, not compacted into the first three
  // cells.
  const bySlotIndex = new Map(slots.map((s) => [s.slot_index, s]));
  const grid: (GrailSlot | null)[] = Array.from({ length: SLOT_COUNT }, (_, i) => bySlotIndex.get(i) ?? null);
  const rows: (GrailSlot | null)[][] = [];
  for (let i = 0; i < grid.length; i += COLS) rows.push(grid.slice(i, i + COLS));

  return (
    <View style={styles.grid}>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((slot, colIndex) => {
            const slotIndex = rowIndex * COLS + colIndex;
            // State: loading — every cell renders as a plain,
            // non-interactive box, no "+" at all, regardless of
            // ownership, so nothing flashes "add a Grail" right before
            // real data arrives.
            if (loading) {
              return <View key={`loading-${slotIndex}`} style={styles.loadingCell} />;
            }
            // Real empty state and stale-data-after-a-failed-refresh both
            // fall through to this same render — the grid looks identical
            // either way; a refresh failure only ever shows in the
            // console (see useGrailSlots), never blocks or hides
            // already-loaded slots.
            return (
              <GrailSlotPreview
                key={slot?.id ?? `empty-${slotIndex}`}
                slot={slot}
                slotIndex={slotIndex}
                isOwnProfile={isOwnProfile}
                onPressEmpty={onPressEmpty}
                onPressItem={onPressItem}
                onPressCollection={onPressCollection}
                onReplace={onReplace}
                onRemove={onRemove}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    marginHorizontal: GRID_HORIZONTAL_MARGIN,
    marginTop: 2,
    gap: GRID_GAP,
  },
  row: {
    flexDirection: 'row',
    gap: GRID_GAP,
  },
  loadingCell: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 6,
    backgroundColor: PV2.emptyCardBg,
  },
  errorState: {
    marginHorizontal: GRID_HORIZONTAL_MARGIN,
    marginTop: 2,
    minHeight: GRID_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  errorTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  retryButton: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  retryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
});
