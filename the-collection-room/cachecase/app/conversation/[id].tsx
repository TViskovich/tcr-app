import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import * as Crypto from 'expo-crypto';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { useMessageBadgeRefresh } from '@/lib/message-badge-context';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

// Extra clearance so the composer sits above the globally-rendered floating
// tab bar (components/navigation/global-floating-tab-bar.tsx, rendered as a
// root-level sibling of every screen outside app/(tabs) — it is NOT part of
// this screen's own view tree, so it doesn't get pushed up by
// KeyboardAvoidingView). Without this, the composer sits underneath that
// bar's touch-absorbing surface whenever the keyboard is closed, and taps
// meant for the input/Send button land on the tab bar's inert background
// instead. Applied only while the keyboard is closed; once it's open the
// composer hugs the keyboard exactly as before, with no dead gap. Same
// TAB_BAR_CLEARANCE pattern already used by app/post/[id].tsx for its
// comment input bar.
const TAB_BAR_CLEARANCE = TAB_BAR_HEIGHT + 16;

// Below this distance (px) from the bottom of the message list, a freshness
// refresh (poll/focus) auto-scrolls to a newly-arrived message; beyond it,
// the user is treated as reading older history and left undisturbed.
const NEAR_BOTTOM_THRESHOLD = 90;

type Message = {
  id: string;
  sender_id: string;
  body: string;
  created_at: string;
};

type OtherUser = {
  id: string;
  username: string;
  display_name: string | null;
};

function formatBubbleTime(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const isToday = (Date.now() - d.getTime()) / 1000 < 86400;
  if (isToday) return time;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

function MessageBubble({ message, isOwn }: { message: Message; isOwn: boolean }) {
  return (
    <View style={[styles.bubbleWrap, isOwn && styles.bubbleWrapOwn]}>
      <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
        <Text style={[styles.bubbleText, isOwn && styles.bubbleTextOwn]}>{message.body}</Text>
      </View>
      <Text style={styles.bubbleTime}>{formatBubbleTime(message.created_at)}</Text>
    </View>
  );
}

export default function ConversationScreen() {
  const {
    id: convId,
    otherUsername: paramUsername,
    otherDisplayName: paramDisplayName,
  } = useLocalSearchParams<{ id: string; otherUsername?: string; otherDisplayName?: string }>();

  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const insets = useSafeAreaInsets();
  const refreshMessageBadge = useMessageBadgeRefresh();
  // A chat thread, not a browsing list — no scroll-hide effect (would
  // fight the thread's own auto-scroll-to-bottom behavior), but still
  // resets the shared navbar to visible on focus.
  useScrollResponsiveNavbar({ enabled: false });

  const [otherUser, setOtherUser] = useState<OtherUser | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  // Synchronous re-entry guard for handleSend — sending (React state) alone
  // doesn't take effect until the next render, so two send events arriving
  // before that commit could both pass a state-only check. See handleSend.
  const sendingRef = useRef(false);
  // A logical send whose outcome is unresolved after an ambiguous write
  // (lost response, 5xx, thrown exception) AND an authoritative
  // reconciliation-by-id read also failed to prove it either way. Holds the
  // same sendId + body so an explicit retry reuses them instead of minting a
  // new logical send — see performSend/resolveAmbiguousSend. Session-local
  // only: held in React state, not persisted, so an app kill while a send is
  // in this state loses the token (known beta gap, not solved here).
  const [pendingSend, setPendingSend] = useState<{ id: string; body: string } | null>(null);
  // Synchronous, same-runtime exactly-once guard for finalizeSentMessage,
  // keyed by durable messages.id. Needed because setPendingSend(null) is an
  // async state update — a second Retry tap can still read the pre-commit
  // "pendingSend still set" closure and call performSend again before React
  // re-renders, which can reach finalizeSentMessage a second time for the
  // same id (e.g. via a second 23505 -> reconciliation FOUND). This ref is
  // checked/populated synchronously, unlike React state, so it closes that
  // window. This is same-JS-runtime side-effect dedupe only, not a durable
  // database uniqueness guarantee — it resets on remount and provides no
  // protection at all across an app restart (see pendingSend's own comment
  // for that still-open, documented beta gap).
  const finalizedSendIdsRef = useRef<Set<string>>(new Set());
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const flatListRef = useRef<FlatList<Message>>(null);

  // Mirrors `messages` synchronously for loadMessages' authoritative-compare
  // logic below, which runs from a setInterval/AppState closure that must
  // never read a stale `messages` value captured at effect-setup time.
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Whether the FlatList is currently scrolled near its bottom edge — used
  // to decide whether a freshness refresh (poll/focus) should auto-scroll to
  // a newly-arrived message or leave the user's scroll position (e.g.
  // reading older history) undisturbed. Starts true: the initial load and
  // every send scroll to bottom.
  const isNearBottomRef = useRef(true);

  // Synchronous overlap guard shared by every authoritative messages fetch
  // (initial mount load, focus-triggered refresh, each 5s poll tick, and
  // manual pull-to-refresh via loadMessages) — prevents two of these firing
  // concurrently, per beta freshness slice's concurrency requirement.
  const fetchInFlightRef = useRef(false);

  // Coalesced "run one more authoritative refresh as soon as the in-flight
  // one releases" request — set only by a foreground-transition refresh
  // (see the AppState listener below) that arrived while fetchInFlightRef
  // was already held (e.g. a poll tick still in flight when the app
  // backgrounds and is quickly foregrounded again). Holds only the
  // requesting call's AbortSignal, never a growing queue: a second request
  // before the first is consumed just overwrites this ref, so at most one
  // extra refresh ever runs. Consumed exactly once, in loadMessages' own
  // `finally`, immediately after it releases fetchInFlightRef.
  const pendingImmediateRefreshRef = useRef<AbortSignal | null>(null);

  // Separate controllers for the mount-effect load and onRefresh — they
  // guard separate flags (loading/refreshing). loadControllerRef belongs to
  // the useEffect below (true unmount when this screen is popped, since
  // it's a stack route, not a tab); refreshControllerRef belongs to
  // pull-to-refresh. Both aborted together on unmount — an in-flight
  // request left running past that point can have its underlying XHR
  // connection torn down by the native networking layer and crash with
  // whatwg-fetch's status-0 RangeError (see hooks/use-profile.ts for the
  // full mechanism writeup).
  const loadControllerRef = useRef<AbortController | null>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);

  // Tracks keyboard state purely to toggle TAB_BAR_CLEARANCE above — see
  // that constant's comment. "Will" events on iOS (available there) avoid a
  // one-frame lag/flash; Android only has "Did" events.
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Fallback pattern: canGoBack() is false when this screen was reached via
  // a deep link or otherwise has no real navigation history to pop —
  // replacing onto the inbox keeps the back action reliable either way.
  const headerBackLeft = () => <BackButton fallbackHref="/(tabs)/messages" />;

  // Shared authoritative messages fetch — called from onRefresh (manual
  // pull-to-refresh), the focus/poll effect below (initial focus, every 5s
  // tick, and app-foreground), each supplying its own controller's signal.
  // Guarded by fetchInFlightRef so overlapping callers skip rather than
  // stack concurrent requests. Always re-fetches the full authoritative,
  // deterministically-ordered list and compares it against messagesRef
  // before touching state — never blind-replaces — so an unchanged poll is
  // a no-op (no re-render, no scroll, no last_read_at write).
  const loadMessages = useCallback(async (
    signal: AbortSignal,
    options?: { coalesceIfBusy?: boolean },
  ) => {
    if (!convId) return;
    if (fetchInFlightRef.current) {
      // Only a foreground-transition refresh opts into coalescing (see the
      // AppState listener below) — a busy poll tick or manual refresh is
      // left to silently skip exactly as before; they have no "must not
      // wait for the next tick" requirement, so queuing them would just be
      // extra unrequested fetches.
      if (options?.coalesceIfBusy) pendingImmediateRefreshRef.current = signal;
      return;
    }
    fetchInFlightRef.current = true;
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('id, sender_id, body, created_at')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .abortSignal(signal);

      // Single caller/single controller here, so checking the signal
      // directly (rather than comparing controller identity, as the
      // multi-controller screens in this codebase do) is sufficient to
      // discard a stale result.
      if (signal.aborted) return;

      if (error) {
        // Leave currently-rendered messages untouched on failure — never
        // clear the conversation or surface a noisy alert for a background
        // freshness check. The next poll tick or manual refresh will retry.
        if (__DEV__) console.error('[Conversation] messages refresh failed:', error.message);
        return;
      }

      const fetched = (data ?? []) as Message[];
      const prev = messagesRef.current;
      const unchanged =
        fetched.length === prev.length && fetched.every((m, i) => m.id === prev[i].id);
      if (unchanged) return;

      const prevIds = new Set(prev.map((m) => m.id));
      const hasNewIncoming = fetched.some(
        (m) => !prevIds.has(m.id) && m.sender_id !== currentUserId,
      );

      setMessages(fetched);
      // Synchronous mirror, not left to the messages-effect above: this
      // function can be re-entered (once fetchInFlightRef releases in
      // `finally` below) sooner than a passive useEffect is guaranteed to
      // have flushed, which would otherwise let a closely-following fetch
      // compare against a stale `prev` and re-flag an already-applied
      // incoming message as new. Keeping both assignments is intentional:
      // this one is the correctness guarantee, the effect covers callers
      // that update `messages` some other way (e.g. finalizeSentMessage).
      messagesRef.current = fetched;

      if (isNearBottomRef.current) {
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);
      }

      // Only advance last_read_at when this fetch actually surfaced a new
      // incoming (not-own) message — never on an unchanged tick, and never
      // unconditionally on every poll. Mirrors the sender-side stamp in
      // finalizeSentMessage, which is untouched by this addition.
      if (hasNewIncoming && currentUserId) {
        const { error: readError } = await supabase
          .from('conversation_participants')
          .update({ last_read_at: new Date().toISOString() })
          .eq('conversation_id', convId)
          .eq('user_id', currentUserId);

        if (readError) {
          if (__DEV__) console.error('[Conversation] last_read_at advance failed:', readError.message);
        } else {
          refreshMessageBadge();
        }
      }
    } catch (e) {
      if (!signal.aborted && __DEV__) console.error('[Conversation] messages refresh threw:', e);
    } finally {
      fetchInFlightRef.current = false;

      // Run a coalesced pending refresh, if one was requested while this
      // fetch held the guard — closes the foreground-catch-up race (Test
      // 11) instead of leaving it to wait for the next 5s interval tick.
      // Consumed exactly once and cleared regardless of outcome, so it can
      // never re-fire or accumulate. Only fires if still valid: the
      // requesting signal's own controller is aborted by the same
      // useFocusEffect cleanup that handles blur/unmount/convId-change (see
      // that effect below), and the AppState check here additionally
      // covers "backgrounded again before this could run" — neither
      // condition is guaranteed by signal.aborted alone.
      const pendingSignal = pendingImmediateRefreshRef.current;
      pendingImmediateRefreshRef.current = null;
      if (pendingSignal && !pendingSignal.aborted && AppState.currentState === 'active') {
        loadMessages(pendingSignal, { coalesceIfBusy: true });
      }
    }
  }, [convId, currentUserId, refreshMessageBadge]);

  useEffect(() => {
    if (!convId || !currentUserId) return;

    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;

    async function load() {
      setLoading(true);
      // Claim the shared fetch guard for the initial combined load too, so
      // a focus-triggered immediate refresh that lands in the same tick
      // (the polling effect below also fires on initial focus) finds it
      // already held and skips — this load already fetches fresh messages,
      // so that would otherwise be a redundant simultaneous request.
      fetchInFlightRef.current = true;

      try {
        // Parallel: find the other participant + load messages
        const [participantRes, messagesRes] = await Promise.all([
          supabase
            .from('conversation_participants')
            .select('user_id')
            .eq('conversation_id', convId)
            .neq('user_id', currentUserId)
            .abortSignal(controller.signal)
            .single(),
          supabase
            .from('messages')
            .select('id, sender_id, body, created_at')
            .eq('conversation_id', convId)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .abortSignal(controller.signal),
        ]);

        if (loadControllerRef.current !== controller || controller.signal.aborted) return;

        const otherUserId = (participantRes.data as any)?.user_id;
        if (otherUserId) {
          const { data: profileData } = await supabase
            .from('profiles')
            .select('id, username, display_name')
            .eq('id', otherUserId)
            .abortSignal(controller.signal)
            .single();
          if (loadControllerRef.current !== controller || controller.signal.aborted) return;
          if (profileData) setOtherUser(profileData as OtherUser);
        }

        const loadedMessages = (messagesRes.data ?? []) as Message[];
        setMessages(loadedMessages);

        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 50);

        // Mark this conversation as read and update the tab badge — tied
        // to the same controller as the load itself: if the user
        // navigates away before this settles, there's no reason to keep
        // it running, and this closes the same crash risk as the rest of
        // this effect.
        supabase
          .from('conversation_participants')
          .update({ last_read_at: new Date().toISOString() })
          .eq('conversation_id', convId)
          .eq('user_id', currentUserId)
          .abortSignal(controller.signal)
          .then(({ error: e }) => {
            if (controller.signal.aborted || loadControllerRef.current !== controller) return;
            if (e) console.error('last_read_at stamp failed:', e.message);
            else refreshMessageBadge();
          });
      } catch (e) {
        if (controller.signal.aborted || loadControllerRef.current !== controller) return;
        if (__DEV__) console.error('[Conversation] load failed:', e);
      } finally {
        fetchInFlightRef.current = false;
        if (loadControllerRef.current === controller) {
          loadControllerRef.current = null;
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      controller.abort();
      refreshControllerRef.current?.abort();
    };
  }, [convId, currentUserId, refreshMessageBadge]);

  const onRefresh = useCallback(async () => {
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;

    setRefreshing(true);
    try {
      await loadMessages(controller.signal);
    } catch (e) {
      if (controller.signal.aborted || refreshControllerRef.current !== controller) return;
      if (__DEV__) console.error('[Conversation] refresh failed:', e);
    } finally {
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
        setRefreshing(false);
      }
    }
  }, [loadMessages]);

  // Beta freshness: while this conversation screen is focused AND the app
  // is foregrounded, poll for new messages every 5s via the same
  // loadMessages used above, plus an immediate refresh on focus/foreground
  // rather than waiting for the first tick. useFocusEffect's own cleanup
  // (returned below) runs on blur, unmount, AND whenever this callback's
  // identity changes while still focused (i.e. convId/currentUserId
  // change) — covering every stop condition without extra bookkeeping.
  // Deliberately does not use Realtime/publication changes — polling only.
  useFocusEffect(
    useCallback(() => {
      if (!convId || !currentUserId) return;

      const controller = new AbortController();
      let intervalId: ReturnType<typeof setInterval> | null = null;

      function startInterval() {
        if (intervalId) return;
        intervalId = setInterval(() => {
          loadMessages(controller.signal);
        }, 5000);
      }
      function stopInterval() {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      }

      // Only start immediately if the app is actually foregrounded right
      // now — a screen can become focused while the app is backgrounded
      // (e.g. a focus event firing during app-state transitions), and
      // polling must never begin until both focus AND foreground hold. The
      // AppState listener below covers the transition the other way.
      if (AppState.currentState === 'active') {
        loadMessages(controller.signal);
        startInterval();
      }

      // Pause polling while backgrounded (no point spending battery/network
      // on a screen nobody can see) and resume with an immediate refresh —
      // same reasoning as the foreground-entry check above — when
      // foregrounded again, all without leaving the screen's focus state.
      const appStateSub = AppState.addEventListener('change', (nextState) => {
        if (nextState === 'active') {
          // coalesceIfBusy: true — if a prior fetch (e.g. a poll tick that
          // was still in flight when the app backgrounded) is still
          // holding fetchInFlightRef, don't just drop this refresh and
          // wait for the next 5s tick; loadMessages' own `finally` will run
          // it the moment that fetch releases the guard.
          loadMessages(controller.signal, { coalesceIfBusy: true });
          startInterval();
        } else {
          stopInterval();
        }
      });

      return () => {
        stopInterval();
        appStateSub.remove();
        controller.abort();
      };
    }, [convId, currentUserId, loadMessages]),
  );

  // Shared finalization for a logical send that is now known to durably
  // exist — used by both a clean INSERT success and a reconciliation read
  // that finds the row. One function so the two cases can't drift apart.
  function finalizeSentMessage(message: Message) {
    // Synchronous exactly-once guard — must be the very first thing this
    // function does, before any side effect or state update below. See
    // finalizedSendIdsRef's declaration for why setPendingSend(null) alone
    // (an async state update) isn't enough to prevent a second call for the
    // same id from a rapid second Retry tap.
    if (finalizedSendIdsRef.current.has(message.id)) return;
    finalizedSendIdsRef.current.add(message.id);

    const now = new Date().toISOString();

    // conversations.last_message_at is maintained server-side by the
    // messages_bump_conversation_last_message_at trigger (AFTER INSERT ON
    // public.messages) — this used to also be set here client-side, but a
    // plain client-clock assignment isn't guaranteed >= the trigger's
    // GREATEST(last_message_at, NEW.created_at) value, so a second client
    // write here could regress it. Removed; the trigger is the sole writer.

    // Keep sender's last_read_at current so their own send doesn't show as unread
    supabase
      .from('conversation_participants')
      .update({ last_read_at: now })
      .eq('conversation_id', convId)
      .eq('user_id', currentUserId)
      .then(({ error: e }) => {
        if (e) console.error('last_read_at send-stamp failed:', e.message);
      });

    // Local-render dedupe only — the DB primary key is what actually
    // prevents a duplicate row; this just guards against appending the same
    // durable row twice locally.
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));

    // type='message' notifications are created server-side by the
    // messages_create_message_notification trigger (AFTER INSERT ON
    // public.messages) — this used to also be inserted here client-side,
    // but a second writer would produce a duplicate, user-visible
    // notification row on every send. Removed; the trigger is the sole
    // writer.

    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  }

  type ReconcileResult =
    | { status: 'found'; message: Message }
    | { status: 'absent' }
    | { status: 'unknown' };

  // Authoritative check for one logical send: did sendId actually commit?
  // The live messages_select policy is participant-gated, so this read is
  // trustworthy for the sender's own row. A read error or thrown exception
  // leaves the true outcome unknown — must not be reported as ABSENT, which
  // would wrongly tell the caller it's safe to let the user resend under a
  // fresh id.
  async function reconcileSendById(sendId: string): Promise<ReconcileResult> {
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('id, sender_id, body, created_at')
        .eq('id', sendId)
        .eq('conversation_id', convId)
        .eq('sender_id', currentUserId)
        .maybeSingle();

      if (error) return { status: 'unknown' };
      return data ? { status: 'found', message: data as Message } : { status: 'absent' };
    } catch {
      return { status: 'unknown' };
    }
  }

  // Resolves an ambiguous write outcome (23505 conflict, status 0, 5xx, or a
  // thrown exception) for one logical send by reading back its sendId.
  // FOUND/ABSENT are authoritative and end the pending send. UNKNOWN is not
  // — the same sendId/body must survive in pendingSend for an explicit
  // retry rather than being discarded or guessed at.
  async function resolveAmbiguousSend(sendId: string, body: string) {
    const outcome = await reconcileSendById(sendId);
    if (outcome.status === 'found') {
      finalizeSentMessage(outcome.message);
      setPendingSend(null);
    } else if (outcome.status === 'absent') {
      setNewMessage(body);
      setPendingSend(null);
    } else {
      setPendingSend({ id: sendId, body });
    }
  }

  // The actual durable-write attempt for one logical send — callable both
  // for a fresh Send tap (handleSend) and an explicit retry of a still-
  // pending sendId (handleRetryPendingSend). Both callers pass the
  // identical (sendId, body) for a given logical send so a retry that lands
  // on an already-committed row surfaces as a genuine primary-key conflict,
  // not a coincidence. sendingRef/sending always release in `finally`,
  // independent of whether the logical send itself resolved — an
  // unresolved send lives on in pendingSend after this returns.
  async function performSend(sendId: string, body: string) {
    if (!currentUserId || !convId || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);

    try {
      const { data: msgData, error, status } = await supabase
        .from('messages')
        .insert({ id: sendId, conversation_id: convId, sender_id: currentUserId, body })
        .select('id, sender_id, body, created_at')
        .single();

      if (!error) {
        // A. Clean success.
        finalizeSentMessage(msgData as Message);
        setPendingSend(null);
        return;
      }

      if (error.code === '23505') {
        // B. Duplicate-key conflict on messages_pkey — a prior attempt
        // under this exact sendId may have already committed.
        await resolveAmbiguousSend(sendId, body);
        return;
      }

      if (status === 0) {
        // C. Lost/network-origin response — the INSERT may have committed
        // before the response leg failed.
        await resolveAmbiguousSend(sendId, body);
        return;
      }

      if (status >= 500) {
        // D. Server error — same ambiguity as status 0.
        await resolveAmbiguousSend(sendId, body);
        return;
      }

      // E. A definitive 4xx that isn't a duplicate-key conflict (e.g. RLS
      // rejection, malformed payload) — the INSERT did not commit.
      console.error('Send failed:', error.message, { code: error.code, status });
      setNewMessage(body);
      setPendingSend(null);
    } catch (e) {
      // F. Thrown after the request may have already left the device — the
      // INSERT may still have committed. Never treat a throw as proof of
      // non-commit; reconcile the same as the ambiguous-status cases above.
      console.error('Send threw (outcome unknown), reconciling:', e);
      await resolveAmbiguousSend(sendId, body);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  // A brand-new logical send always gets a brand-new sendId. Blocked while
  // a pendingSend exists so the composer never has two unresolved logical
  // sends in flight at once — the pending one must be resolved via
  // handleRetryPendingSend first (see the pending-send banner in the JSX).
  function handleSend() {
    if (!currentUserId || !newMessage.trim() || !convId || sendingRef.current || pendingSend) return;
    const body = newMessage.trim();
    const sendId = Crypto.randomUUID();
    setNewMessage('');
    performSend(sendId, body);
  }

  // Explicit retry of the one currently-pending ambiguous send — reuses its
  // exact sendId/body so a prior successful commit surfaces as a 23505
  // conflict (reconciled, not duplicated) rather than a second row.
  function handleRetryPendingSend() {
    if (!pendingSend || sendingRef.current) return;
    performSend(pendingSend.id, pendingSend.body);
  }

  // Updates isNearBottomRef only — a ref write, not state, so this never
  // triggers a render on its own regardless of scroll frequency. Read by
  // loadMessages to decide whether an incoming-message refresh should
  // auto-scroll or leave the user's reading position alone.
  function handleMessagesScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentSize, layoutMeasurement, contentOffset } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    isNearBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD;
  }

  const displayTitle =
    otherUser?.display_name ||
    otherUser?.username ||
    (paramDisplayName ? String(paramDisplayName) : null) ||
    (paramUsername ? String(paramUsername) : null) ||
    'Conversation';

  if (loading) {
    return (
      <>
        <Stack.Screen
          options={{
            title: (paramDisplayName || paramUsername) ? String(paramDisplayName || paramUsername) : 'Conversation',
            headerBackTitle: '',
            headerLeft: headerBackLeft,
          }}
        />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: displayTitle, headerBackTitle: '', headerLeft: headerBackLeft }} />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}>
        <FlatList
          ref={flatListRef}
          style={styles.list}
          data={messages}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          renderItem={({ item }) => (
            <MessageBubble message={item} isOwn={item.sender_id === currentUserId} />
          )}
          contentContainerStyle={styles.messageList}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <CacheCaseLogo variant="icon" size="lg" placement="emptyState" />
              <Text style={styles.emptyText}>No messages yet. Say hi!</Text>
            </View>
          }
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PV2.link} />
          }
          onScroll={handleMessagesScroll}
          scrollEventThrottle={100}
        />

        {/* Pending-send banner — shown only while an ambiguous write's
            outcome is unresolved (see resolveAmbiguousSend's UNKNOWN case).
            The only way to clear this state is Retry (reuses the same
            sendId/body) — the normal composer stays disabled below so the
            user can't accidentally abandon it by starting a new send. */}
        {pendingSend && (
          <View style={styles.pendingBanner}>
            <Text style={styles.pendingBannerText} numberOfLines={1}>
              Message not confirmed as sent
            </Text>
            <TouchableOpacity
              onPress={handleRetryPendingSend}
              disabled={sending}
              style={styles.pendingRetryBtn}>
              {sending ? (
                <ActivityIndicator size="small" color={PV2.link} />
              ) : (
                <Text style={styles.pendingRetryText}>Retry</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* Composer — extra bottom clearance (TAB_BAR_CLEARANCE) only while
            the keyboard is closed, so it sits above the floating tab bar
            instead of underneath its touch-absorbing surface. See
            TAB_BAR_CLEARANCE's comment. */}
        <View
          style={[
            styles.inputBar,
            {
              paddingBottom: keyboardVisible
                ? Math.max(insets.bottom, 8)
                : Math.max(insets.bottom, 8) + TAB_BAR_CLEARANCE,
            },
          ]}>
          <TextInput
            style={styles.input}
            value={newMessage}
            onChangeText={setNewMessage}
            placeholder="Message..."
            placeholderTextColor={PV2.textTertiary}
            returnKeyType="send"
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
            editable={!sending && !pendingSend}
            maxLength={1000}
          />
          <TouchableOpacity
            onPress={handleSend}
            disabled={!newMessage.trim() || sending || !!pendingSend}
            style={styles.sendBtn}>
            {sending ? (
              <ActivityIndicator size="small" color={PV2.link} />
            ) : (
              <Text style={[styles.sendText, !newMessage.trim() && styles.sendTextDisabled]}>
                Send
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.bg,
  },
  list: {
    flex: 1,
  },
  messageList: {
    flexGrow: 1,
    paddingVertical: 12,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyText: {
    fontSize: 15,
    color: PV2.textSecondary,
  },
  // Bubbles
  bubbleWrap: {
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 3,
  },
  bubbleWrapOwn: {
    alignItems: 'flex-end',
  },
  bubble: {
    maxWidth: '75%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  bubbleOther: {
    backgroundColor: PV2.collectorPanelBg,
    borderBottomLeftRadius: 4,
  },
  // Was the same #0a7ea4 teal-blue used ad hoc elsewhere in this file —
  // mapped onto PV2.accent (the app's one actual defined accent, used for
  // likes/primary actions throughout) rather than a color with no other
  // meaning in the rest of the app.
  bubbleOwn: {
    backgroundColor: PV2.accent,
    borderBottomRightRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    color: PV2.textPrimary,
    lineHeight: 20,
  },
  bubbleTextOwn: {
    color: '#fff',
  },
  bubbleTime: {
    fontSize: 10,
    color: PV2.textTertiary,
    marginTop: 2,
    marginHorizontal: 4,
  },
  // Pending-send banner — amber/warning, deliberately distinct from the
  // app's red accent/error color (this isn't a failure, just an
  // unconfirmed send) — same accentSoft-style low-alpha-fill +
  // tinted-border shape as the error banners elsewhere in this dark-theme
  // pass, just amber-hued since no warning token exists in PV2.
  pendingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,183,3,0.14)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,183,3,0.35)',
    gap: 8,
  },
  pendingBannerText: {
    flex: 1,
    fontSize: 13,
    color: '#FFB703',
  },
  pendingRetryBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    minWidth: 48,
    alignItems: 'center',
  },
  pendingRetryText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFB703',
  },
  // Input bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PV2.dividerColor,
    backgroundColor: PV2.bg,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: PV2.textPrimary,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    maxHeight: 100,
  },
  sendBtn: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    minWidth: 48,
    alignItems: 'center',
  },
  sendText: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.link,
  },
  sendTextDisabled: {
    color: PV2.textTertiary,
  },
});
