import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import * as Crypto from 'expo-crypto';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatAvatar } from '@/components/conversation/chat-avatar';
import { CHAT } from '@/components/conversation/conversation-theme';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { type Recipient, RecipientList } from '@/components/share/recipient-list';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAuth } from '@/lib/auth';
import { sendItemAttachment } from '@/lib/dm-send';
import { supabase } from '@/lib/supabase';

type Props = {
  visible: boolean;
  onClose: () => void;
  // Called after a successful send when the user taps View Conversation.
  onViewConversation: (conversationId: string, recipient: Recipient) => void;
  itemId: string;
  // Already-resolved preview (Item Detail signs its own carousel images —
  // this sheet never re-fetches or re-signs anything, same contract as
  // ItemShareSheet).
  imageUri?: string;
  title: string;
  subtitleLines: (string | null)[];
};

type Step = 'pick' | 'confirm' | 'sent';

// Item Detail → Share → Send in DM. Recipient (recent conversations or user
// search) → compact confirmation with optional message → send → "Sent to
// @x" with View Conversation / Done. The conversation is resolved only at
// send time via the existing get_or_create_conversation RPC (concurrency-
// safe per pair, never duplicates), so cancelling never leaves an empty
// conversation behind. The write itself is lib/dm-send.ts — the same path
// the in-conversation Share Item picker uses — and the optional message is
// the ordinary DM body.
export function SendItemDmSheet(props: Props) {
  // Same mid-send dismissal guard as ShareItemPicker: no swipe/Back
  // dismissal while a send is in flight (the request is never cancelled).
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const handleBusyChange = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
  };
  const requestClose = () => {
    if (!busyRef.current) props.onClose();
  };

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal={!busy}
      onRequestClose={requestClose}>
      {props.visible ? <SheetBody {...props} onBusyChange={handleBusyChange} /> : null}
    </Modal>
  );
}

function SheetBody({
  onClose,
  onViewConversation,
  itemId,
  imageUri,
  title,
  subtitleLines,
  onBusyChange,
}: Props & { onBusyChange: (busy: boolean) => void }) {
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<Step>('pick');
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentConversationId, setSentConversationId] = useState<string | null>(null);
  const sendingRef = useRef(false);
  // A send whose outcome is unknown (ambiguous write + inconclusive
  // reconciliation) keeps its message id for the retry, so a prior commit
  // surfaces as a reconciled conflict instead of a duplicate. Tied to the
  // recipient it was for; any definitive outcome clears it.
  const unresolvedSendRef = useRef<{ recipientId: string; messageId: string } | null>(null);

  function chooseRecipient(next: Recipient) {
    if (unresolvedSendRef.current && unresolvedSendRef.current.recipientId !== next.id) {
      unresolvedSendRef.current = null;
    }
    setRecipient(next);
    setSendError(null);
    setStep('confirm');
  }

  async function handleSend() {
    if (!recipient || !currentUserId || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    onBusyChange(true);
    setSendError(null);
    try {
      const { data: conversationId, error: convError } = await supabase.rpc('get_or_create_conversation', {
        other_user_id: recipient.id,
      });
      if (convError || !conversationId) {
        if (__DEV__) console.error('[SendItemDmSheet] get_or_create_conversation failed:', convError?.message);
        setSendError('Couldn’t send. Check your connection and try again.');
        return;
      }

      const unresolved = unresolvedSendRef.current;
      const messageId =
        unresolved && unresolved.recipientId === recipient.id ? unresolved.messageId : Crypto.randomUUID();
      const result = await sendItemAttachment({
        id: messageId,
        conversationId: conversationId as string,
        senderId: currentUserId,
        itemId,
        body: message.trim() || null,
      });

      if (result.kind === 'unknown') {
        unresolvedSendRef.current = { recipientId: recipient.id, messageId };
        setSendError('We couldn’t confirm it sent. Try again — it won’t be sent twice.');
        return;
      }
      unresolvedSendRef.current = null;
      if (result.kind === 'committed') {
        setSentConversationId(conversationId as string);
        setStep('sent');
      } else if (result.kind === 'not_shareable') {
        setSendError('This item can’t be shared right now.');
      } else {
        setSendError('Couldn’t send. Check your connection and try again.');
      }
    } catch (e) {
      if (__DEV__) console.error('[SendItemDmSheet] send threw:', e);
      setSendError('Couldn’t send. Check your connection and try again.');
    } finally {
      sendingRef.current = false;
      setSending(false);
      onBusyChange(false);
    }
  }

  const [subtitle, detail] = subtitleLines.filter(Boolean) as string[];

  // ── Sent ────────────────────────────────────────────────────────────────
  if (step === 'sent' && recipient && sentConversationId) {
    return (
      <View style={[styles.screen, styles.sentScreen, { paddingBottom: insets.bottom + 20 }]}>
        <View style={styles.sentBody}>
          <View style={styles.sentIcon}>
            <IconSymbol name="checkmark" size={28} color={CHAT.onAccent} />
          </View>
          <Text style={styles.sentTitle}>Sent to @{recipient.username}</Text>
          <Text style={styles.sentSubtitle} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <Pressable
          onPress={() => onViewConversation(sentConversationId, recipient)}
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          accessibilityRole="button">
          <Text style={styles.primaryText}>View Conversation</Text>
        </Pressable>
        <Pressable
          onPress={onClose}
          style={({ pressed }) => [styles.neutralBtn, pressed && styles.pressed]}
          accessibilityRole="button">
          <Text style={styles.neutralText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  // ── Confirm ─────────────────────────────────────────────────────────────
  if (step === 'confirm' && recipient) {
    return (
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}>
        <Header
          title="Send Item"
          subtitle="Review and send"
          onCancel={onClose}
          cancelDisabled={sending}
        />
        <ScrollView
          contentContainerStyle={[styles.confirmContent, { paddingBottom: insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled">
          <View style={styles.itemRow}>
            <View style={styles.itemThumb}>
              {imageUri ? (
                <Image source={{ uri: imageUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
              ) : null}
            </View>
            <View style={styles.itemText}>
              <Text style={styles.itemTitle} numberOfLines={1}>
                {title}
              </Text>
              {!!subtitle && (
                <Text style={styles.itemSubtitle} numberOfLines={1}>
                  {subtitle}
                </Text>
              )}
              {!!detail && (
                <Text style={styles.itemSubtitle} numberOfLines={1}>
                  {detail}
                </Text>
              )}
            </View>
          </View>

          <Text style={styles.sectionLabel}>Send to</Text>
          <View style={styles.recipientCard}>
            <ChatAvatar uri={recipient.avatarUrl} name={recipient.displayName || recipient.username} size={40} />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {recipient.displayName || recipient.username}
              </Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                @{recipient.username}
              </Text>
            </View>
          </View>

          <TextInput
            style={styles.messageInput}
            value={message}
            onChangeText={setMessage}
            placeholder="Add a message (optional)"
            placeholderTextColor={PV2.textTertiary}
            selectionColor={CHAT.accent}
            editable={!sending}
            multiline
            maxLength={1000}
          />

          {sendError ? (
            <Text style={styles.sendError} accessibilityLiveRegion="polite">
              {sendError}
            </Text>
          ) : null}

          <Pressable
            onPress={handleSend}
            disabled={sending}
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed, sending && styles.busy]}
            accessibilityRole="button"
            accessibilityState={{ busy: sending }}
            accessibilityLabel={`Send item to ${recipient.username}`}>
            {sending ? (
              <ActivityIndicator color={CHAT.onAccent} />
            ) : (
              <Text style={styles.primaryText}>{sendError ? 'Try Again' : 'Send Item'}</Text>
            )}
          </Pressable>
          <View style={styles.secondaryRow}>
            <Pressable
              onPress={() => {
                setSendError(null);
                setStep('pick');
              }}
              disabled={sending}
              style={({ pressed }) => [styles.neutralBtn, styles.flex, pressed && styles.pressed]}
              accessibilityRole="button">
              <Text style={styles.neutralText}>Change Recipient</Text>
            </Pressable>
            <Pressable
              onPress={onClose}
              disabled={sending}
              style={({ pressed }) => [styles.neutralBtn, styles.flex, pressed && styles.pressed]}
              accessibilityRole="button">
              <Text style={styles.neutralText}>Cancel</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── Pick recipient ──────────────────────────────────────────────────────
  return (
    <View style={styles.screen}>
      <Header title="Send Item" subtitle="Choose someone" onCancel={onClose} />
      <RecipientList currentUserId={currentUserId} onSelect={chooseRecipient} bottomInset={insets.bottom} />
    </View>
  );
}

function Header({
  title,
  subtitle,
  onCancel,
  cancelDisabled,
}: {
  title: string;
  subtitle: string;
  onCancel: () => void;
  cancelDisabled?: boolean;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onCancel}
        disabled={cancelDisabled}
        hitSlop={10}
        accessibilityRole="button"
        style={styles.headerSide}>
        <Text style={[styles.headerCancel, cancelDisabled && styles.disabledText]}>Cancel</Text>
      </Pressable>
      <View style={styles.headerCenter}>
        <Text style={styles.headerTitle}>{title}</Text>
        <Text style={styles.headerSubtitle}>{subtitle}</Text>
      </View>
      <View style={styles.headerSide} />
    </View>
  );
}

// Same palette/treatments as the in-conversation Share Item picker
// (components/conversation/share-item-picker.tsx): PV2 surfaces and text,
// item-share-sheet row/button shapes, brand accent for the primary action.
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  headerSide: {
    width: 64,
  },
  headerCancel: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  disabledText: {
    opacity: 0.4,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  headerSubtitle: {
    fontSize: 13,
    color: PV2.textSecondary,
    marginTop: 2,
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
  confirmContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 22,
  },
  itemThumb: {
    width: 60,
    height: 80,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  itemText: {
    flex: 1,
    gap: 2,
  },
  itemTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  itemSubtitle: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  recipientCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  messageInput: {
    marginTop: 16,
    minHeight: 72,
    maxHeight: 140,
    fontSize: 16,
    color: PV2.textPrimary,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    padding: 12,
    textAlignVertical: 'top',
  },
  sendError: {
    fontSize: 13,
    color: PV2.textPrimary,
    marginTop: 12,
  },
  primaryBtn: {
    marginTop: 16,
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: CHAT.accent,
  },
  primaryText: {
    fontSize: 16,
    fontWeight: '700',
    color: CHAT.onAccent,
  },
  busy: {
    opacity: 0.7,
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  neutralBtn: {
    marginTop: 10,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.collectorPanelBg,
  },
  neutralText: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  pressed: {
    opacity: 0.8,
  },
  sentScreen: {
    paddingHorizontal: 20,
    justifyContent: 'flex-end',
  },
  sentBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  sentIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: CHAT.accent,
    marginBottom: 10,
  },
  sentTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  sentSubtitle: {
    fontSize: 14,
    color: PV2.textSecondary,
  },
});
