import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FOLDER_COLOR_KEYS, type FolderColorKey } from '@/components/collection/folder-card';
import { FolderColorPicker } from '@/components/collection/folder-color-picker';
import { uploadFolderCover } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import type { Folder } from '@/types';

type Props = {
  visible: boolean;
  folder: Folder;
  currentUserId: string | undefined;
  onClose: () => void;
  onSaved: (updated: Folder) => void;
  onDeleted: () => void;
};

// Rename / cover / binder color / visibility / delete for one folder —
// extracted from the legacy app/folder/[id].tsx screen (now a compatibility
// redirect to /collection/[folderId]) so the canonical folder-detail screen
// gets this owner-only management surface without inlining ~300 lines into
// an already-large file.
export function FolderEditModal({ visible, folder, currentUserId, onClose, onSaved, onDeleted }: Props) {
  const [editName, setEditName] = useState('');
  const [editIsPublic, setEditIsPublic] = useState(true);
  const [editCoverSource, setEditCoverSource] = useState<string>('upload');
  const [editCoverUrl, setEditCoverUrl] = useState<string | null>(null);
  const [editColor, setEditColor] = useState<FolderColorKey>(FOLDER_COLOR_KEYS[0]);
  const [newCoverUri, setNewCoverUri] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Re-seed the form from the current folder every time the modal opens —
  // mirrors the legacy screen's openEditFolder(), just triggered by the
  // visible prop instead of an imperative opener.
  useEffect(() => {
    if (!visible) return;
    setEditName(folder.name);
    setEditIsPublic(folder.is_public);
    setEditCoverSource(folder.cover_source ?? 'upload');
    setEditCoverUrl(folder.cover_image_url);
    // Same name-hash fallback folder-card.tsx's leatherTone() uses, so the
    // picker opens pre-selected on whatever color the card is actually
    // showing right now, even if this folder predates the color column.
    setEditColor(
      (folder.color as FolderColorKey) && FOLDER_COLOR_KEYS.includes(folder.color as FolderColorKey)
        ? (folder.color as FolderColorKey)
        : FOLDER_COLOR_KEYS[folder.name.charCodeAt(0) % FOLDER_COLOR_KEYS.length],
    );
    setNewCoverUri(null);
  }, [visible, folder]);

  async function launchCoverCamera() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow camera access in settings.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [3, 2],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) setNewCoverUri(result.assets[0].uri);
  }

  async function launchCoverLibrary() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow photo library access in settings.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [3, 2],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) setNewCoverUri(result.assets[0].uri);
  }

  function pickCover() {
    Alert.alert('Cover Photo', undefined, [
      { text: 'Take Photo', onPress: launchCoverCamera },
      { text: 'Choose from Library', onPress: launchCoverLibrary },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function removeCover() {
    setNewCoverUri(null);
    setEditCoverUrl(null);
  }

  async function saveEditFolder() {
    if (!editName.trim()) return;
    setEditSaving(true);
    try {
      // Only modify cover_image_url when in upload mode; first_card leaves it untouched.
      let coverUrl = folder.cover_image_url;
      if (editCoverSource === 'upload') {
        coverUrl = newCoverUri && currentUserId
          ? await uploadFolderCover(newCoverUri, currentUserId)
          : editCoverUrl;
      }
      const { data, error } = await supabase
        .from('folders')
        .update({
          name: editName.trim(),
          is_public: editIsPublic,
          cover_image_url: coverUrl,
          cover_source: editCoverSource,
          color: editColor,
        })
        .eq('id', folder.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      if (data) onSaved(data as Folder);
      onClose();
    } catch (e) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setEditSaving(false);
    }
  }

  function confirmDeleteFolder() {
    Alert.alert(
      'Delete Folder',
      `Delete "${folder.name}"? This will permanently remove the folder and everything inside it. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: deleteFolder },
      ],
    );
  }

  async function deleteFolder() {
    setDeleting(true);
    try {
      const { error } = await supabase.from('folders').delete().eq('id', folder.id);
      if (error) throw new Error(error.message);
      onClose();
      onDeleted();
    } catch (e) {
      Alert.alert('Delete failed', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setDeleting(false);
    }
  }

  const coverPreviewUri = newCoverUri ?? editCoverUrl;
  const hasCover = !!coverPreviewUri;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}>
      <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
        <View style={styles.modalHeader}>
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <Text style={styles.modalCancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.modalTitle}>Edit Folder</Text>
          <TouchableOpacity onPress={saveEditFolder} disabled={editSaving || !editName.trim()} hitSlop={8}>
            {editSaving
              ? <ActivityIndicator size="small" color="#0a7ea4" />
              : <Text style={[styles.modalSave, !editName.trim() && styles.modalSaveDisabled]}>Save</Text>
            }
          </TouchableOpacity>
        </View>

        <View style={styles.modalBody}>
          {/* Cover source toggle */}
          <View>
            <Text style={styles.modalLabel}>Cover</Text>
            <View style={styles.coverSourceRow}>
              {(['upload', 'first_card'] as const).map(src => (
                <TouchableOpacity
                  key={src}
                  style={[styles.coverSourceBtn, editCoverSource === src && styles.coverSourceBtnActive]}
                  onPress={() => setEditCoverSource(src)}>
                  <Text style={[styles.coverSourceText, editCoverSource === src && styles.coverSourceTextActive]}>
                    {src === 'upload' ? 'Uploaded Image' : 'Latest Card'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Upload controls — only when upload mode */}
          {editCoverSource === 'upload' && (
            <View style={styles.coverSection}>
              {hasCover && (
                <Image
                  source={{ uri: coverPreviewUri! }}
                  style={styles.coverPreview}
                  contentFit="cover"
                  transition={200}
                />
              )}
              <View style={styles.coverActions}>
                <TouchableOpacity style={styles.coverBtn} onPress={pickCover}>
                  <Text style={styles.coverBtnText}>
                    {hasCover ? 'Change Cover' : 'Add Cover'}
                  </Text>
                </TouchableOpacity>
                {hasCover && (
                  <TouchableOpacity style={styles.coverBtn} onPress={removeCover}>
                    <Text style={[styles.coverBtnText, styles.coverBtnDestructive]}>Remove Cover</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}

          {/* First card hint */}
          {editCoverSource === 'first_card' && (
            <Text style={styles.modalHint}>
              The latest card added to this folder will be used as the cover. If the folder is empty, the letter initial is shown instead.
            </Text>
          )}

          {/* Folder name */}
          <View>
            <Text style={styles.modalLabel}>Folder Name</Text>
            <TextInput
              style={styles.modalInput}
              value={editName}
              onChangeText={setEditName}
              placeholder="Folder name"
              placeholderTextColor="#999"
              autoFocus={!hasCover}
              maxLength={80}
            />
          </View>

          {/* Binder color */}
          <View>
            <Text style={styles.modalLabel}>Binder Color</Text>
            <FolderColorPicker value={editColor} onChange={setEditColor} />
          </View>

          {/* Public toggle */}
          <View style={styles.modalToggleRow}>
            <View style={styles.modalToggleLabel}>
              <Text style={styles.modalLabel}>Public Collection</Text>
              <Text style={styles.modalHint}>
                {editIsPublic
                  ? 'Anyone can discover and view this collection.'
                  : 'Only you can see this collection.'}
              </Text>
            </View>
            <Switch
              value={editIsPublic}
              onValueChange={setEditIsPublic}
              trackColor={{ true: '#0a7ea4' }}
            />
          </View>

          {/* Delete folder — destructive, kept separate at the bottom */}
          <View style={styles.modalDangerZone}>
            <TouchableOpacity
              style={styles.modalDeleteButton}
              onPress={confirmDeleteFolder}
              disabled={deleting}>
              {deleting
                ? <ActivityIndicator size="small" color="#e53935" />
                : <Text style={styles.modalDeleteButtonText}>Delete Folder</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#11181C',
  },
  modalCancel: {
    fontSize: 16,
    color: '#687076',
  },
  modalSave: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0a7ea4',
  },
  modalSaveDisabled: {
    color: '#ccc',
  },
  modalBody: {
    padding: 16,
    gap: 20,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#687076',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  modalInput: {
    backgroundColor: '#fff',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#11181C',
  },
  modalToggleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  modalToggleLabel: {
    flex: 1,
  },
  modalHint: {
    fontSize: 13,
    color: '#687076',
    lineHeight: 18,
    marginTop: 4,
  },
  coverSourceRow: {
    flexDirection: 'row',
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    padding: 3,
  },
  coverSourceBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 6,
  },
  coverSourceBtnActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  coverSourceText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#687076',
  },
  coverSourceTextActive: {
    fontSize: 13,
    fontWeight: '600',
    color: '#11181C',
  },
  coverSection: {
    gap: 10,
  },
  coverPreview: {
    width: '100%',
    aspectRatio: 3 / 2,
    borderRadius: 10,
    backgroundColor: '#e9ecef',
  },
  coverActions: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  coverBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#d0d0d0',
    backgroundColor: '#fff',
  },
  coverBtnText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#11181C',
  },
  coverBtnDestructive: {
    color: '#e53935',
  },
  modalDangerZone: {
    paddingTop: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  modalDeleteButton: {
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e53935',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalDeleteButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#e53935',
  },
});
