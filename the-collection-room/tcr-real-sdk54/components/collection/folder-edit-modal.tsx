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

import { IconSymbol } from '@/components/ui/icon-symbol';
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
  // Opens the folder detail screen's own FolderCoverMenu (Choose from
  // Folder / Choose from Photo Library / Remove Cover) — that screen owns
  // the actual cover-change logic (it already has this folder's items and
  // signed image URLs loaded), so this modal only needs to hand off to it.
  onChangeCover: () => void;
};

// Rename / visibility / delete for one folder — extracted from the legacy
// app/folder/[id].tsx screen (now a compatibility redirect to
// /collection/[folderId]) so the canonical folder-detail screen gets this
// owner-only management surface without inlining ~300 lines into an
// already-large file.
//
// Cover-editing UI (the "Change Cover" row below) was reintroduced here —
// it had been deliberately removed as a beta decision (folders.color/
// cover_source/cover_image_url/cover_storage_path had no live, user-facing
// consumer reachable from the main Collection screen or folder detail at
// the time). That's no longer true: app/collection/[folderId].tsx now
// renders a hero using this exact same cover data, so an editing entry
// point belongs here again. Binder color remains untouched/unexposed — it
// still has no rendered consumer anywhere in the app. This still does NOT
// touch cover columns on the rename/privacy Save below — cover changes are
// their own separate update, issued by the parent screen once the owner
// actually picks something, never bundled into this modal's Save.
// deleteFolder() below still cleans up a folder's own uploaded cover
// object on folder deletion, independent of this.
export function FolderEditModal({ visible, folder, currentUserId, onClose, onSaved, onDeleted, onChangeCover }: Props) {
  const [editName, setEditName] = useState('');
  const [editIsPublic, setEditIsPublic] = useState(true);
  // Display-only derivation — the underlying state/DB field stays
  // `editIsPublic`/`is_public` (see saveEditFolder's update below); only
  // the switch's on-screen framing is inverted, matching
  // create-folder-modal.tsx's identical correction. ON now unambiguously
  // means private.
  const editIsPrivate = !editIsPublic;
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

          {/* Change Cover — hands off to the parent screen's FolderCoverMenu
              (Choose from Folder / Choose from Photo Library / Remove
              Cover); this modal owns none of that logic itself. */}
          <TouchableOpacity style={styles.modalCoverRow} onPress={onChangeCover} activeOpacity={0.7}>
            <Text style={styles.modalCoverRowLabel}>Change Cover</Text>
            <IconSymbol name="chevron.right" size={16} color="#c2c2c2" />
          </TouchableOpacity>

          {/* Private toggle */}
          <View style={styles.modalToggleRow}>
            <View style={styles.modalToggleLabel}>
              <Text style={styles.modalLabel}>{editIsPrivate ? 'Private Collection' : 'Public Collection'}</Text>
              <Text style={styles.modalHint}>
                {editIsPrivate
                  ? 'Only you can view this collection.'
                  : 'Anyone can view this collection.'}
              </Text>
            </View>
            <Switch
              value={editIsPrivate}
              onValueChange={(value) => setEditIsPublic(!value)}
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
  modalCoverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  modalCoverRowLabel: {
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
