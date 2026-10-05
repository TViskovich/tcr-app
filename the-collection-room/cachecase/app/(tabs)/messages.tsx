import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useFocusEffect, useRouter } from 'expo-router';
import { Swipeable } from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatAvatar } from '@/components/conversation/chat-avatar';
import { CHAT } from '@/components/conversation/conversation-theme';
import { NewMessageSheet } from '@/components/conversation/new-message-sheet';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { type ConversationItem, loadInbox } from '@/lib/dm-inbox';
import { useMessageBadgeRefresh } from '@/lib/message-badge-context';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

const SKELETON_ROWS = 7;

// Compact inbox timestamp: "now", "5m", "3h", "Yesterday", "Sep 30", and
// "Sep 30, 2025" outside the current year.
function formatTime(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const diff = (now.getTime() - date.getTime()) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400 && date.getDate() === now.getDate()) return `${Math.floor(diff / 3600)}h`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : null),
  });
}

function previewText(item: ConversationItem) {
  if (!item.lastMessageBody) return 'New conversation';
  return item.lastMessageFromMe ? `You: ${item.lastMessageBody}` : item.lastMessageBody;
}

export default function MessagesScreen() {
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const refreshMessageBadge = useMessageBadgeRefresh();
  const { onScroll: navbarOnScroll, scrollEventThrottle } = useScrollResponsiveNavbar();

  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Last authoritative refresh failed. Only surfaced while there's nothing
  // to show — a failed background poll never replaces a loaded inbox.
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [newMessageOpen, setNewMessageOpen] = useState(false);

  // Mirrors `conversations` synchronously for refreshInbox's authoritative-
  // compare logic below, which can be re-entered (via the coalesced-pending
  // path) sooner than a passive effect is guaranteed to have flushed — same
  // pattern/reasoning as app/conversation/[id].tsx's messagesRef.
  const conversationsRef = useRef<ConversationItem[]>([]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Separate controllers for load() and onRefresh() — they guard separate
  // flags (loading/refreshing) so a stale one must never clear the other's
  // flag. Both aborted together on focus-loss/unmount (see the
  // useFocusEffect cleanup below); see hooks/use-profile.ts for the full
  // whatwg-fetch status-0 crash mechanism this guards against.
  const loadControllerRef = useRef<AbortController | null>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);

  // Synchronous overlap guard shared by every authoritative inbox fetch.
  // Claimed and released in EXACTLY ONE place — refreshInbox's own
  // try/finally below. load() and onRefresh() both delegate their actual
  // fetch to refreshInbox rather than claiming this ref themselves: giving
  // two separate call sites their own claim/release of the same ref made it
  // possible for a rapid blur+refocus to have an old (aborted, not-yet-
  // settled) holder release a guard a newer fetch believed it still held.
  // A single claim/release site removes that failure mode structurally.
  const fetchInFlightRef = useRef(false);

  // Coalesced "run one more authoritative refresh as soon as the in-flight
  // one releases" request. Set by a focus-triggered load() or an AppState
  // foreground catch-up (the only two callers that pass coalesceIfBusy:
  // true — see load() and the AppState listener below) that arrived while
  // fetchInFlightRef was already held, regardless of which logical caller
  // currently holds it. Holds only the requesting call's AbortSignal, never
  // a growing queue — a second request before the first is consumed just
  // overwrites this ref, so at most one extra refresh ever runs. Consumed
  // exactly once, in refreshInbox's own `finally`, immediately after it
  // releases fetchInFlightRef — the same fix already proven for this class
  // of race (Test 11) in app/conversation/[id].tsx's
  // pendingImmediateRefreshRef.
  const pendingImmediateRefreshRef = useRef<AbortSignal | null>(null);

  // Shared authoritative inbox refresh — the ONLY function that claims or
  // releases fetchInFlightRef (see that ref's comment for why). Called from
  // load() (focus-triggered), onRefresh() (manual pull-to-refresh), and the
  // poll/foreground effect below. Always re-fetches the full authoritative
  // inbox via loadInbox and compares it against conversationsRef before
  // touching state — an unchanged result is a no-op (no re-render). Never
  // touches `loading`/`refreshing` itself — those stay owned by load()/
  // onRefresh() respectively, so background polling stays visually silent.
  const refreshInbox = useCallback(async (
    signal: AbortSignal,
    options?: { coalesceIfBusy?: boolean },
  ) => {
    if (!currentUserId) return;
    if (fetchInFlightRef.current) {
      // Only a focus-triggered load() or an AppState foreground catch-up
      // opts into coalescing — a busy poll tick or a busy manual refresh is
      // left to silently skip, matching the "poll ticks silently skip when
      // busy" baseline; queuing them would just be extra unrequested
      // fetches.
      if (options?.coalesceIfBusy) pendingImmediateRefreshRef.current = signal;
      return;
    }
    fetchInFlightRef.current = true;
    try {
      const data = await loadInbox(currentUserId, signal);
      if (signal.aborted) return;
      setLoadError(false);

      const prev = conversationsRef.current;
      // Compare only the fields that actually determine what's rendered
      // (identity, order via array position, preview text, timestamp) — not
      // a general deep-equality; avatar/name drift from a profile edit is
      // not this slice's concern and will still show up on the next
      // focus-triggered load() regardless.
      const unchanged =
        data.length === prev.length &&
        data.every(
          (c, i) =>
            c.id === prev[i].id &&
            c.lastMessageAt === prev[i].lastMessageAt &&
            c.lastMessageBody === prev[i].lastMessageBody &&
            c.lastMessageFromMe === prev[i].lastMessageFromMe &&
            c.unread === prev[i].unread,
        );
      if (unchanged) return;

      setConversations(data);
      // Synchronous mirror — see conversationsRef's own comment.
      conversationsRef.current = data;
    } catch (e) {
      if (!signal.aborted) {
        setLoadError(true);
        if (__DEV__) console.error('[Messages] inbox refresh failed:', e);
      }
    } finally {
      fetchInFlightRef.current = false;

      // Run a coalesced pending refresh, if one was requested while THIS
      // call held the guard — regardless of whether this call originated
      // from load(), onRefresh(), a poll tick, or a foreground event.
      // Consumed exactly once and cleared regardless of outcome, so it can
      // never re-fire or accumulate.
      const pendingSignal = pendingImmediateRefreshRef.current;
      pendingImmediateRefreshRef.current = null;
      if (pendingSignal && !pendingSignal.aborted && AppState.currentState === 'active') {
        refreshInbox(pendingSignal, { coalesceIfBusy: true });
      }
    }
  }, [currentUserId]);

  const load = useCallback(async () => {
    if (!currentUserId) {
      setLoading(false);
      return;
    }
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;

    setLoading(true);
    try {
      // coalesceIfBusy: true — a focus-triggered load is a "must obtain
      // current authoritative inbox data now" event, same as foreground
      // catch-up: if it collides with a fetch still settling from the
      // previous focus lifecycle, it must not be silently dropped. If that
      // happens, this controller's signal is the one sitting in
      // pendingImmediateRefreshRef until the busy fetch releases the guard
      // — see why loadControllerRef.current is deliberately NOT cleared
      // here below.
      await refreshInbox(controller.signal, { coalesceIfBusy: true });
    } finally {
      // Deliberately does NOT clear loadControllerRef.current here (only
      // controls `loading` via the identity check). If this call coalesced
      // rather than actually fetching, its signal may still be sitting in
      // pendingImmediateRefreshRef, waiting for a busy fetch to release the
      // guard — that signal must remain abortable by the focus-effect
      // cleanup below for the entire remaining focus session, not just
      // until this function returns. Nulling it here would let a second
      // blur happen with no live reference to abort it, stranding a stale
      // pending refresh that could fire on an unfocused screen. The next
      // load() still safely aborts/replaces whatever loadControllerRef
      // currently holds regardless of whether it was nulled in between.
      if (loadControllerRef.current === controller) {
        setLoading(false);
      }
    }
  }, [currentUserId, refreshInbox]);

  const onRefresh = useCallback(async () => {
    if (!currentUserId) return;
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;

    setRefreshing(true);
    try {
      // No coalesceIfBusy — a manual pull that collides with a busy poll
      // silently skips, same as the proven conversation-screen onRefresh;
      // this function's own independent `finally` below always clears
      // `refreshing` regardless, so the spinner can never stick either way.
      await refreshInbox(controller.signal);
      if (refreshControllerRef.current !== controller || controller.signal.aborted) return;
      // Preserves existing behavior: manual refresh has always refreshed
      // the aggregate unread badge on completion, unconditionally. Left
      // as-is deliberately — global badge polling is Slice B's scope, not
      // this slice's.
      refreshMessageBadge();
    } catch (e) {
      if (controller.signal.aborted || refreshControllerRef.current !== controller) return;
      if (__DEV__) console.error('[Messages] refresh failed:', e);
    } finally {
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
        setRefreshing(false);
      }
    }
  }, [currentUserId, refreshInbox, refreshMessageBadge]);

  useFocusEffect(
    useCallback(() => {
      load();
      return () => {
        // Authoritative place that both aborts AND clears the focus-load
        // controller for this focus session — load() itself deliberately
        // leaves loadControllerRef.current populated after it returns (see
        // that function's own comment) specifically so a coalesced pending
        // refresh's signal remains abortable via this exact cleanup for as
        // long as the tab stays focused, not just until load()'s own await
        // settles. An already-completed AbortController can be aborted
        // again harmlessly, so this is safe even when load() finished a
        // real fetch rather than coalescing.
        loadControllerRef.current?.abort();
        loadControllerRef.current = null;

        refreshControllerRef.current?.abort();
        refreshControllerRef.current = null;
      };
    }, [load]),
  );

  // Beta freshness: while the Messages tab is focused AND the app is
  // foregrounded, poll the inbox for changes every 5s via the same
  // refreshInbox used by load()/onRefresh(), plus an immediate refresh when
  // the app returns to foreground rather than waiting for the first tick.
  // Kept as its own useFocusEffect (rather than merged into the one above)
  // so load()'s existing focus-triggered full-screen load stays untouched —
  // this effect only adds silent background freshness on top of it. Mirrors
  // app/conversation/[id].tsx's polling lifecycle, adapted rather than
  // copied since messages.tsx already owns its own focus-load mechanism.
  useFocusEffect(
    useCallback(() => {
      if (!currentUserId) return;

      const controller = new AbortController();
      let intervalId: ReturnType<typeof setInterval> | null = null;

      function startInterval() {
        if (intervalId) return;
        intervalId = setInterval(() => {
          refreshInbox(controller.signal);
        }, 5000);
      }
      function stopInterval() {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      }

      // Only start immediately if the app is actually foregrounded right
      // now — same reasoning as the conversation screen's identical check.
      // No coalesceIfBusy here: this is a secondary attempt alongside
      // load()'s own focus-triggered fetch, fine to silently skip if the
      // guard is already held.
      if (AppState.currentState === 'active') {
        refreshInbox(controller.signal);
        startInterval();
      }

      // Pause polling while backgrounded and resume with an immediate,
      // coalescing-eligible refresh when foregrounded again, all without
      // leaving the tab's focus state.
      const appStateSub = AppState.addEventListener('change', (nextState) => {
        if (nextState === 'active') {
          // coalesceIfBusy: true — if a prior fetch is still holding
          // fetchInFlightRef when the app foregrounds, don't just drop this
          // refresh and wait for the next 5s tick; refreshInbox's own
          // `finally` will run it the moment that fetch releases the guard.
          refreshInbox(controller.signal, { coalesceIfBusy: true });
          startInterval();
        } else {
          stopInterval();
        }
      });

      return () => {
        stopInterval();
        appStateSub.remove();
        // Aborts this lifecycle's controller — if pendingImmediateRefreshRef
        // currently holds this exact controller's signal (i.e. a pending
        // foreground catch-up owned by THIS polling effect instance),
        // refreshInbox's `finally` will see it as aborted and skip firing.
        controller.abort();
      };
    }, [currentUserId, refreshInbox]),
  );

  function openConversation(conversationId: string, otherUsername: string, otherDisplayName: string | null) {
    router.push({
      pathname: '/conversation/[id]',
      params: { id: conversationId, otherUsername, otherDisplayName: otherDisplayName ?? '' },
    });
  }

  // Local filter over the loaded inbox — name, handle, or last message.
  const filteredConversations = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      [c.otherUsername, c.otherDisplayName, c.lastMessageBody]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q)),
    );
  }, [conversations, query]);

  // Hides the conversation from this user's inbox only — never a real
  // delete (see the hidden_at migration's comment). Row is only removed
  // from local state after the update is confirmed to have succeeded, so a
  // failed request never silently drops a conversation the server still
  // considers visible.
  const handleDeleteConversation = useCallback(
    async (item: ConversationItem) => {
      if (!currentUserId) return;

      const { error } = await supabase
        .from('conversation_participants')
        .update({ hidden_at: new Date().toISOString() })
        .eq('conversation_id', item.id)
        .eq('user_id', currentUserId);

      if (error) {
        if (__DEV__) {
          console.error('[Messages] hide conversation failed:', { conversationId: item.id, code: error.code, message: error.message });
        }
        Alert.alert('Error', 'Could not remove this conversation. Please try again.');
        return;
      }

      setConversations((prev) => prev.filter((c) => c.id !== item.id));
    },
    [currentUserId],
  );

  function handleDeletePress(item: ConversationItem) {
    Alert.alert(
      'Delete conversation?',
      'This conversation will be removed from your inbox. It will remain available to the other person and will reappear if either of you sends a new message.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => handleDeleteConversation(item) },
      ],
    );
  }

  const listBottomPadding = TAB_BAR_HEIGHT + insets.bottom + 24;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>Messages</Text>
        </View>
        <Pressable
          onPress={() => setNewMessageOpen(true)}
          style={({ pressed }) => [styles.composeBtn, pressed && styles.pressed]}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="New message">
          <IconSymbol name="square.and.pencil" size={19} color={PV2.textPrimary} />
        </Pressable>
      </View>

      <View style={styles.searchWrap}>
        <IconSymbol name="magnifyingglass" size={16} color={PV2.textTertiary} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search messages"
          placeholderTextColor={PV2.textTertiary}
          selectionColor={CHAT.accent}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {loading && conversations.length === 0 ? (
        <View style={styles.skeletonList} accessibilityLabel="Loading conversations">
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <View key={i} style={styles.row}>
              <View style={styles.skeletonAvatar} />
              <View style={styles.rowBody}>
                <View style={[styles.skeletonLine, { width: '45%' }]} />
                <View style={[styles.skeletonLine, { width: '70%' }]} />
              </View>
              <View style={[styles.skeletonLine, styles.skeletonTime]} />
            </View>
          ))}
        </View>
      ) : loadError && conversations.length === 0 ? (
        <View style={styles.stateWrap}>
          <Text style={styles.stateTitle}>Couldn’t load messages</Text>
          <Text style={styles.stateBody}>Check your connection and try again.</Text>
          <Pressable
            onPress={onRefresh}
            style={({ pressed }) => [styles.stateBtn, pressed && styles.pressed]}
            accessibilityRole="button">
            <Text style={styles.stateBtnText}>Try Again</Text>
          </Pressable>
        </View>
      ) : conversations.length === 0 ? (
        <View style={styles.stateWrap}>
          <View style={styles.stateIcon}>
            <IconSymbol name="message" size={24} color={PV2.textSecondary} />
          </View>
          <Text style={styles.stateTitle}>No messages yet</Text>
          <Text style={styles.stateBody}>Start a conversation with another collector.</Text>
          <Pressable
            onPress={() => setNewMessageOpen(true)}
            style={({ pressed }) => [styles.stateBtn, styles.stateBtnPrimary, pressed && styles.pressed]}
            accessibilityRole="button">
            <Text style={[styles.stateBtnText, styles.stateBtnTextPrimary]}>New Message</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={filteredConversations}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.listContent, { paddingBottom: listBottomPadding }]}
          onScroll={navbarOnScroll}
          scrollEventThrottle={scrollEventThrottle}
          ListHeaderComponent={<Text style={styles.sectionLabel}>Recent</Text>}
          ListEmptyComponent={
            <Text style={styles.noMatches}>No conversations match “{query.trim()}”.</Text>
          }
          renderItem={({ item }) => (
            <ConversationRow
              item={item}
              onPress={() => openConversation(item.id, item.otherUsername, item.otherDisplayName)}
              onDeletePress={() => handleDeletePress(item)}
            />
          )}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PV2.textSecondary} />
          }
        />
      )}

      <NewMessageSheet
        visible={newMessageOpen}
        onClose={() => setNewMessageOpen(false)}
        onOpenConversation={(conversationId, recipient) => {
          setNewMessageOpen(false);
          // Let the page sheet start dismissing before the push.
          setTimeout(() => openConversation(conversationId, recipient.username, recipient.displayName), 300);
        }}
      />
    </SafeAreaView>
  );
}

// Existing swipe-to-delete (hide from my inbox only) is preserved as-is.
function ConversationRow({
  item,
  onPress,
  onDeletePress,
}: {
  item: ConversationItem;
  onPress: () => void;
  onDeletePress: () => void;
}) {
  const swipeableRef = useRef<Swipeable>(null);
  const displayName = item.otherDisplayName || item.otherUsername;

  function handleDeleteTap() {
    // Close the swipe before the confirmation Alert appears, rather than
    // leaving the row visibly stuck open underneath it.
    swipeableRef.current?.close();
    onDeletePress();
  }

  return (
    <Swipeable
      ref={swipeableRef}
      renderRightActions={() => (
        <TouchableOpacity style={styles.deleteAction} onPress={handleDeleteTap} activeOpacity={0.85}>
          <Text style={styles.deleteActionText}>Delete</Text>
        </TouchableOpacity>
      )}
      overshootRight={false}
      rightThreshold={40}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        accessibilityRole="button"
        accessibilityLabel={`${displayName}${item.unread ? ', unread' : ''}. ${previewText(item)}`}>
        <ChatAvatar uri={item.otherAvatarUrl} name={displayName} size={48} />

        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={[styles.rowName, item.unread && styles.rowNameUnread]} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={[styles.rowTime, item.unread && styles.rowTimeUnread]}>
              {formatTime(item.lastMessageAt)}
            </Text>
          </View>
          <View style={styles.rowBottom}>
            <Text style={[styles.rowPreview, item.unread && styles.rowPreviewUnread]} numberOfLines={1}>
              {previewText(item)}
            </Text>
            {item.unread ? <View style={styles.unreadDot} /> : null}
          </View>
        </View>
      </Pressable>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 12,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  // Same circular control language as the DM conversation screen.
  composeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  pressed: {
    opacity: 0.75,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 6,
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
  listContent: {
    paddingTop: 10,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: PV2.textSecondary,
    paddingHorizontal: 20,
    marginBottom: 4,
  },
  noMatches: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
    paddingTop: 32,
    paddingHorizontal: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 11,
    backgroundColor: PV2.bg,
  },
  rowPressed: {
    backgroundColor: PV2.panel,
  },
  rowBody: {
    flex: 1,
    gap: 3,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  rowNameUnread: {
    fontWeight: '800',
  },
  rowTime: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
  rowTimeUnread: {
    color: PV2.textSecondary,
  },
  rowPreview: {
    flex: 1,
    fontSize: 14,
    color: PV2.textTertiary,
  },
  rowPreviewUnread: {
    color: PV2.textPrimary,
  },
  unreadDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: CHAT.accent,
  },
  deleteAction: {
    width: 88,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.accent,
  },
  deleteActionText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  },
  skeletonList: {
    paddingTop: 10,
  },
  skeletonAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: PV2.collectorPanelBg,
  },
  skeletonLine: {
    height: 11,
    borderRadius: 5.5,
    backgroundColor: PV2.collectorPanelBg,
    marginVertical: 3,
  },
  skeletonTime: {
    width: 28,
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  stateWrap: {
    alignItems: 'center',
    paddingTop: 72,
    paddingHorizontal: 32,
    gap: 6,
  },
  stateIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    marginBottom: 8,
  },
  stateTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  stateBody: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  stateBtn: {
    marginTop: 14,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: PV2.collectorPanelBg,
  },
  stateBtnPrimary: {
    backgroundColor: CHAT.accent,
  },
  stateBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  stateBtnTextPrimary: {
    color: CHAT.onAccent,
    fontWeight: '700',
  },
});
