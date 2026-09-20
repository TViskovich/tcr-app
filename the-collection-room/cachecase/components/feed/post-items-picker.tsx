import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useAllItems } from '@/hooks/use-collection';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';

export type PickedPostItem = {
  itemId: string;
  // Already-resolved signed preview URL, captured at selection time — the
  // composer (app/post/new.tsx) uses this directly for its own preview
  // grid, so it never needs to re-run useSignedItemImages itself. The
  // durable, permanent copy only happens later, at actual post time (see
  // lib/share-snapshots.ts's copyShareSnapshotImage), same as the existing
  // Share Card picker's own previewCards convention
  // (app/share-card/new.tsx).
  previewUri: string;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  currentUserId: string | undefined;
  // How many more images this post can still accept — recomputed by the
  // caller every time this opens (4 - however many attachments already
  // exist), not a fixed constant, since a library pick can also have
  // already used up some of the 4-image budget.
  remainingSlots: number;
  onConfirm: (picked: PickedPostItem[]) => void;
};

// "Choose from My Items" step of the post composer's Add Photo flow
// (app/post/new.tsx). Adapts the exact same browse/filter/select logic
// app/share-card/new.tsx already uses for its own 1-5 card picker
// (useAllItems across every folder, batched useSignedItemImages, and the
// same public/private eligibility rule — a post is public feed content,
// so a private card in a private collection is excluded here too, not
// just dimmed) — extracted into its own modal here since that screen's
// own version is inseparable from its full compose-a-card-share-post flow
// (caption, reorder strip, its own posting logic), not a standalone
// reusable component. Selection state is local and resets every time this
// modal opens/closes; the caller only ever learns the final chosen set via
// onConfirm.
export function PostItemsPicker({ visible, onClose, currentUserId, remainingSlots, onConfirm }: Props) {
  // Explicit, not SafeAreaView's own automatic top-edge inset — this
  // Modal is statusBarTranslucent (so its content draws edge-to-edge
  // under the status bar/Dynamic Island by design, for the full-bleed
  // dark background), and SafeAreaView's automatic Modal-inset
  // measurement is unreliable in exactly that combination on iOS (see
  // components/collection/folder-cover-item-picker.tsx for the sibling
  // picker that avoids the bug simply by not using statusBarTranslucent
  // at all). Computing insets.top/bottom directly and applying them as
  // real padding on the container sidesteps that flakiness rather than
  // depending on it.
  const insets = useSafeAreaInsets();
  const { items, loading, error, refresh } = useAllItems(currentUserId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Fresh selection every time the sheet is (re)opened — a leftover
  // selection from a previous open (e.g. the user backed out without
  // confirming) must never silently resurface next time.
  useEffect(() => {
    if (visible) setSelectedIds([]);
  }, [visible]);

  const shareableItems = items.filter((i) => !!i.image_url?.trim());
  const { urls: signedItemImageUrls } = useSignedItemImages(shareableItems.map((i) => i.primary_image_id));

  function isPubliclyShareable(item: (typeof shareableItems)[number]) {
    return item.folder_is_public && item.is_public;
  }

  const hasPrivateItems = shareableItems.some((i) => !isPubliclyShareable(i));

  function toggleSelect(item: (typeof shareableItems)[number]) {
    if (!isPubliclyShareable(item)) return;
    const id = item.id;
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= remainingSlots) return prev;
      return [...prev, id];
    });
  }

  function handleConfirm() {
    const picked: PickedPostItem[] = selectedIds
      .map((id) => {
        const item = shareableItems.find((i) => i.id === id);
        const previewUri = item?.primary_image_id ? signedItemImageUrls.get(item.primary_image_id) : undefined;
        return item && previewUri ? { itemId: item.id, previewUri } : null;
      })
      // An item whose signed URL genuinely hasn't resolved yet by the
      // moment Add is tapped (rare — the batched signing call above fires
      // the instant this list is known) is dropped rather than handed to
      // the composer with no preview image at all.
      .filter((x): x is PickedPostItem => !!x);
    onConfirm(picked);
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          {/* minHeight 44 on the button itself (not just hitSlop) — the
              real Pressable/touch target, not only its label text, is
              what needs to be reliably tappable. hitSlop stays as extra
              margin on top of that, same convention this app's other
              header buttons already use. */}
          <TouchableOpacity onPress={onClose} hitSlop={8} style={styles.headerActionBtn}>
            <Text style={styles.headerCancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>My Items</Text>
          <TouchableOpacity
            onPress={handleConfirm}
            disabled={selectedIds.length === 0}
            hitSlop={8}
            style={[styles.headerActionBtn, styles.headerActionBtnRight]}>
            <Text style={[styles.headerAdd, selectedIds.length === 0 && styles.headerAddDisabled]}>
              Add{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
            </Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={PV2.link} />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>Couldn&apos;t load your collection</Text>
            <TouchableOpacity style={styles.retryButton} onPress={refresh}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : shareableItems.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>No items to add</Text>
            <Text style={styles.emptyBody}>Add a photo to a card in your collection first.</Text>
          </View>
        ) : (
          <View style={styles.scroll}>
            <Text style={styles.selectedCount}>
              {selectedIds.length}/{remainingSlots} selected
            </Text>
            {hasPrivateItems && (
              <Text style={styles.privateHint}>
                Dimmed items are private — only public items in public collections can be added.
              </Text>
            )}
            <View style={styles.grid}>
              {shareableItems.map((item) => {
                const selectedIndex = selectedIds.indexOf(item.id);
                const isSelected = selectedIndex !== -1;
                const shareable = isPubliclyShareable(item);
                const signedUrl = item.primary_image_id ? signedItemImageUrls.get(item.primary_image_id) : undefined;
                const atCap = !isSelected && selectedIds.length >= remainingSlots;
                return (
                  <Pressable
                    key={item.id}
                    style={styles.slotShadow}
                    onPress={() => toggleSelect(item)}
                    disabled={!shareable || atCap}
                    accessibilityState={{ disabled: !shareable || atCap, selected: isSelected }}>
                    <View
                      style={[
                        styles.slot,
                        isSelected && styles.slotSelected,
                        (!shareable || atCap) && styles.slotDim,
                      ]}>
                      {signedUrl && <Image source={{ uri: signedUrl }} style={styles.image} contentFit="cover" transition={150} />}
                      {isSelected && (
                        <View style={styles.selectedBadge}>
                          <Text style={styles.selectedBadgeText}>{selectedIndex + 1}</Text>
                        </View>
                      )}
                      {!shareable && (
                        <View style={styles.privateBadge} pointerEvents="none">
                          <Text style={styles.privateBadgeText}>Private</Text>
                        </View>
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  // paddingVertical here is the "small breathing room" between the safe
  // area (insets.top, applied to the container above this) and the
  // header row's own content — the container already clears the status
  // bar/Dynamic Island, so this only ever needs to be a small, fixed
  // value, not a second safe-area calculation.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  // Real touch-target size (not just hitSlop) for Cancel/Add — ~44pt tall,
  // matching iOS's own minimum recommended tap target. justifyContent:
  // 'center' keeps the label vertically centered within that taller box
  // rather than pinned to its top.
  headerActionBtn: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
  },
  headerActionBtnRight: {
    alignItems: 'flex-end',
  },
  headerCancel: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  headerAdd: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.link,
  },
  headerAddDisabled: {
    color: PV2.textTertiary,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  retryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  scroll: {
    flex: 1,
    padding: 16,
    gap: 10,
  },
  selectedCount: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  privateHint: {
    fontSize: 12,
    color: PV2.textSecondary,
    marginTop: -4,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  slotShadow: {
    width: '31%',
    aspectRatio: 3 / 4,
    borderRadius: 11,
  },
  slot: {
    flex: 1,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  slotSelected: {
    borderColor: PV2.accent,
  },
  slotDim: {
    opacity: 0.4,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  privateBadge: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  privateBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  selectedBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: PV2.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
});
