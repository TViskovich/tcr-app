import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { RealtimeChannel } from '@supabase/supabase-js';
import { useFocusEffect } from 'expo-router';

import { supabase } from '@/lib/supabase';

// While the local user keeps typing, typing=true is re-broadcast at most this
// often — never per keystroke. Must stay comfortably below PEER_EXPIRY_MS so
// an active typist's indicator never flickers off between refreshes.
const REFRESH_INTERVAL_MS = 2000;
// No text change for this long → typing=false.
const LOCAL_IDLE_MS = 2000;
// Safety expiry on the receiving side: a typing=true not refreshed within
// this window is dropped even if typing=false never arrives (sender force-
// closed, lost connection, backgrounded mid-word).
const PEER_EXPIRY_MS = 3500;

type TypingPayload = {
  userId: string;
  conversationId: string;
  isTyping: boolean;
};

type Options = {
  convId: string | undefined;
  currentUserId: string | undefined;
  // The other participant (from conversation_participants). Events from any
  // other sender id are ignored — until it's known, all events are ignored.
  otherUserId: string | undefined;
};

// Conversation-scoped, ephemeral typing state over Supabase Realtime
// Broadcast — no table, no rows, no publication changes. The channel is
// joined only while this conversation screen is focused (so a second
// stacked instance of the same conversation can't steal it) and left on
// blur/unmount, sending a final typing=false first.
//
// Topic is a public broadcast channel keyed by the conversation UUID: the
// payload carries no message content, and receivers only act on events from
// the known other participant. Restricting who may JOIN the topic would need
// a private channel + RLS policy on realtime.messages (a migration) — not
// done here.
export function useConversationTyping({ convId, currentUserId, otherUserId }: Options) {
  const [peerTyping, setPeerTyping] = useState(false);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const subscribedRef = useRef(false);
  const localTypingRef = useRef(false);
  const lastSentAtRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peerExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside the broadcast handler, which is bound once per subscription —
  // a ref so a late-arriving otherUserId is still honoured without
  // resubscribing.
  const otherUserIdRef = useRef(otherUserId);
  useEffect(() => {
    otherUserIdRef.current = otherUserId;
  }, [otherUserId]);

  const broadcast = useCallback(
    (isTyping: boolean) => {
      const channel = channelRef.current;
      // Only over a joined socket — send() on an unjoined channel silently
      // falls back to a REST POST, which isn't wanted for a throwaway signal.
      if (!channel || !subscribedRef.current || !convId || !currentUserId) return;
      const payload: TypingPayload = { userId: currentUserId, conversationId: convId, isTyping };
      channel.send({ type: 'broadcast', event: 'typing', payload }).catch(() => {});
    },
    [convId, currentUserId],
  );

  const stopLocalTyping = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (localTypingRef.current) {
      localTypingRef.current = false;
      lastSentAtRef.current = 0;
      broadcast(false);
    }
  }, [broadcast]);

  // Called from the composer's onChangeText with the new draft text.
  const notifyLocalInput = useCallback(
    (text: string) => {
      if (!text.trim()) {
        stopLocalTyping();
        return;
      }
      const now = Date.now();
      if (!localTypingRef.current || now - lastSentAtRef.current >= REFRESH_INTERVAL_MS) {
        localTypingRef.current = true;
        lastSentAtRef.current = now;
        broadcast(true);
      }
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(stopLocalTyping, LOCAL_IDLE_MS);
    },
    [broadcast, stopLocalTyping],
  );

  const clearPeerTyping = useCallback(() => {
    if (peerExpiryRef.current) {
      clearTimeout(peerExpiryRef.current);
      peerExpiryRef.current = null;
    }
    setPeerTyping(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!convId || !currentUserId) return;

      const topic = `dm:${convId}:typing`;
      let cancelled = false;
      let channel: RealtimeChannel | null = null;

      const handleTyping = ({ payload }: { payload: TypingPayload }) => {
        if (!payload || payload.conversationId !== convId) return;
        if (payload.userId === currentUserId) return;
        if (!otherUserIdRef.current || payload.userId !== otherUserIdRef.current) return;
        if (payload.isTyping) {
          setPeerTyping(true);
          if (peerExpiryRef.current) clearTimeout(peerExpiryRef.current);
          peerExpiryRef.current = setTimeout(() => {
            peerExpiryRef.current = null;
            setPeerTyping(false);
          }, PEER_EXPIRY_MS);
        } else {
          clearPeerTyping();
        }
      };

      (async () => {
        // supabase.channel(topic) returns any existing channel with the same
        // topic — including one still mid-leave from a quick blur→refocus,
        // which subscribe() would then silently skip. Wait for any such
        // leftover to finish leaving before creating a fresh one.
        const stale = supabase.getChannels().find((c) => c.topic === `realtime:${topic}`);
        if (stale) await supabase.removeChannel(stale);
        if (cancelled) return;

        channel = supabase.channel(topic, { config: { broadcast: { self: false, ack: false } } });
        channelRef.current = channel;
        channel
          .on('broadcast', { event: 'typing' }, handleTyping)
          .subscribe((status) => {
            subscribedRef.current = status === 'SUBSCRIBED';
          });
      })();

      // Backgrounding mid-draft counts as stopping — the peer's expiry would
      // clear it anyway, this just makes it immediate when possible.
      const appStateSub = AppState.addEventListener('change', (next) => {
        if (next !== 'active') stopLocalTyping();
      });

      return () => {
        cancelled = true;
        appStateSub.remove();
        // Final typing=false goes out over the still-joined channel before
        // the leave is pushed.
        stopLocalTyping();
        clearPeerTyping();
        subscribedRef.current = false;
        channelRef.current = null;
        if (channel) supabase.removeChannel(channel);
      };
    }, [convId, currentUserId, stopLocalTyping, clearPeerTyping]),
  );

  return { peerTyping, notifyLocalInput, stopLocalTyping };
}
