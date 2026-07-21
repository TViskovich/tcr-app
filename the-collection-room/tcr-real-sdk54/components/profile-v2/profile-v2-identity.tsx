import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { PV2 } from './profile-v2-theme';

// Name/username now render as an overlay on the hero itself (see
// profile-v2-hero.tsx) rather than here, per the reference — this component
// only owns the action row, bio, and website now.
//
// mode is 'owner' for the signed-in user's own profile, 'public' when
// viewing someone else's (components/profile-v2/profile-v2-screen.tsx,
// shared by both app/(tabs)/profile.tsx and app/user/[username].tsx).
type Props = {
  bio: string | null;
  // Omitted entirely when null/undefined — there's no website column on
  // profiles today, so the owner call site simply never passes one rather
  // than this component inventing a fake row.
  website?: string | null;
  mode: 'owner' | 'public';
  onEditPress?: () => void;
  onFollowPress?: () => void;
  onMessagePress?: () => void;
  isFollowing?: boolean;
  followLoading?: boolean;
  messageLoading?: boolean;
};

export function ProfileV2Identity({
  bio,
  website,
  mode,
  onEditPress,
  onFollowPress,
  onMessagePress,
  isFollowing,
  followLoading,
  messageLoading,
}: Props) {
  return (
    <View style={styles.wrap}>
      <View style={styles.actionRow}>
        {mode === 'owner' ? (
          <TouchableOpacity style={styles.editBtn} onPress={onEditPress} activeOpacity={0.85}>
            <Text style={styles.editBtnLabel}>Edit Profile</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={[styles.followBtn, isFollowing && styles.followBtnActive]}
              onPress={onFollowPress}
              disabled={followLoading}
              activeOpacity={0.85}>
              {followLoading ? (
                <ActivityIndicator size="small" color={isFollowing ? PV2.textPrimary : '#fff'} />
              ) : (
                <Text style={styles.followBtnLabel}>{isFollowing ? 'Following' : 'Follow'}</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.messageBtn}
              onPress={onMessagePress}
              disabled={messageLoading}
              activeOpacity={0.85}>
              {messageLoading ? (
                <ActivityIndicator size="small" color={PV2.textPrimary} />
              ) : (
                <Text style={styles.messageBtnLabel}>Message</Text>
              )}
            </TouchableOpacity>
          </>
        )}
      </View>

      {bio ? <Text style={styles.bio}>{bio}</Text> : null}
      {website ? <Text style={styles.website}>{website}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingHorizontal: 24,
    marginTop: -2,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 8,
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  editBtn: {
    flex: 1,
    maxWidth: 220,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editBtnLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  followBtn: {
    flex: 1,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: '#e8181a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  followBtnActive: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  followBtnLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  messageBtn: {
    flex: 1,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageBtnLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  bio: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 12,
  },
  website: {
    color: PV2.link,
    fontSize: 12,
    marginTop: 4,
  },
});
