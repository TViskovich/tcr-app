import { useEffect, useRef, useState } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
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

import { HeaderBackButton } from '@react-navigation/elements';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { PhotoAdjuster } from '@/components/collection/photo-adjuster';
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

function formatValue(value: number | null) {
  return value != null ? `$${value.toFixed(2)}` : null;
}

function MetaRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
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

// ── Card back face ────────────────────────────────────────────────────────────

function StatCell({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <View style={backStyles.statCell}>
      <Text style={[backStyles.statLabel, { color: accent }]}>{label}</Text>
      <Text style={backStyles.statValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function CardBack({ item, isGrail }: { item: CollectionItem; isGrail: boolean }) {
  const accent = isGrail ? '#D4A520' : '#5BA3C9';
  const bg = isGrail ? '#0E0B07' : '#111318';
  return (
    <View style={[backStyles.container, { backgroundColor: bg }]}>
      <View style={[backStyles.stripe, { backgroundColor: accent }]} />
      {item.title ? <Text style={backStyles.title} numberOfLines={2}>{item.title}</Text> : null}
      {item.player ? <Text style={[backStyles.player, { color: accent }]}>{item.player}</Text> : null}
      {item.team ? <Text style={backStyles.team}>{item.team}</Text> : null}
      <View style={[backStyles.rule, { borderColor: `${accent}44` }]} />
      <View style={backStyles.grid}>
        {item.year != null && <StatCell label="YEAR" value={String(item.year)} accent={accent} />}
        {item.brand ? <StatCell label="BRAND" value={item.brand} accent={accent} /> : null}
        {item.grade ? <StatCell label="GRADE" value={item.grade} accent={accent} /> : null}
        {item.grading_company ? <StatCell label="GRADER" value={item.grading_company} accent={accent} /> : null}
        {item.serial_number ? <StatCell label="SERIAL #" value={item.serial_number} accent={accent} /> : null}
        {item.estimated_value != null ? (
          <StatCell label="VALUE" value={`$${item.estimated_value.toFixed(0)}`} accent={accent} />
        ) : null}
      </View>
      {item.description ? (
        <Text style={backStyles.desc} numberOfLines={3}>{item.description}</Text>
      ) : null}
      <View style={[backStyles.stripe, { backgroundColor: accent }]} />
    </View>
  );
}

const backStyles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    gap: 5,
  },
  stripe: {
    width: 32,
    height: 2,
    borderRadius: 1,
    opacity: 0.80,
  },
  title: {
    fontSize: 13,
    fontWeight: '800',
    color: '#FFFFFF',
    textAlign: 'center',
    letterSpacing: 0.2,
    lineHeight: 17,
  },
  player: {
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 0.4,
  },
  team: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
  },
  rule: {
    width: '70%',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginVertical: 4,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 6,
    width: '100%',
  },
  statCell: {
    alignItems: 'center',
    width: '46%',
    paddingVertical: 5,
    paddingHorizontal: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 6,
  },
  statLabel: {
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 2,
    textTransform: 'uppercase',
  },
  statValue: {
    fontSize: 11,
    fontWeight: '600',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  desc: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.38)',
    textAlign: 'center',
    lineHeight: 13,
    paddingHorizontal: 4,
  },
});

// ─────────────────────────────────────────────────────────────────────────────

export default function ItemDetailScreen() {
  const { id, fromGrails } = useLocalSearchParams<{ id: string; fromGrails?: string }>();
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

  // Card flip animation — shared value goes 0 (front) → 1 (back).
  // flipTargetRef tracks the JS-side target so we never read a stale animated value.
  const flipAnim = useSharedValue(0);
  const flipTargetRef = useRef(false);

  const frontAnimStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 1200 }, { rotateY: `${flipAnim.value * 180}deg` }],
  }));

  const backAnimStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 1200 }, { rotateY: `${flipAnim.value * 180 + 180}deg` }],
  }));

  function handleFlip() {
    const next = !flipTargetRef.current;
    flipTargetRef.current = next;
    flipAnim.value = withTiming(next ? 1 : 0, {
      duration: 480,
      easing: Easing.out(Easing.cubic),
    });
  }

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
    const canGoBack = router.canGoBack();
    console.log('[card-detail] back pressed', { canGoBack });
    if (canGoBack) {
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
  const showGrailsStyle = !editMode && (isInGrails(item?.id ?? '') || fromGrails === '1');

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

          {/* Card — tapping flips between image and stats */}
          {showGrailsStyle ? (
            // ── Grails frame ──────────────────────────────────────
            <View style={styles.grailsShadowWrap}>
              <View style={styles.grailsFrame}>
                <View style={styles.grailsSpotWrap} pointerEvents="none">
                  <View style={styles.grailsSpot} />
                </View>

                {/* Flip container — sits where grailsImageInner was */}
                <Pressable style={styles.flipContainer} onPress={editMode ? pickNewImage : handleFlip}>
                  {/* Front: image */}
                  <Animated.View style={[styles.flipFaceFront, frontAnimStyle]} pointerEvents="none">
                    {displayImage ? (
                      <Image source={{ uri: displayImage }} style={styles.image} contentFit="cover" transition={200} />
                    ) : (
                      <View style={styles.imagePlaceholder}>
                        <Text style={styles.imagePlaceholderText}>
                          {editMode ? 'Tap to change' : 'No image'}
                        </Text>
                      </View>
                    )}
                    {editMode && (
                      <View style={styles.imageEditOverlay}>
                        <Text style={styles.imageEditLabel}>Change Photo</Text>
                      </View>
                    )}
                  </Animated.View>
                  {/* Back: stats */}
                  <Animated.View style={[styles.flipFaceBack, backAnimStyle]} pointerEvents="none">
                    <CardBack item={item} isGrail />
                  </Animated.View>
                </Pressable>

                <View style={styles.grailsBottomWrap} pointerEvents="none">
                  <View style={styles.grailsBottom} />
                </View>
              </View>
            </View>
          ) : (
            // ── Plain card ────────────────────────────────────────
            <Pressable
              style={styles.imageWrap}
              onPress={editMode ? pickNewImage : handleFlip}>
              {/* Front: image */}
              <Animated.View style={[styles.flipFaceFront, frontAnimStyle]} pointerEvents="none">
                {displayImage ? (
                  <Image source={{ uri: displayImage }} style={styles.image} contentFit="cover" transition={200} />
                ) : (
                  <View style={[styles.image, styles.imagePlaceholder]}>
                    <Text style={styles.imagePlaceholderText}>
                      {editMode ? 'Tap to change image' : 'No image'}
                    </Text>
                  </View>
                )}
                {editMode && (
                  <View style={styles.imageEditOverlay}>
                    <Text style={styles.imageEditLabel}>Change Photo</Text>
                  </View>
                )}
              </Animated.View>
              {/* Back: stats */}
              <Animated.View style={[styles.flipFaceBack, backAnimStyle]} pointerEvents="none">
                <CardBack item={item} isGrail={false} />
              </Animated.View>
            </Pressable>
          )}

          {/* Owner card — centered column, only shown to non-owners */}
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

          {editMode ? (
            /* ── Edit Mode (owner only) ──────────────────── */
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
            /* ── View Mode — stats are on the card back; only show owner actions ── */
            isOwner ? (
              <View style={styles.metaSection}>
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
                <View style={{ height: 12 }} />
                <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
                  <Text style={styles.deleteText}>Delete Item</Text>
                </TouchableOpacity>
              </View>
            ) : null
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
    backgroundColor: '#0D0D0D',
  },
  errorText: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.50)',
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
    backgroundColor: '#0D0D0D',
  },
  content: {
    paddingBottom: 48,
  },
  imageWrap: {
    width: '70%',
    alignSelf: 'center',
    aspectRatio: 5 / 7,
    marginVertical: 20,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  // ── Grails display-case frame ───────────────────────────────
  // Same 3-layer pattern as GrailsSlot, scaled for the larger image.
  grailsShadowWrap: {
    width: '74%',
    alignSelf: 'center',
    marginTop: 72,
    marginBottom: 20,
    borderRadius: 16,
    shadowColor: '#FFD700',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.72,
    shadowRadius: 24,
    elevation: 22,
  },
  grailsFrame: {
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'rgba(255, 208, 0, 0.80)',
    backgroundColor: '#111111',
    paddingHorizontal: 6,
    paddingTop: 18,
    paddingBottom: 10,
  },
  grailsSpotWrap: {
    position: 'absolute',
    top: 5,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 2,
  },
  grailsSpot: {
    width: 36,
    height: 7,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 246, 190, 0.90)',
    shadowColor: '#FFE060',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1.0,
    shadowRadius: 16,
    elevation: 14,
  },
  grailsImageInner: {
    borderRadius: 10,
    overflow: 'hidden',
    aspectRatio: 5 / 7,
    backgroundColor: '#0A0806',
  },
  // ── Card flip ────────────────────────────────────────────────
  // flipContainer: replaces grailsImageInner — same dimensions, no overflow clip
  // so the 3D rotation isn't clipped during the flip.
  flipContainer: {
    aspectRatio: 5 / 7,
  },
  // Both faces fill the container and are absolutely stacked.
  // backfaceVisibility:'hidden' prevents the rear face showing through.
  flipFaceFront: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 10,
    overflow: 'hidden',
    backfaceVisibility: 'hidden',
  },
  flipFaceBack: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 10,
    overflow: 'hidden',
    backfaceVisibility: 'hidden',
  },
  grailsBottomWrap: {
    position: 'absolute',
    bottom: 3,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 2,
  },
  grailsBottom: {
    width: 24,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 215, 80, 0.28)',
    shadowColor: '#FFE060',
    shadowOffset: { width: 0, height: -5 },
    shadowOpacity: 0.50,
    shadowRadius: 8,
    elevation: 4,
  },
  imagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  imagePlaceholderText: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 14,
  },
  imageEditOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 12,
  },
  imageEditLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  // Owner profile — shrinks to content so only the avatar+name area is tappable
  ownerCard: {
    flexDirection: 'column',
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: 12,
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
  ownerInfo: {
    gap: 2,
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
  ownerChevronWrap: {
    position: 'absolute',
    right: 14,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  ownerChevron: {
    fontSize: 22,
    color: 'rgba(255,255,255,0.25)',
  },
  // Meta view
  metaSection: {
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  itemTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  itemPlayer: {
    fontSize: 17,
    color: 'rgba(255,255,255,0.60)',
    marginTop: 4,
  },
  itemSub: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.35)',
    marginTop: 4,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.10)',
    marginVertical: 16,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  metaLabel: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.45)',
    flex: 1,
  },
  metaValue: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.85)',
    flex: 2,
    textAlign: 'right',
  },
  descriptionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.40)',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  descriptionText: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.78)',
    lineHeight: 22,
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
    marginTop: 8,
  },
  deleteText: {
    color: '#FF3B30',
    fontSize: 16,
    fontWeight: '600',
  },
  editSection: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
});
