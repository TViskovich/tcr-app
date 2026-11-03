import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatAvatar } from '@/components/conversation/chat-avatar';
import { CHAT } from '@/components/conversation/conversation-theme';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { type Recipient, RecipientList } from '@/components/share/recipient-list';
import { accountErrorMessage } from '@/lib/account-errors';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAuth } from '@/lib/auth';
import {
  checkGroupMessaging,
  createGroupConversation,
  GROUP_MAX_MEMBERS,
  GROUP_NAME_MAX,
  groupMessagingAvailable,
} from '@/lib/group-chat';
import { supabase } from '@/lib/supabase';

type Props = {
  visible: boolean;
  onClose: () => void;
  // recipient: the person for a 1:1 conversation; null for a new group.
  onOpenConversation: (conversationId: string, recipient: Recipient | null) => void;
};

// The most people a creator can pick (the group's cap, minus themself).
const MAX_PICKED = GROUP_MAX_MEMBERS - 1;

// Inbox → New Message. Same "Choose someone" list as Item Detail → Send in
// DM (RecipientList), with no item attached: picking a person resolves the
// 1:1 conversation through the existing get_or_create_conversation RPC
// (returns the existing one if any — concurrency-safe per pair, never a
// duplicate) and hands it back to open /conversation/[id].
//
// "New Group" switches to picking two or more people, then a details step
// (optional name, members) that creates the group through
// create_group_conversation (lib/group-chat.ts) — the creator is its admin.
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

type Step = 'direct' | 'pickGroup' | 'groupDetails';

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

  const [step, setStep] = useState<Step>('direct');
  // New Group: who's picked, in the order they were picked.
  const [picked, setPicked] = useState<Recipient[]>([]);
  const pickedIds = useMemo(() => new Set(picked.map((r) => r.id)), [picked]);
  const [groupName, setGroupName] = useState('');
  // New Group shows only once the database is known to support groups. The
  // inbox behind this sheet usually settled that already; an empty inbox
  // never queries a group column, so check here when it's still unknown.
  const [groupsAvailable, setGroupsAvailable] = useState(groupMessagingAvailable);
  useEffect(() => {
    if (groupsAvailable) return;
    let cancelled = false;
    void checkGroupMessaging().then((available) => {
      if (!cancelled && available) setGroupsAvailable(true);
    });
    return () => {
      cancelled = true;
    };
  }, [groupsAvailable]);

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
        setError(accountErrorMessage(rpcError) ?? 'Couldn’t start the conversation. Please try again.');
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

  function togglePicked(recipient: Recipient) {
    setError(null);
    if (pickedIds.has(recipient.id)) {
      setPicked((prev) => prev.filter((r) => r.id !== recipient.id));
    } else if (picked.length >= MAX_PICKED) {
      setError(`Groups can have up to ${GROUP_MAX_MEMBERS} people, including you.`);
    } else {
      setPicked((prev) => [...prev, recipient]);
    }
  }

  function goTo(next: Step) {
    setError(null);
    if (next === 'direct') {
      setPicked([]);
      setGroupName('');
    }
    setStep(next);
  }

  async function handleCreateGroup() {
    if (openingRef.current || picked.length < 2) return;
    openingRef.current = true;
    setOpening(true);
    onBusyChange(true);
    setError(null);
    const result = await createGroupConversation(
      picked.map((r) => r.id),
      groupName.trim() || null,
    );
    openingRef.current = false;
    setOpening(false);
    onBusyChange(false);
    if (result.ok) onOpenConversation(result.value, null);
    else setError(result.message);
  }

  const header =
    step === 'direct' ? (
      <View style={styles.header}>
        <Pressable onPress={onClose} disabled={opening} hitSlop={10} accessibilityRole="button" style={styles.headerSide}>
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
    ) : (
      <View style={styles.header}>
        <Pressable
          onPress={() => goTo(step === 'groupDetails' ? 'pickGroup' : 'direct')}
          disabled={opening}
          hitSlop={10}
          accessibilityRole="button"
          style={styles.headerSide}>
          <Text style={[styles.headerCancel, opening && styles.disabled]}>Back</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>New Group</Text>
          <Text style={styles.headerSubtitle}>
            {step === 'groupDetails'
              ? `${picked.length + 1} people`
              : picked.length < 2
                ? 'Choose at least 2 people'
                : `${picked.length} selected`}
          </Text>
        </View>
        <View style={[styles.headerSide, styles.headerRight]}>
          {opening ? (
            <ActivityIndicator color={PV2.textSecondary} />
          ) : step === 'pickGroup' ? (
            <Pressable
              onPress={() => goTo('groupDetails')}
              disabled={picked.length < 2}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityState={{ disabled: picked.length < 2 }}>
              <Text style={[styles.headerAction, picked.length < 2 && styles.disabled]}>Next</Text>
            </Pressable>
          ) : (
            <Pressable onPress={handleCreateGroup} hitSlop={10} accessibilityRole="button">
              <Text style={styles.headerAction}>Create</Text>
            </Pressable>
          )}
        </View>
      </View>
    );

  const errorLine = error ? (
    <Text style={styles.error} accessibilityLiveRegion="polite">
      {error}
    </Text>
  ) : null;

  if (step === 'groupDetails') {
    const trimmedLength = groupName.trim().length;
    return (
      <View style={styles.screen}>
        {header}
        {errorLine}
        <ScrollView
          contentContainerStyle={[styles.details, { paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled">
          <Text style={styles.sectionLabel}>Group name</Text>
          <TextInput
            style={styles.nameInput}
            value={groupName}
            onChangeText={setGroupName}
            placeholder="Optional"
            placeholderTextColor={PV2.textTertiary}
            selectionColor={CHAT.accent}
            maxLength={GROUP_NAME_MAX}
            editable={!opening}
            returnKeyType="done"
            accessibilityLabel="Group name (optional)"
          />
          <Text style={styles.counter}>
            {trimmedLength}/{GROUP_NAME_MAX} · Without a name, the group is named after its members.
          </Text>

          <Text style={[styles.sectionLabel, styles.membersLabel]}>Members · {picked.length + 1}</Text>
          <View style={styles.memberRow}>
            <View style={styles.youAvatar}>
              <Text style={styles.youInitial}>You</Text>
            </View>
            <Text style={styles.memberName}>You</Text>
            <Text style={styles.roleTag}>Admin</Text>
          </View>
          {picked.map((r) => (
            <View key={r.id} style={styles.memberRow}>
              <ChatAvatar uri={r.avatarUrl} name={r.displayName || r.username} size={36} />
              <View style={styles.memberText}>
                <Text style={styles.memberName} numberOfLines={1}>
                  {r.displayName || r.username}
                </Text>
                <Text style={styles.memberHandle} numberOfLines={1}>
                  @{r.username}
                </Text>
              </View>
              {picked.length > 2 && !opening ? (
                <Pressable
                  onPress={() => togglePicked(r)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${r.displayName || r.username}`}>
                  <IconSymbol name="xmark" size={16} color={PV2.textTertiary} />
                </Pressable>
              ) : null}
            </View>
          ))}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {header}
      {errorLine}
      {step === 'direct' ? (
        // Only once the database is known to support groups (see
        // groupsAvailable above and lib/group-chat.ts).
        groupsAvailable ? (
        <Pressable
          onPress={() => goTo('pickGroup')}
          disabled={opening}
          style={({ pressed }) => [styles.newGroupRow, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="New group">
          <View style={styles.newGroupIcon}>
            <IconSymbol name="person.2.fill" size={18} color={PV2.textPrimary} />
          </View>
          <Text style={styles.newGroupText}>New Group</Text>
          <IconSymbol name="chevron.right" size={14} color={PV2.textTertiary} />
        </Pressable>
        ) : null
      ) : picked.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.chipsScroll}
          contentContainerStyle={styles.chips}>
          {picked.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => togglePicked(r)}
              style={styles.chip}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${r.displayName || r.username}`}>
              <Text style={styles.chipText} numberOfLines={1}>
                {r.displayName || r.username}
              </Text>
              <IconSymbol name="xmark" size={11} color={PV2.textSecondary} />
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <RecipientList
        currentUserId={currentUserId}
        onSelect={step === 'direct' ? handleSelect : togglePicked}
        bottomInset={insets.bottom}
        disabled={opening}
        selectedIds={step === 'pickGroup' ? pickedIds : undefined}
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
  headerAction: {
    fontSize: 16,
    fontWeight: '700',
    color: CHAT.accent,
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
  pressed: {
    opacity: 0.8,
  },
  newGroupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 8,
  },
  newGroupIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  newGroupText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  chipsScroll: {
    flexGrow: 0,
    marginBottom: 8,
  },
  chips: {
    gap: 8,
    paddingHorizontal: 16,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 180,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: CHAT.accentSoft,
    borderWidth: 1,
    borderColor: CHAT.accentBorder,
  },
  chipText: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  details: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: PV2.textSecondary,
    marginBottom: 8,
  },
  membersLabel: {
    marginTop: 24,
  },
  nameInput: {
    fontSize: 16,
    color: PV2.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: PV2.collectorPanelBg,
  },
  counter: {
    marginTop: 6,
    fontSize: 12,
    color: PV2.textTertiary,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  youAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  youInitial: {
    fontSize: 11,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  memberText: {
    flex: 1,
    gap: 1,
  },
  memberName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  memberHandle: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  roleTag: {
    fontSize: 12,
    fontWeight: '600',
    color: PV2.textTertiary,
  },
});
