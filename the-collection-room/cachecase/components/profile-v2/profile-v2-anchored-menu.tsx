import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  BackHandler,
  type GestureResponderEvent,
  Modal,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from './profile-v2-theme';

export type AnchorRect = { x: number; y: number; width: number; height: number };

// Open/measure/close state for the expanded profile panel's Follow/
// Following dropdown (profile-v2-follow-menu.tsx) — "measure the trigger,
// open a Modal-hosted box just under it, close on an outside tap or a
// selection." Kept as its own small, reusable primitive (rather than
// inlined into that one component) in case another anchored dropdown
// needs the exact same mechanics later; the owner's "..." button
// deliberately does NOT use this — it's a direct tap into enterEdit(),
// with no menu at all (see profile-v2-expanded-details.tsx).
export function useAnchoredMenu() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const triggerRef = useRef<View>(null);

  // Tapping the trigger of an open menu closes it (only reachable inside an
  // AnchoredMenuHost — a Modal-hosted menu covers its trigger).
  function openMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
      setOpen(true);
    });
  }

  function closeMenu() {
    setOpen(false);
  }

  return { open, anchor, triggerRef, openMenu, closeMenu };
}

type Props = {
  visible: boolean;
  anchor: AnchorRect | null;
  onRequestClose: () => void;
  children: ReactNode;
  // Long option lists (e.g. SelectField with many options): the menu is
  // capped to the space available on screen and scrolls, opening ABOVE the
  // trigger when there's more room there. Off by default — every existing
  // short menu renders exactly as before.
  scrollable?: boolean;
};

const SCREEN_MARGIN = 16;

// The dropdown box itself — anchored under `anchor` (from useAnchoredMenu
// above), compact, dark. The project's existing menu-shaped components
// (FolderCoverMenu, CollectionAddMenu, CreateMenu) are all full-width
// bottom sheets over a screen-covering backdrop — the opposite of "anchor
// under a small button, stay compact, don't cover large portions of the
// screen" — so none of them fit this use. Built from React Native's own
// Modal + View.measureInWindow; no new dependency.
//
// On a screen with an AnchoredMenuHost + AnchoredMenuLayer (below) the menu
// is instead part of the scrolling page — it moves with the page and the
// page keeps scrolling while it's open; everywhere else it is Modal-hosted.
export function AnchoredMenu(props: Props) {
  const host = useContext(AnchoredMenuHostContext);
  return host ? <HostedAnchoredMenu {...props} host={host} /> : <ModalAnchoredMenu {...props} />;
}

function ModalAnchoredMenu({ visible, anchor, onRequestClose, children, scrollable = false }: Props) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The menu's own rendered height (0 until its first layout). The menu is
  // always shown at full height — never squeezed into the space left under
  // the trigger — and placed once measured.
  const [menuHeight, setMenuHeight] = useState(0);

  const below = anchor ? anchor.y + anchor.height + 6 : 0;
  const bottomLimit = windowHeight - insets.bottom - SCREEN_MARGIN;
  const fitsBelow = below + menuHeight <= bottomLimit;
  // `scrollable` (long option lists) may also open ABOVE the trigger, but
  // only when the whole menu fits there.
  const openAbove =
    scrollable && !!anchor && menuHeight > 0 && !fitsBelow && anchor.y - 6 - menuHeight >= insets.top + SCREEN_MARGIN;
  const position = openAbove && anchor ? { bottom: windowHeight - anchor.y + 6 } : { top: below };
  // When a below-opening menu runs past the bottom of the screen, the
  // overlay itself scrolls, so the user can drag the rest of the menu into
  // view (the open menu blocks the page underneath from scrolling).
  const contentHeight = openAbove ? windowHeight : Math.max(windowHeight, below + menuHeight + insets.bottom + SCREEN_MARGIN);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      <ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={{ height: contentHeight }}
        bounces={false}
        showsVerticalScrollIndicator={contentHeight > windowHeight}
        keyboardShouldPersistTaps="handled">
        {/* Invisible full-size Pressable purely to catch an outside tap and
            close the menu — this is a real anchored dropdown, not a sheet,
            so there's no dimming backdrop. A drag scrolls instead. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onRequestClose} />
        {anchor && (
          <View
            onLayout={(e) => {
              const height = e.nativeEvent.layout.height;
              setMenuHeight((prev) => (prev === height ? prev : height));
            }}
            style={[
              styles.menu,
              scrollable && styles.menuScrollable,
              position,
              { left: anchor.x, minWidth: anchor.width },
              // Hidden for the single frame before it is measured, so it
              // never flashes in the wrong place.
              menuHeight === 0 && styles.menuMeasuring,
            ]}>
            {children}
          </View>
        )}
      </ScrollView>
    </Modal>
  );
}

// ── Hosted (non-Modal) menus ─────────────────────────────────────────────
// On a screen wrapped in AnchoredMenuHost, with an AnchoredMenuLayer as the
// last child of its ScrollView's content, an open menu is drawn on that
// layer — inside the scrolling content, above every other field — instead
// of in a Modal. It drops down under its field at full size, exactly as
// before, but is part of the page: dragging scrolls the page and the menu
// moves with it, staying attached to its field. A tap (not a drag) outside
// every open menu closes them, same as the Modal's outside tap. A menu that
// would run past the end of the content opens above its field instead.
// Without a layer on screen, menus fall back to the Modal.
//
// Menus reach the layer through a small external store rather than host
// state, so updating a menu re-renders only the layer, never the screen.

type HostedEntry = {
  anchor: AnchorRect;
  children: ReactNode;
  scrollable: boolean;
  onRequestClose: () => void;
};
type HostSnapshot = { entries: [string, HostedEntry][]; layers: number };

function createMenuStore() {
  const entries = new Map<string, HostedEntry>();
  const boxes = new Map<string, View>();
  const listeners = new Set<() => void>();
  let snapshot: HostSnapshot = { entries: [], layers: 0 };
  function emit(next: Partial<HostSnapshot>) {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    // A primitive, so a subscriber reading only this re-renders only when
    // it actually flips (see HostedAnchoredMenu).
    hasLayer: () => snapshot.layers > 0,
    set(id: string, entry: HostedEntry | null) {
      if (entry) {
        const prev = entries.get(id);
        // Same menu, nothing new to draw — don't notify anyone.
        if (
          prev &&
          prev.anchor === entry.anchor &&
          prev.children === entry.children &&
          prev.scrollable === entry.scrollable &&
          prev.onRequestClose === entry.onRequestClose
        ) {
          return;
        }
        entries.set(id, entry);
      } else {
        if (!entries.has(id)) return;
        entries.delete(id);
        boxes.delete(id);
      }
      emit({ entries: [...entries] });
    },
    setBox(id: string, box: View | null) {
      if (box) boxes.set(id, box);
      else boxes.delete(id);
    },
    addLayer() {
      emit({ layers: snapshot.layers + 1 });
      return () => emit({ layers: snapshot.layers - 1 });
    },
    // A tap at window point (x, y): closes every open menu it isn't on.
    tapAt(x: number, y: number) {
      for (const [id, entry] of entries) {
        boxes.get(id)?.measureInWindow((bx, by, width, height) => {
          if (!(x >= bx && x <= bx + width && y >= by && y <= by + height)) entry.onRequestClose();
        });
      }
    },
  };
}

type MenuStore = ReturnType<typeof createMenuStore>;

const AnchoredMenuHostContext = createContext<MenuStore | null>(null);

// Movement (pt) under which a touch counts as a tap rather than a drag.
const TAP_SLOP = 10;

// Wraps the whole screen: provides the store and watches for outside taps.
export function AnchoredMenuHost({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const [store] = useState(createMenuStore);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  function handleTouchStart(e: GestureResponderEvent) {
    const { pageX, pageY, touches } = e.nativeEvent;
    touchStart.current = touches.length > 1 ? null : { x: pageX, y: pageY };
  }

  function handleTouchEnd(e: GestureResponderEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const { pageX, pageY } = e.nativeEvent;
    if (Math.abs(pageX - start.x) > TAP_SLOP || Math.abs(pageY - start.y) > TAP_SLOP) return;
    store.tapAt(pageX, pageY);
  }

  return (
    <AnchoredMenuHostContext.Provider value={store}>
      <View
        style={[styles.host, style]}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={() => {
          touchStart.current = null;
        }}>
        {children}
      </View>
    </AnchoredMenuHostContext.Provider>
  );
}

// Goes LAST inside the screen's ScrollView content, so it scrolls with the
// page and draws above every field. Covers the whole content and only takes
// touches that land on an open menu.
export function AnchoredMenuLayer() {
  const store = useContext(AnchoredMenuHostContext);
  if (!store) return null;
  return <HostedMenuLayer store={store} />;
}

function HostedMenuLayer({ store }: { store: MenuStore }) {
  const { entries } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const layerRef = useRef<View>(null);
  const [layerHeight, setLayerHeight] = useState(0);

  useEffect(() => store.addLayer(), [store]);

  return (
    <View
      ref={layerRef}
      style={styles.layer}
      pointerEvents="box-none"
      onLayout={(e) => {
        const height = e.nativeEvent.layout.height;
        setLayerHeight((prev) => (prev === height ? prev : height));
      }}>
      {entries.map(([id, entry]) => (
        <HostedMenuBox key={id} id={id} entry={entry} layerRef={layerRef} layerHeight={layerHeight} store={store} />
      ))}
    </View>
  );
}

// Publishes this menu to the layer while it's open; renders nothing itself
// (or the Modal menu, when the screen has no layer mounted).
//
// Subscribes ONLY to hasLayer (a boolean), never to the whole snapshot: the
// publish below changes the snapshot, and re-rendering on that would run the
// publish again — an endless update loop.
function HostedAnchoredMenu({ host, ...props }: Props & { host: MenuStore }) {
  const { visible, anchor, onRequestClose, children, scrollable = false } = props;
  const hosted = useSyncExternalStore(host.subscribe, host.hasLayer);
  const id = useId();
  const open = hosted && visible && !!anchor;

  // After each render of this menu's owner: keeps the layer's copy current
  // (a no-op when nothing changed). Re-renders come from the owner only —
  // see the subscription comment above.
  useEffect(() => {
    host.set(id, open && anchor ? { anchor, children, scrollable, onRequestClose } : null);
  });
  useEffect(() => () => host.set(id, null), [host, id]);

  // Android back closes the menu, as the Modal's onRequestClose does.
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onRequestClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onRequestClose]);

  return hosted ? null : <ModalAnchoredMenu {...props} />;
}

// One open menu at full size, in the layer's (= the scroll content's)
// coordinates: the trigger's window position at open, minus the layer's
// window position measured right then — so it stays attached to its field
// however the page scrolls afterwards.
function HostedMenuBox({
  id,
  entry,
  layerRef,
  layerHeight,
  store,
}: {
  id: string;
  entry: HostedEntry;
  layerRef: RefObject<View | null>;
  layerHeight: number;
  store: MenuStore;
}) {
  const { anchor } = entry;
  const [layerOrigin, setLayerOrigin] = useState<{ x: number; y: number } | null>(null);
  const [menuHeight, setMenuHeight] = useState(0);
  const measuredFor = useRef<AnchorRect | null>(null);

  // Re-measure the layer whenever the menu (re)opens at a new anchor.
  useEffect(() => {
    if (measuredFor.current === anchor) return;
    measuredFor.current = anchor;
    layerRef.current?.measureInWindow((x, y) => setLayerOrigin({ x, y }));
  }, [anchor, layerRef]);

  const ready = !!layerOrigin && menuHeight > 0;
  const below = layerOrigin ? anchor.y + anchor.height + 6 - layerOrigin.y : 0;
  const aboveTop = layerOrigin ? anchor.y - 6 - menuHeight - layerOrigin.y : 0;
  // Opens above only when it would run past the end of the content and
  // fits above.
  const openAbove = ready && layerHeight > 0 && below + menuHeight > layerHeight && aboveTop >= 0;
  const left = layerOrigin ? anchor.x - layerOrigin.x : 0;

  return (
    <View
      ref={(node) => store.setBox(id, node)}
      onLayout={(e) => {
        const height = e.nativeEvent.layout.height;
        setMenuHeight((prev) => (prev === height ? prev : height));
      }}
      style={[
        styles.menu,
        entry.scrollable && styles.menuScrollable,
        { top: openAbove ? aboveTop : below, left, minWidth: anchor.width },
        // Hidden until placed, so it never flashes in the wrong spot.
        !ready && styles.menuMeasuring,
      ]}>
      {entry.children}
    </View>
  );
}

export const menuStyles = StyleSheet.create({
  // paddingVertical 9 + centered content matches ProfileV2FollowMenu's own
  // actionBtn spec (profile-v2-follow-menu.tsx) exactly, so a single-item
  // menu (the only case today — Follow/Unfollow) reads as a compact
  // extension of the trigger button rather than a left-aligned list row.
  item: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemLabel: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  // Same color this design system already reserves for destructive actions
  // elsewhere (Remove Avatar, Stolen/Missing custody status, Unfollow).
  itemDestructive: {
    color: PV2.accent,
    fontSize: 13,
    fontWeight: '600',
  },
});

const styles = StyleSheet.create({
  host: {
    flex: 1,
  },
  // Covers the whole scroll content, above every field.
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    elevation: 10,
  },
  // borderRadius 20 matches actionBtn/messageBtn's own radius (both
  // profile-v2-follow-menu.tsx and profile-v2-expanded-details.tsx) — with
  // this menu's own compact height (paddingVertical 4 here + item's own
  // paddingVertical 9 + a ~13px line, landing well under 2*20), RN clips
  // the radius to a true stadium/pill regardless, so this reads as the
  // same pill language as the trigger button above it, not a rounded-rect
  // card.
  // A taller scrolling list reads as a rounded card rather than a pill.
  menuScrollable: {
    borderRadius: 14,
  },
  menuMeasuring: {
    opacity: 0,
  },
  menu: {
    position: 'absolute',
    backgroundColor: '#161616',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    paddingVertical: 4,
    overflow: 'hidden',
  },
});
