import { StyleSheet, Text, View } from 'react-native';

export type HeroStatsData = {
  folders: number;
  items: number;
  posts: number;
  followers: number;
  following: number;
};

type Props = {
  stats: HeroStatsData;
};

const ITEMS: { key: keyof HeroStatsData; label: string }[] = [
  { key: 'folders',   label: 'Folders'   },
  { key: 'items',     label: 'Items'     },
  { key: 'posts',     label: 'Posts'     },
  { key: 'followers', label: 'Followers' },
  { key: 'following', label: 'Following' },
];

export function HeroStats({ stats }: Props) {
  return (
    <View style={styles.row}>
      {ITEMS.map((item, index) => (
        <View key={item.key} style={styles.statGroup}>
          {index > 0 && <View style={styles.divider} />}
          <View style={styles.stat}>
            <Text style={styles.statNumber}>{stats[item.key]}</Text>
            <Text style={styles.statLabel}>{item.label}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  statGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 32,
    backgroundColor: '#e0e0e0',
  },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  statNumber: {
    fontSize: 20,
    fontWeight: '700',
    color: '#11181C',
  },
  statLabel: {
    fontSize: 12,
    color: '#687076',
  },
});
