import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatAvatar } from '@/components/conversation/chat-avatar';
import { CHAT } from '@/components/conversation/conversation-theme';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { type Recipient, RecipientList } from '@/components/share/recipient-list';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAuth } from '@/lib/auth';
import {
  addTags,
  isMissingTagTable,
  loadTags,
  removeTag,
  TAG_LIMIT,
  type TaggedCollector,
  type TagTarget,
} from '@/lib/content-tags';

type Props = {
  visible: boolean;
  // The item or collection being tagged; its owner and name.
  target: TagTarget;
  ownerId: string | null | undefined;
  contentTitle: string;
  onClose: () => void;
};

// Item Detail / Collection Detail → Tag. One sheet for both: who is tagged
// in this item/collection, and — for its owner — tagging more collectors
// (the same "Choose someone" search as New Message / Add Members:
// RecipientList, multi-select) and removing tags. A tagged collector can
// remove their own tag; everyone else sees a read-only list. The database
// decides all of it (lib/content-tags.ts); this only reflects it.
export function CollectorTagSheet({ visible, onClose, ...rest }: Props) {
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
          {...rest}
          onClose={requestClose}
          onBusyChange={(next) => {
            busyRef.current = next;
            setBusy(next);
          }}
        />
      ) : null}
    </Modal>
  );
}

type LoadState = 'loading' | 'ready' | 'failed' | 'unavailable';

function SheetBody({
  target: targetProp,
  ownerId,
  contentTitle,
  onClose,
  onBusyChange,
}: Omit<Props, 'visible'> & { onBusyChange: (busy: boolean) => void }) {
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const insets = useSafeAreaInsets();
  const isOwner = !!currentUserId && currentUserId === ownerId;
  // Callers pass a fresh object each render; only its kind/id matter.
  const target = useMemo<TagTarget>(() => ({ kind: targetProp.kind, id: targetProp.id }), [targetProp.kind, targetProp.id]);

  const [tags, setTags] = useState<TaggedCollector[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'list' | 'pick'>('list');
  const [picked, setPicked] = useState<Recipient[]>([]);
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await loadTags(target, signal);
        if (signal?.aborted) return;
        setTags(next);
        setLoadState('ready');
      } catch (e) {
        if (signal?.aborted) return;
        setLoadState(isMissingTagTable(e as { code?: string; message?: string }) ? 'unavailable' : 'failed');
      }
    },
    [target],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadTags(target, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setTags(next);
        setLoadState('ready');
      })
      .catch((e: { code?: string; message?: string }) => {
        if (controller.signal.aborted) return;
        setLoadState(isMissingTagTable(e) ? 'unavailable' : 'failed');
      });
    return () => controller.abort();
  }, [target]);

  // One write at a time; the list is reloaded after each so it always shows
  // what the server holds.
  async function run(action: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    if (workingRef.current) return false;
    workingRef.current = true;
    setWorking(true);
    onBusyChange(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) setError(result.message);
      await reload();
      return result.ok;
    } finally {
      workingRef.current = false;
      setWorking(false);
      onBusyChange(false);
    }
  }

  const taggedIds = useMemo(() => new Set(tags.map((t) => t.id)), [tags]);
  const excludeIds = useMemo(() => {
    const ids = new Set(taggedIds);
    if (ownerId) ids.add(ownerId);
    return ids;
  }, [taggedIds, ownerId]);
  const pickedIds = useMemo(() => new Set(picked.map((r) => r.id)), [picked]);
  const remaining = Math.max(0, TAG_LIMIT - tags.length);
  const kindLabel = target.kind === 'item' ? 'item' : 'collection';

  function togglePicked(r: Recipient) {
    setError(null);
    if (pickedIds.has(r.id)) {
      setPicked((prev) => prev.filter((p) => p.id !== r.id));
      return;
    }
    if (r.id === currentUserId) {
      setError('You can’t tag yourself.');
      return;
    }
    if (picked.length >= remaining) {
      setError(
        remaining === 0
          ? `Up to ${TAG_LIMIT} collectors can be tagged.`
          : `You can tag ${remaining} more ${remaining === 1 ? 'collector' : 'collectors'}.`,
      );
      return;
    }
    setPicked((prev) => [...prev, r]);
  }

  async function handleAdd() {
    const ok = await run(() => addTags(target, picked.map((r) => r.id)));
    if (ok) {
      setPicked([]);
      setStep('list');
    }
  }

  function goTo(next: 'list' | 'pick') {
    setError(null);
    if (next === 'list') setPicked([]);
    setStep(next);
  }

  const errorLine = error ? (
    <Text style={styles.error} accessibilityLiveRegion="polite">
      {error}
    </Text>
  ) : null;

  if (step === 'pick') {
    return (
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={() => goTo('list')} disabled={working} hitSlop={10} accessibilityRole="button" style={styles.headerSide}>
            <Text style={[styles.headerCancel, working && styles.disabled]}>Back</Text>
          </Pressable>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Tag Collectors</Text>
            <Text style={styles.headerSubtitle}>
              {picked.length > 0 ? `${picked.length} selected` : `Up to ${remaining} more`}
            </Text>
          </View>
          <View style={[styles.headerSide, styles.headerRight]}>
            {working ? (
              <ActivityIndicator color={PV2.textSecondary} />
            ) : (
              <Pressable
                onPress={handleAdd}
                disabled={picked.length === 0}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityState={{ disabled: picked.length === 0 }}>
                <Text style={[styles.headerAction, picked.length === 0 && styles.disabled]}>Tag</Text>
              </Pressable>
            )}
          </View>
        </View>
        {errorLine}
        {picked.length > 0 ? (
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
          onSelect={togglePicked}
          bottomInset={insets.bottom}
          disabled={working}
          selectedIds={pickedIds}
          excludeIds={excludeIds}
          purpose="tag"
        />
      </View>
    );
  }

  let body: React.ReactNode;
  if (loadState === 'loading') {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={PV2.textSecondary} />
      </View>
    );
  } else if (loadState === 'unavailable') {
    body = (
      <View style={styles.center}>
        <Text style={styles.stateTitle}>Tagging isn’t available yet</Text>
      </View>
    );
  } else if (loadState === 'failed') {
    body = (
      <View style={styles.center}>
        <Text style={styles.stateTitle}>Couldn’t load tags</Text>
        <Pressable
          onPress={() => {
            setLoadState('loading');
            void reload();
          }}
          style={styles.retryButton}
          accessibilityRole="button">
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  } else if (tags.length === 0) {
    body = (
      <View style={styles.center}>
        <Text style={styles.stateTitle}>No one is tagged yet</Text>
        {isOwner ? <Text style={styles.stateBody}>Tag collectors to show this {kindLabel} on their profile.</Text> : null}
      </View>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}>
        {tags.map((t) => {
          const isMe = t.id === currentUserId;
          const name = t.displayName?.trim() || t.username;
          const canRemove = isOwner || isMe;
          return (
            <View key={t.id} style={styles.row} accessibilityLabel={`${name}${isMe ? ', you' : ''}`}>
              <ChatAvatar uri={t.avatarUrl} name={name} size={40} />
              <View style={styles.rowText}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {name}
                  {isMe ? <Text style={styles.youTag}> · You</Text> : null}
                </Text>
                <Text style={styles.rowHandle} numberOfLines={1}>
                  @{t.username}
                </Text>
              </View>
              {canRemove ? (
                <Pressable
                  onPress={() => void run(() => removeTag(target, t.id))}
                  disabled={working}
                  hitSlop={8}
                  style={styles.removeButton}
                  accessibilityRole="button"
                  accessibilityLabel={isMe && !isOwner ? 'Remove my tag' : `Remove ${name}`}>
                  <Text style={[styles.removeText, working && styles.disabled]}>{isMe && !isOwner ? 'Remove Me' : 'Remove'}</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
        {isOwner ? (
          <Text style={styles.counter}>
            {tags.length}/{TAG_LIMIT} tagged
          </Text>
        ) : null}
      </ScrollView>
    );
  }

  const canAdd = isOwner && loadState === 'ready' && remaining > 0;
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onClose} disabled={working} hitSlop={10} accessibilityRole="button" style={styles.headerSide}>
          <Text style={[styles.headerCancel, working && styles.disabled]}>Done</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Tagged</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {contentTitle}
          </Text>
        </View>
        <View style={[styles.headerSide, styles.headerRight]}>
          {working ? (
            <ActivityIndicator color={PV2.textSecondary} />
          ) : isOwner && loadState === 'ready' ? (
            <Pressable
              onPress={() => goTo('pick')}
              disabled={!canAdd}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Tag collectors"
              accessibilityState={{ disabled: !canAdd }}>
              <Text style={[styles.headerAction, !canAdd && styles.disabled]}>Add</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {errorLine}
      {isOwner && loadState === 'ready' && remaining === 0 ? (
        <Text style={styles.note}>This {kindLabel} has the maximum of {TAG_LIMIT} tagged collectors.</Text>
      ) : null}
      {body}
    </View>
  );
}

// Same header/chip/row treatment as the New Message and Group Info sheets.
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
  note: {
    fontSize: 13,
    color: PV2.textSecondary,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingBottom: 80,
    gap: 8,
  },
  stateTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  stateBody: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 8,
    paddingHorizontal: 16,
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
  list: {
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  rowText: {
    flex: 1,
    gap: 1,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  youTag: {
    fontWeight: '400',
    color: PV2.textSecondary,
  },
  rowHandle: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  removeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  removeText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  counter: {
    marginTop: 12,
    fontSize: 12,
    color: PV2.textTertiary,
    textAlign: 'center',
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
});
