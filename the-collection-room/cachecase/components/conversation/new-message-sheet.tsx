import { useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { type Recipient, RecipientList } from '@/components/share/recipient-list';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

type Props = {
  visible: boolean;
  onClose: () => void;
  onOpenConversation: (conversationId: string, recipient: Recipient) => void;
};

// Inbox → New Message. Same "Choose someone" list as Item Detail → Send in
// DM (RecipientList), with no item attached: picking a person resolves the
// 1:1 conversation through the existing get_or_create_conversation RPC
// (returns the existing one if any — concurrency-safe per pair, never a
// duplicate) and hands it back to open /conversation/[id].
export function NewMessageSheet({ visible, onClose, onOpenConversation }: Props) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const requestClose = () => {
    if (!busyRef.current) onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal={!busy}
      onRequestClose={requestClose}>
      {visible ? (
        <SheetBody
          onClose={onClose}
          onOpenConversation={onOpenConversation}
          onBusyChange={(next) => {
            busyRef.current = next;
            setBusy(next);
          }}
        />
      ) : null}
    </Modal>
  );
}

function SheetBody({
  onClose,
  onOpenConversation,
  onBusyChange,
}: Omit<Props, 'visible'> & { onBusyChange: (busy: boolean) => void }) {
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const insets = useSafeAreaInsets();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openingRef = useRef(false);

  async function handleSelect(recipient: Recipient) {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    onBusyChange(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_or_create_conversation', {
        other_user_id: recipient.id,
      });
      if (rpcError || !data) {
        if (__DEV__) console.error('[NewMessageSheet] get_or_create_conversation failed:', rpcError?.message);
        setError('Couldn’t start the conversation. Please try again.');
        return;
      }
      onOpenConversation(data as string, recipient);
    } catch (e) {
      if (__DEV__) console.error('[NewMessageSheet] unexpected error:', e);
      setError('Couldn’t start the conversation. Please try again.');
    } finally {
      openingRef.current = false;
      setOpening(false);
      onBusyChange(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          onPress={onClose}
          disabled={opening}
          hitSlop={10}
          accessibilityRole="button"
          style={styles.headerSide}>
          <Text style={[styles.headerCancel, opening && styles.disabled]}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>New Message</Text>
          <Text style={styles.headerSubtitle}>Choose someone</Text>
        </View>
        <View style={[styles.headerSide, styles.headerRight]}>
          {opening ? <ActivityIndicator color={PV2.textSecondary} /> : null}
        </View>
      </View>
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      <RecipientList
        currentUserId={currentUserId}
        onSelect={handleSelect}
        bottomInset={insets.bottom}
        disabled={opening}
      />
    </View>
  );
}

// Same header treatment as the Share Item / Send Item sheets.
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: PV2.bg,
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
  headerRight: {
    alignItems: 'flex-end',
  },
  headerCancel: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  disabled: {
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
  error: {
    fontSize: 13,
    color: PV2.textPrimary,
    marginHorizontal: 16,
    marginBottom: 8,
  },
});
