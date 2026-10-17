import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import * as Haptics from 'expo-haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { ImageTier } from '@/lib/image-tiers';
import type { GrailSlot } from '@/types';

import { GrailSlotPreview } from './grail-slot-preview';
import { PV2 } from './profile-v2-theme';

const SLOT_COUNT = 9;
const COLS = 3;

// How long a finger has to rest on a Grail before it lifts and follows.
const LIFT_DELAY_MS = 220;
// Lift: same idea as Football IQ Academy's draggable field marker
// (InteractiveField.tsx — a spring scale-up while dragging), toned down for
// a full-size card.
const LIFT_SCALE = 1.06;
const SETTLE_SPRING = { damping: 20, stiffness: 220, mass: 0.7 };
const noop = () => {};

type Geometry = { cellWidth: number; cellHeight: number; gap: number };

function cellOrigin(cell: number, g: Geometry) {
  'worklet';
  return {
    x: (cell % COLS) * (g.cellWidth + g.gap),
    y: Math.floor(cell / COLS) * (g.cellHeight + g.gap),
  };
}

function hapticLift() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(noop);
}
function hapticStep() {
  Haptics.selectionAsync().catch(noop);
}
function hapticDrop() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(noop);
}

type Props = Geometry & {
  // Occupied slots only (any order); empty slot indexes render as fixed
  // empty cells and never move.
  slots: GrailSlot[];
  signedImageUrls: Map<string, string>;
  servedTiers: Map<string, ImageTier>;
  // Persists a new order: every occupied slot id, first = the lowest
  // occupied slot_index (reorder_grail_slots' own contract). Resolves false
  // on failure — the grid then animates back to the order before the drag.
  onReorder: (orderedSlotIds: string[]) => Promise<boolean>;
  // True while a Grail is lifted, false on release — lets the screen pause
  // its own vertical scrolling so a vertical drag moves the card, not the
  // page. Called twice per drag, never per frame.
  onDragActiveChange?: (active: boolean) => void;
};

/**
 * Owner-only drag-to-reorder for the 3×3 Grails grid (Profile's reorder
 * mode). Long-press a Grail to lift it; it follows the finger and the
 * others slide out of the way; release and it springs into place and the
 * new order is saved — once, on release.
 *
 * Order model = reorder_grail_slots' own: the occupied slot indexes stay
 * occupied (gaps never move) and the dragged Grail is MOVED to a new
 * position among them, shifting the ones in between by one — a sortable
 * list over the filled cells, not a swap. Hovering an empty cell is
 * ignored.
 *
 * Everything per-frame runs on the UI thread: the order lives in a shared
 * value, tiles position themselves from it, and React only hears about
 * the result on release (plus haptics).
 */
export function GrailDragGrid({
  slots,
  signedImageUrls,
  servedTiers,
  onReorder,
  onDragActiveChange = noop,
  cellWidth,
  cellHeight,
  gap,
}: Props) {
  const geometry = useMemo(() => ({ cellWidth, cellHeight, gap }), [cellWidth, cellHeight, gap]);
  const occupied = useMemo(() => [...slots].sort((a, b) => a.slot_index - b.slot_index), [slots]);
  const occupiedCells = useMemo(() => occupied.map((s) => s.slot_index), [occupied]);
  const emptyCells = useMemo(
    () => Array.from({ length: SLOT_COUNT }, (_, i) => i).filter((i) => !occupiedCells.includes(i)),
    [occupiedCells],
  );

  // Slot ids by list position (position p sits in cell occupiedCells[p]).
  const order = useSharedValue<string[]>(occupied.map((s) => s.id));
  const activeId = useSharedValue<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Server truth changed (save landed, reload, add/remove elsewhere):
  // adopt it. After a successful save it equals what's already shown.
  useEffect(() => {
    if (activeId.get() === null) order.set(occupied.map((s) => s.id));
  }, [occupied, order, activeId]);

  const handleDrop = useCallback(
    async (nextOrder: string[], startOrder: string[]) => {
      hapticDrop();
      if (nextOrder.length === startOrder.length && nextOrder.every((id, i) => id === startOrder[i])) return;
      setSaving(true);
      const ok = await onReorder(nextOrder);
      setSaving(false);
      if (!ok) order.set(startOrder); // tiles spring back
    },
    [onReorder, order],
  );

  const gridWidth = cellWidth * COLS + gap * (COLS - 1);
  const gridHeight = cellHeight * 3 + gap * 2;

  return (
    <View style={{ width: gridWidth, height: gridHeight }}>
      {emptyCells.map((cell) => {
        const { x, y } = cellOrigin(cell, geometry);
        return (
          <View
            key={`empty-${cell}`}
            style={[styles.cell, { width: cellWidth, height: cellHeight, transform: [{ translateX: x }, { translateY: y }] }]}>
            <View style={styles.emptyFill} />
          </View>
        );
      })}
      {occupied.map((slot) => (
        <DraggableGrail
          key={slot.id}
          slot={slot}
          order={order}
          activeId={activeId}
          occupiedCells={occupiedCells}
          geometry={geometry}
          enabled={!saving}
          onDrop={handleDrop}
          onDragActiveChange={onDragActiveChange}>
          {/* Same tile Profile shows (thumbnail / animated collection
              preview). Touches go to the drag gesture, not its Pressable. */}
          <View style={styles.tileContent} pointerEvents="none">
            <GrailSlotPreview
              slot={slot}
              slotIndex={slot.slot_index}
              signedImageUrls={signedImageUrls}
              servedTiers={servedTiers}
              isOwnProfile
              onPressEmpty={noop}
              onPressItem={noop}
              onPressCollection={noop}
              onReplace={noop}
              onRemove={noop}
              reorderMode
            />
          </View>
        </DraggableGrail>
      ))}
    </View>
  );
}

function DraggableGrail({
  slot,
  order,
  activeId,
  occupiedCells,
  geometry,
  enabled,
  onDrop,
  onDragActiveChange,
  children,
}: {
  slot: GrailSlot;
  order: SharedValue<string[]>;
  activeId: SharedValue<string | null>;
  occupiedCells: number[];
  geometry: Geometry;
  enabled: boolean;
  onDrop: (nextOrder: string[], startOrder: string[]) => void;
  onDragActiveChange: (active: boolean) => void;
  children: React.ReactNode;
}) {
  const id = slot.id;
  // Mount position from props, never from `order` (reading a shared value
  // during render trips Reanimated's strict-mode warning). They agree at
  // mount: `order` starts as the occupied slots sorted by slot_index, so
  // this tile's position is its own slot_index. Later moves come from the
  // reaction below (tiles are keyed by slot id, so a reorder doesn't
  // remount them).
  const initial = cellOrigin(slot.slot_index, geometry);
  // Resting position (springs between cells) and, while lifted, the
  // finger-driven position.
  const posX = useSharedValue(initial.x);
  const posY = useSharedValue(initial.y);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startOrder = useSharedValue<string[]>([]);

  // Slide to this Grail's cell whenever the order moves it — the "others
  // make room" animation. The lifted Grail follows the finger instead.
  useAnimatedReaction(
    () => occupiedCells[order.get().indexOf(id)] ?? -1,
    (cell, previous) => {
      if (cell < 0 || cell === previous || activeId.get() === id) return;
      const target = cellOrigin(cell, geometry);
      posX.set(withSpring(target.x, SETTLE_SPRING));
      posY.set(withSpring(target.y, SETTLE_SPRING));
    },
    [occupiedCells, geometry],
  );

  const pan = Gesture.Pan()
    .enabled(enabled)
    .activateAfterLongPress(LIFT_DELAY_MS)
    .onStart(() => {
      activeId.set(id);
      startOrder.set(order.get());
      startX.set(posX.get());
      startY.set(posY.get());
      dragX.set(posX.get());
      dragY.set(posY.get());
      scheduleOnRN(hapticLift);
      scheduleOnRN(onDragActiveChange, true);
    })
    .onUpdate((e) => {
      const x = startX.get() + e.translationX;
      const y = startY.get() + e.translationY;
      dragX.set(x);
      dragY.set(y);
      // Which cell the card's centre is over (clamped into the grid).
      const col = Math.min(COLS - 1, Math.max(0, Math.floor((x + geometry.cellWidth / 2) / (geometry.cellWidth + geometry.gap))));
      const row = Math.min(2, Math.max(0, Math.floor((y + geometry.cellHeight / 2) / (geometry.cellHeight + geometry.gap))));
      const targetPos = occupiedCells.indexOf(row * COLS + col);
      if (targetPos < 0) return; // over an empty cell — hold the current order
      const current = order.get();
      const from = current.indexOf(id);
      if (from < 0 || targetPos === from) return;
      const next = current.slice();
      next.splice(from, 1);
      next.splice(targetPos, 0, id);
      order.set(next);
      scheduleOnRN(hapticStep);
    })
    .onFinalize((_e, success) => {
      if (activeId.get() !== id) return; // released before it lifted
      // Interrupted (e.g. the system cancelled the touch): put everything
      // back and save nothing.
      if (!success) order.set(startOrder.get());
      const target = cellOrigin(occupiedCells[order.get().indexOf(id)], geometry);
      posX.set(dragX.get());
      posY.set(dragY.get());
      posX.set(withSpring(target.x, SETTLE_SPRING));
      posY.set(withSpring(target.y, SETTLE_SPRING));
      activeId.set(null);
      scheduleOnRN(onDragActiveChange, false);
      if (success) scheduleOnRN(onDrop, order.get(), startOrder.get());
    });

  const style = useAnimatedStyle(() => {
    const lifted = activeId.get() === id;
    return {
      zIndex: lifted ? 10 : 0,
      shadowOpacity: withTiming(lifted ? 0.45 : 0, { duration: 150 }),
      transform: [
        { translateX: lifted ? dragX.get() : posX.get() },
        { translateY: lifted ? dragY.get() : posY.get() },
        { scale: withSpring(lifted ? LIFT_SCALE : 1, SETTLE_SPRING) },
      ],
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.cell, styles.liftShadow, { width: geometry.cellWidth, height: geometry.cellHeight }, style]}
        accessibilityHint="Long press and drag to reorder">
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  cell: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  // Row so GrailSlotPreview's own `flex: 1` + aspectRatio fills the cell
  // exactly as it does in ProfileV2Grid's rows.
  tileContent: {
    flex: 1,
    flexDirection: 'row',
  },
  emptyFill: {
    flex: 1,
    backgroundColor: PV2.emptyCardBg,
  },
  liftShadow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowRadius: 16,
    shadowOpacity: 0,
  },
});
