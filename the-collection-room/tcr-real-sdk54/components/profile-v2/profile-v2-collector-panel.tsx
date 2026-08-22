import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from './profile-v2-theme';

type Props = {
  avatarUri: string | null;
  displayName: string;
  username: string;
  vaultTotal: number;
  graded: number;
  // Sole avatar-edit entry point for Profile V2 (see profile-v2-screen.tsx,
  // which only passes this for the owner's own profile — pickAvatar).
  // Omitted entirely for a visitor, leaving the avatar non-interactive,
  // same as it always was.
  onAvatarPress?: () => void;
};

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

export function ProfileV2CollectorPanel({
  avatarUri,
  displayName,
  username,
  vaultTotal,
  graded,
  onAvatarPress,
}: Props) {
  return (
    <View style={styles.panel}>
      {/* Left — identity */}
      <View style={[styles.col, styles.leftCol]}>
        <Pressable
          style={styles.avatar}
          onPress={onAvatarPress}
          disabled={!onAvatarPress}
          accessibilityRole={onAvatarPress ? 'button' : undefined}
          accessibilityLabel={onAvatarPress ? 'Change profile photo' : undefined}>
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
              <Text style={styles.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
            </View>
          )}
        </Pressable>
        <View style={styles.nameBlock}>
          <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
          <Text style={styles.username} numberOfLines={1}>@{username}</Text>
        </View>
      </View>

      <View style={styles.colDivider} />

      {/* Center — vault totals. Both real (collection_items count /
          non-null-grade count via hooks/use-profile.ts). This panel used
          to also show "Authenticated"/"Transferred" stats, but those had
          no backing column/table — always 0 for every user — and were
          removed as visible fake data (beta placeholder-data pass). */}
      <View style={[styles.col, styles.centerCol]}>
        <StatRow label="Vault Total" value={`${vaultTotal} Assets`} />
        <StatRow label="Graded" value={`${graded} Items`} />
      </View>

      <View style={styles.colDivider} />

      {/* Right — CacheCase Certified/Registered seal. A permanent part of
          the CCA identity, not user content — always the same static
          local asset, unrelated to profiles.showcase_badge_url (that
          field and its "Change Collector Badge" edit flow still exist in
          profile-v2-screen.tsx, just no longer rendered here). The
          "CCA #1"-style collector id that used to sit under it was
          identical, hardcoded text on every profile with no real
          per-user identifier behind it — removed as visible fake data. */}
      <View style={[styles.col, styles.rightCol]}>
        <View style={styles.badge}>
          <Image
            source={require('@/assets/Registry/cachecase-certified-registered.png')}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    flexDirection: 'row',
    // 'stretch' (not 'flex-start') so all three columns fill the panel's
    // full height — otherwise each column's height is just its own content
    // height, leaving justifyContent:'center' nothing to center within.
    alignItems: 'stretch',
    marginTop: 0,
    marginHorizontal: 3,
    marginBottom: 3,
    borderRadius: 10,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    overflow: 'hidden',
  },
  col: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  leftCol: {
    gap: 3,
    justifyContent: 'center',
  },
  centerCol: {
    gap: 2,
    justifyContent: 'center',
  },
  rightCol: {
    gap: 3,
    justifyContent: 'center',
  },
  colDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: PV2.dividerColor,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: '#2A2A2A',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  // Purely visual downward nudge for the name+username block — a
  // transform (not marginTop) deliberately, so it's applied after layout
  // and doesn't change leftCol's measured content height. leftCol centers
  // its content via justifyContent:'center', so a marginTop here would
  // have redistributed that centering and shifted the avatar too;
  // transform leaves the avatar's position and leftCol's height exactly
  // as they were.
  nameBlock: {
    transform: [{ translateY: 10 }],
  },
  name: {
    color: PV2.textPrimary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginTop: 2,
  },
  username: {
    color: 'rgba(255,255,255,0.38)',
    fontSize: 9,
  },
  statRow: {
    alignItems: 'center',
  },
  statLabel: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 7,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  statValue: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
  },
  badge: {
    width: 54,
    height: 54,
  },
});
