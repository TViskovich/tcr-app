import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { supabase } from '@/lib/supabase';

type Props = {
  visible: boolean;
  userId: string;
  onClose: () => void;
  onCreated: () => void;
};

// No Binder Color picker here (beta product decision, same reasoning as
// folder-edit-modal.tsx's own — folders.color has no rendered effect
// anywhere reachable in the current, item-based Collection UI). The
// column stays nullable with no DB default (see supabase/migrations/
// 20260714120000_folder_binder_color.sql), and its own documented
// semantics already treat null as a perfectly valid, meaningful value
// ("null = auto (name-hash)") — so the insert below simply omits `color`
// entirely rather than assigning any value on the new folder's behalf.
export function CreateFolderModal({ visible, userId, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  // Defaults to private (false) — the live folders.is_public column
  // default is true, but nothing in this codebase documents that as an
  // intentional product decision (confirmed against supabase/migrations/
  // 20260819120000_enforce_collection_folder_privacy.sql, the only
  // migration that discusses is_public's semantics — it's entirely about
  // RLS enforcement, silent on what a new folder's starting value should
  // be). A user should explicitly opt into public discoverability rather
  // than a new collection starting exposed; the DB column default itself
  // is untouched — this client just always sends an explicit value.
  const [isPublic, setIsPublic] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!name.trim()) return;
    setLoading(true);
    const { error } = await supabase
      .from('folders')
      .insert({ user_id: userId, name: name.trim(), is_public: isPublic });
    if (error) {
      Alert.alert('Error', error.message);
    } else {
      setName('');
      setIsPublic(false);
      onCreated();
    }
    setLoading(false);
  }

  function handleClose() {
    setName('');
    setIsPublic(false);
    onClose();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheetWrap}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>New Folder</Text>
          <TextInput
            style={styles.input}
            placeholder="Folder name"
            placeholderTextColor="#999"
            value={name}
            onChangeText={setName}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={handleCreate}
          />

          {/* Public toggle — same wording/behavior as folder-edit-modal.tsx's
              own Public Collection control, just styled for this sheet. */}
          <View style={styles.toggleRow}>
            <View style={styles.toggleLabel}>
              <Text style={styles.toggleTitle}>Public Collection</Text>
              <Text style={styles.toggleHint}>
                {isPublic
                  ? 'Anyone can discover and view this collection.'
                  : 'Only you can see this collection.'}
              </Text>
            </View>
            <Switch
              value={isPublic}
              onValueChange={setIsPublic}
              trackColor={{ true: '#0a7ea4' }}
            />
          </View>

          <TouchableOpacity
            style={[styles.button, !name.trim() && styles.buttonDisabled]}
            onPress={handleCreate}
            disabled={loading || !name.trim()}>
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Create Folder</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelButton} onPress={handleClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheetWrap: {
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
    gap: 12,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#ddd',
    alignSelf: 'center',
    marginBottom: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  toggleLabel: {
    flex: 1,
  },
  toggleTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#11181C',
  },
  toggleHint: {
    fontSize: 13,
    color: '#687076',
    lineHeight: 18,
    marginTop: 2,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#11181C',
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    backgroundColor: '#fafafa',
    color: '#11181C',
  },
  button: {
    backgroundColor: '#0a7ea4',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    backgroundColor: '#b0d4e3',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  cancelText: {
    color: '#687076',
    fontSize: 15,
  },
});
