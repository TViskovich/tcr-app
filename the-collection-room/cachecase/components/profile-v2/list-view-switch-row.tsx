import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import {
  SEARCH_BAR_BORDER,
  SEARCH_BAR_ICON_GAP,
  SEARCH_BAR_ICON_SIZE,
  SEARCH_BAR_PADDING_H,
} from '@/components/collection/collection-search-bar';
import { IconSymbol } from '@/components/ui/icon-symbol';

import { PV2 } from './profile-v2-theme';

// Profile V2's "List View" display preference (on = List View, off = Grid
// View) for the Collection and Items tabs. One component — rule, spacing and
// row together — used by every long-press menu that offers it (the owner's
// Add menu, the Search Collections / Search Items sheets), so it looks
// exactly the same in all of them: a quiet setting below the menu's own
// content, not another action (no icon tile, no chevron).
// Flipping it doesn't close the menu.
export type ListViewSwitch = {
  label: string;
  icon: 'list.bullet';
  value: boolean;
  onChange: (value: boolean) => void;
};

// Where the icon and label line up — with whatever sits above the row:
//  - 'menuActions' (the owner's Add menu): the action titles ("Add Item",
//    "Add Collection") — their icon tile is 44pt wide with a 14pt gap
//    before the text (collection-add-menu.tsx's iconWrap/row).
//  - 'searchField' (the Search Items / Search Collections sheets): the
//    search bar — icon centered under its magnifying glass, label starting
//    where its text does (collection-search-bar.tsx's own geometry).
const ALIGNMENTS = {
  menuActions: { inset: 0, iconSlot: 44, gap: 14 },
  searchField: {
    inset: SEARCH_BAR_BORDER + SEARCH_BAR_PADDING_H,
    iconSlot: SEARCH_BAR_ICON_SIZE,
    gap: SEARCH_BAR_ICON_GAP,
  },
} as const;

// React Native's iOS Switch height (its native default) — see switchSlot.
const SWITCH_HEIGHT = 31;

export function ListViewSwitchRow({
  toggle,
  alignTo = 'menuActions',
}: {
  toggle: ListViewSwitch;
  alignTo?: keyof typeof ALIGNMENTS;
}) {
  const align = ALIGNMENTS[alignTo];
  return (
    <View style={styles.section}>
      {/* The whole row flips the switch too. The app's established switch
          styling (as in the item details forms): light-blue track when on,
          white thumb. */}
      <Pressable
        style={[styles.row, { paddingLeft: align.inset, gap: align.gap }]}
        onPress={() => toggle.onChange(!toggle.value)}
        accessibilityRole="switch"
        accessibilityLabel={toggle.label}
        accessibilityState={{ checked: toggle.value }}>
        {/* The glyph is centered in the slot (it may be wider than a narrow
            slot; it overflows evenly, so its centre still lines up). */}
        <View style={[styles.iconSlot, { width: align.iconSlot }]}>
          <IconSymbol name={toggle.icon} size={18} color={PV2.textSecondary} />
        </View>
        <Text style={styles.label}>{toggle.label}</Text>
        {/* Centered by the row like the icon and label. The fixed-height
            slot matters: given a taller box, iOS draws a UISwitch pinned to
            the box's top (it doesn't center itself), so a switch stretched
            to the row's height sat above the label's centerline. */}
        <View style={styles.switchSlot}>
          <Switch
            value={toggle.value}
            onValueChange={toggle.onChange}
            trackColor={{ false: PV2.collectorPanelBg, true: PV2.actionPrimary }}
            thumbColor="#fff"
          />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // A full-width rule and breathing room above, so it reads as a separate
  // setting below whatever the menu shows first.
  section: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.14)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
  },
  iconSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
    // Android: no extra font padding above the text (it would push the
    // text lower still, away from the switch's middle).
    includeFontPadding: false,
  },
  // Exactly the switch's own height (React Native's iOS Switch is 31pt), so
  // the switch fills it without being stretched; the row then centers this
  // slot on the same line as the icon and label.
  switchSlot: {
    height: SWITCH_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
