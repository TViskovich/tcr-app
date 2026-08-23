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

import { SafeAreaView } from 'react-native-safe-area-context';

import { deleteFolderCover } from '@/lib/storage';
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

// Rename / visibility / delete for one folder — extracted from the legacy
// app/folder/[id].tsx screen (now a compatibility redirect to
// /collection/[folderId]) so the canonical folder-detail screen gets this
// owner-only management surface without inlining ~300 lines into an
// already-large file.
//
// No cover-editing or binder-color UI here (beta product decision — the
// main Collection screen and folder detail are both item-based today, not
// cover-image or leather-binder-colored cards, so neither field has any
// live, user-facing visual effect anywhere reachable — confirmed by
// tracing every consumer of folders.color/cover_source/cover_image_url/
// cover_storage_path across the app). This deliberately does NOT touch any
// of those columns on save — the UPDATE below omits them entirely, so
// whatever a folder's existing cover/color state already is (frozen from
// before this UI was hidden) is left exactly as-is. That data, the
// signed-cover Edge Function, and the underlying Storage objects remain
// fully live and still render correctly wherever they're still consumed
// (Saved Collections, the Grail collection picker, the registry claim
// folder picker) — only the ability to change either from here is gone.
// deleteFolder() below still cleans up a folder's own uploaded cover
// object on folder deletion, independent of this.
export function FolderEditModal({ visible, folder, currentUserId, onClose, onSaved, onDeleted }: Props) {
  const [editName, setEditName] = useState('');
  const [editIsPublic, setEditIsPublic] = useState(true);
  const [editSaving, setEditSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Re-seed the form from the current folder every time the modal opens —
  // mirrors the legacy screen's openEditFolder(), just triggered by the
  // visible prop instead of an imperative opener.
  useEffect(() => {
    if (!visible) return;
    setEditName(folder.name);
    setEditIsPublic(folder.is_public);
  }, [visible, folder]);

  // No cover or color fields in this payload at all (see this component's
  // own module comment) — an UPDATE only ever touches the columns it
  // names, so whatever cover_source/cover_image_url/cover_storage_path/
  // color a folder already has is left completely untouched by every
  // save, regardless of what it was.
  async function saveEditFolder() {
    if (!editName.trim()) return;
    setEditSaving(true);
    try {
      const { data, error } = await supabase
        .from('folders')
        .update({
          name: editName.trim(),
          is_public: editIsPublic,
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

      // Best-effort, after the fact — the folder row (and every reference
      // to this cover) is already gone by this point. A failure here must
      // never surface as a failed delete: an orphaned Storage object is
      // preferable to losing DB consistency, matching every other
      // best-effort Storage cleanup in this codebase (deleteProfileImage,
      // lib/item-images.ts's cleanupOrphanedItemImages/removeItemImage).
      if (currentUserId) {
        await deleteFolderCover(folder.cover_storage_path, currentUserId);
      }

      onClose();
      onDeleted();
    } catch (e) {
      Alert.alert('Delete failed', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setDeleting(false);
    }
  }

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
          {/* Folder name */}
          <View>
            <Text style={styles.modalLabel}>Folder Name</Text>
            <TextInput
              style={styles.modalInput}
              value={editName}
              onChangeText={setEditName}
              placeholder="Folder name"
              placeholderTextColor="#999"
              autoFocus
              maxLength={80}
            />
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
