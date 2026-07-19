import { useState } from 'react';
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

import { PhotoAdjuster } from '@/components/collection/photo-adjuster';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { uploadItemImage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

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
  const { folderId, folderName } = useLocalSearchParams<{ folderId: string; folderName: string }>();
  const router = useRouter();
  // A create/edit form, not a scrollable browsing list — no scroll-hide
  // effect, but still resets the shared navbar to visible on focus.
  useScrollResponsiveNavbar({ enabled: false });

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [pendingUri, setPendingUri] = useState<string | null>(null);
  const [pendingWidth, setPendingWidth] = useState(0);
  const [pendingHeight, setPendingHeight] = useState(0);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [shareToFeed, setShareToFeed] = useState(false);
  const [loading, setLoading] = useState(false);

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
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
        })
        .select()
        .single();

      if (itemError) throw new Error('Failed to save item. Please try again.');

      if (shareToFeed && item) {
        const { error: postError } = await supabase.from('posts').insert({
          user_id: session.user.id,
          item_id: item.id,
          post_type: 'item',
          image_url: imageUrl,
          caption: form.title.trim() || null,
        });
        if (postError) {
          Alert.alert('Heads up', 'Item saved, but could not share to feed.');
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
          contentContainerStyle={styles.content}
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
          {field('Title', 'title', form, update)}
          {field('Player', 'player', form, update)}
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

          {/* Share toggle */}
          <View style={styles.toggleRow}>
            <View>
              <Text style={styles.toggleLabel}>Share to feed</Text>
              <Text style={styles.toggleSub}>Visible to your followers</Text>
            </View>
            <Switch
              value={shareToFeed}
              onValueChange={setShareToFeed}
              trackColor={{ false: '#ddd', true: '#0a7ea4' }}
              thumbColor="#fff"
            />
          </View>

          {/* Submit */}
          <TouchableOpacity
            style={[styles.submitButton, loading && styles.submitDisabled]}
            onPress={handleSubmit}
            disabled={loading}>
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitText}>Save Item</Text>
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
