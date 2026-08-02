import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { supabase } from '@/lib/supabase';

export type TransferRecipientProfile = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

const SEARCH_DEBOUNCE_MS = 300;
const RESULT_LIMIT = 8;
const MIN_QUERY_LENGTH = 2;

// Escapes Postgres ILIKE's own special characters so user input is matched
// literally, not as a wildcard: backslash is ILIKE's escape character
// itself (escaped first, before introducing any new backslashes below), %
// matches any run of characters, _ matches any single character. This is
// distinct from — and doesn't need to cover — PostgREST's .or() structural
// characters (comma, parentheses, quotes), which this file sidesteps
// entirely by never building a raw .or() string (see searchRecipients).
function escapeIlikePattern(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

async function searchRecipients(
  term: string,
  excludeUserId: string,
): Promise<{ data: TransferRecipientProfile[]; error: string | null }> {
  const pattern = `%${escapeIlikePattern(term)}%`;
  // Two independent single-column queries, not one .or() built by
  // interpolating raw user input — PostgREST's .or() mini-language treats
  // commas, parentheses, and double-quotes as structural (they separate or
  // group conditions), so hand-building one from arbitrary input risks a
  // malformed filter or a query that silently doesn't mean what it looks
  // like. Each .ilike() call below passes `pattern` as an ordinary bound
  // query parameter instead, so none of that syntax can be broken out of —
  // only ILIKE's own wildcard characters need escaping, handled above.
  // Results are merged with username-matches taking priority over
  // display-name-only matches (see the merge loop order below) — a
  // deliberate choice, not an accident of Map insertion order, since a
  // recipient is most often looked up by the handle the sender already
  // knows, not their display name.
  const [byUsername, byDisplayName] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .ilike('username', pattern)
      .neq('id', excludeUserId)
      .order('username')
      .limit(RESULT_LIMIT),
    supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .ilike('display_name', pattern)
      .neq('id', excludeUserId)
      .order('username')
      .limit(RESULT_LIMIT),
  ]);

  const firstError = byUsername.error ?? byDisplayName.error;
  if (firstError) {
    return { data: [], error: firstError.message };
  }

  const merged = new Map<string, TransferRecipientProfile>();
  for (const row of (byUsername.data ?? []) as TransferRecipientProfile[]) merged.set(row.id, row);
  for (const row of (byDisplayName.data ?? []) as TransferRecipientProfile[]) {
    if (!merged.has(row.id)) merged.set(row.id, row);
  }

  return { data: [...merged.values()].slice(0, RESULT_LIMIT), error: null };
}

type Props = {
  excludeUserId: string;
  onSelect: (profile: TransferRecipientProfile) => void;
};

// Dedicated, minimal recipient search for the registry Transfer modal — not
// a reuse of app/(tabs)/search.tsx's queryProfiles/UserRow. That screen's
// query also selects `bio` (unneeded here), and its UserRow is a full-width
// FlatList row styled for a light-themed standalone screen, not a compact
// list inside a dark PV2 bottom sheet. Same debounce shape and self-
// exclusion filter, copied deliberately rather than shared — the two call
// sites have nothing else in common that would justify a shared hook.
export function TransferRecipientPicker({ excludeUserId, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TransferRecipientProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every newly scheduled search AND on unmount — a resolved
  // request only commits its result if the sequence value it captured
  // before awaiting is still current. This is what stops an older, slower
  // request from overwriting a newer one's results (debouncing the timer
  // alone doesn't protect the network round-trip itself), and doubles as
  // the unmount guard: bumping it one last time on unmount makes any
  // still-in-flight request's eventual resolution a permanent no-op.
  const requestSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      requestSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const term = query.trim();

    if (term.length < MIN_QUERY_LENGTH) {
      // Invalidates whatever request was previously in flight so its
      // result can't land after this and repopulate results the user just
      // cleared.
      requestSeqRef.current += 1;
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }

    const seq = ++requestSeqRef.current;
    setSearching(true);
    setSearchError(null);
    debounceRef.current = setTimeout(async () => {
      const { data, error } = await searchRecipients(term, excludeUserId);
      // Only the latest scheduled request may commit — an older request
      // resolving late (or resolving after unmount) is silently discarded.
      if (seq !== requestSeqRef.current) return;
      if (error) {
        if (__DEV__) console.error('[TransferRecipientPicker] search failed:', error);
        setSearchError('Unable to search users. Try again.');
        setResults([]);
        setSearching(false);
        return;
      }
      setResults(data);
      setSearching(false);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, excludeUserId]);

  const trimmedLength = query.trim().length;

  return (
    <View>
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="Search by username..."
        placeholderTextColor={PV2.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel="Search transfer recipients"
        accessibilityHint="Type a username or display name to find a recipient"
      />

      {searching ? (
        <View style={styles.stateWrap}>
          <ActivityIndicator size="small" color={PV2.link} />
        </View>
      ) : searchError ? (
        <View style={styles.stateWrap}>
          <Text style={styles.errorText}>{searchError}</Text>
        </View>
      ) : trimmedLength >= MIN_QUERY_LENGTH && results.length === 0 ? (
        <View style={styles.stateWrap}>
          <Text style={styles.emptyText}>No users found.</Text>
        </View>
      ) : (
        results.map((profile) => {
          const displayName = profile.display_name || profile.username;
          return (
            <TouchableOpacity
              key={profile.id}
              style={styles.row}
              onPress={() => onSelect(profile)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Select @${profile.username}`}>
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
                <Text style={styles.primaryText} numberOfLines={1}>
                  {displayName}
                </Text>
                <Text style={styles.secondaryText} numberOfLines={1}>
                  @{profile.username}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: PV2.border,
    backgroundColor: PV2.panel,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: PV2.textPrimary,
  },
  stateWrap: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
  errorText: {
    fontSize: 13,
    color: PV2.textTertiary,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 15,
    fontWeight: '700',
    color: PV2.textSecondary,
  },
  rowBody: {
    flex: 1,
    gap: 1,
  },
  primaryText: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  secondaryText: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
});
