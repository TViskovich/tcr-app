import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ChatAvatar } from '@/components/conversation/chat-avatar';
import { CHAT } from '@/components/conversation/conversation-theme';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { type ConversationItem, loadInbox } from '@/lib/dm-inbox';
import { supabase } from '@/lib/supabase';

const SEARCH_DEBOUNCE_MS = 250;

export type Recipient = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

type Props = {
  currentUserId: string | undefined;
  onSelect: (recipient: Recipient) => void;
  bottomInset: number;
  // Disables row taps (e.g. while the parent is resolving a conversation).
  disabled?: boolean;
};

// Strips characters that carry meaning inside a PostgREST .or() filter
// string so a typed comma/paren/wildcard can't change the query shape.
function sanitizeSearchTerm(term: string) {
  return term.replace(/[,()%*\\]/g, ' ').trim();
}

// "Choose someone" list shared by Item Detail → Send in DM
// (send-item-dm-sheet.tsx) and the inbox's New Message sheet
// (new-message-sheet.tsx): search field + Recent (existing 1:1
// conversations, via the inbox's own loadInbox) or People (profile search by
// username / display name, debounced, excluding the signed-in user).
export function RecipientList({ currentUserId, onSelect, bottomInset, disabled }: Props) {
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<ConversationItem[]>([]);
  const [recentsLoading, setRecentsLoading] = useState(true);
  // Results are tagged with the term they answer, so "searching" and stale
  // results are derived rather than set synchronously inside the effect.
  const [searchResult, setSearchResult] = useState<{ term: string; rows: Recipient[] } | null>(null);

  useEffect(() => {
    if (!currentUserId) return;
    const controller = new AbortController();
    loadInbox(currentUserId, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setRecents(rows);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setRecentsLoading(false);
      });
    return () => controller.abort();
  }, [currentUserId]);

  const term = sanitizeSearchTerm(query);
  useEffect(() => {
    if (!term || !currentUserId) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .or(`username.ilike.%${term}%,display_name.ilike.%${term}%`)
        .neq('id', currentUserId)
        .order('username')
        .limit(20)
        .abortSignal(controller.signal);
      if (controller.signal.aborted) return;
      if (error && __DEV__) console.error('[RecipientList] search failed:', error.message);
      setSearchResult({
        term,
        rows: ((data ?? []) as {
          id: string;
          username: string;
          display_name: string | null;
          avatar_url: string | null;
        }[])
          .filter((p) => !!p.username)
          .map((p) => ({ id: p.id, username: p.username, displayName: p.display_name, avatarUrl: p.avatar_url })),
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, currentUserId]);
  const searching = !!term && searchResult?.term !== term;
  const results = searchResult?.term === term ? searchResult.rows : [];

  const recentUserIds = useMemo(() => new Set(recents.map((c) => c.otherUserId)), [recents]);
  const recentRecipients: (Recipient & { preview: string | null })[] = useMemo(
    () =>
      recents
        .filter((c) => c.otherUserId && c.otherUserId !== currentUserId)
        .map((c) => ({
          id: c.otherUserId,
          username: c.otherUsername,
          displayName: c.otherDisplayName,
          avatarUrl: c.otherAvatarUrl,
          preview: c.lastMessageBody,
        })),
    [recents, currentUserId],
  );

  const showingSearch = !!term;
  const listData: (Recipient & { preview?: string | null })[] = showingSearch ? results : recentRecipients;

  return (
    <>
      <View style={styles.searchWrap}>
        <IconSymbol name="magnifyingglass" size={16} color={PV2.textTertiary} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search people"
          placeholderTextColor={PV2.textTertiary}
          selectionColor={CHAT.accent}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      <FlatList
        data={listData}
        keyExtractor={(r) => r.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.list, { paddingBottom: bottomInset + 24 }]}
        ListHeaderComponent={<Text style={styles.sectionLabel}>{showingSearch ? 'People' : 'Recent'}</Text>}
        ItemSeparatorComponent={() => <View style={styles.divider} />}
        ListEmptyComponent={
          (showingSearch ? searching : recentsLoading) ? (
            <View style={styles.center}>
              <ActivityIndicator color={PV2.textSecondary} />
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={styles.emptyText}>
                {showingSearch ? 'No people found.' : 'No conversations yet — search for someone above.'}
              </Text>
            </View>
          )
        }
        renderItem={({ item: r }) => {
          const secondary = showingSearch
            ? recentUserIds.has(r.id)
              ? `@${r.username} · Recent conversation`
              : `@${r.username}`
            : r.preview
              ? `@${r.username} · ${r.preview}`
              : `@${r.username}`;
          return (
            <Pressable
              onPress={() => onSelect(r)}
              disabled={disabled}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={r.displayName || r.username}>
              <ChatAvatar uri={r.avatarUrl} name={r.displayName || r.username} size={44} />
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {r.displayName || r.username}
                </Text>
                <Text style={styles.rowSubtitle} numberOfLines={1}>
                  {secondary}
                </Text>
              </View>
              <IconSymbol name="chevron.right" size={14} color={PV2.textTertiary} />
            </Pressable>
          );
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 4,
    paddingHorizontal: 12,
    backgroundColor: PV2.collectorPanelBg,
    borderRadius: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: PV2.textPrimary,
    paddingVertical: 10,
  },
  list: {
    paddingHorizontal: 16,
    paddingTop: 14,
    flexGrow: 1,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: PV2.textSecondary,
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  rowSubtitle: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: PV2.dividerColor,
    marginLeft: 56,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 48,
  },
  emptyText: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  pressed: {
    opacity: 0.8,
  },
});
