import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { PV2 } from './profile-v2-theme';

// Profile V3's shared top-shell sections. 'cachecase' and 'transfer' are the
// OLD ProfileV2Selector carousel's values (components/profile-v2/profile-v2-
// selector.tsx) — kept here, not deleted, so the profile-v2-screen.tsx
// content branches that still key off them keep type-checking and keep
// working; the new tab row below just never sets state to either of them,
// same as it already can't reach Discover/Messages-style hidden tabs
// elsewhere in this app. 'items' and 'tagged' are new: this piece only
// wires them up as selectable states — see profile-v2-screen.tsx for each
// one's actual content (ProfileV2ItemsGrid and ProfileV2Tagged
// respectively). 'tagged' keeps its "Tagged" label here even though its
// content is the existing bookmark/save repository, not literal tags —
// this file only owns the tab strip, not what renders below it.
export type ProfileV2Section = 'posts' | 'collections' | 'items' | 'tagged' | 'cachecase' | 'transfer';

const TABS: { section: ProfileV2Section; label: string }[] = [
  { section: 'posts', label: 'Posts' },
  { section: 'collections', label: 'Collection' },
  { section: 'items', label: 'Items' },
  { section: 'tagged', label: 'Tagged' },
];

const TAB_HEIGHT = 34;

type Props = {
  active: ProfileV2Section;
  onChange: (section: ProfileV2Section) => void;
};

// Four evenly-spaced pill tabs directly under ProfileV2IdentityCard —
// replaces the old snap-to-center carousel (ProfileV2Selector) for Profile
// V3's shared shell. Static row, no scroll/animation: tapping a pill just
// sets `active` directly.
export function ProfileV2TabRow({ active, onChange }: Props) {
  return (
    <View style={styles.row}>
      {TABS.map((tab) => {
        const selected = tab.section === active;
        return (
          <TouchableOpacity
            key={tab.section}
            testID={`profile-v3-tab-${tab.section}`}
            style={[styles.pill, selected && styles.pillSelected]}
            onPress={() => onChange(tab.section)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityState={{ selected }}>
            <Text style={[styles.label, selected && styles.labelSelected]} numberOfLines={1}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Same 16px horizontal inset as ProfileV2IdentityCard's own marginHorizontal
  // — keeps the row's outer edges aligned with the card above it.
  // marginTop trimmed 10 → 4 → 2 (default-load-fold pass, then a further
  // nudge) — combined with ProfileV2HeroCanvas's own gridStage.paddingBottom
  // (4) that's a 6px Grails→tab-row gap profile-v2-screen.tsx's
  // TAB_CONTENT_TOP_GAP still matches on the tab row's other side.
  row: {
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 2,
  },
  pill: {
    flex: 1,
    height: TAB_HEIGHT,
    borderRadius: TAB_HEIGHT / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  pillSelected: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderColor: PV2.borderStrong,
  },
  label: {
    color: PV2.textTertiary,
    fontSize: 12,
    fontWeight: '600',
  },
  labelSelected: {
    color: PV2.textPrimary,
    fontWeight: '700',
  },
});
