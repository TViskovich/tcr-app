import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  ActivityIndicator,
  Dimensions,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

const SCREEN_W = Dimensions.get('window').width;

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { FolderCard } from '@/components/collection/folder-card';
import { GrailsGrid } from '@/components/profile/grails-grid';
import { ProfileHero } from '@/components/profile/profile-hero';
import { resolveCovers } from '@/hooks/use-collection';
import { useGrails } from '@/hooks/use-grails';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { Folder, Profile } from '@/types';

export default function UserProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;

  const scrollY = useRef(new Animated.Value(0)).current;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderItemCounts, setFolderItemCounts] = useState<Record<string, number>>({});

  const { grails } = useGrails(profile?.id);
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
      const foldersRes = await supabase
        .from('folders')
        .select('*')
        .eq('user_id', uid)
        .eq('is_public', true)
        .order('created_at', { ascending: false });

      const resolvedFolders = await resolveCovers((foldersRes.data as Folder[]) ?? []);
      setFolders(resolvedFolders);

      // Batch per-folder item counts
      const folderIds = resolvedFolders.map(f => f.id);
      if (folderIds.length) {
        const { data: countRows } = await supabase
          .from('collection_items')
          .select('folder_id')
          .in('folder_id', folderIds);
        const perFolder: Record<string, number> = {};
        for (const row of (countRows ?? []) as { folder_id: string }[]) {
          perFolder[row.folder_id] = (perFolder[row.folder_id] ?? 0) + 1;
        }
        setFolderItemCounts(perFolder);
      }

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

  function handlePillPress(id: string) {
    if (id === 'grails' && profile) {
      router.push({
        pathname: '/grails/[userId]',
        params: {
          userId: profile.id,
          username: profile.username,
          displayName: profile.display_name ?? '',
        },
      });
    }
    // Followers, Following, Posts: no routes yet — badge handles 'grails' only for now
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
      // Notify the followed user (unique index makes this idempotent on re-follow)
      supabase.from('notifications').insert({
        user_id: profile.id,
        actor_id: currentUserId,
        type: 'follow',
      }).then(({ error }) => {
        if (error && error.code !== '23505') console.error('Follow notif failed:', error.message);
      });
    }
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

  const avatarUri = profile.avatar_url;
  const heroUri = profile.hero_image_url ?? null;
  const isOwnProfile = currentUserId === profile.id;

  return (
    <>
      <Stack.Screen options={{ title: `@${profile.username}` }} />
      <Animated.FlatList
        data={folders}
        numColumns={2}
        keyExtractor={(item) => item.id}
        style={styles.screen}
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
        renderItem={({ item }) => (
          <FolderCard
            folder={item}
            itemCount={folderItemCounts[item.id] ?? 0}
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
          <View>
            <ProfileHero
              profile={profile}
              avatarUri={avatarUri}
              heroImageUri={heroUri}
              scrollY={scrollY}
              brandLabel="SHOWCASE"
              onPillPress={handlePillPress}
            />

            {!isOwnProfile && currentUserId ? (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.msgBtn}
                  onPress={handleMessage}
                  disabled={msgLoading}
                  activeOpacity={0.75}>
                  {msgLoading
                    ? <ActivityIndicator size="small" color="#FFFFFF" />
                    : <Text style={styles.msgBtnText} numberOfLines={1}>Message</Text>
                  }
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.followBtn, isFollowing && styles.followBtnFollowing]}
                  onPress={toggleFollow}
                  disabled={followLoading}
                  activeOpacity={0.75}>
                  {followLoading
                    ? <ActivityIndicator size="small" color={isFollowing ? '#FFFFFF' : '#0D0D0D'} />
                    : <Text style={[styles.followBtnText, isFollowing && styles.followBtnTextFollowing]} numberOfLines={1}>
                        {isFollowing ? 'Following' : 'Follow'}
                      </Text>
                  }
                </TouchableOpacity>
              </View>
            ) : null}

            <GrailsGrid
              grails={grails}
              editable={false}
              onCabinetPress={() =>
                router.push({
                  pathname: '/grails/[userId]',
                  params: {
                    userId: profile.id,
                    username: profile.username,
                    displayName: profile.display_name ?? '',
                  },
                })
              }
            />

            {folders.length > 0 && (
              <Text style={styles.foldersLabel}>Folders</Text>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>No public folders yet.</Text>
          </View>
        }
        ListFooterComponent={
          <View>
            {/* Activity — future section */}
            <View style={styles.placeholderSection}>
              <Text style={styles.placeholderLabel}>Activity</Text>
            </View>
            {/* Collection — future destination */}
            <View style={styles.placeholderSection}>
              <Text style={styles.placeholderLabel}>Collection</Text>
            </View>
            <View style={styles.bottomSpacer} />
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
  screen: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  list: {
    paddingBottom: 32,
    backgroundColor: '#0D0D0D',
  },
  row: {
    justifyContent: 'flex-start',
    paddingHorizontal: 10,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: -55,
    marginBottom: 113,
    alignSelf: 'center',
    width: Math.round(SCREEN_W * 0.86),
  },
  msgBtn: {
    flex: 1,
    height: 46,
    backgroundColor: '#1C1C1E',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  msgBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    includeFontPadding: false,
  },
  followBtn: {
    flex: 1,
    height: 46,
    backgroundColor: '#FFFFFF',
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  followBtnFollowing: {
    backgroundColor: '#1C1C1E',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  followBtnText: {
    color: '#0D0D0D',
    fontSize: 15,
    fontWeight: '600',
    includeFontPadding: false,
  },
  followBtnTextFollowing: {
    color: '#FFFFFF',
  },
  foldersLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#adb5bd',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    alignSelf: 'flex-start',
    marginTop: 24,
    marginBottom: 4,
    paddingHorizontal: 16,
  },
  placeholderSection: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 8,
  },
  placeholderLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#adb5bd',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  bottomSpacer: {
    height: 48,
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
