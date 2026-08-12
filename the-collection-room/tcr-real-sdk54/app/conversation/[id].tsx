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

  async function handleSend() {
    if (!currentUserId || !newMessage.trim() || !convId || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    const body = newMessage.trim();
    setNewMessage('');

    try {
      const { data: msgData, error } = await supabase
        .from('messages')
        .insert({ conversation_id: convId, sender_id: currentUserId, body })
        .select('id, sender_id, body, created_at')
        .single();

      if (error) {
        console.error('Send failed:', error.message);
        setNewMessage(body);
        return;
      }

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

      setMessages((prev) => [...prev, msgData as Message]);

      // Notify the other user of the new message (fire and forget)
      if (otherUser) {
        supabase.from('notifications').insert({
          user_id: otherUser.id,
          actor_id: currentUserId,
          type: 'message',
          conversation_id: convId,
        }).then(({ error: e }) => { if (e) console.error('Message notif failed:', e.message); });
      }

      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (e) {
      console.error('Send threw:', e);
      setNewMessage(body);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
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
            editable={!sending}
            maxLength={1000}
          />
          <TouchableOpacity
            onPress={handleSend}
            disabled={!newMessage.trim() || sending}
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
