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

type Mode = 'users' | 'cards';

type SearchProfile = {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
};

type CardResult = {
  id: string;
  title: string | null;
  player: string | null;
  team: string | null;
  year: number | null;
  brand: string | null;
  grade: string | null;
  image_url: string | null;
  folder_name: string | null;
  owner_username: string;
  owner_display_name: string | null;
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

async function queryCards(term: string): Promise<CardResult[]> {
  // year is smallint — ilike doesn't apply; text fields only
  const { data: items } = await supabase
    .from('collection_items')
    .select('id, title, player, team, year, brand, grade, image_url, user_id, folders!inner(name, is_public)')
    .eq('folders.is_public', true)
    .or(`title.ilike.%${term}%,player.ilike.%${term}%,team.ilike.%${term}%,brand.ilike.%${term}%,grade.ilike.%${term}%`)
    .order('created_at', { ascending: false })
    .limit(30);

  if (!items?.length) return [];

  const userIds = [...new Set((items as any[]).map((i) => i.user_id as string))];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, display_name')
    .in('id', userIds);

  const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));

  return (items as any[]).map((item) => {
    const p = profileMap.get(item.user_id) ?? {};
    const folder = Array.isArray(item.folders) ? item.folders[0] : item.folders;
    return {
      id: item.id,
      title: item.title ?? null,
      player: item.player ?? null,
      team: item.team ?? null,
      year: item.year ?? null,
      brand: item.brand ?? null,
      grade: item.grade ?? null,
      image_url: item.image_url ?? null,
      folder_name: folder?.name ?? null,
      owner_username: p.username ?? 'user',
      owner_display_name: p.display_name ?? null,
    };
  });
}

function UserRow({ profile, onPress }: { profile: SearchProfile; onPress: () => void }) {
  const displayName = profile.display_name || profile.username;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.userAvatar}>
        {profile.avatar_url ? (
          <Image source={{ uri: profile.avatar_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
            <Text style={styles.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.primaryText} numberOfLines={1}>{displayName}</Text>
        <Text style={styles.secondaryText} numberOfLines={1}>@{profile.username}</Text>
        {profile.bio ? (
          <Text style={styles.tertiaryText} numberOfLines={1}>{profile.bio}</Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function CardRow({ card, onPress }: { card: CardResult; onPress: () => void }) {
  const title = card.title || card.player || 'Untitled Card';
  const meta = [card.player, card.year?.toString(), card.brand].filter(Boolean).join(' · ');
  const sub = [card.team, card.grade].filter(Boolean).join(' · ');
  const ownerLine = [
    `@${card.owner_username}`,
    card.folder_name,
  ].filter(Boolean).join(' · ');

  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.cardThumb}>
        {card.image_url ? (
          <Image source={{ uri: card.image_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.cardThumbPlaceholder]}>
            <Text style={styles.cardThumbEmoji}>🃏</Text>
          </View>
        )}
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.primaryText} numberOfLines={1}>{title}</Text>
        {meta ? <Text style={styles.secondaryText} numberOfLines={1}>{meta}</Text> : null}
        {sub ? <Text style={styles.secondaryText} numberOfLines={1}>{sub}</Text> : null}
        <Text style={styles.tertiaryText} numberOfLines={1}>{ownerLine}</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function SearchScreen() {
  const { session } = useAuth();
  const currentUserId = session?.user?.id ?? '';
  const router = useRouter();

  const [mode, setMode] = useState<Mode>('users');
  const [query, setQuery] = useState('');
  const [userResults, setUserResults] = useState<SearchProfile[]>([]);
  const [cardResults, setCardResults] = useState<CardResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (q: string) => {
    const term = q.trim();
    if (!term) {
      setUserResults([]);
      setCardResults([]);
      setHasSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (mode === 'users') {
      setUserResults(await queryProfiles(term, currentUserId));
    } else {
      setCardResults(await queryCards(term));
    }
    setHasSearched(true);
    setLoading(false);
  }, [mode, currentUserId]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim()) setLoading(true);
    debounceRef.current = setTimeout(() => runSearch(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, runSearch]);

  const onRefresh = useCallback(async () => {
    const term = query.trim();
    if (!term) return;
    setRefreshing(true);
    if (mode === 'users') {
      setUserResults(await queryProfiles(term, currentUserId));
    } else {
      setCardResults(await queryCards(term));
    }
    setRefreshing(false);
  }, [query, mode, currentUserId]);

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    // hasSearched resets naturally via the useEffect re-firing with the new runSearch
  }

  function clearSearch() {
    setQuery('');
    setUserResults([]);
    setCardResults([]);
    setHasSearched(false);
  }

  const currentResults: any[] = mode === 'users' ? userResults : cardResults;

  const emptyBody = mode === 'users'
    ? 'Find people by username or display name.'
    : 'Search by title, player, team, brand, or grade.';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Search</Text>
      </View>

      <View style={styles.toggleRow}>
        <View style={styles.toggle}>
          <TouchableOpacity
            style={[styles.toggleBtn, mode === 'users' && styles.toggleBtnActive]}
            onPress={() => switchMode('users')}
            activeOpacity={0.8}>
            <Text style={[styles.toggleText, mode === 'users' && styles.toggleTextActive]}>
              Users
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, mode === 'cards' && styles.toggleBtnActive]}
            onPress={() => switchMode('cards')}
            activeOpacity={0.8}>
            <Text style={[styles.toggleText, mode === 'cards' && styles.toggleTextActive]}>
              Cards
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder={mode === 'users' ? 'Search collectors...' : 'Search cards, players, teams...'}
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
          <Text style={styles.emptyTitle}>Search for collectors or cards</Text>
          <Text style={styles.emptyBody}>{emptyBody}</Text>
        </View>
      ) : currentResults.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>
            {mode === 'users' ? 'No users found' : 'No cards found'}
          </Text>
          <Text style={styles.emptyBody}>Try a different search term.</Text>
        </View>
      ) : mode === 'users' ? (
        <FlatList
          data={userResults}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <UserRow
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
      ) : (
        <FlatList
          data={cardResults}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <CardRow
              card={item}
              onPress={() =>
                router.push({ pathname: '/item/[id]', params: { id: item.id } })
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
  toggleRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
  },
  toggle: {
    flexDirection: 'row',
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    padding: 3,
    alignSelf: 'flex-start',
  },
  toggleBtn: {
    paddingHorizontal: 20,
    paddingVertical: 6,
    borderRadius: 6,
  },
  toggleBtnActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  toggleText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#687076',
  },
  toggleTextActive: {
    color: '#11181C',
    fontWeight: '600',
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
    textAlign: 'center',
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
  // User avatar
  userAvatar: {
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
  // Card thumbnail
  cardThumb: {
    width: 64,
    height: 64,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#f0f0f0',
    flexShrink: 0,
  },
  cardThumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardThumbEmoji: {
    fontSize: 24,
  },
  // Shared row body
  rowBody: {
    flex: 1,
    gap: 2,
  },
  primaryText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#11181C',
  },
  secondaryText: {
    fontSize: 13,
    color: '#687076',
  },
  tertiaryText: {
    fontSize: 12,
    color: '#aaa',
    marginTop: 1,
  },
});
