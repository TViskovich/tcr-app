import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { Stack, useRouter } from 'expo-router';

import { SharePostPreview } from '@/components/feed/share-post-preview';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAllItems } from '@/hooks/use-collection';
import { useProfile } from '@/hooks/use-profile';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { copyShareSnapshotImage, createSnapshotPost } from '@/lib/share-snapshots';
import { supabase } from '@/lib/supabase';
import type { CardShareItem } from '@/types';

const MAX_CHARS = 280;
const MAX_CARDS = 5;

// Card picker for the Create menu's "Share Card" option — lets the
// signed-in user pick 1-5 of their own collection_items (across every
// folder, via useAllItems) and post them to the feed. 1 selected copies
// its snapshot then inserts directly (mirrors app/item/new.tsx's own
// share-to-feed pattern). 2-5 selected goes through the
// create-snapshot-post Edge Function (Phase 3E — supersedes the original
// create_card_share_post RPC, still present in the database but no
// longer called from here), which copies every card's image into
// share-snapshots and creates the post + card_share_items rows together,
// server-side, as one all-or-nothing unit — see that function's own
// module comment for the full invariant.
export default function ShareCardScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const { items, loading, error, refresh } = useAllItems(currentUserId);
  // Own profile only — the "current user's avatar/username" the preview
  // (below) needs, same hook every other screen in this app already uses
  // for that. Not used for anything else on this screen.
  const { profile: currentProfile } = useProfile(currentUserId);
  // A create form, not a scrollable browsing list — no scroll-hide effect,
  // but still resets the shared navbar to visible on focus.
  useScrollResponsiveNavbar({ enabled: false });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);

  // A feed post needs an image to be worth sharing — this is a product/UX
  // filter only; create-snapshot-post's own copy step independently fails
  // the whole request for any item with no resolvable image regardless of
  // this (see that function's own module comment). Trimmed, not just
  // truthy — a whitespace-only string is not a usable image. Still
  // filtered on the legacy image_url
  // field (unrelated to Step 2's render migration below) — every real
  // item with a gallery image also has this field set (kept in sync by
  // the same DB functions that maintain primary_image_id), so this
  // remains an accurate proxy for "has an image" without needing to wait
  // on a signed lookup just to decide the picker's contents.
  const shareableItems = items.filter((i) => !!i.image_url?.trim());
  // One batched call for the whole picker grid — never one signing
  // request per card (item-images beta privacy hardening, Phase 3E).
  const { urls: signedItemImageUrls } = useSignedItemImages(
    shareableItems.map((i) => i.primary_image_id),
  );

  // Effective (most-restrictive-wins) public visibility — the same rule
  // enforced by items_select_public/collection_item_images_select_public
  // RLS and by app/item/new.tsx's own Share-to-feed gate (see
  // supabase/migrations/20260825120000_add_collection_item_privacy.sql).
  // Ownership (useAllItems already scopes this whole list to the caller's
  // own items) grants private viewing, not permission to create a public
  // feed representation — a private card stays ineligible here even though
  // the owner can obviously still see it in this picker.
  function isPubliclyShareable(item: (typeof shareableItems)[number]) {
    return item.folder_is_public && item.is_public;
  }

  const hasPrivateCards = shareableItems.some((i) => !isPubliclyShareable(i));
  const canPost = selectedIds.length >= 1 && !posting;

  // The compose step's own view of the selection, in FINAL posting order —
  // selectedIds' own array order IS that order (see moveSelected below and
  // handlePost, which passes selectedIds straight through to
  // createSnapshotPost/the single-card insert; display_order on the
  // persisted card_share_items rows is assigned server-side from this same
  // array's index — see create-snapshot-post's own module comment). Filters
  // out any id that no longer resolves against shareableItems defensively
  // (mirrors handlePost's own re-validation below) rather than assuming
  // selectedIds and shareableItems can never disagree for a render in
  // between state updates.
  const selectedItems = selectedIds
    .map((id) => shareableItems.find((i) => i.id === id))
    .filter((i): i is (typeof shareableItems)[number] => !!i);

  // Fake, LOCAL-ONLY CardShareItem rows for the preview — no post exists
  // yet, so there is no real card_share_items id/post_id to read. Reuses
  // the exact fields CardSharePostBody actually renders (snapshot_title/
  // snapshot_subtitle sourced the same way create-snapshot-post derives
  // them server-side: item.title/item.brand) plus the already-signed
  // preview image this screen's own grid already displays — never the
  // durable share-snapshots copy, which only gets created at actual post
  // time. item_id is deliberately null (not the real item id) so
  // CardSharePostBody's own tap-to-navigate is disabled here — this
  // preview is a visual confirmation, not a live interactive card; tapping
  // it should never navigate the user away from mid-compose.
  const previewCards: CardShareItem[] = selectedItems.map((item, index) => ({
    id: item.id,
    post_id: 'preview',
    item_id: null,
    snapshot_image_url: item.primary_image_id ? (signedItemImageUrls.get(item.primary_image_id) ?? null) : null,
    snapshot_title: item.title,
    snapshot_subtitle: item.brand,
    display_order: index,
  }));

  // Adjacent swap only — matches the move-left/move-right control pair
  // rendered per thumbnail below (no drag-and-drop library in this
  // project; see the reorder strip's own comment). No-ops silently at
  // either end of the list rather than wrapping around.
  function moveSelected(id: string, direction: -1 | 1) {
    setSelectedIds((prev) => {
      const index = prev.indexOf(id);
      if (index === -1) return prev;
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }

  // No back history when this screen was deep-linked, reloaded directly, or
  // opened during development — fall back to the main feed, where the Create
  // menu that opens this screen always lives and where the new post appears.
  function leaveScreen() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  function toggleSelect(item: (typeof shareableItems)[number]) {
    // Primary prevention — a private card is never added to the selection
    // in the first place, regardless of how this is invoked (the grid
    // below also visually disables the Pressable itself as a second,
    // independent layer).
    if (!isPubliclyShareable(item)) return;
    const id = item.id;
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_CARDS) return prev;
      return [...prev, id];
    });
  }

  async function handlePost() {
    if (!canPost || !currentUserId) return;

    // Handler-level guard, immediately before any feed-post insert — not
    // just relying on toggleSelect/the disabled grid state having kept
    // private cards out of selectedIds. Re-reads the actual item objects'
    // current privacy flags rather than trusting stale selection state.
    const selectedItems = shareableItems.filter((i) => selectedIds.includes(i.id));
    if (selectedItems.length !== selectedIds.length || selectedItems.some((i) => !isPubliclyShareable(i))) {
      Alert.alert('Cannot share', 'Private cards can’t be shared to the public feed.');
      return;
    }

    setPosting(true);

    try {
      if (selectedIds.length === 1) {
        const item = shareableItems.find((i) => i.id === selectedIds[0]);
        if (!item) throw new Error('Selected card is missing an image.');

        // Copy-before-insert (Phase 3E) — a feed post is never created
        // pointing at a raw item-images URL. targetId reuses item.id
        // since no post exists yet at this point (see
        // lib/share-snapshots.ts's own module comment). This is now the
        // sole enforcement point for "the selected item must have a
        // resolvable image" on this path — a copy failure aborts the
        // whole post, surfaced to the user below.
        const snapshot = await copyShareSnapshotImage(item.id, 'post', item.id);
        if (snapshot.status !== 'ok') {
          throw new Error('Could not prepare this card’s image. Please try again.');
        }

        const { error: insertError } = await supabase.from('posts').insert({
          user_id: currentUserId,
          item_id: item.id,
          post_type: 'item',
          image_url: snapshot.publicUrl,
          caption: caption.trim() || null,
        });
        if (insertError) throw insertError;
      } else {
        // All-or-nothing (Phase 3E) — every selected card's image is
        // copied into share-snapshots and the post + card_share_items
        // rows are created together, server-side, as one unit. Either the
        // whole post exists with every card already durable, or nothing
        // was created at all — never a partially-imaged post, never a
        // raw item-images URL. See create-snapshot-post's own module
        // comment for the full invariant.
        const result = await createSnapshotPost('card_share', selectedIds, caption.trim() || null);
        if (result.status !== 'ok') {
          throw new Error('Could not prepare these cards’ images. Please try again.');
        }
      }
      leaveScreen();
    } catch (e) {
      // Full detail stays in the console; the user gets a stable, generic
      // message rather than a raw Supabase/Postgres error string.
      console.error('[share-card] post failed:', e);
      Alert.alert('Post failed', 'Something went wrong. Please try again.');
      // Stay on screen — selection/caption preserved so the user can retry.
    } finally {
      setPosting(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Share Card',
          headerLeft: () => (
            <TouchableOpacity onPress={leaveScreen} hitSlop={8}>
              <Text style={styles.headerCancel}>Cancel</Text>
            </TouchableOpacity>
          ),
          headerRight: () => (
            <TouchableOpacity onPress={handlePost} disabled={!canPost} hitSlop={8}>
              {posting ? (
                <ActivityIndicator size="small" color={PV2.link} />
              ) : (
                <Text style={[styles.headerPost, !canPost && styles.headerPostDisabled]}>Post</Text>
              )}
            </TouchableOpacity>
          ),
        }}
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      ) : error ? (
        // Distinct from the empty state below — a failed query must never
        // look identical to "you have no cards." error itself (the raw
        // Supabase message) is only ever logged, via useAllItems's own
        // console.error — never rendered here.
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Couldn&apos;t load your collection</Text>
          <Text style={styles.emptyBody}>Something went wrong. Please try again.</Text>
          <TouchableOpacity style={styles.emptyButton} onPress={refresh}>
            <Text style={styles.emptyButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : shareableItems.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No cards to share</Text>
          <Text style={styles.emptyBody}>
            Add a photo to a card in your collection before sharing it.
          </Text>
          <TouchableOpacity style={styles.emptyButton} onPress={() => router.push('/(tabs)/collection')}>
            <Text style={styles.emptyButtonText}>Go to Collection</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView contentContainerStyle={styles.scroll}>
            <View style={styles.selectRow}>
              <Text style={styles.sectionLabel}>
                Choose 1{'–'}{MAX_CARDS} cards
              </Text>
              <Text style={styles.selectedCount}>
                {selectedIds.length}/{MAX_CARDS} selected
              </Text>
            </View>
            {selectedIds.length >= MAX_CARDS && (
              <Text style={styles.maxHint}>Maximum {MAX_CARDS} cards</Text>
            )}
            {hasPrivateCards && (
              <Text style={styles.privateHint}>
                Dimmed cards are private — only public cards in public collections can be shared.
              </Text>
            )}

            <View style={styles.grid}>
              {shareableItems.map((item) => {
                const selectedIndex = selectedIds.indexOf(item.id);
                const isSelected = selectedIndex !== -1;
                const shareable = isPubliclyShareable(item);
                const signedUrl = item.primary_image_id
                  ? signedItemImageUrls.get(item.primary_image_id)
                  : undefined;
                return (
                  <Pressable
                    key={item.id}
                    style={styles.slotShadow}
                    onPress={() => toggleSelect(item)}
                    disabled={!shareable}
                    accessibilityState={{ disabled: !shareable, selected: isSelected }}
                    accessibilityLabel={shareable ? undefined : 'Private card — cannot be shared to the feed'}>
                    <View style={[styles.slot, isSelected && styles.slotSelected, !shareable && styles.slotPrivate]}>
                      {signedUrl && (
                        <Image source={{ uri: signedUrl }} style={styles.image} contentFit="cover" transition={150} />
                      )}
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

            {/* Step 2 — only appears once there's something to compose.
                Reorder strip, caption, and preview all live in this one
                section/page rather than a separate route (kept as a single
                scroll so caption text and card order both stay intact
                while the other is being adjusted — there's no navigation
                transition between them to lose state across). */}
            {selectedItems.length > 0 && (
              <View style={styles.composeSection}>
                <Text style={styles.sectionLabel}>Arrange your cards</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.reorderRow}>
                  {selectedItems.map((item, index) => {
                    const signedUrl = item.primary_image_id
                      ? signedItemImageUrls.get(item.primary_image_id)
                      : undefined;
                    return (
                      <View key={item.id} style={styles.reorderThumbWrap}>
                        <View style={styles.reorderThumb}>
                          {signedUrl && (
                            <Image source={{ uri: signedUrl }} style={styles.image} contentFit="cover" />
                          )}
                          <View style={styles.selectedBadge}>
                            <Text style={styles.selectedBadgeText}>{index + 1}</Text>
                          </View>
                          <TouchableOpacity
                            style={styles.reorderRemoveBtn}
                            onPress={() => toggleSelect(item)}
                            hitSlop={6}
                            accessibilityRole="button"
                            accessibilityLabel="Remove card from post">
                            <IconSymbol name="xmark" size={12} color={PV2.textPrimary} />
                          </TouchableOpacity>
                        </View>
                        <View style={styles.reorderControls}>
                          <TouchableOpacity
                            onPress={() => moveSelected(item.id, -1)}
                            disabled={index === 0}
                            hitSlop={6}
                            style={styles.reorderArrowBtn}
                            accessibilityRole="button"
                            accessibilityLabel="Move card earlier">
                            <IconSymbol
                              name="chevron.left"
                              size={14}
                              color={index === 0 ? PV2.textTertiary : PV2.textPrimary}
                            />
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => moveSelected(item.id, 1)}
                            disabled={index === selectedItems.length - 1}
                            hitSlop={6}
                            style={styles.reorderArrowBtn}
                            accessibilityRole="button"
                            accessibilityLabel="Move card later">
                            <IconSymbol
                              name="chevron.right"
                              size={14}
                              color={index === selectedItems.length - 1 ? PV2.textTertiary : PV2.textPrimary}
                            />
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })}
                </ScrollView>

                <Text style={styles.sectionLabel}>Caption</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Add a caption (optional)"
                  placeholderTextColor={PV2.textTertiary}
                  multiline
                  value={caption}
                  onChangeText={setCaption}
                  maxLength={MAX_CHARS}
                  textAlignVertical="top"
                />
                <Text style={styles.counter}>
                  {caption.length}/{MAX_CHARS}
                </Text>

                <Text style={styles.sectionLabel}>Preview</Text>
                <SharePostPreview
                  avatarUrl={currentProfile?.avatar_url ?? null}
                  displayName={currentProfile?.display_name || currentProfile?.username || ''}
                  username={currentProfile?.username ?? ''}
                  caption={caption}
                  cards={previewCards}
                />
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  headerCancel: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  headerPost: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.link,
  },
  headerPostDisabled: {
    color: PV2.textTertiary,
  },
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  scroll: {
    padding: 16,
    gap: 12,
  },
  selectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: PV2.textSecondary,
  },
  selectedCount: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  maxHint: {
    fontSize: 12,
    color: PV2.textTertiary,
    marginTop: -6,
  },
  privateHint: {
    fontSize: 12,
    color: PV2.textSecondary,
    marginTop: -6,
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
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 5,
    elevation: 2,
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
  // Private, ineligible-to-share card — dimmed and non-interactive
  // (Pressable disabled), not removed from the grid entirely, so the user
  // can still see which of their own cards exist and why each is excluded.
  slotPrivate: {
    opacity: 0.55,
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
  composeSection: {
    gap: 12,
    marginTop: 4,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: PV2.dividerColor,
  },
  reorderRow: {
    gap: 10,
    paddingBottom: 2,
  },
  reorderThumbWrap: {
    width: 84,
    alignItems: 'center',
    gap: 6,
  },
  reorderThumb: {
    width: 84,
    aspectRatio: 3 / 4,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  reorderRemoveBtn: {
    position: 'absolute',
    top: 5,
    left: 5,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reorderControls: {
    flexDirection: 'row',
    gap: 4,
  },
  reorderArrowBtn: {
    width: 30,
    height: 26,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: PV2.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    fontSize: 16,
    color: PV2.textPrimary,
    minHeight: 80,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    padding: 12,
  },
  counter: {
    fontSize: 13,
    color: PV2.textTertiary,
    textAlign: 'right',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: PV2.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 15,
    color: PV2.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  emptyButton: {
    backgroundColor: PV2.accent,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  emptyButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
