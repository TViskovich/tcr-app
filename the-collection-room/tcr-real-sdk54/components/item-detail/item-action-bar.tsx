import { StyleSheet, Text, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

// Layout only — see app/item/[id].tsx. None of these icons are wired to a
// handler yet; this is the permanent slot future features (likes, comments,
// ratings, search, bookmark, share) will plug into. The centered dots are a
// placeholder for a future element, not a control.
export function ItemActionBar() {
  return (
    <View style={styles.row}>
      <View style={styles.side}>
        <View style={styles.iconBtn}>
          <IconSymbol name="heart" size={22} color={PV2.textPrimary} />
        </View>
        <View style={styles.iconBtn}>
          <IconSymbol name="message" size={21} color={PV2.textPrimary} />
        </View>
        <View style={styles.iconBtn}>
          <IconSymbol name="star" size={21} color={PV2.textPrimary} />
        </View>
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
});
