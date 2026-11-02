import { useEffect, useState } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';

import { PV2 } from './profile-v2-theme';

// Search Items' filter dropdown — a compact menu anchored to the filter
// button beside the search field. The first level is three rows (Sort By,
// Item Type, View), each showing its current choice; a row opens a small
// submenu of that row's options (checkmark on the current one) with a back
// row to return. Choosing an option applies it immediately and closes the
// menu. Tapping outside closes it.
//
// Drawn on the search sheet's own overlay layer (same Modal as the sheet,
// never a second Modal), positioned in window coordinates from the button's
// measured rect: under the button when it fits above the keyboard, else
// above it, and always clamped inside the visible screen (between the
// status bar and the keyboard/home indicator) — a submenu taller than the
// space scrolls.

export type AnchorRect = { x: number; y: number; width: number; height: number };
export type MenuOption<V extends string> = { value: V; label: string };

const MENU_WIDTH = 220;
const GAP = 6;
const SCREEN_MARGIN = 8;

type Page = 'root' | 'sort' | 'type' | 'view';

export function ItemSearchFilterMenu<S extends string, T extends string, W extends string>({
  anchor,
  onClose,
  sortOptions,
  sort,
  onSort,
  typeOptions,
  type,
  onType,
  viewOptions,
  view,
  onView,
}: {
  // The filter button's window rect; null renders nothing.
  anchor: AnchorRect | null;
  onClose: () => void;
  sortOptions: MenuOption<S>[];
  sort: S;
  onSort: (value: S) => void;
  typeOptions: MenuOption<T>[];
  type: T;
  onType: (value: T) => void;
  // Omitted when the caller has no Grid/List preference to offer.
  viewOptions?: MenuOption<W>[];
  view?: W;
  onView?: (value: W) => void;
}) {
  const [page, setPage] = useState<Page>('root');
  const [menuHeight, setMenuHeight] = useState(0);
  const keyboardHeight = useKeyboardHeight();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  if (!anchor) return null;

  const labelOf = <V extends string>(options: MenuOption<V>[], value: V | undefined) =>
    options.find((o) => o.value === value)?.label ?? '';

  // Visible band: below the status bar, above the keyboard (or the home
  // indicator when the keyboard is down).
  const visibleTop = insets.top + SCREEN_MARGIN;
  const visibleBottom = windowHeight - Math.max(keyboardHeight, insets.bottom) - SCREEN_MARGIN;
  const below = anchor.y + anchor.height + GAP;
  const spaceBelow = visibleBottom - below;
  const spaceAbove = anchor.y - GAP - visibleTop;
  const openBelow = menuHeight <= spaceBelow || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(openBelow ? spaceBelow : spaceAbove, 120);
  const shownHeight = Math.min(menuHeight, maxHeight);
  const top = openBelow ? below : Math.max(visibleTop, anchor.y - GAP - shownHeight);
  // Right edge on the button's right edge, kept inside the screen.
  const left = Math.min(
    Math.max(anchor.x + anchor.width - MENU_WIDTH, SCREEN_MARGIN),
    windowWidth - MENU_WIDTH - SCREEN_MARGIN,
  );

  function choose(apply: () => void) {
    apply();
    setPage('root');
    onClose();
  }

  function close() {
    setPage('root');
    onClose();
  }

  let rows: React.ReactNode;
  if (page === 'root') {
    rows = (
      <>
        <RootRow label="Sort By" value={labelOf(sortOptions, sort)} onPress={() => setPage('sort')} />
        <RootRow label="Item Type" value={labelOf(typeOptions, type)} onPress={() => setPage('type')} />
        {viewOptions && <RootRow label="View" value={labelOf(viewOptions, view)} onPress={() => setPage('view')} />}
      </>
    );
  } else {
    const back = (title: string) => (
      <Pressable
        style={({ pressed }) => [styles.row, styles.backRow, pressed && styles.rowPressed]}
        onPress={() => setPage('root')}
        accessibilityRole="button"
        accessibilityLabel={`Back to filters from ${title}`}>
        <IconSymbol name="chevron.left" size={14} color={PV2.textSecondary} />
        <Text style={styles.backLabel}>{title}</Text>
      </Pressable>
    );
    if (page === 'sort') {
      rows = (
        <>
          {back('Sort By')}
          {sortOptions.map((o) => (
            <OptionRow key={o.value} label={o.label} selected={o.value === sort} onPress={() => choose(() => onSort(o.value))} />
          ))}
        </>
      );
    } else if (page === 'type') {
      rows = (
        <>
          {back('Item Type')}
          {typeOptions.map((o) => (
            <OptionRow key={o.value} label={o.label} selected={o.value === type} onPress={() => choose(() => onType(o.value))} />
          ))}
        </>
      );
    } else {
      rows = (
        <>
          {back('View')}
          {(viewOptions ?? []).map((o) => (
            <OptionRow
              key={o.value}
              label={o.label}
              selected={o.value === view}
              onPress={() => choose(() => onView?.(o.value))}
            />
          ))}
        </>
      );
    }
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Outside tap closes the menu; no dimming — it's a contextual menu. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close filters" />
      <View
        style={[
          styles.menu,
          { top, left, maxHeight },
          // Hidden for the frame before its height is known, so it never
          // flashes in the wrong place.
          menuHeight === 0 && styles.measuring,
        ]}>
        <ScrollView
          bounces={false}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={(_w, h) => setMenuHeight((prev) => (prev === h ? prev : h))}>
          {rows}
        </ScrollView>
      </View>
    </View>
  );
}

function RootRow({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
      <IconSymbol name="chevron.right" size={12} color={PV2.textTertiary} />
    </Pressable>
  );
}

function OptionRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="menuitem"
      accessibilityState={{ selected }}>
      <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]} numberOfLines={1}>
        {label}
      </Text>
      {selected && <Text style={styles.checkmark}>✓</Text>}
    </Pressable>
  );
}

// Current keyboard height (0 while it's down) — keeps the menu above it.
function useKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

const styles = StyleSheet.create({
  // Same dark contextual-menu treatment as AnchoredMenu's scrollable menus
  // (profile-v2-anchored-menu.tsx: #161616, panelBorder, 14 radius), with a
  // shadow so it reads above the sheet behind it.
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    backgroundColor: '#161616',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    paddingVertical: 4,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  measuring: {
    opacity: 0,
  },
  // Row spec shared with SelectField's menu rows (select-field.tsx).
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  rowLabel: {
    fontSize: 15,
    color: PV2.textPrimary,
  },
  rowValue: {
    flex: 1,
    textAlign: 'right',
    fontSize: 13,
    color: PV2.textTertiary,
  },
  backRow: {
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.border,
  },
  backLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  optionLabel: {
    flex: 1,
    fontSize: 15,
    color: PV2.textPrimary,
  },
  optionLabelSelected: {
    color: PV2.actionPrimary,
    fontWeight: '600',
  },
  checkmark: {
    fontSize: 14,
    fontWeight: '700',
    color: PV2.actionPrimary,
  },
});
