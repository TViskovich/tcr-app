import { useEffect, useState } from 'react';
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
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

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

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const router = useRouter();

  const [item, setItem] = useState<CollectionItem | null>(null);
  const [fetching, setFetching] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [newImageUri, setNewImageUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
      }
      setFetching(false);
    }
    fetchItem();
  }, [id]);

  function enterEdit() {
    if (item) setForm(itemToForm(item));
    setNewImageUri(null);
    setEditMode(true);
  }

  function cancelEdit() {
    if (item) setForm(itemToForm(item));
    setNewImageUri(null);
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
      allowsEditing: true,
      aspect: [5, 7],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setNewImageUri(result.assets[0].uri);
    }
  }

  async function handleSave() {
    if (!item || !form || !session?.user?.id) return;
    setSaving(true);
    try {
      let imageUrl = item.image_url;
      if (newImageUri) {
        imageUrl = await uploadItemImage(newImageUri, session.user.id);
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

      if (error) throw new Error(error.message);
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

  const displayImage = newImageUri ?? item?.image_url ?? null;
  const headerTitle = editMode
    ? 'Edit Item'
    : (item?.title ?? 'Item Detail');

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
          headerRight: () =>
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
            ),
          headerLeft: editMode
            ? () => (
                <TouchableOpacity onPress={cancelEdit} style={styles.headerBtn}>
                  <Text style={[styles.headerBtnText, styles.cancelBtnText]}>Cancel</Text>
                </TouchableOpacity>
              )
            : undefined,
        }}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled">

          {/* Image */}
          <Pressable
            onPress={editMode ? pickNewImage : undefined}
            style={styles.imageWrap}>
            {displayImage ? (
              <Image
                source={{ uri: displayImage }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
              />
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
          </Pressable>

          {editMode ? (
            /* ── Edit Mode ─────────────────────────────── */
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
            /* ── View Mode ─────────────────────────────── */
            <View style={styles.metaSection}>
              {item.title && <Text style={styles.itemTitle}>{item.title}</Text>}
              {item.player && <Text style={styles.itemPlayer}>{item.player}</Text>}

              {(item.year || item.brand) && (
                <Text style={styles.itemSub}>
                  {[item.year, item.brand].filter(Boolean).join(' · ')}
                </Text>
              )}

              <View style={styles.divider} />

              <MetaRow label="Team" value={item.team} />
              <MetaRow label="Grade" value={item.grade} />
              <MetaRow label="Grading Company" value={item.grading_company} />
              <MetaRow label="Serial Number" value={item.serial_number} />
              <MetaRow label="Estimated Value" value={formatValue(item.estimated_value)} />

              {item.description ? (
                <>
                  <View style={styles.divider} />
                  <Text style={styles.descriptionLabel}>Description</Text>
                  <Text style={styles.descriptionText}>{item.description}</Text>
                </>
              ) : null}

              <View style={styles.divider} />
              <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
                <Text style={styles.deleteText}>Delete Item</Text>
              </TouchableOpacity>
            </View>
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
    color: '#687076',
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontSize: 16,
    color: '#687076',
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
    backgroundColor: '#f8f9fa',
  },
  content: {
    paddingBottom: 48,
  },
  imageWrap: {
    width: '70%',
    alignSelf: 'center',
    aspectRatio: 5 / 7,
    borderRadius: 12,
    overflow: 'hidden',
    marginVertical: 20,
    backgroundColor: '#e9ecef',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  imagePlaceholderText: {
    color: '#687076',
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
  metaSection: {
    paddingHorizontal: 20,
  },
  itemTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#11181C',
  },
  itemPlayer: {
    fontSize: 17,
    color: '#687076',
    marginTop: 4,
  },
  itemSub: {
    fontSize: 14,
    color: '#aaa',
    marginTop: 4,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e0e0e0',
    marginVertical: 16,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
  },
  metaLabel: {
    fontSize: 14,
    color: '#687076',
    flex: 1,
  },
  metaValue: {
    fontSize: 14,
    fontWeight: '500',
    color: '#11181C',
    flex: 2,
    textAlign: 'right',
  },
  descriptionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#687076',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  descriptionText: {
    fontSize: 15,
    color: '#11181C',
    lineHeight: 22,
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
