import { type ReactNode, useCallback, useEffect, useMemo } from 'react';
import { type AccessibilityActionEvent, StyleSheet, View } from 'react-native';

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

// Same feel as Profile's Grails reorder (components/profile-v2/
// grail-drag-grid.tsx): lift delay, lift scale, settle spring and haptics.
// Adapted rather than shared — that grid is built around the 9 fixed Grail
// slots (gaps that never move) and a server save per drop; this one is a
// plain wrapping list whose order is local composer state.
const LIFT_DELAY_MS = 220;
const LIFT_SCALE = 1.06;
const SETTLE_SPRING = { damping: 20, stiffness: 220, mass: 0.7 };
const noop = () => {};

type Geometry = { cellWidth: number; cellHeight: number; gap: number; columns: number };

function cellOrigin(position: number, g: Geometry) {
  'worklet';
  return {
    x: (position % g.columns) * (g.cellWidth + g.gap),
    y: Math.floor(position / g.columns) * (g.cellHeight + g.gap),
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

type Props<T extends { id: string }> = Geometry & {
  // In current order; position 0 is the post's first (primary) card.
  items: T[];
  // False while the post is submitting — nothing lifts.
  enabled: boolean;
  // The full new order of ids, once per drop that changed it. Local state
  // only — the caller saves nothing until Post.
  onReorder: (orderedIds: string[]) => void;
  // True while a card is lifted, false on release — lets the screen pause
  // its vertical scrolling. Called twice per drag, never per frame.
  onDragActiveChange?: (active: boolean) => void;
  renderItem: (item: T, index: number) => ReactNode;
};

/**
 * Share Item Preview's drag-to-arrange grid. Long-press a card to lift it;
 * it follows the finger (across rows too) and the others spring out of the
 * way; release and it settles into place and the new order is handed back
 * once. A cancelled touch puts the order back as it was before the drag.
 *
 * Everything per-frame runs on the UI thread: the order lives in a shared
 * value, cards position themselves from it, and React only hears about the
 * result on release (plus haptics). Shared values are never read during
 * render.
 */
export function ShareCardDragGrid<T extends { id: string }>({
  items,
  enabled,
  onReorder,
  onDragActiveChange = noop,
  renderItem,
  cellWidth,
  cellHeight,
  gap,
  columns,
}: Props<T>) {
  const geometry = useMemo(() => ({ cellWidth, cellHeight, gap, columns }), [cellWidth, cellHeight, gap, columns]);
  const idsKey = items.map((i) => i.id).join(',');
  const ids = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey]);

  const order = useSharedValue<string[]>(ids);
  const activeId = useSharedValue<string | null>(null);

  // The caller's order changed (a drop it applied, or a card removed):
  // adopt it. After a drop it already equals what's shown.
  useEffect(() => {
    if (activeId.get() === null) order.set(ids);
  }, [ids, order, activeId]);

  const handleDrop = useCallback(
    (nextOrder: string[], startOrder: string[]) => {
      hapticDrop();
      if (nextOrder.length === startOrder.length && nextOrder.every((id, i) => id === startOrder[i])) return;
      onReorder(nextOrder);
    },
    [onReorder],
  );

  // Screen-reader alternative to dragging: move one place earlier/later.
  const moveByOne = useCallback(
    (id: string, direction: -1 | 1) => {
      const from = ids.indexOf(id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= ids.length) return;
      const next = ids.slice();
      next.splice(from, 1);
      next.splice(to, 0, id);
      onReorder(next);
    },
    [ids, onReorder],
  );

  const rows = Math.max(1, Math.ceil(items.length / columns));
  const width = cellWidth * Math.min(columns, Math.max(1, items.length)) + gap * (Math.min(columns, Math.max(1, items.length)) - 1);
  const height = cellHeight * rows + gap * (rows - 1);

  return (
    <View style={{ width, height }}>
      {items.map((item, index) => (
        <DraggableCard
          key={item.id}
          id={item.id}
          index={index}
          count={items.length}
          order={order}
          activeId={activeId}
          geometry={geometry}
          enabled={enabled}
          onDrop={handleDrop}
          onDragActiveChange={onDragActiveChange}
          onMoveByOne={moveByOne}>
          {renderItem(item, index)}
        </DraggableCard>
      ))}
    </View>
  );
}

function DraggableCard({
  id,
  index,
  count,
  order,
  activeId,
  geometry,
  enabled,
  onDrop,
  onDragActiveChange,
  onMoveByOne,
  children,
}: {
  id: string;
  index: number;
  count: number;
  order: SharedValue<string[]>;
  activeId: SharedValue<string | null>;
  geometry: Geometry;
  enabled: boolean;
  onDrop: (nextOrder: string[], startOrder: string[]) => void;
  onDragActiveChange: (active: boolean) => void;
  onMoveByOne: (id: string, direction: -1 | 1) => void;
  children: ReactNode;
}) {
  // Mount position from props, never from `order` (reading a shared value
  // during render trips Reanimated's strict-mode warning). They agree at
  // mount; later moves come from the reaction below (cards are keyed by id,
  // so a reorder doesn't remount them).
  const initial = cellOrigin(index, geometry);
  const posX = useSharedValue(initial.x);
  const posY = useSharedValue(initial.y);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startOrder = useSharedValue<string[]>([]);

  // Slide to this card's position whenever the order moves it — the "others
  // make room" animation. The lifted card follows the finger instead.
  useAnimatedReaction(
    () => order.get().indexOf(id),
    (position, previous) => {
      if (position < 0 || position === previous || activeId.get() === id) return;
      const target = cellOrigin(position, geometry);
      posX.set(withSpring(target.x, SETTLE_SPRING));
      posY.set(withSpring(target.y, SETTLE_SPRING));
    },
    [geometry],
  );

  const rows = Math.max(1, Math.ceil(count / geometry.columns));
  const pan = Gesture.Pan()
    .enabled(enabled)
    // Long-press first, so a scroll that starts on a card scrolls the page.
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
      // Which position the card's centre is over, clamped into the grid;
      // past the last card of a partial row = the last position.
      const col = Math.min(
        geometry.columns - 1,
        Math.max(0, Math.floor((x + geometry.cellWidth / 2) / (geometry.cellWidth + geometry.gap))),
      );
      const row = Math.min(
        rows - 1,
        Math.max(0, Math.floor((y + geometry.cellHeight / 2) / (geometry.cellHeight + geometry.gap))),
      );
      const targetPos = Math.min(count - 1, row * geometry.columns + col);
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
      // Interrupted (e.g. the system cancelled the touch): put the order
      // back as it was before this drag; report nothing.
      if (!success) order.set(startOrder.get());
      const target = cellOrigin(Math.max(0, order.get().indexOf(id)), geometry);
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

  function handleAccessibilityAction(e: AccessibilityActionEvent) {
    if (!enabled) return;
    if (e.nativeEvent.actionName === 'moveEarlier') onMoveByOne(id, -1);
    if (e.nativeEvent.actionName === 'moveLater') onMoveByOne(id, 1);
  }

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.cell, styles.liftShadow, { width: geometry.cellWidth, height: geometry.cellHeight }, style]}
        accessibilityHint="Long press and drag to reorder"
        accessibilityActions={[
          { name: 'moveEarlier', label: 'Move earlier' },
          { name: 'moveLater', label: 'Move later' },
        ]}
        onAccessibilityAction={handleAccessibilityAction}>
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
  liftShadow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowRadius: 16,
    shadowOpacity: 0,
  },
});
