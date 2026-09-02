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

import { useAllItems } from '@/hooks/use-collection';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { copyShareSnapshotImage, createSnapshotPost } from '@/lib/share-snapshots';
import { supabase } from '@/lib/supabase';

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
                <ActivityIndicator size="small" color="#0a7ea4" />
              ) : (
                <Text style={[styles.headerPost, !canPost && styles.headerPostDisabled]}>Post</Text>
              )}
            </TouchableOpacity>
          ),
        }}
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
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

            <TextInput
              style={styles.input}
              placeholder="Add a caption (optional)"
              placeholderTextColor="#999"
              multiline
              value={caption}
              onChangeText={setCaption}
              maxLength={MAX_CHARS}
              textAlignVertical="top"
            />
            <Text style={styles.counter}>
              {caption.length}/{MAX_CHARS}
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  headerCancel: {
    fontSize: 16,
    color: '#687076',
  },
  headerPost: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0a7ea4',
  },
  headerPostDisabled: {
    color: '#ccc',
  },
  container: {
    flex: 1,
    backgroundColor: '#fff',
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
    color: '#687076',
  },
  selectedCount: {
    fontSize: 13,
    fontWeight: '600',
    color: '#11181C',
  },
  maxHint: {
    fontSize: 12,
    color: '#aaa',
    marginTop: -6,
  },
  privateHint: {
    fontSize: 12,
    color: '#687076',
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
    backgroundColor: '#e9ecef',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  slotSelected: {
    borderColor: '#0a7ea4',
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
    backgroundColor: '#0a7ea4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  input: {
    fontSize: 16,
    color: '#11181C',
    minHeight: 80,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    padding: 12,
  },
  counter: {
    fontSize: 13,
    color: '#aaa',
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
    color: '#11181C',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 15,
    color: '#687076',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  emptyButton: {
    backgroundColor: '#0a7ea4',
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
