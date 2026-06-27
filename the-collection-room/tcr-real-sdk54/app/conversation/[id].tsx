import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import { useMessageBadgeRefresh } from '@/lib/message-badge-context';
import { supabase } from '@/lib/supabase';

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

  const [otherUser, setOtherUser] = useState<OtherUser | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const flatListRef = useRef<FlatList<Message>>(null);

  const loadMessages = useCallback(async () => {
    if (!convId) return;
    const { data } = await supabase
      .from('messages')
      .select('id, sender_id, body, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true });
    setMessages((data ?? []) as Message[]);
  }, [convId]);

  useEffect(() => {
    if (!convId || !currentUserId) return;

    async function load() {
      setLoading(true);

      // Parallel: find the other participant + load messages
      const [participantRes, messagesRes] = await Promise.all([
        supabase
          .from('conversation_participants')
          .select('user_id')
          .eq('conversation_id', convId)
          .neq('user_id', currentUserId)
          .single(),
        supabase
          .from('messages')
          .select('id, sender_id, body, created_at')
          .eq('conversation_id', convId)
          .order('created_at', { ascending: true }),
      ]);

      const otherUserId = (participantRes.data as any)?.user_id;
      if (otherUserId) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('id, username, display_name')
          .eq('id', otherUserId)
          .single();
        if (profileData) setOtherUser(profileData as OtherUser);
      }

      const loadedMessages = (messagesRes.data ?? []) as Message[];
      setMessages(loadedMessages);
      setLoading(false);

      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 50);

      // Mark this conversation as read and update the tab badge
      supabase
        .from('conversation_participants')
        .update({ last_read_at: new Date().toISOString() })
        .eq('conversation_id', convId)
        .eq('user_id', currentUserId)
        .then(({ error: e }) => {
          if (e) console.error('last_read_at stamp failed:', e.message);
          else refreshMessageBadge();
        });
    }

    load();
  }, [convId, currentUserId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadMessages();
    setRefreshing(false);
  }, [loadMessages]);

  async function handleSend() {
    if (!currentUserId || !newMessage.trim() || !convId || sending) return;
    setSending(true);
    const body = newMessage.trim();
    setNewMessage('');

    const { data: msgData, error } = await supabase
      .from('messages')
      .insert({ conversation_id: convId, sender_id: currentUserId, body })
      .select('id, sender_id, body, created_at')
      .single();

    if (error) {
      console.error('Send failed:', error.message);
      setNewMessage(body);
      setSending(false);
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

    setSending(false);
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
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
      <Stack.Screen options={{ title: displayTitle, headerBackTitle: '' }} />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}>
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <MessageBubble message={item} isOwn={item.sender_id === currentUserId} />
          )}
          contentContainerStyle={styles.messageList}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>No messages yet. Say hi!</Text>
            </View>
          }
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#0a7ea4" />
          }
        />

        <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
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
