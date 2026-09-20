import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { formatCount, PV2 } from './profile-v2-theme';

type Props = {
  followers: number;
  following: number;
  // Optional — omitted entirely (e.g. the old, unreachable `section ===
  // 'cachecase'` call site in profile-v2-screen.tsx) leaves each stat a
  // plain, non-interactive View exactly as before. When provided (the
  // expanded-details panel), each stat becomes tappable — no visible
  // button background, just a bigger hitSlop over the same visual size.
  onFollowersPress?: () => void;
  onFollowingPress?: () => void;
};

// Real counts — hooks/use-profile.ts's ProfileStats already queries the
// follows table for both directions, no new data source needed here.
export function ProfileV2Stats({ followers, following, onFollowersPress, onFollowingPress }: Props) {
  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={styles.stat}
        onPress={onFollowersPress}
        disabled={!onFollowersPress}
        hitSlop={8}
        activeOpacity={0.6}
        accessibilityRole={onFollowersPress ? 'button' : undefined}
        accessibilityLabel="Followers">
        <Text style={styles.value}>{formatCount(followers)}</Text>
        <Text style={styles.label}>Followers</Text>
      </TouchableOpacity>
      <View style={styles.divider} />
      <TouchableOpacity
        style={styles.stat}
        onPress={onFollowingPress}
        disabled={!onFollowingPress}
        hitSlop={8}
        activeOpacity={0.6}
        accessibilityRole={onFollowingPress ? 'button' : undefined}
        accessibilityLabel="Following">
        <Text style={styles.value}>{formatCount(following)}</Text>
        <Text style={styles.label}>Following</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    gap: 24,
  },
  stat: {
    alignItems: 'center',
    minWidth: 72,
  },
  value: {
    color: PV2.textPrimary,
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 20,
  },
  label: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 2,
  },
  divider: {
    width: 1,
    height: 28,
    backgroundColor: PV2.dividerColor,
  },
});
