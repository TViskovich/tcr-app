import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { FolderCard } from '@/components/collection/folder-card';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { Folder, Profile } from '@/types';

type Counts = {
  folders: number;
  items: number;
  posts: number;
  followers: number;
  following: number;
};

export default function UserProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [counts, setCounts] = useState<Counts>({ folders: 0, items: 0, posts: 0, followers: 0, following: 0 });
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [msgLoading, setMsgLoading] = useState(false);

  useEffect(() => {
    if (!username) return;

    async function load() {
      setLoading(true);

      const { data: profileData } = await supabase
        .from('profiles')
        .select('*')
        .eq('username', username)
        .single();

      if (!profileData) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setProfile(profileData as Profile);

      const uid = profileData.id;
      const [
        foldersRes,
        folderCountRes,
        itemCountRes,
        postCountRes,
        followerCountRes,
        followingCountRes,
      ] = await Promise.all([
        supabase.from('folders').select('*').eq('user_id', uid).eq('is_public', true).order('created_at', { ascending: false }),
        supabase.from('folders').select('*', { count: 'exact', head: true }).eq('user_id', uid),
        supabase.from('collection_items').select('*', { count: 'exact', head: true }).eq('user_id', uid),
        supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', uid),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', uid),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', uid),
      ]);

      setFolders((foldersRes.data as Folder[]) ?? []);
      setCounts({
        folders: folderCountRes.count ?? 0,
        items: itemCountRes.count ?? 0,
        posts: postCountRes.count ?? 0,
        followers: followerCountRes.count ?? 0,
        following: followingCountRes.count ?? 0,
      });
      setLoading(false);
    }

    load();
  }, [username]);

  // Check follow state once profile + current user are both known
  const profileId = profile?.id;
  useEffect(() => {
    if (!profileId || !currentUserId || profileId === currentUserId) return;

    supabase
      .from('follows')
      .select('follower_id')
      .eq('follower_id', currentUserId)
      .eq('following_id', profileId)
      .maybeSingle()
      .then(({ data }) => setIsFollowing(!!data));
  }, [profileId, currentUserId]);

  async function refreshFollowerCounts(uid: string) {
    const [followersRes, followingRes] = await Promise.all([
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', uid),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', uid),
    ]);
    setCounts((prev) => ({
      ...prev,
      followers: followersRes.count ?? prev.followers,
      following: followingRes.count ?? prev.following,
    }));
  }

  async function handleMessage() {
    if (!currentUserId || !profile || currentUserId === profile.id) return;
    setMsgLoading(true);
    const { data, error } = await supabase.rpc('get_or_create_conversation', {
      other_user_id: profile.id,
    });
    if (error || !data) {
      console.error('DM failed:', error?.message);
      setMsgLoading(false);
      return;
    }
    setMsgLoading(false);
    router.push({
      pathname: '/conversation/[id]',
      params: {
        id: data as string,
        otherUsername: profile.username,
        otherDisplayName: profile.display_name ?? '',
      },
    });
  }

  async function toggleFollow() {
    if (!currentUserId || !profile) return;
    setFollowLoading(true);
    if (isFollowing) {
      await supabase
        .from('follows')
        .delete()
        .eq('follower_id', currentUserId)
        .eq('following_id', profile.id);
      setIsFollowing(false);
    } else {
      await supabase
        .from('follows')
        .insert({ follower_id: currentUserId, following_id: profile.id });
      setIsFollowing(true);
    }
    await refreshFollowerCounts(profile.id);
    setFollowLoading(false);
  }

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: username ? `@${username}` : 'Profile' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      </>
    );
  }

  if (notFound || !profile) {
    return (
      <>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>User not found.</Text>
        </View>
      </>
    );
  }

  const displayName = profile.display_name || profile.username;
  const avatarUri = profile.avatar_url;
  const isOwnProfile = currentUserId === profile.id;

  return (
    <>
      <Stack.Screen options={{ title: `@${profile.username}` }} />
      <FlatList
        data={folders}
        numColumns={2}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <FolderCard
            folder={item}
            onPress={() =>
              router.push({
                pathname: '/folder/[id]',
                params: { id: item.id, name: item.name },
              })
            }
          />
        )}
        contentContainerStyle={styles.list}
        columnWrapperStyle={styles.row}
        ListHeaderComponent={
          <View style={styles.profileHeader}>
            <View style={styles.avatarWrap}>
              {avatarUri ? (
                <Image
                  source={{ uri: avatarUri }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                />
              ) : (
                <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
                  <Text style={styles.avatarInitial}>
                    {displayName.charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
            </View>

            <Text style={styles.displayName}>{displayName}</Text>
            <Text style={styles.usernameText}>@{profile.username}</Text>
            {profile.bio ? (
              <Text style={styles.bio}>{profile.bio}</Text>
            ) : null}

            {/* Stats row */}
            <View style={styles.statsRow}>
              <View style={styles.stat}>
                <Text style={styles.statNumber}>{counts.folders}</Text>
                <Text style={styles.statLabel}>Folders</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statNumber}>{counts.items}</Text>
                <Text style={styles.statLabel}>Items</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statNumber}>{counts.posts}</Text>
                <Text style={styles.statLabel}>Posts</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statNumber}>{counts.followers}</Text>
                <Text style={styles.statLabel}>Followers</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statNumber}>{counts.following}</Text>
                <Text style={styles.statLabel}>Following</Text>
              </View>
            </View>

            {/* Message + Follow/Unfollow — hidden on own profile or when not logged in */}
            {!isOwnProfile && currentUserId ? (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.msgBtn}
                  onPress={handleMessage}
                  disabled={msgLoading}
                  activeOpacity={0.75}>
                  {msgLoading ? (
                    <ActivityIndicator size="small" color="#0a7ea4" />
                  ) : (
                    <Text style={styles.msgBtnText}>Message</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.followBtn, isFollowing && styles.followBtnFollowing]}
                  onPress={toggleFollow}
                  disabled={followLoading}
                  activeOpacity={0.75}>
                  {followLoading ? (
                    <ActivityIndicator size="small" color={isFollowing ? '#687076' : '#fff'} />
                  ) : (
                    <Text style={[styles.followBtnText, isFollowing && styles.followBtnTextFollowing]}>
                      {isFollowing ? 'Following' : 'Follow'}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : null}

            {folders.length > 0 && (
              <Text style={styles.sectionTitle}>Collection</Text>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>No public folders yet.</Text>
          </View>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8f9fa',
  },
  errorText: {
    fontSize: 16,
    color: '#687076',
  },
  list: {
    paddingHorizontal: 10,
    paddingBottom: 32,
    backgroundColor: '#f8f9fa',
  },
  row: {
    justifyContent: 'flex-start',
  },
  profileHeader: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 8,
  },
  avatarWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    marginTop: 24,
    marginBottom: 16,
    overflow: 'hidden',
    backgroundColor: '#E3F2FD',
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 36,
    fontWeight: '700',
    color: '#1565C0',
  },
  displayName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#11181C',
  },
  usernameText: {
    fontSize: 14,
    color: '#687076',
    marginTop: 4,
  },
  bio: {
    fontSize: 14,
    color: '#444',
    textAlign: 'center',
    lineHeight: 20,
    marginTop: 8,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    paddingVertical: 14,
    marginTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  statNumber: {
    fontSize: 18,
    fontWeight: '700',
    color: '#11181C',
  },
  statLabel: {
    fontSize: 10,
    color: '#687076',
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
    backgroundColor: '#e0e0e0',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
    alignSelf: 'stretch',
  },
  msgBtn: {
    flex: 1,
    paddingVertical: 10,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#0a7ea4',
    borderRadius: 20,
    alignItems: 'center',
  },
  msgBtnText: {
    color: '#0a7ea4',
    fontSize: 15,
    fontWeight: '600',
  },
  followBtn: {
    flex: 1,
    paddingVertical: 10,
    backgroundColor: '#0a7ea4',
    borderRadius: 20,
    alignItems: 'center',
  },
  followBtnFollowing: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#687076',
  },
  followBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  followBtnTextFollowing: {
    color: '#687076',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#11181C',
    alignSelf: 'flex-start',
    marginTop: 28,
    marginBottom: 4,
  },
  emptyWrap: {
    alignItems: 'center',
    paddingTop: 32,
  },
  emptyText: {
    fontSize: 15,
    color: '#687076',
  },
});
