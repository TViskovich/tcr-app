import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { Swipeable } from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, Ellipse, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { useMessageBadgeRefresh } from '@/lib/message-badge-context';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

type ConversationItem = {
  id: string;
  otherUserId: string;
  otherUsername: string;
  otherDisplayName: string | null;
  otherAvatarUrl: string | null;
  lastMessageBody: string | null;
  lastMessageAt: string;
};

function formatTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// 3 sequential round-trips:
//   1. my participation rows → convIds
//   2. parallel: all participants + conversations + recent messages
//   3. profiles for the other users
// `signal` required — always called from load/onRefresh below, each of
// which owns an AbortController tied to this screen's focus lifecycle (see
// the useFocusEffect cleanup further down for why an uncancelled request
// left running past a tab switch can crash with whatwg-fetch's status-0
// RangeError — same mechanism as hooks/use-profile.ts).
async function loadInbox(currentUserId: string, signal: AbortSignal): Promise<ConversationItem[]> {
  const { data: myRows } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', currentUserId)
    // Conversations this user swipe-deleted from their own inbox — hidden
    // here only; the other participant's own row/inbox is untouched, and a
    // DB trigger clears this back to NULL the moment a new message lands.
    .is('hidden_at', null)
    .abortSignal(signal);

  // Checked after every awaited phase below (not just the final one) so an
  // aborted lifecycle (blur/unmount/foreground-superseded) stops issuing
  // further queries instead of paying for phases whose result can never be
  // applied — the caller (load/onRefresh/refreshInbox) independently checks
  // signal.aborted again before touching state either way.
  if (signal.aborted) return [];
  if (!myRows?.length) return [];

  const convIds = (myRows as any[]).map((r) => r.conversation_id as string);

  const [allParticipantsRes, conversationsRes, messagesRes] = await Promise.all([
    supabase
      .from('conversation_participants')
      .select('conversation_id, user_id')
      .in('conversation_id', convIds)
      .abortSignal(signal),
    supabase
      .from('conversations')
      .select('id, last_message_at')
      .in('id', convIds)
      .abortSignal(signal),
    supabase
      .from('messages')
      .select('conversation_id, body, created_at')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false })
      .limit(200)
      .abortSignal(signal),
  ]);

  if (signal.aborted) return [];

  // Map: conversation_id → other user_id
  const convOtherUserMap = new Map<string, string>();
  for (const row of (allParticipantsRes.data ?? []) as any[]) {
    if (row.user_id !== currentUserId) {
      convOtherUserMap.set(row.conversation_id, row.user_id);
    }
  }

  const otherUserIds = [...new Set([...convOtherUserMap.values()])];
  const { data: profilesData } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', otherUserIds)
    .abortSignal(signal);

  if (signal.aborted) return [];

  const profileMap = new Map((profilesData ?? []).map((p: any) => [p.id, p]));

  // Messages are DESC — first seen per conversation_id is the latest
  const latestMsgMap = new Map<string, any>();
  for (const msg of (messagesRes.data ?? []) as any[]) {
    if (!latestMsgMap.has(msg.conversation_id)) {
      latestMsgMap.set(msg.conversation_id, msg);
    }
  }

  const convLastAtMap = new Map<string, string>(
    (conversationsRes.data ?? []).map((c: any) => [c.id, c.last_message_at]),
  );

  return convIds
    .map((convId) => {
      const otherUserId = convOtherUserMap.get(convId) ?? '';
      const p = profileMap.get(otherUserId) ?? {};
      const lastMsg = latestMsgMap.get(convId);
      return {
        id: convId,
        otherUserId,
        otherUsername: p.username ?? 'user',
        otherDisplayName: p.display_name ?? null,
        otherAvatarUrl: p.avatar_url ?? null,
        lastMessageBody: lastMsg?.body ?? null,
        lastMessageAt: lastMsg?.created_at ?? convLastAtMap.get(convId) ?? new Date().toISOString(),
      };
    })
    .sort(
      (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
    );
}

// Two overlapping chat bubbles, each holding a faint card silhouette, with a
// few small iridescent tiles drifting between them and a soft ground shadow
// beneath — metallic white-silver surfaces with restrained cyan/lavender/pink
// accents, no gold, no glow.
function EmptyMessagesArtwork() {
  return (
    <Svg width={320} height={230} viewBox="0 0 320 230">
      <Defs>
        <LinearGradient id="bubbleRear" x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#FFFFFF" />
          <Stop offset="100%" stopColor="#E4EEF0" />
        </LinearGradient>
        <LinearGradient id="bubbleFront" x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#FFFFFF" />
          <Stop offset="100%" stopColor="#EEEAF6" />
        </LinearGradient>
        <RadialGradient id="groundShadow" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor="#1B2733" stopOpacity={0.16} />
          <Stop offset="100%" stopColor="#1B2733" stopOpacity={0} />
        </RadialGradient>
      </Defs>

      {/* Ground shadow */}
      <Ellipse cx={170} cy={207} rx={95} ry={11} fill="url(#groundShadow)" />

      {/* Rear-left bubble — tail drawn first so the body's rounded edge covers the seam */}
      <Path d="M62,151 L82,151 L54,175 Z" fill="url(#bubbleRear)" />
      <Rect
        x={35}
        y={48}
        width={155}
        height={105}
        rx={24}
        fill="url(#bubbleRear)"
        stroke="#C9D3D6"
        strokeWidth={1}
      />
      <Path
        d="M55,60 Q47,68 47,80"
        stroke="#FFFFFF"
        strokeWidth={3}
        strokeLinecap="round"
        opacity={0.6}
        fill="none"
      />
      {/* Card silhouette — no image or text, just faint frame */}
      <Rect x={90} y={68} width={46} height={66} rx={8} fill="#EDF2F3" stroke="#D3DBDD" strokeWidth={1} />
      <Rect x={95} y={73} width={36} height={56} rx={5} fill="none" stroke="#C7D0D2" strokeWidth={0.75} opacity={0.7} />

      {/* Front-right bubble */}
      <Path d="M243,181 L263,181 L271,203 Z" fill="url(#bubbleFront)" />
      <Rect
        x={130}
        y={78}
        width={155}
        height={105}
        rx={24}
        fill="url(#bubbleFront)"
        stroke="#D2CDE0"
        strokeWidth={1}
      />
      <Path
        d="M150,90 Q142,98 142,110"
        stroke="#FFFFFF"
        strokeWidth={3}
        strokeLinecap="round"
        opacity={0.6}
        fill="none"
      />
      <Rect x={185} y={98} width={46} height={66} rx={8} fill="#F1EEF7" stroke="#DAD4E8" strokeWidth={1} />
      <Rect x={190} y={103} width={36} height={56} rx={5} fill="none" stroke="#CFC8E0" strokeWidth={0.75} opacity={0.7} />
    </Svg>
  );
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
            c.lastMessageBody === prev[i].lastMessageBody,
        );
      if (unchanged) return;

      setConversations(data);
      // Synchronous mirror — see conversationsRef's own comment.
      conversationsRef.current = data;
    } catch (e) {
      if (!signal.aborted && __DEV__) console.error('[Messages] inbox refresh failed:', e);
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

  function handleFindCollectors() {
    router.push('/(tabs)/search');
  }

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

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Messages</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      ) : conversations.length === 0 ? (
        <View style={styles.messagesEmptyState}>
          <CacheCaseLogo
            variant="light"
            size="lg"
            placement="emptyState"
            style={styles.messagesEmptyLogo}
          />
          <EmptyMessagesArtwork />

          <Text style={styles.messagesEmptyTitle}>No conversations yet</Text>

          <Text style={styles.messagesEmptyBody}>
            Connect with collectors and start talking cards.
          </Text>

          <TouchableOpacity
            style={styles.messagesEmptyButton}
            onPress={handleFindCollectors}
            activeOpacity={0.82}>
            <Text style={styles.messagesEmptyButtonText}>Find Collectors</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }}
          onScroll={navbarOnScroll}
          scrollEventThrottle={scrollEventThrottle}
          renderItem={({ item }) => (
            <ConversationRow
              item={item}
              onPress={() =>
                router.push({
                  pathname: '/conversation/[id]',
                  params: {
                    id: item.id,
                    otherUsername: item.otherUsername,
                    otherDisplayName: item.otherDisplayName ?? '',
                  },
                })
              }
              onDeletePress={() => handleDeletePress(item)}
            />
          )}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PV2.link} />
          }
        />
      )}
    </SafeAreaView>
  );
}

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
        <TouchableOpacity
          style={styles.deleteAction}
          onPress={handleDeleteTap}
          activeOpacity={0.85}>
          <Text style={styles.deleteActionText}>Delete</Text>
        </TouchableOpacity>
      )}
      overshootRight={false}
      rightThreshold={40}>
      <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
        <View style={styles.avatar}>
          {item.otherAvatarUrl ? (
            <Image
              source={{ uri: item.otherAvatarUrl }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={200}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
              <Text style={styles.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
            </View>
          )}
        </View>

        <View style={styles.rowBody}>
          <Text style={styles.rowName} numberOfLines={1}>{displayName}</Text>
          <Text style={styles.rowPreview} numberOfLines={1}>
            {item.lastMessageBody ?? 'New conversation'}
          </Text>
        </View>

        <Text style={styles.rowTime}>{formatTime(item.lastMessageAt)}</Text>
      </TouchableOpacity>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: PV2.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  messagesEmptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    transform: [{ translateY: -24 }],
  },
  messagesEmptyArtwork: {
    width: 320,
    height: 230,
    alignSelf: 'center',
  },
  messagesEmptyLogo: {
    transform: [{ translateY: -50 }],
  },
  messagesEmptyTitle: {
    marginTop: 18,
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700',
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  messagesEmptyBody: {
    marginTop: 10,
    maxWidth: 330,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '400',
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  messagesEmptyButton: {
    marginTop: 24,
    width: 230,
    height: 52,
    borderRadius: 26,
    backgroundColor: PV2.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messagesEmptyButtonText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
    backgroundColor: PV2.bg,
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
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    flexShrink: 0,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 20,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  rowBody: {
    flex: 1,
    marginLeft: 12,
    gap: 3,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  rowPreview: {
    fontSize: 14,
    color: PV2.textSecondary,
  },
  rowTime: {
    fontSize: 12,
    color: PV2.textTertiary,
    marginLeft: 8,
    flexShrink: 0,
  },
});
