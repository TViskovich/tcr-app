import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhotoAdjuster } from '@/components/collection/photo-adjuster';
import { ItemActionBar } from '@/components/item-detail/item-action-bar';
import { ItemDescription } from '@/components/item-detail/item-description';
import { ItemIdentity } from '@/components/item-detail/item-identity';
import { buildItemImageList, ItemImageCarousel, type CarouselImage } from '@/components/item-detail/item-image-carousel';
import { ItemImageGalleryManager } from '@/components/item-detail/item-image-gallery-manager';
import { ItemMetadataSection, type MetadataRow } from '@/components/item-detail/item-metadata-section';
import { ItemOwnerRow } from '@/components/item-detail/item-owner-row';
import { MoveItemModal } from '@/components/item-detail/move-item-modal';
import { RelatedItemsGrid } from '@/components/item-detail/related-items-grid';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useGrails } from '@/hooks/use-grails';
import { useItemImages } from '@/hooks/use-item-images';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useRegisteredCardForItem } from '@/hooks/use-registered-card';
import { useSavedCard } from '@/hooks/use-saved';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { cleanupOrphanedItemImages, materializeLegacyItemImage, MAX_ITEM_IMAGES } from '@/lib/item-images';
import { navigateToProfile } from '@/lib/profile-navigation';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { CollectionItem } from '@/types';

type EditForm = {
  title: string;
  player: string;
  team: string;
  year: string;
  brand: string;
  grade: string;
  gradingCompany: string;
  serialNumber: string;
  estimatedValue: string;
  description: string;
};

type OwnerProfile = {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

function itemToForm(item: CollectionItem): EditForm {
  return {
    title: item.title ?? '',
    player: item.player ?? '',
    team: item.team ?? '',
    year: item.year?.toString() ?? '',
    brand: item.brand ?? '',
    grade: item.grade ?? '',
    gradingCompany: item.grading_company ?? '',
    serialNumber: item.serial_number ?? '',
    estimatedValue: item.estimated_value?.toString() ?? '',
    description: item.description ?? '',
  };
}

// Player is the primary identity (matches how collectors actually refer to
// a card); the item's own title/brand/year become supporting detail lines
// instead. Falls back to the item's own title, then a generic label, if
// there's no player set.
// Same formatting convention already used for dates elsewhere in this
// registry-adjacent screen family (e.g. app/registry/[id].tsx's own
// formatDate) — not shared, since each is a small, standalone helper.
// Accepts a possibly-missing/malformed value and never returns a
// renderable "Invalid Date" string: null covers both "no timestamp" and
// "unparseable timestamp" identically, so the call site can gate on one
// simple truthiness check either way.
function formatTransferredOutDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function buildIdentity(item: CollectionItem): { title: string; subtitleLines: (string | null)[] } {
  const title = item.player?.trim() || item.title?.trim() || 'Untitled Item';
  const yearAndSet = [item.year != null ? String(item.year) : null, item.brand]
    .filter(Boolean)
    .join(' ') || null;
  const cardTitle = item.title && item.title.trim() !== title ? item.title : null;
  return { title, subtitleLines: [yearAndSet, cardTitle] };
}

function buildMetadataRows(item: CollectionItem): MetadataRow[] {
  return [
    { label: 'Player', value: item.player },
    { label: 'Team', value: item.team },
    { label: 'Year', value: item.year != null ? String(item.year) : null },
    { label: 'Set', value: item.brand },
    { label: 'Grade', value: item.grade },
    { label: 'Grading Company', value: item.grading_company },
    { label: 'Serial Number', value: item.serial_number },
    { label: 'Estimated Value', value: item.estimated_value != null ? `$${item.estimated_value.toFixed(2)}` : null },
  ];
}

function EditField({
  label,
  value,
  onChange,
  extra,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  extra?: object;
}) {
  return (
    <View style={editStyles.wrap}>
      <Text style={editStyles.label}>{label}</Text>
      <TextInput
        style={editStyles.input}
        value={value}
        onChangeText={onChange}
        placeholder={label}
        placeholderTextColor="#999"
        {...extra}
      />
    </View>
  );
}

// Custom header bar — replaces the native Stack header entirely for this
// screen (every Stack.Screen below sets headerShown: false). react-navigation's
// native header picks up the OS's own rounded/"Liquid Glass" pill chrome
// around header bar items on iOS 18+ — confirmed on-device, and not
// something any headerLeft/headerRight style prop can suppress, since it's
// applied by the native header itself rather than by anything this app
// controls (see components/ui/back-button.tsx's own doc comment on the same
// finding). Rendering the header row as plain in-screen content is the only
// way to guarantee a bare chevron here. leftSlot/rightSlot are both
// HEADER_SIDE_WIDTH wide regardless of their actual content (a 44px
// BackButton vs. "Cancel"/"Edit"/"Save" text) so the title in between is
// truly centered on the row, not just centered between two unequal-width
// controls.
const HEADER_SIDE_WIDTH = 70;
const HEADER_ROW_HEIGHT = 44;

function ItemDetailHeaderBar({
  insetsTop,
  title,
  left,
  right,
}: {
  insetsTop: number;
  title: string;
  left: ReactNode;
  right?: ReactNode;
}) {
  return (
    <View style={[headerBarStyles.bar, { paddingTop: insetsTop }]}>
      <View style={headerBarStyles.row}>
        <View style={headerBarStyles.slotLeft}>{left}</View>
        <Text style={headerBarStyles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={headerBarStyles.slotRight}>{right}</View>
      </View>
    </View>
  );
}

const headerBarStyles = StyleSheet.create({
  bar: {
    backgroundColor: PV2.bg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: HEADER_ROW_HEIGHT,
  },
  slotLeft: {
    width: HEADER_SIDE_WIDTH,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  slotRight: {
    width: HEADER_SIDE_WIDTH,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingRight: 12,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: PV2.textPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Permanent layout/component architecture for the item detail screen — see
// components/item-detail/*. Order: hero image → action bar (placeholder,
// unwired) → identity → owner card (non-owners only) → description →
// metadata → related items grid → owner-only management actions. Edit mode
// keeps its existing metadata form UI; the hero area swaps to
// ItemImageGalleryManager (add/remove/reorder/set cover) instead.
export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string; fromGrails?: string }>();
  const { session } = useAuth();
  const router = useRouter();
  const currentUserId = session?.user?.id;
  const insets = useSafeAreaInsets();
  const { onScroll: navbarOnScroll, scrollEventThrottle: navbarScrollEventThrottle } =
    useScrollResponsiveNavbar();

  const [item, setItem] = useState<CollectionItem | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);
  const [fetching, setFetching] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  // Item-level privacy (Model A, most-restrictive-wins — see
  // supabase/migrations/20260825120000_add_collection_item_privacy.sql).
  // Kept separate from `form`/EditForm (same convention as
  // folder-edit-modal.tsx's editIsPublic vs. its rename field) since it's a
  // boolean switch, not a text field. Seeded from the item's own current
  // value in enterEdit()/cancelEdit() below — this is an existing item
  // being edited, so it starts from what it already is, not from the
  // parent folder (that seeding only applies to a brand-new item, in
  // app/item/new.tsx).
  const [editItemIsPublic, setEditItemIsPublic] = useState(true);
  const editItemIsPrivate = !editItemIsPublic;
  const [saving, setSaving] = useState(false);
  const [grailsLoading, setGrailsLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  // Phase 1 item move — single-item only (see components/item-detail/
  // move-item-modal.tsx). Kept as a top-level bool here, not folded into
  // editMode: Move is reachable from the edit form but is its own
  // independent action/modal, not a form field.
  const [showMoveModal, setShowMoveModal] = useState(false);
  // Multi-photo "Add Photos" queue — handleAddPhotos below seeds this from
  // however many library assets the user multi-selected in one pass, then
  // PhotoAdjuster is shown once per entry (see the render below) so every
  // photo gets the same crop/adjust step a single photo already got,
  // rather than uploading the raw, unedited picker output. photoQueue is
  // cleared (empty array) whenever there's nothing pending; queueIndex is
  // only meaningful while it isn't.
  const [photoQueue, setPhotoQueue] = useState<{ uri: string; width: number; height: number }[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueAdjustedUris, setQueueAdjustedUris] = useState<string[]>([]);

  const isOwner = !!currentUserId && item?.user_id === currentUserId;
  // Sender Transferred-Out Item Lifecycle — a top-level derived flag, not
  // a separate query: collection_status already comes back on the same
  // row this screen fetches by id. Used both to gate the header Edit
  // button below and to swap the entire view-mode action area for the
  // historical state (see the single top-level conditional further down,
  // rather than hiding many individual buttons).
  const isTransferredOut = item?.collection_status === 'transferred_out';

  const { isFull, isInGrails, addToGrails, removeFromGrails } = useGrails(currentUserId);
  const { isSaved: cardSaved, saving: savingCard, toggle: toggleCardSave } = useSavedCard(id, currentUserId);
  // Not gated on isOwner — RLS (registered_cards_select_visible) already
  // restricts what a non-owner can read (public rows, or their own), so
  // this only lets an already-permitted read happen. It has to run for
  // every viewer because the CacheCase ID button in ItemActionBar (below)
  // is visible to everyone, not just the owner; the owner-only register/
  // edit UI stays gated separately, at the JSX level (see isOwner &&
  // below), unaffected by this. The hook's own automatic effect only ever
  // performs a SELECT (see hooks/use-registered-card.ts) — registerItem()
  // is a separate function, never auto-invoked.
  const {
    registeredCard,
    loading: registryLoading,
    registering,
    registerItem,
    retrySnapshotImage,
  } = useRegisteredCardForItem(item?.id);
  const {
    images: galleryImages,
    loading: galleryLoading,
    mutating: galleryMutating,
    refresh: refreshGalleryImages,
    addImages: addGalleryImages,
    removeImage: removeGalleryImage,
    setPrimary: setPrimaryGalleryImage,
    reorder: reorderGalleryImages,
  } = useItemImages(item?.id);

  useEffect(() => {
    async function fetchItem() {
      const { data } = await supabase
        .from('collection_items')
        .select('*')
        .eq('id', id)
        .single();

      if (data) {
        setItem(data);
        setForm(itemToForm(data));

        // Always fetched now (not just for non-owners) — the Instagram-style
        // ItemOwnerRow above the image shows the owner's identity
        // regardless of viewer, same as the owner-only card further down
        // still does for non-owners only (that block's own !isOwner check
        // is unaffected by this).
        const { data: profile } = await supabase
          .from('profiles')
          .select('username, display_name, avatar_url')
          .eq('id', data.user_id)
          .single();
        if (profile) setOwnerProfile(profile as OwnerProfile);
      }
      setFetching(false);
    }
    fetchItem();
  }, [id, currentUserId]);

  // Legacy items (and, defensively, any item whose creation-time gallery
  // row is somehow missing) predate this feature and only have
  // collection_items.image_url — self-heal into a real gallery row on
  // entering edit mode so the gallery manager always operates on real rows
  // (the migration's backfill already does this in bulk for every item
  // that existed at deploy time; this covers the rare gap).
  async function enterEdit() {
    if (!isOwner) return;
    if (item) {
      setForm(itemToForm(item));
      setEditItemIsPublic(item.is_public);
    }
    if (!galleryLoading && galleryImages.length === 0 && item?.image_url && currentUserId) {
      try {
        await materializeLegacyItemImage(item.id, currentUserId, item.image_url);
        await refreshGalleryImages();
      } catch {
        // Best-effort — edit mode still opens; the gallery manager simply
        // starts empty and the next successful add becomes primary.
      }
    }
    setEditMode(true);
  }

  function cancelEdit() {
    if (item) {
      setForm(itemToForm(item));
      setEditItemIsPublic(item.is_public);
    }
    setEditMode(false);
  }

  function updateField(key: keyof EditForm) {
    return (value: string) =>
      setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleAddPhotos() {
    if (!item || !currentUserId) return;
    const remaining = MAX_ITEM_IMAGES - galleryImages.length;
    if (remaining <= 0) {
      Alert.alert('Limit reached', `You can add up to ${MAX_ITEM_IMAGES} photos per item.`);
      return;
    }
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 0.85,
    });
    if (result.canceled || !result.assets.length) return;

    // Queue every selected asset through PhotoAdjuster (one at a time, in
    // the order iOS returned them) instead of uploading the raw picker
    // output directly — see the PhotoAdjuster render below and
    // handleQueuedPhotoAdjusted/handleQueuedPhotoSkipped.
    setQueueAdjustedUris([]);
    setQueueIndex(0);
    setPhotoQueue(result.assets.map((asset) => ({ uri: asset.uri, width: asset.width, height: asset.height })));
  }

  // Runs once the queue is done — either every photo was adjusted/skipped,
  // or the user hit Cancel partway through — and uploads whatever was
  // actually adjusted. Can run with anywhere from 0 to photoQueue.length
  // uris.
  async function finishPhotoQueue(adjustedUris: string[]) {
    setPhotoQueue([]);
    setQueueIndex(0);
    setQueueAdjustedUris([]);
    if (adjustedUris.length === 0 || !currentUserId) return;
    try {
      const { failed } = await addGalleryImages(currentUserId, adjustedUris);
      if (failed > 0) {
        Alert.alert(
          'Some photos failed',
          `${failed} of ${adjustedUris.length} photo${adjustedUris.length === 1 ? '' : 's'} could not be uploaded. The rest were added.`,
        );
      }
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    }
  }

  function handleQueuedPhotoAdjusted(uri: string) {
    const adjusted = [...queueAdjustedUris, uri];
    if (queueIndex + 1 < photoQueue.length) {
      setQueueAdjustedUris(adjusted);
      setQueueIndex(queueIndex + 1);
    } else {
      finishPhotoQueue(adjusted);
    }
  }

  // Skip discards only the current photo and continues to the next one —
  // distinct from Cancel below, which stops the whole remaining queue.
  function handleQueuedPhotoSkipped() {
    if (queueIndex + 1 < photoQueue.length) {
      setQueueIndex(queueIndex + 1);
    } else {
      finishPhotoQueue(queueAdjustedUris);
    }
  }

  // Cancel stops the ENTIRE remaining queue (this photo plus every
  // unprocessed one after it) but keeps whatever was already accepted via
  // Use Photo earlier in this same batch — never silently treated the same
  // as Skip.
  function handleQueueCancelled() {
    finishPhotoQueue(queueAdjustedUris);
  }

  async function handleRemovePhoto(imageId: string) {
    try {
      await removeGalleryImage(imageId);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not remove photo.');
    }
  }

  async function handleSetPrimaryPhoto(imageId: string) {
    try {
      await setPrimaryGalleryImage(imageId);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not update cover photo.');
    }
  }

  async function handleReorderPhotos(orderedIds: string[]) {
    try {
      await reorderGalleryImages(orderedIds);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not reorder photos.');
    }
  }

  async function handleSave() {
    if (!item || !form || !currentUserId) return;
    setSaving(true);
    try {
      // image_url is no longer written here — it's owned exclusively by the
      // gallery helpers (lib/item-images.ts), which keep it synced to
      // whichever photo is currently primary as soon as a gallery action
      // happens, independent of this Save button.
      const { data: updated, error } = await supabase
        .from('collection_items')
        .update({
          title: form.title.trim() || null,
          player: form.player.trim() || null,
          team: form.team.trim() || null,
          year: form.year ? parseInt(form.year, 10) : null,
          brand: form.brand.trim() || null,
          grade: form.grade.trim() || null,
          grading_company: form.gradingCompany.trim() || null,
          serial_number: form.serialNumber.trim() || null,
          estimated_value: form.estimatedValue ? parseFloat(form.estimatedValue) : null,
          description: form.description.trim() || null,
          is_public: editItemIsPublic,
        })
        .eq('id', item.id)
        .select()
        .single();

      if (error) throw new Error('Failed to save changes. Please try again.');
      if (updated) {
        setItem(updated);
        setForm(itemToForm(updated));
        setEditItemIsPublic(updated.is_public);
      }
      setEditMode(false);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  // Move Item — the modal itself owns the folder picker UI and the
  // folder_id UPDATE (including its own error handling/re-entrancy guard);
  // this screen only owns reflecting the confirmed result: update local
  // `item` state so the new folder is visible immediately (no refetch
  // needed), close the picker, and show a brief non-blocking confirmation.
  // Source/destination folder screens (Collections tab, folder detail) are
  // not told about this directly — both already re-fetch their own folder/
  // item queries on every useFocusEffect refocus, so navigating back to
  // either after a move picks it up automatically, same as every other
  // cross-screen mutation in this app.
  // MoveItemModal now returns only the destination folder id (it shares
  // move_collection_items with bulk mode, which only ever returns a moved
  // row count, not full rows) — a move never touches anything about the
  // item besides its folder_id, so patching that one field locally is
  // exactly as correct as replacing the whole row would be, with no extra
  // round-trip.
  function handleItemMoved(destinationFolderId: string, folderName: string) {
    setItem((prev) => (prev ? { ...prev, folder_id: destinationFolderId } : prev));
    setShowMoveModal(false);
    Alert.alert('Moved', `Moved to ${folderName}`);
  }

  // Reconciliation for the two ambiguous delete outcomes (resolved {error}
  // and thrown exception) — both can mean either "never committed" or
  // "committed but the response was lost", and the two are indistinguishable
  // from the client's perspective without an authoritative re-read.
  //
  // Queries by id only, with no .eq('user_id', ...) filter — but this is
  // always the CALLER'S OWN just-attempted delete (handleDelete is
  // owner-gated), and items_select_public's owner clause (auth.uid() =
  // collection_items.user_id) grants the owner full read access regardless
  // of either the folder's or the item's own is_public flag (see
  // supabase/migrations/20260819120000_enforce_collection_folder_privacy.sql
  // and 20260825120000_add_collection_item_privacy.sql). So a null result
  // here still reliably means "this row does not exist" for this specific
  // caller, never "exists but hidden from this viewer" — this is
  // authoritative for "does the item still exist", which is the only
  // question that matters for reconciling a delete this user already
  // issued. (It is NOT authoritative in general — a non-owner's SELECT can
  // return null for a row that exists but is private to them; that's an
  // intentional RLS property, not a bug, and irrelevant here since this
  // function is never called for anyone but the owner.)
  //
  // Catches its own read failure internally so it never rethrows into a
  // second reconciliation attempt.
  async function reconcileItemDeleteAfterError(itemId: string, capturedPaths: string[]) {
    try {
      const { data, error } = await supabase
        .from('collection_items')
        .select('id')
        .eq('id', itemId)
        .maybeSingle();

      if (error) {
        console.error('[ItemDetail] reconciliation read failed:', error.message, error);
        Alert.alert(
          'Delete status unknown',
          "We couldn't confirm whether the item was deleted. Refresh your collection before trying again.",
        );
        return;
      }

      if (data === null) {
        await cleanupOrphanedItemImages(capturedPaths);
        router.back();
        return;
      }

      console.error('[ItemDetail] reconciliation confirms item still exists:', { itemId });
      Alert.alert('Delete failed', 'This item could not be deleted. Please try again.');
    } catch (e) {
      console.error('[ItemDetail] reconciliation read threw:', e);
      Alert.alert(
        'Delete status unknown',
        "We couldn't confirm whether the item was deleted. Refresh your collection before trying again.",
      );
    }
  }

  // deletingRef is the actual re-entry lock: it's acquired synchronously
  // here, before Alert.alert is even shown, so a second tap on the delete
  // button while the confirmation dialog is already open bails out above
  // without ever queueing a second dialog. It's released on Cancel and on
  // Android's outside-tap/back-button dismissal (onDismiss below); on
  // Delete it stays held through the whole mutation and is only released in
  // the mutation's own finally. `settled` (local per invocation, not state)
  // distinguishes "a button already claimed this dismissal" from a bare
  // onDismiss, since Android fires onDismiss after every button press too —
  // without that guard, onDismiss would immediately re-release the lock
  // while the Delete mutation it just started is still in flight.
  // `deleting` (React state) is separate: it only reflects the actual
  // mutation/loading window, for button UI, not the confirmation-dialog
  // window.
  function handleDelete() {
    if (deletingRef.current) return;
    deletingRef.current = true;

    let settled = false;

    const title = isTransferredOut ? 'Remove from Collection?' : 'Delete Item';
    const body = isTransferredOut
      ? 'This permanently removes this historical item from your collection. It will not affect the transferred Cache ID or the recipient\'s ownership.'
      : 'Are you sure? This cannot be undone.';
    Alert.alert(
      title,
      body,
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => {
            settled = true;
            deletingRef.current = false;
          },
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            settled = true;
            if (!currentUserId) {
              deletingRef.current = false;
              return;
            }

            setDeleting(true);

            // Gallery storage_path values must be captured before the
            // parent DELETE — ON DELETE CASCADE destroys the
            // collection_item_images rows the instant it commits, so this
            // is the last point they're readable. Best-effort only: Storage
            // cleanup must never block the authoritative item deletion.
            let capturedPaths: string[] = [];
            try {
              const { data: galleryRows, error: galleryReadError } = await supabase
                .from('collection_item_images')
                .select('storage_path')
                .eq('item_id', id);
              if (!galleryReadError && galleryRows) {
                capturedPaths = galleryRows.map((r) => r.storage_path).filter((p): p is string => !!p);
              }
            } catch (galleryReadErr) {
              if (__DEV__) {
                console.warn('[ItemDetail] pre-delete gallery path capture failed:', galleryReadErr);
              }
            }

            // No manual posts cleanup here — posts.item_id is FK'd to
            // collection_items(id) ON DELETE SET NULL (see supabase/
            // schema.sql), so any post referencing this item is preserved
            // (its own image_url/caption are already denormalized onto the
            // post row at creation time) and just loses its "view original
            // card" link, exactly like the card_share_items/
            // rate_my_grail_cards snapshot pattern. A manual delete()...
            // eq('item_id', id) here would be a second, non-atomic
            // destructive operation — if it succeeded but the item delete
            // below then failed, the user's feed post would be gone while
            // the collection item survived.

            try {
              // .select('id') is what makes a silently-zero-row delete (e.g.
              // an RLS/ownership mismatch) detectable at all — without it, a
              // DELETE whose WHERE clause (id + the RLS USING policy)
              // matches nothing still returns { error: null },
              // indistinguishable from success. The .eq('user_id',
              // currentUserId) is a defense-in-depth client-side ownership
              // check on top of RLS, not a replacement for it.
              const { data: deletedRows, error: deleteError } = await supabase
                .from('collection_items')
                .delete()
                .eq('id', id)
                .eq('user_id', currentUserId)
                .select('id');

              if (deleteError) {
                console.error('[ItemDetail] delete failed:', deleteError.message, deleteError);
                await reconcileItemDeleteAfterError(id, capturedPaths);
                return;
              }

              if (!deletedRows || deletedRows.length === 0) {
                console.error('[ItemDetail] delete returned zero rows:', { itemId: id, currentUserId });
                Alert.alert('Delete failed', 'No item was deleted. Check ownership and database permissions.');
                return;
              }

              await cleanupOrphanedItemImages(capturedPaths);
              router.back();
            } catch (e) {
              console.error('[ItemDetail] delete threw:', e);
              await reconcileItemDeleteAfterError(id, capturedPaths);
            } finally {
              deletingRef.current = false;
              setDeleting(false);
            }
          },
        },
      ],
      {
        cancelable: true,
        onDismiss: () => {
          if (!settled) {
            deletingRef.current = false;
          }
        },
      },
    );
  }

  function handleRegisterPress() {
    if (!item || !isOwner || registering) return;
    Alert.alert(
      'Register with CacheCase?',
      'Registration creates a permanent CacheCase identity and provenance record for this physical card.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Register',
          onPress: async () => {
            const { error, registeredCardId } = await registerItem({
              serialNumber: item.serial_number,
              gradeCompany: item.grading_company,
              grade: item.grade,
            });
            if (!error) return;

            // registeredCardId is only present when the registered_cards
            // row itself was created — i.e. the failure is scoped to the
            // durable image copy, not the registration itself. Retrying
            // here re-invokes only that copy (via retrySnapshotImage), and
            // never register_card again, so it can't produce a duplicate
            // registration or the "already registered" rejection a full
            // re-registration attempt would hit.
            if (registeredCardId) {
              Alert.alert('Registry image not saved', error, [
                { text: 'Later', style: 'cancel' },
                {
                  text: 'Retry',
                  onPress: async () => {
                    const { error: retryError } = await retrySnapshotImage(registeredCardId);
                    if (retryError) {
                      Alert.alert('Retry failed', retryError);
                    }
                  },
                },
              ]);
            } else {
              Alert.alert('Registration failed', error);
            }
          },
        },
      ],
    );
  }

  function handleViewRegistry() {
    if (!registeredCard) return;
    router.push({ pathname: '/registry/[id]', params: { id: registeredCard.id } });
  }

  // Consolidated CacheCase ID entry point — replaces the old ItemActionBar
  // logo button's placeholder sheet. Reuses handleViewRegistry rather than
  // duplicating the navigation call.
  function handleCacheCaseIdPress() {
    if (registryLoading) return;
    if (registeredCard) {
      handleViewRegistry();
      return;
    }
    Alert.alert('Not Registered', 'This card has not been registered with CacheCase yet.');
  }

  async function handleGrailsToggle() {
    if (!item) return;
    setGrailsLoading(true);
    if (isInGrails(item.id)) {
      await removeFromGrails(item.id);
    } else {
      await addToGrails(item.id);
    }
    setGrailsLoading(false);
  }

  // View-mode carousel now renders through the signed-delivery Edge
  // Function (item-images beta privacy hardening, Phase 3) instead of each
  // row's raw public image_url — one batched call for the whole gallery,
  // fired the moment `galleryImages` itself is known (see useItemImages),
  // never waiting on anything else first.
  const galleryImageIds = useMemo(() => galleryImages.map((img) => img.id), [galleryImages]);
  const { urls: signedGalleryUrls, statuses: signedGalleryStatuses } = useSignedItemImages(galleryImageIds);

  // Gallery STRUCTURE vs. IMAGE AVAILABILITY are deliberately separate here.
  // One carouselImages entry per gallery row, ALWAYS — never filtered down
  // to only the rows whose signed URL has resolved so far. That filtering
  // used to be exactly what made a 2-photo item render as a single,
  // non-paginated image for however long signing took: galleryImageUrls
  // (the old plain string[]) only grew to length 2 once BOTH signed URLs
  // were in, so ItemImageCarousel never even learned a second photo
  // existed until then. Now `carouselImages.length` reflects the gallery
  // row count immediately; a still-unresolved row just carries `uri:
  // undefined` and its own real `status` ('loading' or 'unavailable', read
  // straight off useSignedItemImages' existing statuses map — no second
  // signing call) and fills in, in place, once its own url resolves — the
  // array's own length/order never changes at that point, only that one
  // entry's `uri`/`status`. This is also what lets ItemImageCarousel show
  // an honest "still loading" spinner instead of "No image" for a slide
  // that simply hasn't resolved yet (see CarouselImage's own status
  // comment in item-image-carousel.tsx). Falls back to the legacy single
  // image_url only when the gallery genuinely has no rows yet (a rare gap
  // Phase 1A's backfill — and enterEdit's self-heal — mostly close); that
  // narrow fallback has no real collection_item_images.id (a stable
  // synthetic one is used purely as a React/FlatList key) and no signing
  // status at all — it's either a real, permanent uri or nothing, so
  // `status` is left unset there, which ItemImageCarousel already treats
  // as "not loading" (i.e. genuinely unavailable, never a fake spinner).
  const carouselImages: CarouselImage[] = useMemo(() => {
    if (galleryImages.length > 0) {
      return galleryImages.map((img) => ({
        id: img.id,
        uri: signedGalleryUrls.get(img.id),
        status: signedGalleryStatuses.get(img.id),
      }));
    }
    return buildItemImageList([item?.image_url]).map((uri, i) => ({
      id: `legacy-${item?.id ?? 'unknown'}-${i}`,
      uri,
    }));
  }, [galleryImages, signedGalleryUrls, signedGalleryStatuses, item?.image_url, item?.id]);

  const headerTitle = editMode ? 'Edit Item' : (item?.title ?? 'Item Detail');

  if (fetching) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ headerShown: false }} />
        <ItemDetailHeaderBar
          insetsTop={insets.top}
          title="Item Detail"
          left={<BackButton fallbackHref="/(tabs)" />}
        />
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      </View>
    );
  }

  if (!item || !form) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ headerShown: false }} />
        <ItemDetailHeaderBar
          insetsTop={insets.top}
          title="Item Not Found"
          left={<BackButton fallbackHref="/(tabs)" />}
        />
        <View style={styles.center}>
          <Text style={styles.errorText}>Item not found.</Text>
        </View>
      </View>
    );
  }

  const identity = buildIdentity(item);
  const metadataRows = buildMetadataRows(item);
  const transferredOutDateLabel = formatTransferredOutDate(item.transferred_out_at);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Non-owner viewers no longer get a header-right control at all —
          the ItemActionBar bookmark (lower on the screen) is now the sole
          bookmark entry point; see that component for the
          cardSaved/toggleCardSave/savingCard wiring, still owned by this
          same useSavedCard() call below. */}
      <ItemDetailHeaderBar
        insetsTop={insets.top}
        title={headerTitle}
        left={
          editMode ? (
            <TouchableOpacity onPress={cancelEdit} style={styles.headerBtn}>
              <Text style={[styles.headerBtnText, styles.cancelBtnText]}>Cancel</Text>
            </TouchableOpacity>
          ) : (
            <BackButton fallbackHref="/(tabs)" />
          )
        }
        right={
          isOwner && !isTransferredOut ? (
            editMode ? (
              <TouchableOpacity onPress={handleSave} disabled={saving} style={styles.headerBtn}>
                {saving ? (
                  <ActivityIndicator size="small" color="#0a7ea4" />
                ) : (
                  <Text style={styles.headerBtnText}>Save</Text>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={enterEdit} style={styles.headerBtn}>
                <Text style={styles.headerBtnText}>Edit</Text>
              </TouchableOpacity>
            )
          ) : undefined
        }
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? undefined : 'height'}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          onScroll={navbarOnScroll}
          scrollEventThrottle={navbarScrollEventThrottle}>

          {/* Instagram-style owner identity row — avatar + @username,
              directly above the hero image below. Shown for every viewer
              (owner included, same as Instagram's own post header), purely
              a navigation/identity row: no edit affordance, and it doesn't
              affect the existing owner-only card further down the screen
              (that one stays gated to !isOwner). */}
          {ownerProfile && (
            <ItemOwnerRow
              username={ownerProfile.username}
              avatarUrl={ownerProfile.avatar_url}
              onPress={() =>
                navigateToProfile(router, currentUserId, item?.user_id ?? '', ownerProfile.username)
              }
            />
          )}

          {/* Hero — edit mode shows the editable gallery manager (add/
              remove/reorder/set cover); view mode shows the swipeable
              carousel. Both read from the same useItemImages data, so what
              you arrange in edit mode is exactly what view mode swipes
              through. The carousel's own tap is reserved for a future
              full-screen viewer. */}
          {editMode ? (
            <ItemImageGalleryManager
              images={galleryImages}
              loading={galleryLoading}
              mutating={galleryMutating}
              maxImages={MAX_ITEM_IMAGES}
              onAdd={handleAddPhotos}
              onRemove={handleRemovePhoto}
              onSetPrimary={handleSetPrimaryPhoto}
              onReorder={handleReorderPhotos}
            />
          ) : (
            <ItemImageCarousel images={carouselImages} />
          )}

          {editMode ? (
            /* ── Edit Mode (owner only) — existing form, plus the Private
                Item toggle below (same dynamic label/helper pattern as
                create-folder-modal.tsx / folder-edit-modal.tsx). ── */
            <View style={styles.editSection}>
              <Text style={editStyles.sectionHeader}>Card Details</Text>
              <EditField label="Title" value={form.title} onChange={updateField('title')} />
              <EditField label="Player" value={form.player} onChange={updateField('player')} />
              <EditField label="Team" value={form.team} onChange={updateField('team')} />
              <EditField label="Year" value={form.year} onChange={updateField('year')} extra={{ keyboardType: 'number-pad', maxLength: 4 }} />

              <Text style={editStyles.sectionHeader}>Card Info</Text>
              <EditField label="Brand" value={form.brand} onChange={updateField('brand')} />
              <EditField label="Grade" value={form.grade} onChange={updateField('grade')} extra={{ autoCapitalize: 'characters' }} />
              <EditField label="Grading Company" value={form.gradingCompany} onChange={updateField('gradingCompany')} />
              <EditField label="Serial Number" value={form.serialNumber} onChange={updateField('serialNumber')} />

              <Text style={editStyles.sectionHeader}>Value</Text>
              <EditField label="Estimated Value ($)" value={form.estimatedValue} onChange={updateField('estimatedValue')} extra={{ keyboardType: 'decimal-pad' }} />

              <Text style={editStyles.sectionHeader}>Notes</Text>
              <View style={editStyles.wrap}>
                <Text style={editStyles.label}>Description</Text>
                <TextInput
                  style={[editStyles.input, { height: 100, paddingTop: 12 }]}
                  value={form.description}
                  onChangeText={updateField('description')}
                  placeholder="Description"
                  placeholderTextColor="#999"
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                />
              </View>

              {/* Private Item toggle — editItemIsPublic is the field that's
                  actually persisted (see handleSave's update above);
                  editItemIsPrivate is display-only. */}
              <View style={editStyles.toggleRow}>
                <View style={editStyles.toggleTextArea}>
                  <Text style={editStyles.toggleTitle}>
                    {editItemIsPrivate ? 'Private Item' : 'Public Item'}
                  </Text>
                  <Text style={editStyles.toggleHint}>
                    {editItemIsPrivate ? 'Only you can view this item.' : 'Anyone can view this item.'}
                  </Text>
                </View>
                <Switch
                  value={editItemIsPrivate}
                  onValueChange={(value) => setEditItemIsPublic(!value)}
                  trackColor={{ true: '#0a7ea4' }}
                />
              </View>

              {/* Move Item — Phase 1 (single item, no bulk/drag-drop). Opens
                  MoveItemModal's folder picker; that modal owns the actual
                  UPDATE + its own error/re-entrancy handling, this screen
                  only reacts to a confirmed move via handleItemMoved. */}
              <Text style={editStyles.sectionHeader}>Organization</Text>
              <TouchableOpacity
                style={editStyles.moveRow}
                onPress={() => setShowMoveModal(true)}
                activeOpacity={0.7}>
                <Text style={editStyles.moveRowLabel}>Move to Another Folder</Text>
                <IconSymbol name="chevron.right" size={16} color={PV2.textTertiary} />
              </TouchableOpacity>

              {/* Delete Item — moved here from the normal Item Detail view
                  (Save/Cancel live in the header, not this form body, so
                  this is already well separated from them by scroll
                  distance alone; the top divider/spacing below adds a
                  further visual break from the privacy toggle above).
                  Reuses handleDelete unchanged — same confirmation Alert,
                  same DB/Storage cleanup, same navigation, same
                  reconciliation-on-error path as before. */}
              <View style={editStyles.deleteSection}>
                <TouchableOpacity style={styles.deleteButton} onPress={handleDelete} disabled={deleting}>
                  <Text style={styles.deleteText}>Delete Item</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : isTransferredOut ? (
            /* ── Transferred Out — one top-level conditional replacing the
                whole normal action area, rather than hiding many
                individual controls. No edit, register, relink, custody,
                transfer, or gallery-edit action exists in this branch at
                all — only the three explicitly allowed actions below. The
                item's own identity/description/metadata still render, as
                historical information. */
            <>
              <View style={styles.transferredOutBanner}>
                <Text style={styles.transferredOutTitle}>Transferred Out</Text>
                <Text style={styles.transferredOutBody}>This card is no longer in your collection.</Text>
                {transferredOutDateLabel && (
                  <Text style={styles.transferredOutDate}>Transferred on {transferredOutDateLabel}</Text>
                )}
              </View>

              <ItemIdentity title={identity.title} subtitleLines={identity.subtitleLines} />

              <ItemDescription description={item.description} />

              <ItemMetadataSection rows={metadataRows} />

              {isOwner && (
                <View style={styles.ownerActions}>
                  {item.transferred_registered_card_id && (
                    <>
                      <TouchableOpacity
                        style={styles.transferredOutActionButton}
                        onPress={() =>
                          router.push({
                            pathname: '/registry/[id]',
                            params: { id: item.transferred_registered_card_id! },
                          })
                        }
                        activeOpacity={0.8}>
                        <Text style={styles.transferredOutActionText}>View Registry</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.transferredOutActionButton}
                        onPress={() =>
                          router.push({
                            pathname: '/registry-history/[id]',
                            params: { id: item.transferred_registered_card_id! },
                          })
                        }
                        activeOpacity={0.8}>
                        <Text style={styles.transferredOutActionText}>View Registry History</Text>
                      </TouchableOpacity>
                    </>
                  )}
                  <TouchableOpacity style={styles.deleteButton} onPress={handleDelete} disabled={deleting}>
                    <Text style={styles.deleteText}>Remove from Collection</Text>
                  </TouchableOpacity>
                </View>
              )}
            </>
          ) : (
            /* ── View Mode — the new permanent layout ── */
            <>
              <ItemActionBar
                onPressCacheCaseId={handleCacheCaseIdPress}
                isSaved={!isOwner ? cardSaved : undefined}
                onPressBookmark={!isOwner ? toggleCardSave : undefined}
                savingBookmark={savingCard}
              />

              <ItemIdentity title={identity.title} subtitleLines={identity.subtitleLines} />

              {/* Owner card — only ever reachable for non-owners, since
                  entering edit mode is gated to isOwner above. */}
              {!isOwner && ownerProfile && (
                <TouchableOpacity
                  style={styles.ownerCard}
                  onPress={() =>
                    router.push({
                      pathname: '/user/[username]',
                      params: { username: ownerProfile.username },
                    })
                  }
                  activeOpacity={0.7}>
                  <View style={styles.ownerAvatar}>
                    {ownerProfile.avatar_url ? (
                      <Image
                        source={{ uri: ownerProfile.avatar_url }}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                        transition={200}
                      />
                    ) : (
                      <View style={[StyleSheet.absoluteFill, styles.ownerAvatarPlaceholder]}>
                        <Text style={styles.ownerAvatarInitial}>
                          {(ownerProfile.display_name || ownerProfile.username).charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.ownerName}>
                    {ownerProfile.display_name || ownerProfile.username}
                  </Text>
                  <Text style={styles.ownerUsername}>@{ownerProfile.username}</Text>
                </TouchableOpacity>
              )}

              <ItemDescription description={item.description} />

              <ItemMetadataSection rows={metadataRows} />

              <RelatedItemsGrid />

              {isOwner && (
                <View style={styles.ownerActions}>
                  {registryLoading ? (
                    <View style={styles.registryLoadingWrap}>
                      <ActivityIndicator size="small" color={PV2.textTertiary} />
                    </View>
                  ) : registeredCard ? null : (
                    <TouchableOpacity
                      style={styles.registerButton}
                      onPress={handleRegisterPress}
                      disabled={registering}
                      activeOpacity={0.8}>
                      {registering ? (
                        <>
                          <ActivityIndicator color="#fff" />
                          <Text style={styles.registerButtonText}>Registering…</Text>
                        </>
                      ) : (
                        <>
                          <Text style={styles.registerButtonText}>Register with CacheCase</Text>
                          <Text style={styles.registerButtonSubtext}>
                            Create a permanent CacheCase identity and provenance record for this physical card.
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}

                  {(() => {
                    const inGrails = isInGrails(item.id);
                    const disabled = !inGrails && isFull;
                    return (
                      <TouchableOpacity
                        style={[
                          styles.grailsButton,
                          inGrails && styles.grailsButtonRemove,
                          disabled && styles.grailsButtonDisabled,
                        ]}
                        onPress={handleGrailsToggle}
                        disabled={grailsLoading || disabled}
                        activeOpacity={0.8}>
                        {grailsLoading ? (
                          <ActivityIndicator color={inGrails ? '#C9952C' : '#fff'} />
                        ) : (
                          <Text
                            style={[
                              styles.grailsText,
                              inGrails && styles.grailsTextRemove,
                              disabled && styles.grailsTextDisabled,
                            ]}>
                            {inGrails ? 'Remove from Grails' : disabled ? 'Grails Full' : 'Add to Grails'}
                          </Text>
                        )}
                      </TouchableOpacity>
                    );
                  })()}
                </View>
              )}
            </>
          )}

        </ScrollView>
      </KeyboardAvoidingView>

      {isOwner && (
        <MoveItemModal
          mode="single"
          visible={showMoveModal}
          item={item}
          currentUserId={currentUserId}
          onClose={() => setShowMoveModal(false)}
          onMoved={handleItemMoved}
        />
      )}

      {photoQueue.length > 0 && (
        <PhotoAdjuster
          uri={photoQueue[queueIndex].uri}
          imageWidth={photoQueue[queueIndex].width}
          imageHeight={photoQueue[queueIndex].height}
          progressLabel={photoQueue.length > 1 ? `Photo ${queueIndex + 1} of ${photoQueue.length}` : undefined}
          onUse={handleQueuedPhotoAdjusted}
          onSkip={photoQueue.length > 1 ? handleQueuedPhotoSkipped : undefined}
          onCancel={handleQueueCancelled}
        />
      )}
    </View>
  );
}

const editStyles = StyleSheet.create({
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.40)',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 12,
  },
  wrap: {
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.50)',
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: PV2.collectorPanelBg,
    color: PV2.textPrimary,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 10,
    padding: 16,
    marginTop: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  toggleTextArea: {
    flex: 1,
    marginRight: 12,
  },
  toggleTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  toggleHint: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.50)',
    marginTop: 2,
  },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  moveRowLabel: {
    fontSize: 15,
    color: PV2.textPrimary,
  },
  // Visually separates the destructive Delete Item action (below) from the
  // normal editable controls above it (fields, then the privacy toggle) —
  // same top-divider convention as the view-mode ownerActions section.
  deleteSection: {
    marginTop: 28,
    paddingTop: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
  },
});

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.bg,
  },
  errorText: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  headerBtn: {
    paddingHorizontal: 4,
  },
  headerBtnText: {
    color: '#0a7ea4',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelBtnText: {
    color: '#687076',
  },
  scroll: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  content: {
    paddingBottom: 48,
  },
  // Owner profile — shrinks to content so only the avatar+name area is tappable
  ownerCard: {
    flexDirection: 'column',
    alignItems: 'center',
    alignSelf: 'center',
    marginTop: 16,
    gap: 4,
  },
  ownerAvatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    overflow: 'hidden',
    backgroundColor: '#2A2A2A',
    marginBottom: 2,
  },
  ownerAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ownerAvatarInitial: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  ownerName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  ownerUsername: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.50)',
    textAlign: 'center',
  },
  // Owner-only management actions — kept at the very bottom, out of the
  // primary browsing flow, per the "understated" design direction.
  ownerActions: {
    marginTop: 32,
    paddingHorizontal: 20,
    gap: 12,
  },
  registryLoadingWrap: {
  minHeight: 104,
  paddingVertical: 18,
  alignItems: 'center',
  justifyContent: 'center',
},
registerButton: {
  backgroundColor: '#A08CDC',
  borderRadius: 12,
  paddingVertical: 15,
  paddingHorizontal: 18,
  alignItems: 'center',
  gap: 5,
},
registerButtonText: {
  color: '#fff',
  fontSize: 16,
  fontWeight: '700',
},
registerButtonSubtext: {
  color: 'rgba(255,255,255,0.82)',
  fontSize: 12,
  textAlign: 'center',
  lineHeight: 17,
  maxWidth: 290,
},
registryStatusCard: {
  borderRadius: 12,
  borderWidth: 1,
  borderColor: 'rgba(160,140,220,0.38)',
  backgroundColor: 'rgba(160,140,220,0.10)',
  paddingVertical: 16,
  paddingHorizontal: 18,
  alignItems: 'center',
  gap: 9,
},
registryStatusRow: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 7,
},
registryStatusDot: {
  width: 8,
  height: 8,
  borderRadius: 4,
  backgroundColor: '#34C759',
},
registryStatusText: {
  color: 'rgba(255,255,255,0.86)',
  fontSize: 13,
  fontWeight: '700',
  letterSpacing: 0.3,
  textTransform: 'uppercase',
},
registryCcId: {
  color: '#fff',
  fontSize: 20,
  fontWeight: '800',
  letterSpacing: 1.2,
},
registryViewButton: {
  marginTop: 5,
  minHeight: 40,
  paddingVertical: 10,
  paddingHorizontal: 20,
  borderRadius: 20,
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.24)',
  backgroundColor: 'rgba(255,255,255,0.07)',
  alignItems: 'center',
  justifyContent: 'center',
},
registryViewButtonText: {
  color: '#fff',
  fontSize: 14,
  fontWeight: '700',
},
  grailsButton: {
    backgroundColor: '#0a7ea4',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  grailsButtonRemove: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#C9952C',
  },
  grailsButtonDisabled: {
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  grailsText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  grailsTextRemove: {
    color: '#C9952C',
  },
  grailsTextDisabled: {
    color: '#999',
  },
  deleteButton: {
    borderWidth: 1,
    borderColor: '#FF3B30',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  deleteText: {
    color: '#FF3B30',
    fontSize: 16,
    fontWeight: '600',
  },
  transferredOutBanner: {
    marginHorizontal: 20,
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  transferredOutTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: PV2.accent,
  },
  transferredOutBody: {
    marginTop: 4,
    fontSize: 13,
    color: PV2.textSecondary,
  },
  transferredOutDate: {
    marginTop: 8,
    fontSize: 12,
    color: PV2.textTertiary,
  },
  transferredOutActionButton: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: PV2.border,
    backgroundColor: PV2.panel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transferredOutActionText: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  editSection: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 24,
  },
});
