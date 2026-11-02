import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatAvatar } from '@/components/conversation/chat-avatar';
import { CHAT } from '@/components/conversation/conversation-theme';
import { GroupAvatar } from '@/components/conversation/group-avatar';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { type Recipient, RecipientList } from '@/components/share/recipient-list';
import { BackButton } from '@/components/ui/back-button';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAuth } from '@/lib/auth';
import {
  addGroupMembers,
  type ConversationMember,
  type ConversationMeta,
  GROUP_MAX_MEMBERS,
  GROUP_NAME_MAX,
  groupTitle,
  leaveGroup,
  loadConversationMeta,
  memberName,
  removeGroupMember,
  renameGroup,
} from '@/lib/group-chat';
import { navigateToProfile } from '@/lib/profile-navigation';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

// Group Info — opened from a group conversation's header. Shows the group
// and its members; admins can rename, add and remove people; everyone can
// leave. Every action is a server function (lib/group-chat.ts) that checks
// the caller's role itself — the admin-only controls here are only what the
// server would allow anyway, never the safeguard.
export default function GroupInfoScreen() {
  const { id: conversationId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;

  // undefined = loading; null = not available to this user.
  const [meta, setMeta] = useState<ConversationMeta | null | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!conversationId) return;
      try {
        const next = await loadConversationMeta(conversationId, signal);
        if (signal?.aborted) return;
        setMeta(next && next.kind === 'group' ? next : null);
        setLoadFailed(false);
      } catch {
        if (signal?.aborted) return;
        setLoadFailed(true);
      }
    },
    [conversationId],
  );

  // Fresh on every visit (and on returning from a member's profile).
  useFocusEffect(
    useCallback(() => {
      const controller = new AbortController();
      void reload(controller.signal);
      return () => controller.abort();
    }, [reload]),
  );

  const me = meta?.members.find((m) => m.id === currentUserId) ?? null;
  const isAdmin = me?.role === 'admin';
  const others = useMemo(() => (meta?.members ?? []).filter((m) => m.id !== currentUserId), [meta, currentUserId]);
  const memberIds = useMemo(() => new Set((meta?.members ?? []).map((m) => m.id)), [meta]);
  const title = meta ? groupTitle(meta.name, meta.members, currentUserId) : 'Group';

  // Runs one server action at a time; reloads afterwards; shows the
  // server's reason when it refuses.
  async function run(action: () => Promise<{ ok: true } | { ok: false; message: string }>, failureTitle: string) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) {
        Alert.alert(failureTitle, result.message);
        await reload();
        return false;
      }
      await reload();
      return true;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function saveName() {
    if (!conversationId) return;
    const ok = await run(() => renameGroup(conversationId, nameDraft), 'Couldn’t rename the group');
    if (ok) setEditingName(false);
  }

  function confirmRemove(member: ConversationMember) {
    if (!conversationId) return;
    Alert.alert(
      `Remove ${memberName(member)}?`,
      'They’ll lose access to this conversation and its message history.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => void run(() => removeGroupMember(conversationId, member.id), 'Couldn’t remove them'),
        },
      ],
    );
  }

  function confirmLeave() {
    if (!conversationId || !meta) return;
    // Mirrors the server's succession: the longest-standing other member
    // (members are loaded in joined order).
    const otherAdmins = others.filter((m) => m.role === 'admin');
    const successor = isAdmin && otherAdmins.length === 0 ? others[0] : undefined;
    const lines = ['You’ll lose access to this conversation and its message history.'];
    if (others.length === 0) lines.push('You’re the last member, so the group will be deleted.');
    else if (successor) lines.push(`${memberName(successor)} will become the group admin.`);
    Alert.alert(`Leave ${title}?`, lines.join('\n\n'), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave Group',
        style: 'destructive',
        onPress: async () => {
          if (busyRef.current) return;
          busyRef.current = true;
          setBusy(true);
          const result = await leaveGroup(conversationId);
          busyRef.current = false;
          setBusy(false);
          if (!result.ok) {
            Alert.alert('Couldn’t leave the group', result.message);
            return;
          }
          // Out of both this screen and the conversation behind it.
          if (router.canDismiss()) router.dismiss(2);
          else router.replace('/(tabs)/messages');
        },
      },
    ]);
  }

  const bottomPadding = TAB_BAR_HEIGHT + insets.bottom + 24;

  let body: React.ReactNode;
  if (meta === undefined && !loadFailed) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={PV2.textSecondary} />
      </View>
    );
  } else if (loadFailed && !meta) {
    body = (
      <View style={styles.center}>
        <Text style={styles.stateTitle}>Couldn’t load this group</Text>
        <Pressable onPress={() => void reload()} style={styles.retryButton} accessibilityRole="button">
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  } else if (!meta || !me) {
    body = (
      <View style={styles.center}>
        <Text style={styles.stateTitle}>This group isn’t available</Text>
        <Text style={styles.stateBody}>You may have left or been removed from it, or it no longer exists.</Text>
      </View>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPadding }]} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <GroupAvatar names={others.map(memberName)} size={72} />
          {editingName ? (
            <View style={styles.renameBlock}>
              <TextInput
                style={styles.nameInput}
                value={nameDraft}
                onChangeText={setNameDraft}
                placeholder="Group name (blank to use members’ names)"
                placeholderTextColor={PV2.textTertiary}
                selectionColor={CHAT.accent}
                maxLength={GROUP_NAME_MAX}
                autoFocus
                editable={!busy}
                returnKeyType="done"
                onSubmitEditing={saveName}
                accessibilityLabel="Group name"
              />
              <View style={styles.renameActions}>
                <Pressable onPress={() => setEditingName(false)} disabled={busy} hitSlop={8} accessibilityRole="button">
                  <Text style={styles.secondaryAction}>Cancel</Text>
                </Pressable>
                <Pressable onPress={saveName} disabled={busy} hitSlop={8} accessibilityRole="button">
                  <Text style={styles.primaryAction}>Save</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.titleRow}>
              <Text style={styles.title} numberOfLines={2}>
                {title}
              </Text>
              {isAdmin ? (
                <Pressable
                  onPress={() => {
                    setNameDraft(meta.name ?? '');
                    setEditingName(true);
                  }}
                  disabled={busy}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Rename group">
                  <IconSymbol name="pencil" size={16} color={PV2.textSecondary} />
                </Pressable>
              ) : null}
            </View>
          )}
          <Text style={styles.subtitle}>
            {meta.members.length} {meta.members.length === 1 ? 'member' : 'members'}
          </Text>
        </View>

        {isAdmin ? (
          <Pressable
            onPress={() => setAddOpen(true)}
            disabled={busy || meta.members.length >= GROUP_MAX_MEMBERS}
            style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}
            accessibilityRole="button">
            <View style={styles.actionIcon}>
              <IconSymbol name="person.badge.plus" size={18} color={PV2.textPrimary} />
            </View>
            <Text style={[styles.actionText, meta.members.length >= GROUP_MAX_MEMBERS && styles.disabled]}>
              {meta.members.length >= GROUP_MAX_MEMBERS ? `Group is full (${GROUP_MAX_MEMBERS})` : 'Add Members'}
            </Text>
          </Pressable>
        ) : null}

        <Text style={styles.sectionLabel}>Members</Text>
        {meta.members.map((member) => {
          const isMe = member.id === currentUserId;
          return (
            <View key={member.id} style={styles.memberRow}>
              <Pressable
                style={({ pressed }) => [styles.memberMain, pressed && styles.pressed]}
                onPress={() => navigateToProfile(router, currentUserId, member.id, member.username)}
                accessibilityRole="button"
                accessibilityLabel={`${memberName(member)}${member.role === 'admin' ? ', admin' : ''}${isMe ? ', you' : ''}`}
                accessibilityHint="Opens their profile">
                <ChatAvatar uri={member.avatarUrl} name={memberName(member)} size={40} />
                <View style={styles.memberText}>
                  <Text style={styles.memberName} numberOfLines={1}>
                    {memberName(member)}
                    {isMe ? <Text style={styles.youTag}> · You</Text> : null}
                  </Text>
                  <Text style={styles.memberHandle} numberOfLines={1}>
                    @{member.username}
                  </Text>
                </View>
                {member.role === 'admin' ? (
                  <View style={styles.adminBadge}>
                    <Text style={styles.adminBadgeText}>Admin</Text>
                  </View>
                ) : null}
              </Pressable>
              {isAdmin && !isMe ? (
                <Pressable
                  onPress={() => confirmRemove(member)}
                  disabled={busy}
                  hitSlop={8}
                  style={styles.removeButton}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${memberName(member)}`}>
                  <Text style={styles.removeText}>Remove</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}

        <Pressable
          onPress={confirmLeave}
          disabled={busy}
          style={({ pressed }) => [styles.leaveButton, pressed && styles.pressed]}
          accessibilityRole="button">
          <Text style={styles.leaveText}>Leave Group</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <BackButton fallbackHref="/(tabs)/messages" size={22} />
        <Text style={styles.headerTitle}>Group Info</Text>
        <View style={styles.headerSide}>{busy ? <ActivityIndicator color={PV2.textSecondary} /> : null}</View>
      </View>
      {body}
      {meta && conversationId ? (
        <AddMembersSheet
          visible={addOpen}
          conversationId={conversationId}
          memberIds={memberIds}
          remaining={GROUP_MAX_MEMBERS - meta.members.length}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            void reload();
          }}
        />
      ) : null}
    </View>
  );
}

// Admin → Add Members: the same "Choose someone" list in multi-select,
// without anyone already in the group, up to the space left.
function AddMembersSheet({
  visible,
  conversationId,
  memberIds,
  remaining,
  onClose,
  onAdded,
}: {
  visible: boolean;
  conversationId: string;
  memberIds: ReadonlySet<string>;
  remaining: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const [picked, setPicked] = useState<Recipient[]>([]);
  const pickedIds = useMemo(() => new Set(picked.map((r) => r.id)), [picked]);
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (addingRef.current) return;
    setPicked([]);
    setError(null);
    onClose();
  }

  function toggle(recipient: Recipient) {
    setError(null);
    if (pickedIds.has(recipient.id)) setPicked((prev) => prev.filter((r) => r.id !== recipient.id));
    else if (picked.length >= remaining) setError(`This group can take ${remaining} more ${remaining === 1 ? 'person' : 'people'}.`);
    else setPicked((prev) => [...prev, recipient]);
  }

  async function add() {
    if (addingRef.current || picked.length === 0) return;
    addingRef.current = true;
    setAdding(true);
    setError(null);
    const result = await addGroupMembers(
      conversationId,
      picked.map((r) => r.id),
    );
    addingRef.current = false;
    setAdding(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPicked([]);
    onAdded();
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal={!adding}
      onRequestClose={close}>
      <View style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <Pressable onPress={close} disabled={adding} hitSlop={10} accessibilityRole="button" style={styles.sheetSide}>
            <Text style={[styles.secondaryAction, adding && styles.disabled]}>Cancel</Text>
          </Pressable>
          <View style={styles.sheetCenter}>
            <Text style={styles.sheetTitle}>Add Members</Text>
            <Text style={styles.sheetSubtitle}>
              {picked.length > 0 ? `${picked.length} selected` : `Up to ${remaining} more`}
            </Text>
          </View>
          <View style={[styles.sheetSide, styles.sheetRight]}>
            {adding ? (
              <ActivityIndicator color={PV2.textSecondary} />
            ) : (
              <Pressable
                onPress={add}
                disabled={picked.length === 0}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityState={{ disabled: picked.length === 0 }}>
                <Text style={[styles.primaryAction, picked.length === 0 && styles.disabled]}>Add</Text>
              </Pressable>
            )}
          </View>
        </View>
        {error ? (
          <Text style={styles.sheetError} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
        <RecipientList
          currentUserId={session?.user?.id}
          onSelect={toggle}
          bottomInset={insets.bottom}
          disabled={adding}
          selectedIds={pickedIds}
          excludeIds={memberIds}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  headerSide: {
    width: 32,
    alignItems: 'flex-end',
  },
  content: {
    paddingHorizontal: 16,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  stateTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  stateBody: {
    marginTop: 8,
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  retryText: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  hero: {
    alignItems: 'center',
    paddingVertical: 20,
    gap: 10,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
  },
  title: {
    flexShrink: 1,
    fontSize: 22,
    fontWeight: '700',
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: PV2.textSecondary,
  },
  renameBlock: {
    alignSelf: 'stretch',
    gap: 8,
  },
  nameInput: {
    fontSize: 16,
    color: PV2.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: PV2.collectorPanelBg,
  },
  renameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 20,
  },
  primaryAction: {
    fontSize: 16,
    fontWeight: '700',
    color: CHAT.accent,
  },
  secondaryAction: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.8,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  actionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  actionText: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  sectionLabel: {
    marginTop: 18,
    marginBottom: 6,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: PV2.textSecondary,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  memberMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 9,
  },
  memberText: {
    flex: 1,
    gap: 1,
  },
  memberName: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  youTag: {
    fontWeight: '400',
    color: PV2.textTertiary,
  },
  memberHandle: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  adminBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: CHAT.accentSoft,
    borderWidth: 1,
    borderColor: CHAT.accentBorder,
  },
  adminBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  removeButton: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  removeText: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.accent,
  },
  leaveButton: {
    marginTop: 28,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  leaveText: {
    fontSize: 16,
    fontWeight: '700',
    color: PV2.accent,
  },
  sheet: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  sheetSide: {
    width: 64,
  },
  sheetRight: {
    alignItems: 'flex-end',
  },
  sheetCenter: {
    flex: 1,
    alignItems: 'center',
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  sheetSubtitle: {
    fontSize: 13,
    color: PV2.textSecondary,
    marginTop: 2,
  },
  sheetError: {
    fontSize: 13,
    color: PV2.textPrimary,
    marginHorizontal: 16,
    marginBottom: 8,
  },
});
