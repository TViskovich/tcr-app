import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
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
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { deriveStoragePathFromPublicUrl } from '@/lib/item-images';
import { uploadItemImage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

type FormState = {
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

const INITIAL_FORM: FormState = {
  title: '',
  player: '',
  team: '',
  year: '',
  brand: '',
  grade: '',
  gradingCompany: '',
  serialNumber: '',
  estimatedValue: '',
  description: '',
};

function field(label: string, key: keyof FormState, form: FormState, update: (k: keyof FormState) => (v: string) => void, extra?: object) {
  return (
    <View style={fieldStyles.wrap}>
      <Text style={fieldStyles.label}>{label}</Text>
      <TextInput
        style={fieldStyles.input}
        value={form[key]}
        onChangeText={update(key)}
        placeholderTextColor="#999"
        placeholder={label}
        {...extra}
      />
    </View>
  );
}

export default function AddItemScreen() {
  const { session } = useAuth();
  const { folderId, folderName, mode } = useLocalSearchParams<{
    folderId: string;
    folderName: string;
    // Set only by the Collections screen's "+ Add" → Add Item entry point
    // (app/(tabs)/collection.tsx), which has no folder selected yet. This
    // is a preview/navigation-only visit — the user can look around (pick
    // a photo, crop it, fill in fields) but handleSubmit below refuses to
    // actually persist anything, and the submit button is disabled with
    // copy explaining why. Deliberately an explicit mode rather than
    // inferring "preview" from a missing folderId, since a missing
    // folderId shouldn't silently change behavior elsewhere if this
    // screen ever gains another no-folderId entry point.
    mode?: string;
  }>();
  const isPreviewOnly = mode === 'preview';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // A create/edit form, not a scrollable browsing list — no scroll-hide
  // effect, but still resets the shared navbar to visible on focus.
  useScrollResponsiveNavbar({ enabled: false });

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [pendingUri, setPendingUri] = useState<string | null>(null);
  const [pendingWidth, setPendingWidth] = useState(0);
  const [pendingHeight, setPendingHeight] = useState(0);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  // Item-level privacy (Model A, most-restrictive-wins — see
  // supabase/migrations/20260825120000_add_collection_item_privacy.sql).
  // Defaults to public; seeded from the parent folder's current is_public
  // below so the UI starts in a state that matches the folder, then stays
  // independently editable. There's no parent folder yet in preview mode
  // (no folderId), so it just stays at its public default there.
  const [isPublic, setIsPublic] = useState(true);
  const isPrivate = !isPublic;
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!folderId) return;
    let cancelled = false;
    supabase
      .from('folders')
      .select('is_public')
      .eq('id', folderId)
      .single()
      .then(({ data }) => {
        if (cancelled || !data) return;
        setIsPublic(data.is_public);
      });
    return () => {
      cancelled = true;
    };
  }, [folderId]);

  function update(key: keyof FormState) {
    return (value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function pickImage() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setPendingUri(asset.uri);
      setPendingWidth(asset.width);
      setPendingHeight(asset.height);
    }
  }

  async function handleSubmit() {
    // Defense in depth alongside the disabled submit button below — this
    // Collections-level entry point has no folder assigned yet, so nothing
    // may be persisted from it regardless of how handleSubmit is reached.
    if (isPreviewOnly) return;
    if (!imageUri) {
      Alert.alert('Image required', 'Please select an image for this item.');
      return;
    }
    if (!session?.user?.id) return;

    setLoading(true);
    try {
      let imageUrl: string;
      try {
        imageUrl = await uploadItemImage(imageUri, session.user.id);
      } catch {
        throw new Error('Image upload failed. Check your connection and try again.');
      }

      const { data: item, error: itemError } = await supabase
        .from('collection_items')
        .insert({
          folder_id: folderId,
          user_id: session.user.id,
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
          is_public: isPublic,
        })
        .select()
        .single();

      if (itemError) throw new Error('Failed to save item. Please try again.');

      // Seeds the new item's gallery with its cover photo as the primary
      // row, so it's immediately a real gallery-backed item rather than
      // relying on the edit page's legacy-materialization fallback the
      // first time someone opens it. Best-effort — the item itself is
      // already saved at this point, so a failure here shouldn't block
      // the save; the fallback still covers this item if it happens.
      if (item) {
        const { error: galleryError } = await supabase.from('collection_item_images').insert({
          item_id: item.id,
          user_id: session.user.id,
          image_url: imageUrl,
          storage_path: deriveStoragePathFromPublicUrl(imageUrl, 'item-images'),
          sort_order: 0,
          is_primary: true,
        });
        if (galleryError) {
          console.error('[handleSubmit] gallery row insert failed:', galleryError.message);
        }
      }

      // No back history when this screen was deep-linked, reloaded directly,
      // or opened during development — fall back to the folder we just added
      // to (if we know which one), otherwise the canonical Collection tab.
      if (router.canGoBack()) {
        router.back();
      } else if (folderId) {
        router.replace({ pathname: '/collection/[folderId]', params: { folderId } });
      } else {
        router.replace('/collection');
      }
    } catch (e: unknown) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: folderName ? `Add to ${folderName}` : 'Add Item' }} />
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
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>

          {/* Image picker */}
          <Pressable onPress={pickImage} style={styles.imagePicker}>
            {imageUri ? (
              <Image source={{ uri: imageUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
            ) : (
              <View style={styles.imagePlaceholder}>
                <Text style={styles.imagePlaceholderIcon}>📷</Text>
                <Text style={styles.imagePlaceholderText}>Tap to select image</Text>
              </View>
            )}
          </Pressable>

          {/* Card Details */}
          <Text style={styles.sectionHeader}>Card Details</Text>
          {field('Player', 'player', form, update)}
          {field('Title', 'title', form, update)}
          {field('Team', 'team', form, update)}
          {field('Year', 'year', form, update, { keyboardType: 'number-pad', maxLength: 4 })}

          {/* Card Info */}
          <Text style={styles.sectionHeader}>Card Info</Text>
          {field('Brand', 'brand', form, update)}
          {field('Grade', 'grade', form, update, { autoCapitalize: 'characters' })}
          {field('Grading Company', 'gradingCompany', form, update)}
          {field('Serial Number', 'serialNumber', form, update)}

          {/* Value */}
          <Text style={styles.sectionHeader}>Value</Text>
          {field('Estimated Value ($)', 'estimatedValue', form, update, { keyboardType: 'decimal-pad' })}

          {/* Notes */}
          <Text style={styles.sectionHeader}>Notes</Text>
          <View style={fieldStyles.wrap}>
            <Text style={fieldStyles.label}>Description</Text>
            <TextInput
              style={[fieldStyles.input, styles.multiline]}
              value={form.description}
              onChangeText={update('description')}
              placeholder="Description"
              placeholderTextColor="#999"
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>

          {/* Private Item toggle — same dynamic label/helper pattern as
              create-folder-modal.tsx / folder-edit-modal.tsx. isPublic is
              the field that's actually persisted (see handleSubmit's
              insert above); isPrivate is display-only. Sharing an existing
              item to the feed is a separate, dedicated flow
              (app/share-card/new.tsx) — this screen only creates the item
              itself. */}
          <View style={styles.toggleRow}>
            <View style={styles.toggleTextArea}>
              <Text style={styles.toggleLabel}>{isPrivate ? 'Private Item' : 'Public Item'}</Text>
              <Text style={styles.toggleSub}>
                {isPrivate ? 'Only you can view this item.' : 'Anyone can view this item.'}
              </Text>
            </View>
            <Switch
              value={isPrivate}
              onValueChange={(value) => setIsPublic(!value)}
              trackColor={{ false: '#ddd', true: '#0a7ea4' }}
              thumbColor="#fff"
            />
          </View>

          {/* Submit — disabled entirely in preview mode (no folder assigned
              yet), with copy explaining why, so the user can never come
              away thinking an item was saved when it wasn't. */}
          <TouchableOpacity
            style={[styles.submitButton, (loading || isPreviewOnly) && styles.submitDisabled]}
            onPress={handleSubmit}
            disabled={loading || isPreviewOnly}>
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitText}>
                {isPreviewOnly ? 'Folder assignment required' : 'Save Item'}
              </Text>
            )}
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>

      {pendingUri && (
        <PhotoAdjuster
          uri={pendingUri}
          imageWidth={pendingWidth}
          imageHeight={pendingHeight}
          onUse={(uri) => {
            setImageUri(uri);
            setPendingUri(null);
          }}
          onCancel={() => setPendingUri(null)}
        />
      )}
    </>
  );
}

const fieldStyles = StyleSheet.create({
  wrap: {
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: '#687076',
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
  scroll: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  imagePicker: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 24,
    alignSelf: 'center',
    width: '60%',
    aspectRatio: 5 / 7,
    backgroundColor: '#e9ecef',
  },
  imagePlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  imagePlaceholderIcon: {
    fontSize: 36,
  },
  imagePlaceholderText: {
    fontSize: 14,
    color: '#687076',
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#687076',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 12,
  },
  multiline: {
    height: 100,
    paddingTop: 12,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginTop: 8,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  toggleTextArea: {
    flex: 1,
    marginRight: 12,
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: '#11181C',
  },
  toggleSub: {
    fontSize: 12,
    color: '#687076',
    marginTop: 2,
  },
  submitButton: {
    backgroundColor: '#0a7ea4',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
  },
  submitDisabled: {
    backgroundColor: '#b0d4e3',
  },
  submitText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
