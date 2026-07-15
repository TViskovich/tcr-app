import { StyleSheet, Text, View } from 'react-native';

import { formatCount, PV2 } from './profile-v2-theme';

type Props = {
  followers: number;
  following: number;
};

// Real counts — hooks/use-profile.ts's ProfileStats already queries the
// follows table for both directions, no new data source needed here.
export function ProfileV2Stats({ followers, following }: Props) {
  return (
    <View style={styles.row}>
      <View style={styles.stat}>
        <Text style={styles.value}>{formatCount(followers)}</Text>
        <Text style={styles.label}>Followers</Text>
      </View>
      <View style={styles.divider} />
      <View style={styles.stat}>
        <Text style={styles.value}>{formatCount(following)}</Text>
        <Text style={styles.label}>Following</Text>
      </View>
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
