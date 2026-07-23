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
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

const MAX_CHARS = 280;
const MAX_CARDS = 5;

// Card picker for the Create menu's "Share Card" option — lets the
// signed-in user pick 1-5 of their own collection_items (across every
// folder, via useAllItems) and post them to the feed. 1 selected reuses
// the existing plain post_type 'item' insert shape (app/item/new.tsx's own
// pattern) — no orphan risk, a single-table insert. 2-5 selected goes
// through the create_card_share_post RPC (see the migration), which is
// atomic (a failure can never leave an orphaned empty post) and validates
// everything server-side regardless of what this screen already filtered
// client-side.
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
  // filter only; create_card_share_post independently rejects any
  // imageless (or whitespace-only) item server-side for the multi-card
  // path regardless of this. Trimmed, not just truthy — a whitespace-only
  // string is not a usable image.
  const shareableItems = items.filter((i) => !!i.image_url?.trim());
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

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_CARDS) return prev;
      return [...prev, id];
    });
  }

  async function handlePost() {
    if (!canPost || !currentUserId) return;
    setPosting(true);

    try {
      if (selectedIds.length === 1) {
        const item = shareableItems.find((i) => i.id === selectedIds[0]);
        // Re-validated here (trimmed, non-empty) rather than trusted from
        // the shareableItems filter above — this single-card path is a
        // plain client insert that bypasses create_card_share_post's own
        // server-side image validation entirely, so this is the only
        // enforcement point for it.
        const trimmedImageUrl = item?.image_url?.trim();
        if (!item || !trimmedImageUrl) throw new Error('Selected card is missing an image.');

        const { error: insertError } = await supabase.from('posts').insert({
          user_id: currentUserId,
          item_id: item.id,
          post_type: 'item',
          image_url: trimmedImageUrl,
          caption: caption.trim() || null,
        });
        if (insertError) throw insertError;
      } else {
        const { error: rpcError } = await supabase.rpc('create_card_share_post', {
          p_caption: caption.trim() || null,
          p_item_ids: selectedIds,
        });
        if (rpcError) throw rpcError;
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

            <View style={styles.grid}>
              {shareableItems.map((item) => {
                const selectedIndex = selectedIds.indexOf(item.id);
                const isSelected = selectedIndex !== -1;
                return (
                  <Pressable key={item.id} style={styles.slotShadow} onPress={() => toggleSelect(item.id)}>
                    <View style={[styles.slot, isSelected && styles.slotSelected]}>
                      <Image source={{ uri: item.image_url! }} style={styles.image} contentFit="cover" transition={150} />
                      {isSelected && (
                        <View style={styles.selectedBadge}>
                          <Text style={styles.selectedBadgeText}>{selectedIndex + 1}</Text>
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
  image: {
    width: '100%',
    height: '100%',
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
