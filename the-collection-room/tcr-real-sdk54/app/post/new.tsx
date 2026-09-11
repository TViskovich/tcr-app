import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AddPhotoMenu } from '@/components/feed/add-photo-menu';
import { AttachmentImageGrid } from '@/components/feed/attachment-image-grid';
import { PostItemsPicker, type PickedPostItem } from '@/components/feed/post-items-picker';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import {
  cleanupShareSnapshots,
  copyPostPhotoToShareSnapshots,
  copyShareSnapshotImage,
  createTextPost,
  type TextPostAttachment,
} from '@/lib/share-snapshots';
import { uploadItemImage } from '@/lib/storage';

const MAX_CHARS = 280;
const MAX_ATTACHMENTS = 4;

// One staged (not-yet-uploaded/copied) image the user has picked for this
// post — 'library' holds a local picker uri, 'item' holds an already-
// resolved signed preview uri for one of the user's own collection items
// (see PostItemsPicker's own PickedPostItem). Neither is durable yet;
// resolving both into permanent share-snapshots URLs only happens once
// Post is actually tapped (handlePost below) — same "stage now, persist
// on submit" convention as every other image field in this app.
type PendingAttachment =
  | { key: string; source: 'library'; localUri: string }
  | { key: string; source: 'item'; itemId: string; previewUri: string };

export default function NewPostScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  // A create form, not a scrollable browsing list — no scroll-hide effect,
  // but still resets the shared navbar to visible on focus.
  useScrollResponsiveNavbar({ enabled: false });
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [showAddPhotoMenu, setShowAddPhotoMenu] = useState(false);
  const [showItemsPicker, setShowItemsPicker] = useState(false);

  const charCount = text.length;
  // A post now needs text OR at least one image, not text alone — mirrors
  // every other multi-source post type in this app (card_share,
  // rate_my_grails) in never requiring a caption/body.
  const canPost = (text.trim().length > 0 || attachments.length > 0) && charCount <= MAX_CHARS && !posting;
  const remainingSlots = MAX_ATTACHMENTS - attachments.length;

  function removeAttachment(key: string) {
    setAttachments((prev) => prev.filter((a) => a.key !== key));
  }

  // Library source of the Add Photo chooser — selection only, no native
  // crop/edit screen (matches the prior single-photo behavior: a post
  // photo keeps its natural shape, AttachmentImageGrid's fixed-cell
  // layout below handles arbitrary aspect ratios via contentFit="cover").
  // allowsMultipleSelection + selectionLimit are both supported by this
  // project's current expo-image-picker (~17, Expo SDK 54).
  async function pickFromLibrary() {
    setShowAddPhotoMenu(false);
    const remaining = MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0) return;

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 1,
    });
    if (result.canceled || result.assets.length === 0) return;

    // Defensive clamp — selectionLimit is expected to already enforce
    // this, but never trusted as the sole boundary (platform picker
    // behavior can vary). Anything beyond `remaining` is dropped, with a
    // clear message rather than a silently truncated selection.
    const usable = result.assets.slice(0, remaining);
    if (result.assets.length > remaining) {
      Alert.alert(
        'Too many photos',
        `A post can have at most ${MAX_ATTACHMENTS} images — only the first ${remaining} were added.`,
      );
    }

    setAttachments((prev) => [
      ...prev,
      ...usable.map(
        (asset, i): PendingAttachment => ({
          key: `lib-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
          source: 'library',
          localUri: asset.uri,
        }),
      ),
    ]);
  }

  function openItemsPicker() {
    setShowAddPhotoMenu(false);
    setShowItemsPicker(true);
  }

  function handleItemsConfirmed(picked: PickedPostItem[]) {
    setShowItemsPicker(false);
    setAttachments((prev) => {
      const remaining = MAX_ATTACHMENTS - prev.length;
      const existingItemIds = new Set(
        prev.filter((a): a is Extract<PendingAttachment, { source: 'item' }> => a.source === 'item').map((a) => a.itemId),
      );
      // Re-picking an item already staged in this post (e.g. the picker
      // was reopened without removing a prior pick first) is deduped
      // rather than added twice.
      const deduped = picked.filter((p) => !existingItemIds.has(p.itemId));
      const toAdd = deduped.slice(0, remaining).map(
        (p): PendingAttachment => ({ key: `item-${p.itemId}`, source: 'item', itemId: p.itemId, previewUri: p.previewUri }),
      );
      return [...prev, ...toAdd];
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

  async function handlePost() {
    if (!canPost || !session?.user?.id) return;
    setPosting(true);
    const userId = session.user.id;

    // Copy-before-write (Phase 3E convention, extended from the single-
    // photo path to N mixed-source attachments): every attachment is
    // resolved to an already-durable share-snapshots URL FIRST, via the
    // same per-image copy functions the single-photo/single-card flows
    // already use — a freshly-picked library photo is staged into
    // item-images then copied (copyPostPhotoToShareSnapshots), an
    // existing collection item's photo is copied directly from its own
    // row (copyShareSnapshotImage).
    //
    // Promise.allSettled (not Promise.all) — every attachment's own
    // outcome is awaited to completion before this decides anything,
    // rather than reacting to just the FIRST rejection while others are
    // still silently in flight. That matters because Storage and Postgres
    // are not one transaction: by the time createTextPost is ever called,
    // every successfully-copied attachment already durably exists in
    // share-snapshots regardless of what happens next. Using allSettled
    // is what lets `createdUrls` below reliably capture every single one
    // of those objects — not just whichever happened to resolve before
    // the first failure — so that if this attempt ultimately fails (any
    // copy failing, or createTextPost itself failing after every copy
    // succeeded), cleanupShareSnapshots can reclaim ALL of them, not just
    // some. Never a partially-imaged post either way: the post/post_images
    // rows are only ever written after every copy has already succeeded.
    const settled = await Promise.allSettled(
      attachments.map(async (a): Promise<TextPostAttachment> => {
        if (a.source === 'library') {
          const stagedUrl = await uploadItemImage(a.localUri, userId);
          const copyResult = await copyPostPhotoToShareSnapshots(stagedUrl);
          if (copyResult.status !== 'ok') throw new Error('copy_failed');
          return { imageUrl: copyResult.publicUrl, sourceType: 'library', itemId: null };
        }
        const copyResult = await copyShareSnapshotImage(a.itemId, 'post', a.itemId);
        if (copyResult.status !== 'ok') throw new Error('copy_failed');
        return { imageUrl: copyResult.publicUrl, sourceType: 'item', itemId: a.itemId };
      }),
    );

    // Every share-snapshots URL actually created during THIS attempt,
    // regardless of whether some other attachment failed — the exact set
    // cleanupShareSnapshots should reclaim on failure, and only ever that
    // set (never an existing item image or any other pre-existing asset:
    // this list can only ever contain fresh objects this same call just
    // created).
    const createdUrls = settled
      .filter((r): r is PromiseFulfilledResult<TextPostAttachment> => r.status === 'fulfilled')
      .map((r) => r.value.imageUrl);

    const firstFailure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (firstFailure) {
      console.error('[post/new] attachment copy failed:', firstFailure.reason);
      // Fire-and-forget — never awaited before showing the alert below, so
      // a slow or failed cleanup can never delay or replace the real error
      // the user needs to see (cleanupShareSnapshots also never throws).
      cleanupShareSnapshots(createdUrls);
      Alert.alert('Post failed', 'Something went wrong preparing your photos. Check your connection and try again.');
      setPosting(false);
      // Stay on screen — text/attachments preserved so the user can retry,
      // same convention as app/share-card/new.tsx's own handlePost.
      return;
    }

    const resolved = settled.map((r) => (r as PromiseFulfilledResult<TextPostAttachment>).value);

    try {
      const result = await createTextPost(text.trim() || null, resolved);
      if (result.status !== 'ok') throw new Error(result.reason);

      leaveScreen();
    } catch (e) {
      console.error('[post/new] post failed:', e);
      // Every attachment above was successfully copied but is now
      // unreferenced by any post row (createTextPost failed after the
      // fact) — reclaim all of them, same fire-and-forget/non-masking
      // convention as the copy-failure branch above.
      cleanupShareSnapshots(createdUrls);
      Alert.alert('Post failed', 'Something went wrong. Check your connection and try again.');
      setPosting(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: 'New Post',
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
                <Text style={[styles.headerPost, !canPost && styles.headerPostDisabled]}>
                  Post
                </Text>
              )}
            </TouchableOpacity>
          ),
        }}
      />

      {/* keyboardVerticalOffset — same insets.top + 44 (standard iOS nav-bar
          height) pattern already used by app/post/[id].tsx and
          app/conversation/[id].tsx for this exact screen shape (a Stack
          header above a KeyboardAvoidingView). Without it, "padding"
          behavior undershoots by the header's own height, since the
          native Stack header isn't part of this view's own measured
          frame — that undershoot is exactly why the Add Photo/preview
          control (below the text input) was ending up hidden under the
          keyboard. Not a hardcoded keyboard height: 44 is the header,
          insets.top is the safe-area/notch inset above it. */}
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}>
        <TextInput
          style={styles.input}
          placeholder="What are you collecting?"
          placeholderTextColor={PV2.textTertiary}
          multiline
          autoFocus
          value={text}
          onChangeText={setText}
          maxLength={MAX_CHARS}
          textAlignVertical="top"
        />

        {attachments.length > 0 && (
          <View style={styles.attachmentsWrap}>
            <AttachmentImageGrid
              images={attachments.map((a) => ({ key: a.key, uri: a.source === 'library' ? a.localUri : a.previewUri }))}
              renderOverlay={(index) => (
                <TouchableOpacity
                  onPress={() => removeAttachment(attachments[index].key)}
                  hitSlop={8}
                  style={styles.photoRemoveBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Remove photo">
                  <IconSymbol name="xmark" size={14} color={PV2.textPrimary} />
                </TouchableOpacity>
              )}
            />
          </View>
        )}

        {attachments.length < MAX_ATTACHMENTS ? (
          <TouchableOpacity
            onPress={() => setShowAddPhotoMenu(true)}
            style={styles.addPhotoBtn}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Add photo">
            <IconSymbol name="camera.fill" size={18} color={PV2.link} />
            <Text style={styles.addPhotoLabel}>
              {attachments.length > 0 ? 'Add More' : 'Add Photo'}
            </Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.maxHint}>Maximum {MAX_ATTACHMENTS} photos</Text>
        )}

        <View style={styles.footer}>
          <Text
            style={[
              styles.counter,
              charCount >= MAX_CHARS - 30 && styles.counterAmber,
              charCount >= MAX_CHARS && styles.counterRed,
            ]}>
            {charCount}/{MAX_CHARS}
          </Text>
        </View>
      </KeyboardAvoidingView>

      <AddPhotoMenu
        visible={showAddPhotoMenu}
        onClose={() => setShowAddPhotoMenu(false)}
        onChooseFromLibrary={pickFromLibrary}
        onChooseFromMyItems={openItemsPicker}
      />

      <PostItemsPicker
        visible={showItemsPicker}
        onClose={() => setShowItemsPicker(false)}
        currentUserId={session?.user?.id}
        remainingSlots={remainingSlots}
        onConfirm={handleItemsConfirmed}
      />
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
  input: {
    flex: 1,
    fontSize: 17,
    color: PV2.textPrimary,
    padding: 16,
    lineHeight: 24,
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PV2.dividerColor,
  },
  counter: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
  counterAmber: {
    color: '#F59E0B',
  },
  counterRed: {
    color: PV2.accent,
  },
  addPhotoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  addPhotoLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.link,
  },
  maxHint: {
    fontSize: 13,
    color: PV2.textTertiary,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  // Kept compact (not full-bleed) so the composer still reads as a post
  // composer, not an image-editing screen — same horizontal inset as the
  // original single-photo preview box.
  attachmentsWrap: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  photoRemoveBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
