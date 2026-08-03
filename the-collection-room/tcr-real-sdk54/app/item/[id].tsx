import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { HeaderBackButton } from '@react-navigation/elements';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ItemActionBar } from '@/components/item-detail/item-action-bar';
import { ItemDescription } from '@/components/item-detail/item-description';
import { ItemIdentity } from '@/components/item-detail/item-identity';
import { buildItemImageList, ItemImageCarousel } from '@/components/item-detail/item-image-carousel';
import { ItemImageGalleryManager } from '@/components/item-detail/item-image-gallery-manager';
import { ItemMetadataSection, type MetadataRow } from '@/components/item-detail/item-metadata-section';
import { RelatedItemsGrid } from '@/components/item-detail/related-items-grid';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BookmarkButton } from '@/components/ui/bookmark-button';
import { useGrails } from '@/hooks/use-grails';
import { useItemImages } from '@/hooks/use-item-images';
import { useRegisteredCardForItem } from '@/hooks/use-registered-card';
import { useSavedCard } from '@/hooks/use-saved';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { materializeLegacyItemImage, MAX_ITEM_IMAGES } from '@/lib/item-images';
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
  const [saving, setSaving] = useState(false);
  const [grailsLoading, setGrailsLoading] = useState(false);

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

        if (data.user_id !== currentUserId) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('username, display_name, avatar_url')
            .eq('id', data.user_id)
            .single();
          if (profile) setOwnerProfile(profile as OwnerProfile);
        }
      }
      setFetching(false);
    }
    fetchItem();
  }, [id, currentUserId]);

  // Guarded back handler — every entry point into this screen uses
  // router.push (never replace), so a stack entry should normally exist.
  // canGoBack() is checked anyway as a safety net for the rare case this
  // screen is the root of its stack (e.g. opened via a deep link).
  function handleBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)');
  }

  // Legacy items (and, defensively, any item whose creation-time gallery
  // row is somehow missing) predate this feature and only have
  // collection_items.image_url — self-heal into a real gallery row on
  // entering edit mode so the gallery manager always operates on real rows
  // (the migration's backfill already does this in bulk for every item
  // that existed at deploy time; this covers the rare gap).
  async function enterEdit() {
    if (!isOwner) return;
    if (item) setForm(itemToForm(item));
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
    if (item) setForm(itemToForm(item));
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
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 0.85,
    });
    if (result.canceled || !result.assets.length) return;

    const uris = result.assets.map((asset) => asset.uri);
    try {
      const { failed } = await addGalleryImages(currentUserId, uris);
      if (failed > 0) {
        Alert.alert(
          'Some photos failed',
          `${failed} of ${uris.length} photo${uris.length === 1 ? '' : 's'} could not be uploaded. The rest were added.`,
        );
      }
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    }
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
        })
        .eq('id', item.id)
        .select()
        .single();

      if (error) throw new Error('Failed to save changes. Please try again.');
      if (updated) {
        setItem(updated);
        setForm(itemToForm(updated));
      }
      setEditMode(false);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const title = isTransferredOut ? 'Remove from Collection?' : 'Delete Item';
    const body = isTransferredOut
      ? 'This permanently removes this historical item from your collection. It will not affect the transferred Cache ID or the recipient\'s ownership.'
      : 'Are you sure? This cannot be undone.';
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (!currentUserId) return;

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
          console.log('[ItemDetail][DEBUG] delete: start', { itemId: id, currentUserId });

          // .select('id') is what makes a silently-zero-row delete (e.g. an
          // RLS/ownership mismatch) detectable at all — without it, a
          // DELETE whose WHERE clause (id + the RLS USING policy) matches
          // nothing still returns { error: null }, indistinguishable from
          // success. The .eq('user_id', currentUserId) is a defense-in-
          // depth client-side ownership check on top of RLS, not a
          // replacement for it.
          const { data: deletedRows, error: deleteError } = await supabase
            .from('collection_items')
            .delete()
            .eq('id', id)
            .eq('user_id', currentUserId)
            .select('id');

          if (deleteError) {
            console.error('[ItemDetail] delete failed:', deleteError.message, deleteError);
            Alert.alert('Delete failed', 'This item could not be deleted. Please try again.');
            return;
          }

          console.log('[ItemDetail][DEBUG] delete: returned rows', {
            deletedIds: deletedRows?.map((r) => r.id) ?? [],
          });

          if (!deletedRows || deletedRows.length === 0) {
            console.error('[ItemDetail] delete returned zero rows:', { itemId: id, currentUserId });
            Alert.alert('Delete failed', 'No item was deleted. Check ownership and database permissions.');
            return;
          }

          console.log('[ItemDetail][DEBUG] delete: confirmed, navigating back', { itemId: id });
          router.back();
        },
      },
    ]);
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
            const { error } = await registerItem({
              serialNumber: item.serial_number,
              gradeCompany: item.grading_company,
              grade: item.grade,
            });
            if (error) {
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

  // Real per-item gallery, ordered primary-first (see useItemImages/
  // lib/item-images.ts). Falls back to the legacy single image_url only
  // when the gallery genuinely has no rows yet (a rare gap the migration's
  // backfill — and enterEdit's self-heal — mostly close); buildItemImageList
  // still runs over that fallback to drop null/duplicate values.
  const galleryImageUrls = useMemo(
    () =>
      galleryImages.length > 0
        ? galleryImages.map((img) => img.image_url)
        : buildItemImageList([item?.image_url]),
    [galleryImages, item?.image_url],
  );
  const headerTitle = editMode ? 'Edit Item' : (item?.title ?? 'Item Detail');

  if (fetching) {
    return (
      <>
        <Stack.Screen options={{ title: 'Item Detail' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      </>
    );
  }

  if (!item || !form) {
    return (
      <>
        <Stack.Screen options={{ title: 'Item Not Found' }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Item not found.</Text>
        </View>
      </>
    );
  }

  const identity = buildIdentity(item);
  const metadataRows = buildMetadataRows(item);
  const transferredOutDateLabel = formatTransferredOutDate(item.transferred_out_at);

  return (
    <>
      <Stack.Screen
        options={{
          title: headerTitle,
          headerBackButtonDisplayMode: 'minimal',
          headerRight: isOwner && !isTransferredOut
            ? () =>
                editMode ? (
                  <TouchableOpacity
                    onPress={handleSave}
                    disabled={saving}
                    style={styles.headerBtn}>
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
            : !!currentUserId
            ? () => (
                <BookmarkButton isSaved={cardSaved} onPress={toggleCardSave} disabled={savingCard} />
              )
            : undefined,
          headerLeft: editMode
            ? () => (
                <TouchableOpacity onPress={cancelEdit} style={styles.headerBtn}>
                  <Text style={[styles.headerBtnText, styles.cancelBtnText]}>Cancel</Text>
                </TouchableOpacity>
              )
            : () => <HeaderBackButton onPress={handleBack} displayMode="minimal" />,
        }}
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
            <ItemImageCarousel images={galleryImageUrls} />
          )}

          {editMode ? (
            /* ── Edit Mode (owner only) — unchanged existing form ── */
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
                  <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
                    <Text style={styles.deleteText}>Remove from Collection</Text>
                  </TouchableOpacity>
                </View>
              )}
            </>
          ) : (
            /* ── View Mode — the new permanent layout ── */
            <>
              <ItemActionBar onPressCacheCaseId={handleCacheCaseIdPress} />

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
                  <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
                    <Text style={styles.deleteText}>Delete Item</Text>
                  </TouchableOpacity>
                </View>
              )}
            </>
          )}

        </ScrollView>
      </KeyboardAvoidingView>
    </>
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
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: '#fafafa',
    color: '#11181C',
  },
});

const styles = StyleSheet.create({
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
