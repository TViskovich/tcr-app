import { useEffect, useState } from 'react';
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

import { PhotoAdjuster } from '@/components/collection/photo-adjuster';
import { ItemActionBar } from '@/components/item-detail/item-action-bar';
import { ItemDescription } from '@/components/item-detail/item-description';
import { ItemHeroImage } from '@/components/item-detail/item-hero-image';
import { ItemIdentity } from '@/components/item-detail/item-identity';
import { ItemMetadataSection, type MetadataRow } from '@/components/item-detail/item-metadata-section';
import { RelatedItemsGrid } from '@/components/item-detail/related-items-grid';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BookmarkButton } from '@/components/ui/bookmark-button';
import { useGrails } from '@/hooks/use-grails';
import { useSavedCard } from '@/hooks/use-saved';
import { useAuth } from '@/lib/auth';
import { uploadItemImage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
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
// keeps its existing form UI, just reusing ItemHeroImage for the "change
// photo" tap instead of a separate renderer.
export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string; fromGrails?: string }>();
  const { session } = useAuth();
  const router = useRouter();
  const currentUserId = session?.user?.id;

  const [item, setItem] = useState<CollectionItem | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);
  const [fetching, setFetching] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [newImageUri, setNewImageUri] = useState<string | null>(null);
  const [pendingNewImageUri, setPendingNewImageUri] = useState<string | null>(null);
  const [pendingNewWidth, setPendingNewWidth] = useState(0);
  const [pendingNewHeight, setPendingNewHeight] = useState(0);
  const [saving, setSaving] = useState(false);
  const [grailsLoading, setGrailsLoading] = useState(false);

  const { isFull, isInGrails, addToGrails, removeFromGrails } = useGrails(currentUserId);
  const { isSaved: cardSaved, saving: savingCard, toggle: toggleCardSave } = useSavedCard(id, currentUserId);

  const isOwner = !!currentUserId && item?.user_id === currentUserId;

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

  function enterEdit() {
    if (!isOwner) return;
    if (item) setForm(itemToForm(item));
    setNewImageUri(null);
    setEditMode(true);
  }

  function cancelEdit() {
    if (item) setForm(itemToForm(item));
    setNewImageUri(null);
    setPendingNewImageUri(null);
    setEditMode(false);
  }

  function updateField(key: keyof EditForm) {
    return (value: string) =>
      setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function pickNewImage() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setPendingNewImageUri(asset.uri);
      setPendingNewWidth(asset.width);
      setPendingNewHeight(asset.height);
    }
  }

  async function handleSave() {
    if (!item || !form || !currentUserId) return;
    setSaving(true);
    try {
      let imageUrl = item.image_url;
      if (newImageUri) {
        try {
          imageUrl = await uploadItemImage(newImageUri, currentUserId);
        } catch {
          throw new Error('Image upload failed. Check your connection and try again.');
        }
      }

      const { data: updated, error } = await supabase
        .from('collection_items')
        .update({
          image_url: imageUrl,
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
      setNewImageUri(null);
      setEditMode(false);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    Alert.alert('Delete Item', 'Are you sure? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error: postError } = await supabase
            .from('posts')
            .delete()
            .eq('item_id', id);
          if (postError) {
            console.error('[handleDelete] post cleanup failed:', postError.message);
            Alert.alert('Error', 'Could not remove feed post. Item was not deleted.');
            return;
          }

          const { error } = await supabase
            .from('collection_items')
            .delete()
            .eq('id', id);
          if (error) {
            Alert.alert('Error', error.message);
          } else {
            router.back();
          }
        },
      },
    ]);
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

  const displayImage = newImageUri ?? item?.image_url ?? null;
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

  return (
    <>
      <Stack.Screen
        options={{
          title: headerTitle,
          headerBackButtonDisplayMode: 'minimal',
          headerRight: isOwner
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
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>

          {/* Hero — tap reserved for a future full-screen viewer in view
              mode; in edit mode it opens the existing photo picker. */}
          <ItemHeroImage
            imageUrl={displayImage}
            editMode={editMode}
            onPress={editMode ? pickNewImage : undefined}
          />

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
          ) : (
            /* ── View Mode — the new permanent layout ── */
            <>
              <ItemActionBar />

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

      {pendingNewImageUri && (
        <PhotoAdjuster
          uri={pendingNewImageUri}
          imageWidth={pendingNewWidth}
          imageHeight={pendingNewHeight}
          onUse={(uri) => {
            setNewImageUri(uri);
            setPendingNewImageUri(null);
          }}
          onCancel={() => setPendingNewImageUri(null)}
        />
      )}
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
  editSection: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 24,
  },
});
