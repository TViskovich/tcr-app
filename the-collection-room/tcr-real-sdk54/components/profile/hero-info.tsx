import { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

type Props = {
  displayName: string;
  username: string;
  bio: string | null;
  actionRow?: ReactNode;
};

export function HeroInfo({ displayName, username, bio, actionRow }: Props) {
  return (
    <>
      {/* Tight text cluster — name / @handle / bio */}
      <View style={styles.textGroup}>
        <Text style={styles.displayName} numberOfLines={1}>{displayName}</Text>
        <Text style={styles.username}>@{username}</Text>
        {bio ? (
          <Text style={styles.bio}>{bio}</Text>
        ) : null}
      </View>

      {/* Action row slot — follow/message/etc passed in by the parent */}
      {actionRow ? (
        <View style={styles.actionRowWrap}>{actionRow}</View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  textGroup: {
    alignItems: 'center',
    gap: 2,
    marginTop: 12,
    paddingHorizontal: 24,
  },
  displayName: {
    fontSize: 21,
    fontWeight: '800',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  username: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.55)',
  },
  bio: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
    lineHeight: 19,
    marginTop: 2,
  },
  actionRowWrap: {
    marginTop: 14,
    alignSelf: 'stretch',
    paddingHorizontal: 24,
  },
});
