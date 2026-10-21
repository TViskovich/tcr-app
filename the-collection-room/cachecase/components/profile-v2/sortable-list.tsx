import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
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

import { PV2 } from './profile-v2-theme';

// Vertical drag-to-reorder for Profile V2's List View Edit Mode — the same
// feel as the Grails drag grid (components/profile-v2/grail-drag-grid.tsx)
// and Share Item's drag grid (components/share/share-card-drag-grid.tsx):
// long-press lifts a row, it follows the finger, the others spring out of
// the way, release snaps it into place and hands the new order back once.
// A cancelled touch puts the order back as it was before the drag.
//
// Fixed row height (every row the same height), so positions are pure
// arithmetic on the UI thread. The order lives in a shared value; rows
// position themselves from it; React only hears about the result on
// release. Shared values are never read during render.
//
// Edge auto-scroll: this list sits inside the screen's own ScrollView, so
// while a lifted row's finger is near the top/bottom of the visible area
// the list asks the screen to scroll (autoScroll.scrollBy) every frame and
// shifts the dragged row by however far it actually scrolled — so an entry
// can be carried past the visible area of a long list.

const LIFT_DELAY_MS = 220;
const LIFT_SCALE = 1.03;
const SETTLE_SPRING = { damping: 20, stiffness: 220, mass: 0.7 };
// How close (pt) to the visible area's top/bottom edge auto-scroll starts,
// and how far it scrolls per frame (~60fps → ~540pt/s).
const EDGE_ZONE = 64;
const AUTO_SCROLL_STEP = 9;
const noop = () => {};

function hapticLift() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(noop);
}
function hapticStep() {
  Haptics.selectionAsync().catch(noop);
}
function hapticDrop() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(noop);
}

export type SortableListAutoScroll = {
  // Scrolls the outer ScrollView by dy (clamped to its range) and returns
  // how far it actually moved.
  scrollBy: (dy: number) => number;
  // The visible content area's top and bottom edges in window coordinates
  // (below a sticky header, above a floating nav). Read when a drag starts.
  getEdges: () => { top: number; bottom: number };
};

type Props<T extends { id: string }> = {
  items: T[];
  rowHeight: number;
  // False while a save is in flight — nothing lifts.
  enabled: boolean;
  // The full new order of ids, once per drop that changed it.
  onReorder: (orderedIds: string[]) => void;
  // True while a row is lifted, false on release (twice per drag).
  onDragActiveChange?: (active: boolean) => void;
  autoScroll?: SortableListAutoScroll;
  renderItem: (item: T, index: number) => ReactNode;
};

export function SortableList<T extends { id: string }>({
  items,
  rowHeight,
  enabled,
  onReorder,
  onDragActiveChange = noop,
  autoScroll,
  renderItem,
}: Props<T>) {
  const idsKey = items.map((i) => i.id).join(',');
  const ids = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey]);

  const order = useSharedValue<string[]>(ids);
  const activeId = useSharedValue<string | null>(null);
  // Total auto-scroll during the current drag (reset as each drag starts).
  const scrollOffset = useSharedValue(0);
  const edgeTop = useSharedValue(0);
  const edgeBottom = useSharedValue(Number.MAX_SAFE_INTEGER);
  const autoDirection = useSharedValue(0);

  // The caller's order changed (a drop it applied, a failed save rolled
  // back, or a refresh): adopt it.
  useEffect(() => {
    if (activeId.get() === null) order.set(ids);
  }, [ids, order, activeId]);

  // ── Edge auto-scroll loop (JS: it drives the outer ScrollView) ───────────
  const frameRef = useRef<number | null>(null);
  const autoScrollRef = useRef(autoScroll);
  useEffect(() => {
    autoScrollRef.current = autoScroll;
  });
  const setAutoScrollDirection = useCallback(
    (direction: number) => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (direction === 0 || !autoScrollRef.current) return;
      const tick = () => {
        const moved = autoScrollRef.current?.scrollBy(direction * AUTO_SCROLL_STEP) ?? 0;
        if (moved !== 0) scrollOffset.set(scrollOffset.get() + moved);
        frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
    },
    [scrollOffset],
  );
  useEffect(() => () => setAutoScrollDirection(0), [setAutoScrollDirection]);

  const dragStarted = useCallback(() => {
    const edges = autoScrollRef.current?.getEdges();
    if (edges) {
      edgeTop.set(edges.top);
      edgeBottom.set(edges.bottom);
    }
    hapticLift();
    onDragActiveChange(true);
  }, [edgeTop, edgeBottom, onDragActiveChange]);

  const dragEnded = useCallback(() => {
    setAutoScrollDirection(0);
    onDragActiveChange(false);
  }, [setAutoScrollDirection, onDragActiveChange]);

  const handleDrop = useCallback(
    (nextOrder: string[], startOrder: string[]) => {
      hapticDrop();
      if (nextOrder.length === startOrder.length && nextOrder.every((id, i) => id === startOrder[i])) return;
      onReorder(nextOrder);
    },
    [onReorder],
  );

  return (
    <View style={{ height: rowHeight * items.length }}>
      {items.map((item, index) => (
        <SortableRow
          key={item.id}
          id={item.id}
          index={index}
          count={items.length}
          rowHeight={rowHeight}
          order={order}
          activeId={activeId}
          scrollOffset={scrollOffset}
          edgeTop={edgeTop}
          edgeBottom={edgeBottom}
          autoDirection={autoDirection}
          enabled={enabled}
          onDragStarted={dragStarted}
          onDragEnded={dragEnded}
          onAutoScrollDirection={setAutoScrollDirection}
          onDrop={handleDrop}>
          {renderItem(item, index)}
        </SortableRow>
      ))}
    </View>
  );
}

function SortableRow({
  id,
  index,
  count,
  rowHeight,
  order,
  activeId,
  scrollOffset,
  edgeTop,
  edgeBottom,
  autoDirection,
  enabled,
  onDragStarted,
  onDragEnded,
  onAutoScrollDirection,
  onDrop,
  children,
}: {
  id: string;
  index: number;
  count: number;
  rowHeight: number;
  order: SharedValue<string[]>;
  activeId: SharedValue<string | null>;
  scrollOffset: SharedValue<number>;
  edgeTop: SharedValue<number>;
  edgeBottom: SharedValue<number>;
  autoDirection: SharedValue<number>;
  enabled: boolean;
  onDragStarted: () => void;
  onDragEnded: () => void;
  onAutoScrollDirection: (direction: number) => void;
  onDrop: (nextOrder: string[], startOrder: string[]) => void;
  children: ReactNode;
}) {
  // Mount position from props, never from `order` (no shared-value reads in
  // render). They agree at mount; later moves come from the reaction below.
  const posY = useSharedValue(index * rowHeight);
  const dragY = useSharedValue(0);
  const startY = useSharedValue(0);
  const translation = useSharedValue(0);
  const startOrder = useSharedValue<string[]>([]);

  // Moves this (lifted) row's id to the position its centre is over.
  const reorderTo = (y: number) => {
    'worklet';
    const target = Math.min(count - 1, Math.max(0, Math.floor((y + rowHeight / 2) / rowHeight)));
    const current = order.get();
    const from = current.indexOf(id);
    if (from < 0 || target === from) return;
    const next = current.slice();
    next.splice(from, 1);
    next.splice(target, 0, id);
    order.set(next);
    scheduleOnRN(hapticStep);
  };

  // Slide to this row's slot whenever the order moves it — the "others make
  // room" animation. The lifted row follows the finger instead.
  useAnimatedReaction(
    () => order.get().indexOf(id),
    (position, previous) => {
      if (position < 0 || position === previous || activeId.get() === id) return;
      posY.set(withSpring(position * rowHeight, SETTLE_SPRING));
    },
    [rowHeight],
  );

  // Auto-scroll moved the list under a still finger: keep the lifted row
  // under the finger and keep reordering.
  useAnimatedReaction(
    () => scrollOffset.get(),
    (offset, previous) => {
      if (offset === previous || activeId.get() !== id) return;
      const y = startY.get() + translation.get() + offset;
      dragY.set(y);
      reorderTo(y);
    },
  );

  const pan = Gesture.Pan()
    .enabled(enabled)
    // Long-press first, so a vertical swipe that starts on a row still
    // scrolls the page.
    .activateAfterLongPress(LIFT_DELAY_MS)
    .onStart(() => {
      activeId.set(id);
      startOrder.set(order.get());
      scrollOffset.set(0);
      translation.set(0);
      startY.set(posY.get());
      dragY.set(posY.get());
      scheduleOnRN(onDragStarted);
    })
    .onUpdate((e) => {
      translation.set(e.translationY);
      const y = startY.get() + e.translationY + scrollOffset.get();
      dragY.set(y);
      reorderTo(y);
      const direction =
        e.absoluteY > edgeBottom.get() - EDGE_ZONE ? 1 : e.absoluteY < edgeTop.get() + EDGE_ZONE ? -1 : 0;
      if (direction !== autoDirection.get()) {
        autoDirection.set(direction);
        scheduleOnRN(onAutoScrollDirection, direction);
      }
    })
    .onFinalize((_e, success) => {
      if (activeId.get() !== id) return; // released before it lifted
      autoDirection.set(0);
      // Interrupted (e.g. the system cancelled the touch): put the order
      // back as it was before this drag; report nothing.
      if (!success) order.set(startOrder.get());
      const target = Math.max(0, order.get().indexOf(id)) * rowHeight;
      posY.set(dragY.get());
      posY.set(withSpring(target, SETTLE_SPRING));
      activeId.set(null);
      scheduleOnRN(onDragEnded);
      if (success) scheduleOnRN(onDrop, order.get(), startOrder.get());
    });

  const style = useAnimatedStyle(() => {
    const lifted = activeId.get() === id;
    return {
      zIndex: lifted ? 10 : 0,
      shadowOpacity: withTiming(lifted ? 0.45 : 0, { duration: 150 }),
      transform: [
        { translateY: lifted ? dragY.get() : posY.get() },
        { scale: withSpring(lifted ? LIFT_SCALE : 1, SETTLE_SPRING) },
      ],
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.row, styles.liftShadow, { height: rowHeight }, style]}
        accessibilityHint="Long press and drag to reorder">
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    // Opaque, so a lifted row covers the rows it slides over.
    backgroundColor: PV2.bg,
  },
  liftShadow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowRadius: 16,
    shadowOpacity: 0,
  },
});
