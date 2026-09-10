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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { LIGHT_PAGE_BACKGROUND } from '@/constants/theme';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { attachPrimaryImageIds } from '@/lib/item-images';
import { navigateToProfile } from '@/lib/profile-navigation';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

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
  primary_image_id: string | null;
  folder_name: string | null;
  owner_username: string;
  owner_display_name: string | null;
};

async function queryProfiles(term: string, excludeId: string): Promise<SearchProfile[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, bio, avatar_url')
    .or(`username.ilike.%${term}%,display_name.ilike.%${term}%`)
    .neq('id', excludeId)
    .order('username')
    .limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as SearchProfile[];
}

async function queryCards(term: string): Promise<CardResult[]> {
  // year is smallint — ilike doesn't apply; text fields only
  const { data: items, error: itemsError } = await supabase
    .from('collection_items')
    .select('id, title, player, team, year, brand, grade, image_url, user_id, folders!inner(name, is_public)')
    .eq('folders.is_public', true)
    .eq('collection_status', 'active')
    .or(`title.ilike.%${term}%,player.ilike.%${term}%,team.ilike.%${term}%,brand.ilike.%${term}%,grade.ilike.%${term}%`)
    .order('created_at', { ascending: false })
    .limit(30);

  // Critical — this is the actual result set. A failure here must never be
  // represented as "no matching cards," so it's thrown rather than
  // swallowed into [].
  if (itemsError) throw new Error(itemsError.message);

  if (!items?.length) return [];

  const userIds = [...new Set((items as any[]).map((i) => i.user_id as string))];
  // Best-effort — the card results above are already valid on their own; a
  // failure here only degrades the owner byline to the existing 'user'/null
  // fallback below, it must never fail the whole card search.
  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, username, display_name')
    .in('id', userIds);
  if (profileError) {
    console.error('[Search] owner profile enrichment failed (best-effort):', profileError.message, profileError);
  }

  const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));

  // One batched query for every result's primary_image_id (item-images
  // beta privacy hardening, Phase 3E) — never one per row.
  const withPrimaryIds = await attachPrimaryImageIds(items as { id: string }[]);
  const primaryIdByItemId = new Map(withPrimaryIds.map((i) => [i.id, i.primary_image_id]));

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
      primary_image_id: primaryIdByItemId.get(item.id) ?? null,
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
          <Image source={{ uri: profile.avatar_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
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

function CardRow({
  card,
  imageUrl,
  onPress,
}: {
  card: CardResult;
  imageUrl: string | undefined;
  onPress: () => void;
}) {
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
        {imageUrl ? (
          <Image source={{ uri: imageUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
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
  // Deliberately no `?? ''` fallback — queryProfiles' own .neq('id',
  // excludeId) is a UUID column comparison, and an empty string is not a
  // valid UUID (confirmed root cause of a beta crash: "invalid input
  // syntax for type uuid" during logout, when session had already cleared
  // for one render but this screen was still mounted with a leftover
  // non-empty query, and the debounce effect below re-fired against it —
  // see runSearch's own guard for the actual fix). Users-mode search
  // requires a resolved, real user id; this screen has no anonymous-search
  // affordance to fall back to.
  const currentUserId = session?.user?.id;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const listContentStyle = { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 };
  const { onScroll: navbarOnScroll, scrollEventThrottle } = useScrollResponsiveNavbar();

  const [mode, setMode] = useState<Mode>('users');
  const [query, setQuery] = useState('');
  const [userResults, setUserResults] = useState<SearchProfile[]>([]);
  const [cardResults, setCardResults] = useState<CardResult[]>([]);
  // One batched call for the whole visible results list — never one
  // signing request per row (item-images beta privacy hardening,
  // Phase 3E). cardResults already carries public folders' items only
  // (queryCards' own .eq('folders.is_public', true)); this is the
  // cross-user counterpart to the owner-only signed lookups elsewhere in
  // the app, authorized the same way via get-collection-item-image-signed-url.
  const { urls: signedCardImageUrls } = useSignedItemImages(cardResults.map((c) => c.primary_image_id));
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Distinct from "hasSearched && zero results" — only a real query
  // failure sets this, never a legitimate empty search.
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Request-identity guard — plain incrementing counter, not
  // AbortController: runSearch fires on every debounced keystroke and
  // onRefresh fires on pull-to-refresh, both writing the same
  // userResults/cardResults/searchError state, so a slower older call
  // (e.g. typing "a" then quickly "ab", or a refresh racing a fresh
  // search) must never win and overwrite a newer call's result. Shared
  // between runSearch and onRefresh on purpose — either can supersede the
  // other, they write the same state.
  const searchRequestIdRef = useRef(0);

  const runSearch = useCallback(async (q: string) => {
    const term = q.trim();
    if (!term) {
      // Invalidate any older in-flight request first — otherwise a slow
      // request started before the query was cleared could still resolve
      // afterward and repopulate results for a term that no longer exists.
      searchRequestIdRef.current += 1;
      setUserResults([]);
      setCardResults([]);
      setHasSearched(false);
      setSearchError(null);
      setLoading(false);
      return;
    }

    // Users-mode search requires a resolved, real user id — queryProfiles'
    // own .neq('id', excludeId) is a UUID column comparison, and this
    // screen has no anonymous-search affordance to fall back to. The one
    // place currentUserId can transiently go missing while this screen is
    // still mounted with leftover query text is the render right after
    // logout, before the root layout finishes redirecting away — this
    // effect (see its useCallback deps below) re-fires the instant
    // currentUserId changes identity, which would otherwise re-run this
    // exact search with no valid id to exclude by and throw. Same
    // invalidate-then-reset shape as the empty-term branch above, since
    // there's equally nothing valid to search for.
    if (mode === 'users' && !currentUserId) {
      searchRequestIdRef.current += 1;
      setUserResults([]);
      setHasSearched(false);
      setSearchError(null);
      setLoading(false);
      return;
    }

    const requestId = ++searchRequestIdRef.current;
    const isCurrent = () => searchRequestIdRef.current === requestId;

    setLoading(true);
    try {
      if (mode === 'users') {
        if (!currentUserId) return; // unreachable — already guarded above
        const results = await queryProfiles(term, currentUserId);
        if (!isCurrent()) return;
        setUserResults(results);
      } else {
        const results = await queryCards(term);
        if (!isCurrent()) return;
        setCardResults(results);
      }
      if (!isCurrent()) return;
      setSearchError(null);
      setHasSearched(true);
    } catch (e) {
      if (!isCurrent()) return;
      console.error('[Search] search failed:', e);
      // Clear results for the NEW term — stale results from whatever term
      // was previously displayed must never be shown as if they belong to
      // this one.
      if (mode === 'users') setUserResults([]);
      else setCardResults([]);
      setSearchError(e instanceof Error ? e.message : 'Something went wrong.');
      setHasSearched(true);
    } finally {
      // A superseded request must never clear loading out from under
      // whichever newer request is now responsible for it.
      if (isCurrent()) setLoading(false);
    }
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
    // Same reasoning as runSearch's own guard above — never fire
    // queryProfiles' UUID .neq() with no resolved user id.
    if (mode === 'users' && !currentUserId) return;

    const requestId = ++searchRequestIdRef.current;
    const isCurrent = () => searchRequestIdRef.current === requestId;

    setRefreshing(true);
    try {
      if (mode === 'users') {
        if (!currentUserId) return; // unreachable — already guarded above
        const results = await queryProfiles(term, currentUserId);
        if (!isCurrent()) return;
        setUserResults(results);
      } else {
        const results = await queryCards(term);
        if (!isCurrent()) return;
        setCardResults(results);
      }
      if (!isCurrent()) return;
      setSearchError(null);
    } catch (e) {
      if (!isCurrent()) return;
      console.error('[Search] refresh failed:', e);
      // Existing results are deliberately left untouched — only a failed
      // refresh's own error is surfaced, never a wiped list.
      setSearchError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      if (isCurrent()) setRefreshing(false);
    }
  }, [query, mode, currentUserId]);

  function switchMode(next: Mode) {
    if (next === mode) return;
    // Immediately supersede any in-flight request for the old mode — the
    // debounce effect below will also claim a new request id once its
    // 300ms timer elapses, but without this, a slow old-mode request could
    // still resolve first and commit stale loading/hasSearched/searchError
    // state (shared across both modes) out from under the new mode.
    searchRequestIdRef.current += 1;
    // Same render that switches mode must already be in loading state —
    // otherwise the newly-selected mode's stored results (last known-good
    // from whatever was previously searched there, now stale for the
    // current query) can paint for a frame before the debounce effect's
    // own setLoading(true) catches up, since that effect runs post-render,
    // not synchronously with this handler. Batched into the same render as
    // setMode below (React batches same-tick state updates), so the
    // stale results never actually get painted. The stored arrays
    // themselves are left untouched — this only gates whether they're
    // shown, per the "don't clear just to hide" requirement.
    if (query.trim()) setLoading(true);
    setMode(next);
    // hasSearched resets naturally via the useEffect re-firing with the new runSearch
  }

  // Same reasoning as switchMode above — onChangeText alone updates the
  // visible input text before the debounce effect's setLoading(true) runs
  // (a post-render effect), so results for the previous term could briefly
  // remain visible under the new term's text. Setting loading synchronously
  // here, batched into the same render as setQuery, closes that gap.
  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (value.trim()) {
      setLoading(true);
    } else {
      // Mirrors runSearch's own empty-term branch (and clearSearch below)
      // synchronously — without this, old results/hasSearched/searchError
      // from before the field was cleared could remain visible for up to
      // 300ms, until the debounced runSearch('') this setQuery('') also
      // triggers would otherwise be the only thing to perform this same
      // reset. That later call still fires and is harmless/idempotent
      // against the state this already settled into.
      searchRequestIdRef.current += 1;
      setUserResults([]);
      setCardResults([]);
      setHasSearched(false);
      setSearchError(null);
      setLoading(false);
    }
  }, []);

  function clearSearch() {
    // Same reasoning as the empty-query branch inside runSearch — this is
    // a manual reset outside that function, so it invalidates in-flight
    // requests itself rather than waiting for the debounced runSearch('')
    // that setQuery('') below will eventually trigger.
    searchRequestIdRef.current += 1;
    setQuery('');
    setUserResults([]);
    setCardResults([]);
    setHasSearched(false);
    setSearchError(null);
  }

  const currentResults: any[] = mode === 'users' ? userResults : cardResults;

  const emptyBody = mode === 'users'
    ? 'Find people by username or display name.'
    : 'Search by title, player, team, brand, or grade.';

  // Failed refresh with results already on screen — kept visible below
  // (never cleared/replaced), just flagged with this lightweight inline
  // row above the active list. Same shape as the Collections-tab/
  // Folder-detail refreshErrorRow pattern. Computed once, rendered in both
  // the Users and Cards FlatList branches below rather than duplicated.
  const searchErrorBanner =
    searchError && currentResults.length > 0 ? (
      <View style={styles.refreshErrorRow}>
        <Text style={styles.refreshErrorText} numberOfLines={1}>
          Couldn&apos;t refresh results
        </Text>
        <TouchableOpacity onPress={onRefresh} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.refreshErrorRetry}>Retry</Text>
        </TouchableOpacity>
      </View>
    ) : null;

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
            hitSlop={{ top: 9, bottom: 9 }}
            activeOpacity={0.8}>
            <Text style={[styles.toggleText, mode === 'users' && styles.toggleTextActive]}>
              Users
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, mode === 'cards' && styles.toggleBtnActive]}
            onPress={() => switchMode('cards')}
            hitSlop={{ top: 9, bottom: 9 }}
            activeOpacity={0.8}>
            <Text style={[styles.toggleText, mode === 'cards' && styles.toggleTextActive]}>
              Cards
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          testID="discover-search-input"
          style={styles.input}
          value={query}
          onChangeText={handleQueryChange}
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
          <CacheCaseLogo variant="dark" size={48} placement="emptyState" style={styles.emptyLogoSpacing} />
          <Text style={styles.emptyTitle}>Search for collectors or cards</Text>
          <Text style={styles.emptyBody}>{emptyBody}</Text>
        </View>
      ) : hasSearched && searchError && currentResults.length === 0 ? (
        // Real query/network failure with nothing already on screen for
        // this term — distinct from the legitimate zero-results state
        // below. Retry re-runs the same search for the current query text.
        <View style={styles.center}>
          <CacheCaseLogo variant="icon" size={44} placement="emptyState" style={styles.emptyLogoSpacing} />
          <Text style={styles.emptyTitle}>Couldn&apos;t load search results</Text>
          <Text style={styles.emptyBody}>Check your connection and try again.</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => runSearch(query)}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : currentResults.length === 0 ? (
        <View style={styles.center}>
          <CacheCaseLogo variant="icon" size={44} placement="emptyState" style={styles.emptyLogoSpacing} />
          <Text style={styles.emptyTitle}>
            {mode === 'users' ? 'No users found' : 'No cards found'}
          </Text>
          <Text style={styles.emptyBody}>Try a different search term.</Text>
        </View>
      ) : mode === 'users' ? (
        <>
          {searchErrorBanner}
          <FlatList
            data={userResults}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={listContentStyle}
            onScroll={navbarOnScroll}
            scrollEventThrottle={scrollEventThrottle}
            renderItem={({ item }) => (
              <UserRow
                profile={item}
                onPress={() => navigateToProfile(router, currentUserId, item.id, item.username)}
              />
            )}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#0a7ea4" />
            }
          />
        </>
      ) : (
        <>
          {searchErrorBanner}
          <FlatList
            data={cardResults}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={listContentStyle}
            onScroll={navbarOnScroll}
            scrollEventThrottle={scrollEventThrottle}
            renderItem={({ item }) => (
              <CardRow
                card={item}
                imageUrl={item.primary_image_id ? signedCardImageUrls.get(item.primary_image_id) : undefined}
                onPress={() =>
                  router.push({ pathname: '/item/[id]', params: { id: item.id } })
                }
              />
            )}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#0a7ea4" />
            }
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: LIGHT_PAGE_BACKGROUND,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
    transform: [{ translateY: -25 }],
  },
  // Overrides CacheCaseLogo's default emptyState marginBottom (14) to keep
  // the gap to the title proportionate now that the logo here is bigger —
  // scoped to just this screen's instances, not the shared component default.
  emptyLogoSpacing: {
    marginBottom: 18,
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
  // Full-panel error-state Retry button — same convention as Feed's own
  // retryButton (app/(tabs)/index.tsx).
  retryButton: {
    marginTop: 16,
    backgroundColor: '#0a7ea4',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  // Inline banner for a failed refresh when results are already on
  // screen — same shape as the Collections-tab/Folder-detail
  // refreshErrorRow, adapted to this screen's light theme/accent.
  refreshErrorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#fdecea',
    borderWidth: 1,
    borderColor: '#f5c6c0',
  },
  refreshErrorText: {
    flex: 1,
    fontSize: 13,
    color: '#687076',
    marginRight: 12,
  },
  refreshErrorRetry: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0a7ea4',
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
    width: 44,
    height: 44,
    borderRadius: 22,
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
