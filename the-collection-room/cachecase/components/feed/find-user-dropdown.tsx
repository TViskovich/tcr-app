import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { navigateToProfile } from '@/lib/profile-navigation';
import {
  loadRecentProfiles,
  removeRecentProfile,
  subscribeRecentProfiles,
  type RecentProfile,
} from '@/lib/recent-profiles';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 10;
const SIDE_MARGIN = 16;
const NOTCH_SIZE = 14;
const OPEN_FADE_MS = 180;

type Props = {
  visible: boolean;
  onClose: () => void;
  currentUserId: string | undefined;
  // Where the logo's bottom-center is on screen (window coordinates) — the
  // panel's notch points at it.
  anchor: { x: number; y: number } | null;
};

type ProfileRow = {
  id: string;
  username: string;
  display_name: string | null;
  hero_display_name: string | null;
  avatar_url: string | null;
};

function toRecentShape(row: ProfileRow): RecentProfile {
  return {
    id: row.id,
    username: row.username,
    displayName: row.hero_display_name || row.display_name || null,
    avatarUrl: row.avatar_url ?? null,
  };
}

// ilike patterns: the user's text is matched literally — its own % and _
// (and the escape character) are escaped, never treated as wildcards.
function likePattern(term: string) {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Public profile fields only, through the same world-readable profiles
// table (profiles_select_public) the rest of the app reads. Two plain
// .ilike() filters — values encoded by the client, never assembled into a
// filter string — run in parallel and merged: username or display name,
// case-insensitive, partial. Prefix matches on the username first.
async function searchProfiles(term: string, excludeId: string | undefined): Promise<RecentProfile[]> {
  const pattern = likePattern(term);
  const columns = 'id, username, display_name, hero_display_name, avatar_url';
  const [byUsername, byDisplayName] = await Promise.all([
    supabase.from('profiles').select(columns).ilike('username', pattern).order('username').limit(SEARCH_LIMIT),
    supabase.from('profiles').select(columns).ilike('display_name', pattern).order('username').limit(SEARCH_LIMIT),
  ]);
  if (byUsername.error) throw byUsername.error;
  if (byDisplayName.error) throw byDisplayName.error;
  const seen = new Map<string, ProfileRow>();
  for (const row of [...(byUsername.data ?? []), ...(byDisplayName.data ?? [])] as ProfileRow[]) {
    if (row.id !== excludeId && !seen.has(row.id)) seen.set(row.id, row);
  }
  const lower = term.toLowerCase();
  return [...seen.values()]
    .sort((a, b) => {
      const aPrefix = a.username.toLowerCase().startsWith(lower) ? 0 : 1;
      const bPrefix = b.username.toLowerCase().startsWith(lower) ? 0 : 1;
      return aPrefix - bPrefix || a.username.localeCompare(b.username);
    })
    .slice(0, SEARCH_LIMIT)
    .map(toRecentShape);
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'results'; profiles: RecentProfile[] }
  | { kind: 'error' };

// Find User — long-press the Feed's CacheCase logo. A compact panel
// anchored under the logo (notch pointing at it) over a dimmed Feed: a
// search box, then either this account's recent collectors or, while
// typing, live search results. Tapping outside closes it; the Feed beneath
// is untouched (its scroll position included). Opening a collector goes
// through the app's one profile navigation helper (navigateToProfile).
export function FindUserDropdown({ visible, onClose, currentUserId, anchor }: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  const [recents, setRecents] = useState<RecentProfile[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const searchSeqRef = useRef(0);

  // Opening fade only. The Modal itself uses animationType="none": its
  // native "fade" animates BOTH ways, so dismissing kept the dimmed backdrop
  // and panel on screen (and blocking touches) for the whole fade-out. Now
  // closing removes everything at once, and this fades the content in on
  // each open instead.
  const [openProgress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!visible) return;
    openProgress.setValue(0);
    Animated.timing(openProgress, { toValue: 1, duration: OPEN_FADE_MS, useNativeDriver: true }).start();
  }, [visible, openProgress]);

  // This account's recents — loaded on open, kept current while open.
  useEffect(() => {
    if (!visible || !currentUserId) return;
    let cancelled = false;
    const refresh = () => {
      loadRecentProfiles(currentUserId).then((list) => {
        if (!cancelled) setRecents(list);
      });
    };
    refresh();
    const unsubscribe = subscribeRecentProfiles(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [visible, currentUserId]);

  // Debounced search; only the latest request's answer is ever shown.
  const trimmed = query.trim();
  useEffect(() => {
    if (!visible || !trimmed) return;
    const seq = ++searchSeqRef.current;
    const timer = setTimeout(() => {
      setSearch({ kind: 'loading' });
      searchProfiles(trimmed, currentUserId)
        .then((profiles) => {
          if (searchSeqRef.current === seq) setSearch({ kind: 'results', profiles });
        })
        .catch((e) => {
          if (__DEV__) console.warn('[FindUser] search failed:', e);
          if (searchSeqRef.current === seq) setSearch({ kind: 'error' });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [visible, trimmed, currentUserId]);

  // Keep the panel above the keyboard.
  useEffect(() => {
    if (!visible) return;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (e) => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [visible]);

  function close() {
    Keyboard.dismiss();
    setQuery('');
    setSearch({ kind: 'idle' });
    setNotice(null);
    setOpening(null);
    onClose();
  }

  function openProfile(profile: RecentProfile) {
    close();
    navigateToProfile(router, currentUserId, profile.id, profile.username);
  }

  // A recent may be stale (renamed, or the account removed): look it up by
  // id first and open it under its CURRENT username; drop it if it's gone.
  async function openRecent(profile: RecentProfile) {
    if (opening) return;
    setOpening(profile.id);
    setNotice(null);
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, hero_display_name, avatar_url')
      .eq('id', profile.id)
      .maybeSingle();
    setOpening(null);
    if (error) {
      setNotice('Couldn’t open that collector. Check your connection and try again.');
      return;
    }
    if (!data) {
      if (currentUserId) void removeRecentProfile(currentUserId, profile.id);
      setNotice('That collector is no longer available.');
      return;
    }
    openProfile(toRecentShape(data as ProfileRow));
  }

  // Layout: centered panel under the logo, inside the side margins, never
  // under the bottom navigation (or the keyboard when it's up).
  const panelWidth = windowWidth - SIDE_MARGIN * 2;
  const panelTop = (anchor?.y ?? insets.top + 56) + NOTCH_SIZE / 2 + 4;
  const bottomReserve = keyboardHeight > 0 ? keyboardHeight + 12 : TAB_BAR_HEIGHT + insets.bottom + 16;
  const maxPanelHeight = Math.max(180, windowHeight - panelTop - bottomReserve);
  const notchLeft = Math.min(
    Math.max((anchor?.x ?? windowWidth / 2) - SIDE_MARGIN - NOTCH_SIZE / 2, 24),
    panelWidth - 24 - NOTCH_SIZE,
  );

  const showingSearch = trimmed.length > 0;

  function renderRow(profile: RecentProfile, onPress: () => void) {
    const name = profile.displayName || profile.username;
    return (
      <TouchableOpacity
        key={profile.id}
        style={styles.row}
        onPress={onPress}
        activeOpacity={0.7}
        disabled={opening !== null}
        accessibilityRole="button"
        accessibilityLabel={`Open ${name}'s profile`}>
        <View style={styles.avatar}>
          {profile.avatarUrl ? (
            <Image source={{ uri: profile.avatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
          ) : (
            <Text style={styles.avatarInitial}>{name.charAt(0).toUpperCase()}</Text>
          )}
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowName} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.rowUsername} numberOfLines={1}>
            @{profile.username}
          </Text>
        </View>
        {opening === profile.id ? (
          <ActivityIndicator size="small" color={PV2.textSecondary} />
        ) : (
          <IconSymbol name="chevron.right" size={16} color={PV2.textSecondary} />
        )}
      </TouchableOpacity>
    );
  }

  let body: React.ReactNode;
  if (showingSearch) {
    if (search.kind === 'results') {
      body = search.profiles.length ? (
        search.profiles.map((p) => renderRow(p, () => openProfile(p)))
      ) : (
        <Text style={styles.stateText}>No collectors found.</Text>
      );
    } else if (search.kind === 'error') {
      body = <Text style={styles.stateText}>Couldn’t search right now. Check your connection and try again.</Text>;
    } else {
      body = <ActivityIndicator style={styles.stateSpinner} color={PV2.textSecondary} />;
    }
  } else {
    body = (
      <>
        <Text style={styles.sectionLabel}>Recent</Text>
        {recents.length ? (
          recents.map((p) => renderRow(p, () => openRecent(p)))
        ) : (
          <Text style={styles.stateText}>No recent collectors yet.</Text>
        )}
      </>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: openProgress }]}>
        <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Close Find User" />
      </Animated.View>
      <Animated.View
        style={[
          styles.panel,
          { top: panelTop, left: SIDE_MARGIN, width: panelWidth, maxHeight: maxPanelHeight, opacity: openProgress },
        ]}
        accessibilityViewIsModal>
        <View style={[styles.notch, { left: notchLeft }]} />
        <View style={styles.searchBox}>
          <IconSymbol name="magnifyingglass" size={18} color={PV2.textSecondary} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={(text) => {
              setQuery(text);
              setNotice(null);
              if (!text.trim()) setSearch({ kind: 'idle' });
            }}
            placeholder="Find user"
            placeholderTextColor={PV2.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityLabel="Find user"
          />
        </View>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag">
          {body}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  panel: {
    position: 'absolute',
    backgroundColor: PV2.panel,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    paddingTop: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 18,
    elevation: 12,
  },
  // Pointer toward the logo: a rotated square half-tucked behind the panel's
  // top edge, sharing its fill and border.
  notch: {
    position: 'absolute',
    top: -NOTCH_SIZE / 2,
    width: NOTCH_SIZE,
    height: NOTCH_SIZE,
    backgroundColor: PV2.panel,
    borderLeftWidth: 1,
    borderTopWidth: 1,
    borderColor: PV2.panelBorder,
    transform: [{ rotate: '45deg' }],
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 14,
    paddingHorizontal: 14,
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    backgroundColor: PV2.bg,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: PV2.textPrimary,
    paddingVertical: 0,
  },
  notice: {
    marginHorizontal: 16,
    marginTop: 10,
    fontSize: 13,
    color: PV2.textSecondary,
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
    gap: 6,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textSecondary,
    marginLeft: 4,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    backgroundColor: PV2.bg,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  rowUsername: {
    fontSize: 14,
    color: PV2.textSecondary,
  },
  stateText: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
    paddingVertical: 18,
  },
  stateSpinner: {
    paddingVertical: 18,
  },
});
