import { ReactNode, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Fonts } from '@/constants/theme';

type Props = {
  displayName: string;
  username: string;
  bio: string | null;
  actionRow?: ReactNode;
  animatedBioOpacity?: Animated.Value;
  followable?: boolean;
  initiallyFollowing?: boolean;
  onFollowToggle?: (next: boolean) => void;
};

export function HeroInfo({
  displayName,
  username,
  bio,
  actionRow,
  animatedBioOpacity,
  followable = false,
  initiallyFollowing = false,
  onFollowToggle,
}: Props) {
  const [following, setFollowing] = useState(initiallyFollowing);

  function handleFollow() {
    const next = !following;
    setFollowing(next);
    onFollowToggle?.(next);
  }

  return (
    <>
      {/* Identity block — name + handle as one unit, bio below */}
      <View style={styles.textGroup}>
        <Text style={styles.displayName} numberOfLines={1}>{displayName}</Text>
        <Text style={styles.username}>@{username}</Text>
        {bio ? (
          <Animated.Text
            style={[
              styles.bio,
              animatedBioOpacity !== undefined ? { opacity: animatedBioOpacity } : undefined,
            ]}
          >
            {bio}
          </Animated.Text>
        ) : null}
      </View>

      {followable && (
        <Pressable
          onPress={handleFollow}
          style={({ pressed }) => [
            styles.followBtn,
            following && styles.followBtnActive,
            pressed && styles.followBtnPressed,
          ]}
        >
          <Text style={[styles.followBtnText, following && styles.followBtnTextActive]}>
            {following ? 'Following' : 'Follow'}
          </Text>
        </Pressable>
      )}

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
    marginTop: 20,
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
    marginBottom: 5,
  },
  bio: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.80)',
    textAlign: 'center',
    lineHeight: 19,
  },
  followBtn: {
    marginTop: 14,
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 44,
    borderRadius: 24,
    backgroundColor: 'rgba(20,20,24,0.50)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    shadowColor: '#000',
    shadowOpacity: 0.20,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  followBtnActive: {
    backgroundColor: 'rgba(20,20,24,0.40)',
    borderColor: 'rgba(255,255,255,0.16)',
  },
  followBtnPressed: {
    opacity: 0.70,
  },
  followBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  followBtnTextActive: {
    color: 'rgba(255,255,255,0.82)',
  },
  actionRowWrap: {
    marginTop: 2,
    alignSelf: 'stretch',
  },
});
