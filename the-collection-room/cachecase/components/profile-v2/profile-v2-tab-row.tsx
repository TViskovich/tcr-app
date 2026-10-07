import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';

import { getProfileBannerAccent, type ProfileBannerVariant } from './profile-banner-variants';
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
// Themed outline: the profile's banner gradient drawn as a thin stroke
// around each pill. 1dp — the same width as the plain border it replaces,
// so the pill's interior, label position and overall size are unchanged —
// and far thinner than the identity card's 4dp frame, so it reads as a
// supporting accent, not four more banners.
const STROKE_WIDTH = 1;
// Active pill gets the full-strength stroke; inactive pills the same colors
// subdued. Active state is still carried mainly by the existing fill/label
// treatment — this only reinforces it.
const ACTIVE_STROKE_OPACITY = 1;
const INACTIVE_STROKE_OPACITY = 0.5;

type Props = {
  active: ProfileV2Section;
  onChange: (section: ProfileV2Section) => void;
  // The profile OWNER's banner (profiles.banner_variant), so a visitor sees
  // the owner's theme. null = legacy neon, same as the identity card.
  bannerVariant: ProfileBannerVariant | null;
};

// Four evenly-spaced pill tabs directly under ProfileV2IdentityCard —
// replaces the old snap-to-center carousel (ProfileV2Selector) for Profile
// V3's shared shell. Static row, no scroll/animation: tapping a pill just
// sets `active` directly.
export function ProfileV2TabRow({ active, onChange, bannerVariant }: Props) {
  const accent = getProfileBannerAccent(bannerVariant);

  return (
    <View style={styles.row}>
      {TABS.map((tab) => {
        const selected = tab.section === active;
        return (
          <TouchableOpacity
            key={tab.section}
            testID={`profile-v3-tab-${tab.section}`}
            style={styles.pill}
            onPress={() => onChange(tab.section)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityState={{ selected }}>
            {/* Stroke = gradient filling the pill, covered by the opaque
                surface inset STROKE_WIDTH on every side. */}
            <LinearGradient
              colors={accent.colors}
              locations={accent.locations}
              start={accent.start}
              end={accent.end}
              style={[
                styles.stroke,
                { opacity: selected ? ACTIVE_STROKE_OPACITY : INACTIVE_STROKE_OPACITY },
              ]}
            />
            <View style={styles.surface}>
              <View style={[StyleSheet.absoluteFill, selected ? styles.fillSelected : styles.fill]} />
            </View>
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
    overflow: 'hidden',
  },
  stroke: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: TAB_HEIGHT / 2,
  },
  // Opaque PV2.bg backing (what used to show through the selected pill's
  // translucent fill — the sticky row behind it is PV2.bg), so the fills
  // below look exactly as before and the gradient only shows as the stroke.
  surface: {
    position: 'absolute',
    top: STROKE_WIDTH,
    right: STROKE_WIDTH,
    bottom: STROKE_WIDTH,
    left: STROKE_WIDTH,
    borderRadius: TAB_HEIGHT / 2 - STROKE_WIDTH,
    overflow: 'hidden',
    backgroundColor: PV2.bg,
  },
  fill: {
    backgroundColor: PV2.panel,
  },
  fillSelected: {
    backgroundColor: 'rgba(255,255,255,0.12)',
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
