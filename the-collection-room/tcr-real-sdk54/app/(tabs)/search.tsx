import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

type SearchProfile = {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
};

async function queryProfiles(term: string, excludeId: string): Promise<SearchProfile[]> {
  const { data } = await supabase
    .from('profiles')
    .select('id, username, display_name, bio, avatar_url')
    .or(`username.ilike.%${term}%,display_name.ilike.%${term}%`)
    .neq('id', excludeId)
    .order('username')
    .limit(20);
  return (data ?? []) as SearchProfile[];
}

function ResultRow({ profile, onPress }: { profile: SearchProfile; onPress: () => void }) {
  const displayName = profile.display_name || profile.username;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.avatar}>
        {profile.avatar_url ? (
          <Image source={{ uri: profile.avatar_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
            <Text style={styles.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.displayName} numberOfLines={1}>{displayName}</Text>
        <Text style={styles.username} numberOfLines={1}>@{profile.username}</Text>
        {profile.bio ? (
          <Text style={styles.bio} numberOfLines={1}>{profile.bio}</Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

export default function SearchScreen() {
  const { session } = useAuth();
  const currentUserId = session?.user?.id ?? '';
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (q: string) => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      setHasSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setResults(await queryProfiles(term, currentUserId));
    setHasSearched(true);
    setLoading(false);
  }, [currentUserId]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, runSearch]);

  const onRefresh = useCallback(async () => {
    const term = query.trim();
    if (!term) return;
    setRefreshing(true);
    setResults(await queryProfiles(term, currentUserId));
    setRefreshing(false);
  }, [query, currentUserId]);

  function clearSearch() {
    setQuery('');
    setResults([]);
    setHasSearched(false);
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Search</Text>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Search collectors..."
          placeholderTextColor="#999"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={clearSearch} style={styles.clearBtn} hitSlop={8}>
            <Text style={styles.clearText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      ) : !hasSearched ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Search for collectors</Text>
          <Text style={styles.emptyBody}>Find people by username or display name.</Text>
        </View>
      ) : results.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No users found</Text>
          <Text style={styles.emptyBody}>Try a different name or username.</Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <ResultRow
              profile={item}
              onPress={() =>
                router.push({ pathname: '/user/[username]', params: { username: item.username } })
              }
            />
          )}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#0a7ea4" />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#11181C',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 12,
    paddingHorizontal: 12,
    backgroundColor: '#f5f5f5',
    borderRadius: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#11181C',
    paddingVertical: 10,
  },
  clearBtn: {
    paddingLeft: 8,
    paddingVertical: 4,
  },
  clearText: {
    fontSize: 14,
    color: '#999',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#11181C',
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 14,
    color: '#687076',
    textAlign: 'center',
    lineHeight: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
    gap: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#E3F2FD',
    flexShrink: 0,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1565C0',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  displayName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#11181C',
  },
  username: {
    fontSize: 13,
    color: '#687076',
  },
  bio: {
    fontSize: 13,
    color: '#999',
    marginTop: 1,
  },
});
