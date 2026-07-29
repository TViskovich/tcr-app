import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

const IcLogo = require('@/assets/icons/ic-logo-transparent.png');

type Props = {
  // Opens the consolidated CacheCase Registry page (app/registry/[id].tsx)
  // when this item is registered, or a short "Not Registered" notice
  // otherwise — see app/item/[id].tsx's handleCacheCaseIdPress. Previously
  // opened a local placeholder bottom sheet (components/item-detail/
  // cachecase-id-sheet.tsx, removed) with no real data; this button now
  // leads to the one real registry screen instead of a second, fake one.
  onPressCacheCaseId: () => void;
};

// Layout only — see app/item/[id].tsx. None of these icons are wired to a
// handler yet except the CacheCase ID logo below; this is the permanent
// slot future features (likes, comments, ratings, search, bookmark, share)
// will plug into. The centered dots are a placeholder for a future
// element, not a control.
export function ItemActionBar({ onPressCacheCaseId }: Props) {
  return (
    <View style={styles.row}>
      <View style={styles.side}>
        <View style={styles.iconBtn}>
          <IconSymbol name="heart" size={22} color={PV2.textPrimary} />
        </View>
        <View style={styles.iconBtn}>
          <IconSymbol name="message" size={21} color={PV2.textPrimary} />
        </View>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={onPressCacheCaseId}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="CacheCase ID">
          {/* Brand mark, not a tintable glyph — no color prop, kept exactly
              as designed (metallic silver, own transparency). */}
          <Image source={IcLogo} contentFit="contain" style={styles.icLogo} />
        </TouchableOpacity>
      </View>

      <View style={styles.center}>
        <Text style={styles.dots}>•  •  •</Text>
      </View>

      <View style={[styles.side, styles.sideRight]}>
        <View style={styles.iconBtn}>
          <IconSymbol name="magnifyingglass" size={20} color={PV2.textPrimary} />
        </View>
        <View style={styles.iconBtn}>
          <IconSymbol name="bookmark" size={21} color={PV2.textPrimary} />
        </View>
        <View style={styles.iconBtn}>
          <IconSymbol name="square.and.arrow.up" size={21} color={PV2.textPrimary} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  side: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  sideRight: {
    justifyContent: 'flex-end',
  },
  center: {
    paddingHorizontal: 10,
  },
  dots: {
    color: PV2.textTertiary,
    fontSize: 13,
    letterSpacing: 1,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Matches the 21px height of the surrounding icons; width follows the
  // source PNG's own aspect ratio (563x350) rather than a hand-picked
  // number, so it can't distort. iconBtn's own centering keeps it
  // optically aligned with the rest of the row — same as every other icon.
  icLogo: {
    height: 21,
    aspectRatio: 563 / 350,
  },
});
