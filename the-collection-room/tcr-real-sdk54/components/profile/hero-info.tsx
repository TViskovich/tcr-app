import { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Fonts } from '@/constants/theme';

type Props = {
  displayName: string;
  username: string;
  bio: string | null;
  actionRow?: ReactNode;
};

export function HeroInfo({ displayName, username, bio, actionRow }: Props) {
  return (
    <>
      {/* Identity block — name + handle as one unit, bio below */}
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
    marginTop: 10,
    paddingHorizontal: 20,
  },
  displayName: {
    fontFamily: Fonts?.brand,
    fontSize: 24,
    color: '#FFFFFF',
    textAlign: 'center',
    letterSpacing: 0.5,
    marginBottom: 6,
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  username: {
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 0.2,
    color: 'rgba(255,255,255,0.82)',
    marginBottom: 11,
  },
  bio: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.48)',
    textAlign: 'center',
    lineHeight: 19,
  },
  actionRowWrap: {
    marginTop: 14,
    alignSelf: 'stretch',
    paddingHorizontal: 24,
  },
});
