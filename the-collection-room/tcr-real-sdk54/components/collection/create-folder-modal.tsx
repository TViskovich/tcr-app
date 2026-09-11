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

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { supabase } from '@/lib/supabase';

type Props = {
  visible: boolean;
  userId: string;
  onClose: () => void;
  onCreated: () => void;
  // Omitted/undefined (and null) both mean "create a top-level folder."
  // Passed by app/collection/[folderId].tsx when Add Folder is used from
  // inside an existing folder. Parent ownership and cycle prevention are
  // enforced entirely by folders_insert_own's RLS — this modal never
  // verifies either itself; a mismatched/invalid parent simply surfaces as
  // the same generic insert error already handled below.
  parentFolderId?: string | null;
};

// No Binder Color picker here (beta product decision, same reasoning as
// folder-edit-modal.tsx's own — folders.color has no rendered effect
// anywhere reachable in the current, item-based Collection UI). The
// column stays nullable with no DB default (see supabase/migrations/
// 20260714120000_folder_binder_color.sql), and its own documented
// semantics already treat null as a perfectly valid, meaningful value
// ("null = auto (name-hash)") — so the insert below simply omits `color`
// entirely rather than assigning any value on the new folder's behalf.
export function CreateFolderModal({ visible, userId, onClose, onCreated, parentFolderId }: Props) {
  const [name, setName] = useState('');
  // Defaults to public (true) — matches the live folders.is_public column
  // default (NOT NULL DEFAULT true, unchanged since the column was added;
  // see supabase/schema.sql), which this client previously overrode down
  // to false on every insert. That override is gone now: a new folder
  // created without touching this toggle saves as public, same as the DB
  // would produce on its own; explicitly sending is_public below (rather
  // than omitting it and relying on the column default) is still correct
  // and unchanged — it just now agrees with that default instead of
  // fighting it. Users can still flip this to private before creating, or
  // afterward via folder-edit-modal.tsx's own Private Collection toggle
  // (unaffected by this — it always loads from the folder's actual saved
  // is_public value, never this default).
  const [isPublic, setIsPublic] = useState(true);
  // Display-only derivation — the underlying state/DB field stays
  // `isPublic`/`is_public` (see above and handleCreate's insert below);
  // only the switch's on-screen framing is inverted, since "Public
  // Collection" labeled above a helper text saying "Only you can see
  // this" read as contradictory. ON now unambiguously means private.
  const isPrivate = !isPublic;
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!name.trim()) return;
    setLoading(true);
    const { error } = await supabase.from('folders').insert({
      user_id: userId,
      name: name.trim(),
      is_public: isPublic,
      parent_folder_id: parentFolderId ?? null,
      // folders.cover_source is `NOT NULL DEFAULT 'upload'` at the DB level
      // (a pre-existing default, not one this app ever intended — see
      // folder-edit-modal.tsx/[folderId].tsx's own handleRemoveCover, which
      // resets to 'first_card' and calls it "the same implicit default a
      // folder starts with"). Leaving cover_source unset here silently
      // inherited that wrong DB default, producing a folder that claims an
      // uploaded cover exists (cover_source: 'upload') while
      // cover_storage_path/cover_image_url are both null — exactly the
      // invalid combination that made new folders' own cover previews
      // render blank. Setting it explicitly on every insert is what
      // actually prevents a newly-created folder from ever entering that
      // state, rather than relying on the column default to happen to
      // match.
      cover_source: 'first_card',
    });
    if (error) {
      Alert.alert('Error', error.message);
    } else {
      setName('');
      setIsPublic(true);
      onCreated();
    }
    setLoading(false);
  }

  function handleClose() {
    setName('');
    setIsPublic(true);
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
            placeholderTextColor={PV2.textTertiary}
            value={name}
            onChangeText={setName}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={handleCreate}
          />

          {/* Private toggle — same wording/behavior as folder-edit-modal.tsx's
              own Private Collection control, just styled for this sheet. */}
          <View style={styles.toggleRow}>
            <View style={styles.toggleLabel}>
              <Text style={styles.toggleTitle}>{isPrivate ? 'Private Collection' : 'Public Collection'}</Text>
              <Text style={styles.toggleHint}>
                {isPrivate
                  ? 'Only you can view this collection.'
                  : 'Anyone can view this collection.'}
              </Text>
            </View>
            <Switch
              value={isPrivate}
              onValueChange={(value) => setIsPublic(!value)}
              trackColor={{ false: PV2.collectorPanelBg, true: PV2.accent }}
              thumbColor="#fff"
            />
          </View>

          <TouchableOpacity
            style={[styles.button, !name.trim() && styles.buttonDisabled]}
            onPress={handleCreate}
            disabled={loading || !name.trim()}>
            {loading ? (
              <ActivityIndicator color={PV2.textPrimary} />
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
    backgroundColor: PV2.panel,
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
    backgroundColor: PV2.border,
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
    color: PV2.textPrimary,
  },
  toggleHint: {
    fontSize: 13,
    color: PV2.textSecondary,
    lineHeight: 18,
    marginTop: 2,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: PV2.textPrimary,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    backgroundColor: PV2.collectorPanelBg,
    color: PV2.textPrimary,
  },
  button: {
    backgroundColor: PV2.accent,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    backgroundColor: PV2.accentSoft,
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
    color: PV2.textSecondary,
    fontSize: 15,
  },
});
