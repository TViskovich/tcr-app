import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { FolderCard } from '@/components/collection/folder-card';
import { supabase } from '@/lib/supabase';
import type { Folder, Profile } from '@/types';

export default function UserProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const router = useRouter();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

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

      const { data: foldersData } = await supabase
        .from('folders')
        .select('*')
        .eq('user_id', profileData.id)
        .eq('is_public', true)
        .order('created_at', { ascending: false });

      setFolders((foldersData as Folder[]) ?? []);
      setLoading(false);
    }

    load();
  }, [username]);

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
