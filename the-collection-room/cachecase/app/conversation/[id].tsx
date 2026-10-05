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
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { AttachmentSheet } from '@/components/conversation/attachment-sheet';
import { ConversationComposer } from '@/components/conversation/conversation-composer';
import { ConversationHeader } from '@/components/conversation/conversation-header';
import { DmImageAttachment } from '@/components/conversation/dm-image-attachment';
import { DmItemAttachmentCard } from '@/components/conversation/dm-item-attachment-card';
import { CHAT } from '@/components/conversation/conversation-theme';
import { MessageBubble } from '@/components/conversation/message-bubble';
import { type PhotoFlowState, type PhotoSource, PhotoConfirmSheet } from '@/components/conversation/photo-confirm-sheet';
import { ShareItemPicker } from '@/components/conversation/share-item-picker';
import { TypingIndicator } from '@/components/conversation/typing-indicator';
import { ItemPhotoViewerModal } from '@/components/item-detail/item-photo-viewer-modal';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useConversationTyping } from '@/hooks/use-conversation-typing';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import {
  type DmItemPreviewState,
  fetchDmItemPreviews,
  MESSAGE_COLUMNS,
} from '@/lib/dm-attachments';
import { useMessageBadgeRefresh } from '@/lib/message-badge-context';
import { dmImagePath, prepareDmImage, type PreparedDmImage, removeDmImage, uploadDmImage } from '@/lib/dm-images';
import {
  attachmentColumns,
  type DmAttachmentInput,
  type DmMessage,
  stampSenderReadCursor,
  writeDmMessage,
} from '@/lib/dm-send';
import { navigateToProfile } from '@/lib/profile-navigation';
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

type Message = DmMessage;

// 'not_shareable' = the server's item_not_shareable rejection (definitive,
// nothing committed) — reported separately so the picker can say so.
type SendOutcome = 'sent' | 'failed' | 'not_shareable' | 'pending' | 'skipped';

type OtherUser = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

// Bubble timestamps are time-only — the calendar day is carried by the
// centered day separator rendered above the first message of each day.
function formatBubbleTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function isSameDay(a: string, b: string) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

// Value written to the viewer's own conversation_participants.last_read_at:
// the server-assigned created_at of the newest message actually loaded on
// screen, not the device clock. The peer's "Read" status compares this
// cursor against messages.created_at (also server time), so a skewed phone
// clock can neither hide a real read nor fake one for a message not yet
// seen. The unread badge (hooks/use-unread-messages.ts) compares
// conversations.last_message_at (server time) with a strict >, so an equal
// cursor still clears it.
function readCursorFor(list: Message[]) {
  return list.length ? list[list.length - 1].created_at : new Date().toISOString();
}

function formatDayLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : null),
  });
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
  // The other participant's read cursor (their conversation_participants.
  // last_read_at) — drives the Sent/Read status on my newest outgoing
  // message. Refreshed by the initial load and every loadMessages call
  // (focus, 5s poll, foreground, pull-to-refresh). Readable only because
  // the existing participant-gated RLS already exposes the other
  // participant's row (the load below already selects its user_id).
  const [peerReadAt, setPeerReadAt] = useState<string | null>(null);
  // Display-only placeholder for the send currently in flight, so the
  // bubble can show "Sending…" before the INSERT returns. Never written to
  // `messages`/messagesRef — finalizeSentMessage still appends the durable
  // row exactly as before; this is cleared in performSend's finally.
  const [inFlight, setInFlight] = useState<Message | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [itemPickerOpen, setItemPickerOpen] = useState(false);
  // Camera/Photos → shared PhotoConfirmSheet. Null = sheet closed.
  const [photoFlow, setPhotoFlow] = useState<PhotoFlowState | null>(null);
  // Full-screen viewer for a tapped DM photo (already-signed URL).
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  // Live-resolved item attachment previews, keyed by item id. Resolved under
  // this viewer's own RLS (see lib/dm-attachments.ts) — an item they can't
  // see comes back 'unavailable'. Screen-local: a fresh open re-resolves, so
  // a privacy change or deletion shows up on the next visit.
  const [itemPreviews, setItemPreviews] = useState<Map<string, DmItemPreviewState>>(() => new Map());
  const requestedItemIdsRef = useRef<Set<string>>(new Set());
  // Aborted only on unmount — not per `messages` change, so a lookup started
  // by one change is never cancelled by the next (which would strand its
  // cards on "loading").
  const previewsControllerRef = useRef<AbortController | null>(null);
  const router = useRouter();
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
  const [pendingSend, setPendingSend] = useState<{
    id: string;
    body: string | null;
    attachment: DmAttachmentInput | null;
  } | null>(null);
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

  // Ephemeral typing state over Realtime Broadcast (see the hook) —
  // independent of the polling/read-state logic in this file.
  const { peerTyping, notifyLocalInput, stopLocalTyping } = useConversationTyping({
    convId,
    currentUserId,
    otherUserId: otherUser?.id,
  });

  // The indicator renders as the list footer, i.e. below the newest message.
  // Only follow it into view when the reader is already at the bottom —
  // never yank someone reading older history back down.
  useEffect(() => {
    if (peerTyping && isNearBottomRef.current) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [peerTyping]);

  // Resolve any attachment item ids not yet requested — one batched lookup
  // per new set of ids, covering initial load, polled arrivals and own sends
  // alike (they all land in `messages`). Ids whose lookup failed are
  // released so the next change retries them instead of staying "loading".
  useEffect(() => {
    const pending = Array.from(
      new Set(
        messages
          .map((m) => m.attachment_item_id)
          .filter((id): id is string => !!id && !requestedItemIdsRef.current.has(id)),
      ),
    );
    if (!pending.length) return;
    for (const id of pending) requestedItemIdsRef.current.add(id);
    previewsControllerRef.current ??= new AbortController();
    const signal = previewsControllerRef.current.signal;
    fetchDmItemPreviews(pending, signal)
      .catch(() => null)
      .then((result) => {
        if (signal.aborted) return;
        if (!result) {
          for (const id of pending) requestedItemIdsRef.current.delete(id);
          return;
        }
        setItemPreviews((prev) => {
          const next = new Map(prev);
          result.forEach((state, id) => next.set(id, state));
          return next;
        });
      });
  }, [messages]);

  useEffect(() => () => previewsControllerRef.current?.abort(), []);

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
    if (!convId || !currentUserId) return;
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
      const [{ data, error }, peerRes] = await Promise.all([
        supabase
          .from('messages')
          .select(MESSAGE_COLUMNS)
          .eq('conversation_id', convId)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .abortSignal(signal),
        // Peer read cursor rides the same poll — no Realtime (see the
        // polling effect below). Checked before the messages "unchanged"
        // early-return, since a read update arrives without any new rows.
        supabase
          .from('conversation_participants')
          .select('last_read_at')
          .eq('conversation_id', convId)
          .neq('user_id', currentUserId)
          .abortSignal(signal)
          .maybeSingle(),
      ]);

      // Single caller/single controller here, so checking the signal
      // directly (rather than comparing controller identity, as the
      // multi-controller screens in this codebase do) is sufficient to
      // discard a stale result.
      if (signal.aborted) return;

      if (peerRes.error) {
        if (__DEV__) console.error('[Conversation] peer read refresh failed:', peerRes.error.message);
      } else {
        const nextPeerReadAt = (peerRes.data as { last_read_at: string | null } | null)?.last_read_at ?? null;
        setPeerReadAt((prev) => (prev === nextPeerReadAt ? prev : nextPeerReadAt));
      }

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
          .update({ last_read_at: readCursorFor(fetched) })
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
            .select('user_id, last_read_at')
            .eq('conversation_id', convId)
            .neq('user_id', currentUserId)
            .abortSignal(controller.signal)
            .single(),
          supabase
            .from('messages')
            .select(MESSAGE_COLUMNS)
            .eq('conversation_id', convId)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .abortSignal(controller.signal),
        ]);

        if (loadControllerRef.current !== controller || controller.signal.aborted) return;

        const otherUserId = (participantRes.data as any)?.user_id;
        setPeerReadAt((participantRes.data as any)?.last_read_at ?? null);
        if (otherUserId) {
          const { data: profileData } = await supabase
            .from('profiles')
            .select('id, username, display_name, avatar_url')
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
          .update({ last_read_at: readCursorFor(loadedMessages) })
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

    // conversations.last_message_at is maintained server-side by the
    // messages_bump_conversation_last_message_at trigger (AFTER INSERT ON
    // public.messages) — this used to also be set here client-side, but a
    // plain client-clock assignment isn't guaranteed >= the trigger's
    // GREATEST(last_message_at, NEW.created_at) value, so a second client
    // write here could regress it. Removed; the trigger is the sole writer.

    // Keep sender's last_read_at current so their own send doesn't show as
    // unread (shared with Item Detail → Send in DM — see lib/dm-send.ts).
    if (convId && currentUserId) stampSenderReadCursor(convId, currentUserId, message.created_at);

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

  // The actual durable-write attempt for one logical send — callable both
  // for a fresh Send tap (handleSend) and an explicit retry of a still-
  // pending sendId (handleRetryPendingSend). Both callers pass the
  // identical (sendId, body) for a given logical send so a retry that lands
  // on an already-committed row surfaces as a genuine primary-key conflict,
  // not a coincidence. sendingRef/sending always release in `finally`,
  // independent of whether the logical send itself resolved — an
  // unresolved send lives on in pendingSend after this returns.
  //
  // attachment (optional): a live item reference — the server's
  // enforce_message_attachment_visibility trigger rejects it with
  // item_not_shareable if the sender or recipient can't view that item — or
  // an image ALREADY uploaded to this message's deterministic path (see
  // handleSendImage).
  //
  // Resolves to the logical send's outcome — ignored by the text path, used
  // by the Share Item picker to decide whether to close. Ambiguous writes
  // (23505 / status 0 / 5xx / thrown) are reconciled by id inside
  // writeDmMessage.
  async function performSend(
    sendId: string,
    body: string | null,
    attachment: DmAttachmentInput | null = null,
  ): Promise<SendOutcome> {
    if (!currentUserId || !convId || sendingRef.current) return 'skipped';
    sendingRef.current = true;
    setSending(true);
    setInFlight({
      id: sendId,
      sender_id: currentUserId,
      body,
      created_at: new Date().toISOString(),
      ...attachmentColumns(attachment),
    });
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);

    try {
      // Insert + ambiguous-outcome reconciliation + error classification
      // live in lib/dm-send.ts (shared with Item Detail → Send in DM).
      const result = await writeDmMessage({
        id: sendId,
        conversationId: convId,
        senderId: currentUserId,
        body,
        attachment,
      });
      switch (result.kind) {
        case 'committed':
          finalizeSentMessage(result.message);
          setPendingSend(null);
          return 'sent';
        case 'unknown':
          // The same sendId/body must survive in pendingSend for an explicit
          // retry rather than being discarded or guessed at.
          setPendingSend({ id: sendId, body, attachment });
          return 'pending';
        default:
          // absent / not_shareable / rejected — definitively not committed.
          setNewMessage(body ?? '');
          setPendingSend(null);
          return result.kind === 'not_shareable' ? 'not_shareable' : 'failed';
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
      setInFlight(null);
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
    performSend(pendingSend.id, pendingSend.body, pendingSend.attachment);
  }

  // Item attachment send from the Share Item picker. The composer draft (if
  // any) rides along as the message text. Unlike the text path, the draft
  // is left in the composer until the outcome is known: cleared on success
  // (or when the send is held as pending — it lives in pendingSend then, and
  // leaving it in the composer would invite a duplicate), kept on failure.
  async function handleSendItem(itemId: string): Promise<SendOutcome> {
    if (!currentUserId || !convId || sendingRef.current || pendingSend) return 'skipped';
    const body = newMessage.trim() || null;
    const outcome = await performSend(Crypto.randomUUID(), body, { type: 'item', itemId });
    if (outcome === 'sent' || outcome === 'pending') setNewMessage('');
    return outcome;
  }

  // Photo send (Camera/Photos → PhotoConfirmSheet). `messageId` is owned by
  // the confirm sheet and REUSED across its retries, so every attempt of one
  // logical send targets the same deterministic object
  // (<conversation>/<message>/image.jpg) and the same message row:
  //   1. upload (idempotent — "already exists" from an earlier attempt is OK)
  //   2. insert via performSend → writeDmMessage (reconciles ambiguity by id)
  //   3. definitive failure → best-effort object cleanup
  //      ambiguous ('pending') → never delete; the row may have committed
  // Draft handling matches handleSendItem: cleared only on sent/pending.
  async function handleSendImage(image: PreparedDmImage, messageId: string): Promise<SendOutcome> {
    if (!currentUserId || !convId || sendingRef.current || pendingSend) return 'skipped';
    const storagePath = dmImagePath(convId, messageId);
    try {
      await uploadDmImage(storagePath, image.uri);
    } catch (e) {
      if (__DEV__) console.error('[Conversation] photo upload failed:', e);
      return 'failed';
    }
    const body = newMessage.trim() || null;
    const outcome = await performSend(messageId, body, {
      type: 'image',
      storagePath,
      width: image.width,
      height: image.height,
    });
    if (outcome === 'failed') removeDmImage(storagePath);
    if (outcome === 'sent' || outcome === 'pending') setNewMessage('');
    return outcome;
  }

  function openItemPicker() {
    setAttachOpen(false);
    setItemPickerOpen(true);
  }

  // Launches the native camera or library picker (one still image), then
  // prepares it (JPEG, ≤2048px long edge) for the shared confirm sheet.
  // Cancelling the picker just returns to the conversation — the composer
  // draft is never touched on any of these paths.
  async function launchPhotoSource(source: PhotoSource) {
    setAttachOpen(false);
    let result: ImagePicker.ImagePickerResult;
    try {
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setPhotoFlow({ status: 'camera_denied' });
          return;
        }
        result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false });
      } else {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: false,
          quality: 1,
          exif: false,
        });
      }
    } catch (e) {
      if (__DEV__) console.error('[Conversation] photo picker failed:', e);
      setPhotoFlow({ status: 'prepare_failed', source });
      return;
    }
    if (result.canceled || !result.assets.length) return;

    const asset = result.assets[0];
    setPhotoFlow({ status: 'preparing', source });
    try {
      const image = await prepareDmImage(asset.uri, asset.width, asset.height);
      setPhotoFlow({ status: 'ready', source, image });
    } catch (e) {
      if (__DEV__) console.error('[Conversation] photo prepare failed:', e);
      setPhotoFlow({ status: 'prepare_failed', source });
    }
  }

  // Close the confirm sheet first, then relaunch the same source once its
  // dismiss has started (a native picker can't present over a closing sheet).
  function chooseAnotherPhoto(source: PhotoSource) {
    setPhotoFlow(null);
    setTimeout(() => launchPhotoSource(source), 400);
  }

  // Opening the sheet dismisses the keyboard (the composer — and the sheet
  // anchored to it — settles above the nav); the draft in newMessage is
  // never touched by opening or closing it.
  function toggleAttachSheet() {
    if (attachOpen) {
      setAttachOpen(false);
      return;
    }
    Keyboard.dismiss();
    setAttachOpen(true);
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

  // Truthful static subtitle — no presence data exists, so never "Active
  // recently". @handle when the title is a distinct display name; otherwise
  // a plain context label.
  const knownUsername = otherUser?.username ?? (paramUsername ? String(paramUsername) : null);
  const headerSubtitle =
    knownUsername && displayTitle !== knownUsername ? `@${knownUsername}` : 'CacheCase collector';

  // In-flight placeholder appended for display only, and dropped as soon as
  // the durable row with the same id is in `messages`.
  const sendingId = inFlight && !messages.some((m) => m.id === inFlight.id) ? inFlight.id : null;
  const displayMessages = sendingId && inFlight ? [...messages, inFlight] : messages;
  // Status shows on my newest outgoing message only — earlier ones are
  // implied by it (a read cursor covers everything before it).
  let lastOwnId: string | null = null;
  for (let i = displayMessages.length - 1; i >= 0; i--) {
    if (displayMessages[i].sender_id === currentUserId) {
      lastOwnId = displayMessages[i].id;
      break;
    }
  }
  const peerReadMs = peerReadAt ? Date.parse(peerReadAt) : null;

  const header = (
    <ConversationHeader
      title={displayTitle}
      subtitle={headerSubtitle}
      avatarUrl={otherUser?.avatar_url}
      topInset={insets.top}
    />
  );

  // Static, non-animated ambient layer — a single gradient, so it costs
  // nothing during scroll and sits well below text contrast.
  const ambient = (
    <LinearGradient
      pointerEvents="none"
      colors={['rgba(154,140,255,0)', 'rgba(154,140,255,0)', 'rgba(154,140,255,0.12)']}
      locations={[0, 0.45, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 0.8, y: 1 }}
      style={StyleSheet.absoluteFill}
    />
  );

  if (loading) {
    return (
      <View style={styles.container}>
        {ambient}
        {header}
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {ambient}
      {/* Header lives inside the KeyboardAvoidingView, which now starts at
          the very top of the screen (native header hidden) — so no
          keyboardVerticalOffset is needed; the list shrinks, the header
          stays put. */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}>
        {header}
        <FlatList
          ref={flatListRef}
          style={styles.flex}
          data={displayMessages}
          extraData={`${peerReadAt ?? ''}|${sendingId ?? ''}|${itemPreviews.size}`}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          renderItem={({ item, index }) => {
            // Presentation-only neighbour checks over the already-ordered
            // list — no data/grouping model changes.
            const prev = index > 0 ? displayMessages[index - 1] : undefined;
            const next = index < displayMessages.length - 1 ? displayMessages[index + 1] : undefined;
            const startsDay = !prev || !isSameDay(prev.created_at, item.created_at);
            const continuesRun = !startsDay && prev?.sender_id === item.sender_id;
            const endsRun =
              !next || next.sender_id !== item.sender_id || !isSameDay(next.created_at, item.created_at);
            const isOwn = item.sender_id === currentUserId;
            // Only states the backend can back: no delivery tracking exists,
            // so there is no "Delivered".
            let status: string | undefined;
            let statusRead = false;
            if (isOwn && item.id === lastOwnId) {
              if (item.id === sendingId) {
                status = 'Sending…';
              } else if (peerReadMs !== null && peerReadMs >= Date.parse(item.created_at)) {
                status = 'Read';
                statusRead = true;
              } else {
                status = 'Sent';
              }
            }
            return (
              <>
                {startsDay ? (
                  <Text style={styles.daySeparator}>{formatDayLabel(item.created_at)}</Text>
                ) : null}
                <MessageBubble
                  body={item.body}
                  attachment={
                    item.attachment_type === 'image' ? (
                      <DmImageAttachment
                        storagePath={item.attachment_storage_path}
                        width={item.attachment_width}
                        height={item.attachment_height}
                        onOpen={setViewerUri}
                      />
                    ) : item.attachment_type === 'item' ? (
                      <DmItemAttachmentCard
                        state={
                          item.attachment_item_id
                            ? (itemPreviews.get(item.attachment_item_id) ?? { status: 'loading' })
                            : { status: 'unavailable' }
                        }
                        onOpenItem={(itemId) => router.push({ pathname: '/item/[id]', params: { id: itemId } })}
                        onOpenOwner={(ownerId, username) =>
                          navigateToProfile(router, currentUserId, ownerId, username)
                        }
                      />
                    ) : null
                  }
                  time={formatBubbleTime(item.created_at)}
                  isOwn={isOwn}
                  status={status}
                  statusRead={statusRead}
                  showAvatar={!isOwn && endsRun}
                  continuesRun={continuesRun}
                  avatarUrl={otherUser?.avatar_url}
                  avatarName={displayTitle}
                />
              </>
            );
          }}
          contentContainerStyle={styles.messageList}
          ListFooterComponent={
            peerTyping ? <TypingIndicator avatarUrl={otherUser?.avatar_url} name={displayTitle} /> : null
          }
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

        {/* Tap-outside-to-dismiss for the attachment sheet. Rendered before
            the composer wrapper so the composer and sheet stay above it. */}
        {attachOpen ? (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setAttachOpen(false)}
            accessibilityLabel="Close attachment menu"
          />
        ) : null}

        {/* Composer — extra bottom clearance (TAB_BAR_CLEARANCE) only while
            the keyboard is closed, so it sits above the floating tab bar
            instead of underneath its touch-absorbing surface. See
            TAB_BAR_CLEARANCE's comment. With the keyboard open the home
            indicator is covered, so only a small gap is kept. */}
        <View>
          {attachOpen ? (
            <AttachmentSheet
              onClose={() => setAttachOpen(false)}
              onShareItem={openItemPicker}
              onCamera={() => launchPhotoSource('camera')}
              onPhotos={() => launchPhotoSource('library')}
            />
          ) : null}
          <ConversationComposer
          value={newMessage}
          onChangeText={(text) => {
            setNewMessage(text);
            notifyLocalInput(text);
          }}
          onSend={() => {
            stopLocalTyping();
            handleSend();
          }}
          sending={sending}
          locked={sending || !!pendingSend}
          bottomPadding={keyboardVisible ? 8 : Math.max(insets.bottom, 8) + TAB_BAR_CLEARANCE}
          onAttachPress={toggleAttachSheet}
          attachActive={attachOpen}
          onInputFocus={() => setAttachOpen(false)}
        />
        </View>
      </KeyboardAvoidingView>

      <PhotoConfirmSheet
        state={photoFlow}
        onClose={() => setPhotoFlow(null)}
        onChooseAnother={chooseAnotherPhoto}
        recipientUsername={otherUser?.username ?? (paramUsername ? String(paramUsername) : null)}
        draft={newMessage}
        onSend={handleSendImage}
      />

      <ItemPhotoViewerModal visible={!!viewerUri} uri={viewerUri ?? undefined} onClose={() => setViewerUri(null)} />

      <ShareItemPicker
        visible={itemPickerOpen}
        onClose={() => setItemPickerOpen(false)}
        recipientUsername={otherUser?.username ?? (paramUsername ? String(paramUsername) : null)}
        draft={newMessage}
        onSend={handleSendItem}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: CHAT.bg,
  },
  flex: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageList: {
    flexGrow: 1,
    paddingTop: 4,
    paddingBottom: 12,
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
  daySeparator: {
    alignSelf: 'center',
    marginTop: 18,
    marginBottom: 2,
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.2,
    color: CHAT.separator,
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
});
