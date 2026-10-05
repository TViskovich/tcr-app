import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CHAT } from '@/components/conversation/conversation-theme';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { type CollectionItemWithFolderVisibility, useAllItems } from '@/hooks/use-collection';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { compactItemIdentity, ITEM_TYPE_LABEL } from '@/lib/dm-attachments';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';
import type { CollectibleItemType } from '@/types';

const COLUMNS = 2;
const GRID_GAP = 12;
const GRID_PADDING = 16;
// Shorter than a full 3:4 card slot so two-up tiles don't run tall; the
// image is cover-cropped like every other grid thumbnail.
const TILE_ASPECT = 1.1;
const SKELETON_TILES = 6;

type SendOutcome = 'sent' | 'failed' | 'not_shareable' | 'pending' | 'skipped';

type Props = {
  visible: boolean;
  onClose: () => void;
  recipientUsername: string | null;
  // Composer draft, shown in the confirmation so it's clear it rides along.
  draft: string;
  // Sends the chosen item through the existing DM attachment pipeline.
  onSend: (itemId: string) => Promise<SendOutcome>;
};

// Same effective-visibility approximation as app/share-card/new.tsx's
// isPubliclyShareable: item.is_public AND its own folder's is_public. The
// server's enforce_message_attachment_visibility trigger stays authoritative
// (it also walks ancestor folders and checks the actual recipient) — this
// only filters out the items that would obviously be rejected.
function isShareable(item: CollectionItemWithFolderVisibility) {
  return item.is_public && item.folder_is_public;
}

// "Share Item" picker for DMs — one item from the signed-in user's own
// active collection (useAllItems: own items only, collection_status =
// 'active', so transferred-out items never appear). Tap to select, confirm
// in the bottom panel, then Send. Native page sheet on iOS (swipe down to
// dismiss); nothing here touches the composer draft.
export function ShareItemPicker({ visible, onClose, recipientUsername, draft, onSend }: Props) {
  // True while a send is in flight. Blocks every dismissal path so a swipe
  // can't look like it cancelled a send that then completes anyway:
  // allowSwipeDismissal={false} keeps the iOS sheet in place (RN routes the
  // attempt to onRequestClose), and onRequestClose — also Android Back — is
  // ignored until the send resolves. The request itself is never cancelled.
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const handleBusyChange = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
  };
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
      {/* Mounted only while visible, so the collection loads fresh per open
          and selection/search reset each time. */}
      {visible ? (
        <PickerBody
          onClose={onClose}
          recipientUsername={recipientUsername}
          draft={draft}
          onSend={onSend}
          onBusyChange={handleBusyChange}
        />
      ) : null}
    </Modal>
  );
}

function PickerBody({
  onClose,
  recipientUsername,
  draft,
  onSend,
  onBusyChange,
}: Omit<Props, 'visible'> & { onBusyChange: (busy: boolean) => void }) {
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const identity = currentUserId ?? 'anon';
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { items, loading, error, refresh } = useAllItems(currentUserId);

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<CollectibleItemType | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Synchronous double-tap guard — `sending` state doesn't commit until the
  // next render, so two taps in the same frame could both pass it.
  const sendingRef = useRef(false);

  // Only items that can plausibly be shared are offered (see isShareable).
  const shareableItems = useMemo(() => items.filter(isShareable), [items]);
  const hiddenPrivateCount = items.length - shareableItems.length;

  const { urls, servedTiers } = useSignedItemImages(
    shareableItems.map((i) => i.primary_image_id),
    COMPACT_IMAGE_TIER,
  );

  // Type chips only when the collection actually spans more than one type.
  const presentTypes = useMemo(
    () => Array.from(new Set(shareableItems.map((i) => i.item_type).filter(Boolean))) as CollectibleItemType[],
    [shareableItems],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return shareableItems.filter((item) => {
      if (typeFilter !== 'all' && item.item_type !== typeFilter) return false;
      if (!q) return true;
      const haystack = [
        item.player,
        item.title,
        item.brand,
        item.team,
        item.year != null ? String(item.year) : null,
        item.item_type ? ITEM_TYPE_LABEL[item.item_type] : null,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [shareableItems, query, typeFilter]);

  const selected = selectedId ? (shareableItems.find((i) => i.id === selectedId) ?? null) : null;
  const tileWidth = (width - GRID_PADDING * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS;

  function select(itemId: string | null) {
    if (sendingRef.current) return;
    setSendError(null);
    setSelectedId(itemId);
  }

  async function handleSend() {
    if (!selected || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    onBusyChange(true);
    setSendError(null);
    const outcome = await onSend(selected.id);
    sendingRef.current = false;
    setSending(false);
    onBusyChange(false);
    if (outcome === 'sent' || outcome === 'pending') {
      onClose();
      return;
    }
    // Failure: picker stays open with the selection intact; the draft was
    // never cleared, so Send Item can simply be tapped again.
    if (outcome === 'not_shareable') setSendError('This item can’t be shared right now.');
    else if (outcome === 'failed') setSendError('Couldn’t send. Check your connection and try again.');
  }

  const showSkeleton = loading && !items.length;
  const showLoadError = !!error && !items.length && !loading;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          onPress={onClose}
          disabled={sending}
          hitSlop={10}
          accessibilityRole="button"
          style={styles.headerSide}>
          <Text style={styles.headerCancel}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Share Item</Text>
          <Text style={styles.headerSubtitle}>Choose from your collection</Text>
        </View>
        <View style={styles.headerSide} />
      </View>

      <View style={styles.searchWrap}>
        <IconSymbol name="magnifyingglass" size={16} color={PV2.textTertiary} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search your collection"
          placeholderTextColor={PV2.textTertiary}
          selectionColor={CHAT.accent}
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {presentTypes.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipsScroll}
          contentContainerStyle={styles.chipsRow}>
          {(['all', ...presentTypes] as const).map((t) => {
            const active = typeFilter === t;
            return (
              <Pressable
                key={t}
                onPress={() => setTypeFilter(t)}
                style={[styles.chip, active && styles.chipActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {t === 'all' ? 'All Items' : ITEM_TYPE_LABEL[t]}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {showSkeleton ? (
        <View style={[styles.grid, styles.skeletonGrid]} accessibilityLabel="Loading your collection">
          {Array.from({ length: SKELETON_TILES }, (_, i) => (
            <View key={i} style={[styles.tile, { width: tileWidth }]}>
              <View style={[styles.thumb, { height: tileWidth * TILE_ASPECT }]} />
              <View style={[styles.skeletonLine, { width: '75%' }]} />
              <View style={[styles.skeletonLine, { width: '50%' }]} />
            </View>
          ))}
        </View>
      ) : showLoadError ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Couldn’t load your collection</Text>
          <Pressable onPress={refresh} style={styles.retryBtn} accessibilityRole="button">
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : !shareableItems.length ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No items to share yet</Text>
          <Text style={styles.emptyText}>
            {hiddenPrivateCount
              ? 'Only public items can be shared. Make an item public to send it.'
              : 'Add an item to your collection first.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          numColumns={COLUMNS}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={[styles.grid, { paddingBottom: (selected ? 300 : 24) + insets.bottom }]}
          extraData={selectedId}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyText}>No items match your search.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <PickerTile
              item={item}
              width={tileWidth}
              selected={item.id === selectedId}
              imageUri={item.primary_image_id ? urls.get(item.primary_image_id) : undefined}
              cacheKey={
                item.primary_image_id
                  ? itemImageCacheKey(identity, item.primary_image_id, COMPACT_IMAGE_TIER, servedTiers)
                  : undefined
              }
              onPress={() => select(item.id === selectedId ? null : item.id)}
            />
          )}
        />
      )}

      {selected ? (
        <View style={[styles.confirm, { paddingBottom: insets.bottom + 14 }]}>
          <View style={styles.confirmRow}>
            <View style={styles.confirmThumb}>
              {selected.primary_image_id && urls.get(selected.primary_image_id) ? (
                <Image
                  source={{
                    uri: urls.get(selected.primary_image_id)!,
                    cacheKey: itemImageCacheKey(identity, selected.primary_image_id, COMPACT_IMAGE_TIER, servedTiers),
                  }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                />
              ) : null}
            </View>
            <View style={styles.confirmText}>
              {(() => {
                const { title, subtitle, detail } = compactItemIdentity(selected);
                return (
                  <>
                    <Text style={styles.confirmTitle} numberOfLines={1}>
                      {title}
                    </Text>
                    {!!subtitle && (
                      <Text style={styles.confirmSubtitle} numberOfLines={1}>
                        {subtitle}
                      </Text>
                    )}
                    {!!detail && (
                      <Text style={styles.confirmSubtitle} numberOfLines={1}>
                        {detail}
                      </Text>
                    )}
                  </>
                );
              })()}
              {recipientUsername ? (
                <Text style={styles.confirmRecipient} numberOfLines={1}>
                  Send to @{recipientUsername}
                </Text>
              ) : null}
            </View>
          </View>
          {draft.trim() ? (
            <Text style={styles.confirmDraft} numberOfLines={2}>
              With your message: “{draft.trim()}”
            </Text>
          ) : null}
          {sendError ? (
            <Text style={styles.sendError} accessibilityLiveRegion="polite">
              {sendError}
            </Text>
          ) : null}
          <Pressable
            onPress={handleSend}
            disabled={sending}
            style={({ pressed }) => [styles.sendBtn, pressed && styles.pressed, sending && styles.sendBtnBusy]}
            accessibilityRole="button"
            accessibilityState={{ busy: sending }}
            accessibilityLabel={recipientUsername ? `Send item to ${recipientUsername}` : 'Send item'}>
            {sending ? (
              <ActivityIndicator color={CHAT.onAccent} />
            ) : (
              <Text style={styles.sendText}>{sendError ? 'Try Again' : 'Send Item'}</Text>
            )}
          </Pressable>
          <View style={styles.secondaryRow}>
            <Pressable
              onPress={() => select(null)}
              disabled={sending}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Change item">
              <Text style={styles.secondaryText}>Change</Text>
            </Pressable>
            <Pressable
              onPress={onClose}
              disabled={sending}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Cancel sharing">
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function PickerTile({
  item,
  width,
  selected,
  imageUri,
  cacheKey,
  onPress,
}: {
  item: CollectionItemWithFolderVisibility;
  width: number;
  selected: boolean;
  imageUri: string | undefined;
  cacheKey: string | undefined;
  onPress: () => void;
}) {
  const { title, subtitle } = compactItemIdentity(item);
  return (
    <Pressable
      onPress={onPress}
      style={[styles.tile, { width }]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}>
      <View style={[styles.thumb, { height: width * TILE_ASPECT }, selected && styles.thumbSelected]}>
        {imageUri ? (
          <Image
            source={{ uri: imageUri, cacheKey }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
          />
        ) : null}
        {selected ? (
          <View style={styles.selectedBadge}>
            <IconSymbol name="checkmark" size={13} color={CHAT.onAccent} />
          </View>
        ) : null}
      </View>
      <Text style={styles.tileTitle} numberOfLines={1}>
        {title}
      </Text>
      {!!subtitle && (
        <Text style={styles.tileSubtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      )}
    </Pressable>
  );
}

// Palette and component treatments reused from the rest of the app, not a
// DM-specific theme: grid tiles/selected border/badges from
// app/share-card/new.tsx, search field from app/(tabs)/search.tsx, header
// from share-card's Cancel/title bar, confirmation panel from
// components/share/item-share-sheet.tsx.
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
  headerCancel: {
    fontSize: 16,
    color: PV2.textSecondary,
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
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: GRID_PADDING,
    marginTop: 4,
    paddingHorizontal: 12,
    backgroundColor: PV2.collectorPanelBg,
    borderRadius: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: PV2.textPrimary,
    paddingVertical: 10,
  },
  chipsScroll: {
    flexGrow: 0,
    marginTop: 10,
  },
  chipsRow: {
    paddingHorizontal: GRID_PADDING,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  chipActive: {
    borderColor: PV2.borderStrong,
    backgroundColor: PV2.panel,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  chipTextActive: {
    color: PV2.textPrimary,
  },
  grid: {
    paddingHorizontal: GRID_PADDING,
    paddingTop: 12,
    flexGrow: 1,
  },
  gridRow: {
    gap: GRID_GAP,
    marginBottom: 14,
  },
  tile: {
    gap: 2,
  },
  thumb: {
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 2,
    borderColor: 'transparent',
    marginBottom: 4,
  },
  thumbSelected: {
    borderColor: CHAT.accent,
  },
  selectedBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: CHAT.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  tileSubtitle: {
    fontSize: 12,
    color: PV2.textSecondary,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  emptyText: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  skeletonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: GRID_GAP,
    rowGap: 14,
    flexGrow: 0,
  },
  skeletonLine: {
    height: 10,
    borderRadius: 5,
    backgroundColor: PV2.collectorPanelBg,
    marginTop: 4,
  },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: PV2.collectorPanelBg,
  },
  retryText: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  confirm: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 16,
    paddingHorizontal: 20,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: PV2.panelBorder,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
    elevation: 12,
  },
  confirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  confirmThumb: {
    width: 54,
    height: 72,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  confirmText: {
    flex: 1,
    gap: 2,
  },
  confirmTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  confirmSubtitle: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  confirmRecipient: {
    fontSize: 13,
    color: PV2.textTertiary,
    marginTop: 2,
  },
  confirmDraft: {
    fontSize: 13,
    color: PV2.textSecondary,
    marginTop: 12,
  },
  // Brand foil accent (CHAT.accent) with dark text; shape matches
  // item-share-sheet's cancel button.
  sendBtn: {
    marginTop: 14,
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: CHAT.accent,
  },
  sendText: {
    fontSize: 16,
    fontWeight: '700',
    color: CHAT.onAccent,
  },
  sendBtnBusy: {
    opacity: 0.7,
  },
  sendError: {
    fontSize: 13,
    color: PV2.textPrimary,
    marginTop: 12,
  },
  pressed: {
    opacity: 0.85,
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  secondaryBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.collectorPanelBg,
  },
  secondaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
});
