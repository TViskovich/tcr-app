import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { HeaderBackButton } from '@react-navigation/elements';
import { uuid } from 'expo-modules-core';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
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
  const router = useRouter();
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
  function handleBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)/messages');
  }

  const headerBackLeft = () => <HeaderBackButton onPress={handleBack} displayMode="minimal" />;

  // Only caller is onRefresh below, which always supplies a signal from its
  // own controller — see that controller's comment for why.
  const loadMessages = useCallback(async (signal: AbortSignal) => {
    if (!convId) return;
    const { data } = await supabase
      .from('messages')
      .select('id, sender_id, body, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .abortSignal(signal);
    // Single caller/single controller here, so checking the signal directly
    // (rather than comparing controller identity, as the multi-controller
    // screens in this codebase do) is sufficient to discard a stale result.
    if (signal.aborted) return;
    setMessages((data ?? []) as Message[]);
  }, [convId]);

  useEffect(() => {
    if (!convId || !currentUserId) return;

    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;

    async function load() {
      setLoading(true);

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

    // Update last_message_at so inbox sorts correctly — fire and forget
    supabase
      .from('conversations')
      .update({ last_message_at: now })
      .eq('id', convId)
      .then(({ error: e }) => {
        if (e) console.error('last_message_at update failed:', e.message);
      });

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

    // Notify the other user of the new message (fire and forget). Safe to
    // run unconditionally here: the finalizedSendIdsRef guard above already
    // made this function body exactly-once for message.id within this JS
    // runtime — a rapid second Retry/reconciliation FOUND for the same id
    // returns before reaching this point.
    if (otherUser) {
      supabase.from('notifications').insert({
        user_id: otherUser.id,
        actor_id: currentUserId,
        type: 'message',
        conversation_id: convId,
      }).then(({ error: e }) => { if (e) console.error('Message notif failed:', e.message); });
    }

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
    const sendId = uuid.v4();
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
          <ActivityIndicator size="large" color="#0a7ea4" />
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
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#0a7ea4" />
          }
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
                <ActivityIndicator size="small" color="#0a7ea4" />
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
            placeholderTextColor="#999"
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
              <ActivityIndicator size="small" color="#0a7ea4" />
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
    backgroundColor: '#f8f9fa',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8f9fa',
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
    color: '#687076',
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
    backgroundColor: '#e9ecef',
    borderBottomLeftRadius: 4,
  },
  bubbleOwn: {
    backgroundColor: '#0a7ea4',
    borderBottomRightRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    color: '#11181C',
    lineHeight: 20,
  },
  bubbleTextOwn: {
    color: '#fff',
  },
  bubbleTime: {
    fontSize: 10,
    color: '#aaa',
    marginTop: 2,
    marginHorizontal: 4,
  },
  // Pending-send banner
  pendingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#fff3e0',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
    gap: 8,
  },
  pendingBannerText: {
    flex: 1,
    fontSize: 13,
    color: '#8a5a00',
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
    color: '#0a7ea4',
  },
  // Input bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
    backgroundColor: '#fff',
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#11181C',
    backgroundColor: '#f5f5f5',
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
    color: '#0a7ea4',
  },
  sendTextDisabled: {
    color: '#ccc',
  },
});
