import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { useFollow } from '@/hooks/use-follow';
import type { FollowListUser } from '@/hooks/use-follow-list';

import { PV2 } from './profile-v2-theme';

type Props = {
  user: FollowListUser;
  currentUserId: string | undefined;
  onPress: () => void;
};

// One row in the Followers/Following list screens
// (components/profile-v2/follow-list-screen.tsx). Same avatar+@username+
// display-name shape already established for a user row elsewhere in this
// app (app/(tabs)/search.tsx's own UserRow), rebuilt here in this app's
// dark PV2 palette rather than that screen's light theme — the two screens
// don't share a visual system, so there's nothing to literally import,
// only the row's layout convention to match.
//
// The trailing Follow/Following control uses hooks/use-follow.ts (not
// profile-v2-screen.tsx's own toggleFollow, which is tightly coupled to
// that screen's own state) — same `follows` table, same insert/delete
// shape, same follow-notification RPC. It's hidden entirely for the
// viewer's own row (hooks/use-follow.ts's own canFollow already refuses a
// user following themselves) — self-follow is impossible here, not just
// hidden.
//
// `user.isFollowedByViewer` (batched once for the whole list — see
// hooks/use-follow-list.ts) is passed straight through as useFollow's
// `initialIsFollowing`, so this row's follow state is already known on its
// very first render — there is no "false until the real answer loads"
// window here, which is what used to cause a visible red Follow flash on
// rows the viewer already followed.
export function FollowListRow({ user, currentUserId, onPress }: Props) {
  const { isFollowing, checking, mutating, toggle, canFollow } = useFollow(
    user.id,
    currentUserId,
    user.isFollowedByViewer,
  );
  const displayName = user.displayName || user.username;

  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.avatar}>
        {user.avatarUrl ? (
          <Image source={{ uri: user.avatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
            <Text style={styles.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>

      <View style={styles.info}>
        <Text style={styles.username} numberOfLines={1}>@{user.username}</Text>
        {user.displayName ? (
          <Text style={styles.displayName} numberOfLines={1}>{user.displayName}</Text>
        ) : null}
      </View>

      {/* A nested Pressable/TouchableOpacity claims its own tap — RN's
          responder system gives a tap inside it to this button, never
          bubbling out to the row's own onPress, so tapping Follow never
          also navigates (same pattern already used for
          ProfileV2IdentityCard's avatar-inside-card Pressable). */}
      {canFollow && (
        <TouchableOpacity
          style={[
            styles.followBtn,
            isFollowing === true && styles.followBtnActive,
            // Unknown/loading — a neutral placeholder, never the red
            // Follow fill or the outlined Following look, so nothing has
            // to visibly flip once the real state resolves. Same width/
            // height/radius/position as the resolved states (only the
            // background/border change), so the row never shifts.
            isFollowing === null && styles.followBtnUnknown,
          ]}
          onPress={toggle}
          disabled={checking}
          activeOpacity={0.85}>
          {mutating ? (
            <ActivityIndicator size="small" color={isFollowing ? PV2.textPrimary : '#fff'} />
          ) : isFollowing === null ? null : (
            <Text style={styles.followBtnLabel}>{isFollowing ? 'Following' : 'Follow'}</Text>
          )}
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: '#2A2A2A',
    flexShrink: 0,
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
  info: {
    flex: 1,
    gap: 2,
  },
  username: {
    color: PV2.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  displayName: {
    color: PV2.textTertiary,
    fontSize: 13,
  },
  followBtn: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: '#e8181a',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 92,
  },
  followBtnActive: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: PV2.border,
  },
  // Neutral placeholder while the relationship is still unknown — same
  // footprint as followBtn/followBtnActive, deliberately neither the red
  // Follow fill nor the outlined Following look.
  followBtnUnknown: {
    backgroundColor: PV2.emptyCardBg,
  },
  followBtnLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
});
