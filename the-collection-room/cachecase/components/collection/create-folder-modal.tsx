import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FolderMetadataFields } from '@/components/collection/folder-metadata-fields';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import {
  changedFolderMetadata,
  EMPTY_FOLDER_METADATA_FORM,
  folderMetadataPatch,
  type FolderMetadataForm,
} from '@/lib/folder-metadata';
import { invalidateOwnProfileCache } from '@/lib/own-profile-cache';
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
  // Optional Description/Year/Type/Genre (lib/folder-metadata.ts). Collapsed
  // behind "Add details" so the default sheet stays name + privacy only.
  const [meta, setMeta] = useState<FolderMetadataForm>(EMPTY_FOLDER_METADATA_FORM);
  const [showDetails, setShowDetails] = useState(false);
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // iOS: KeyboardAvoidingView lifts the sheet by the keyboard's height, so
  // the sheet must also fit in what's left above the keyboard, or its top
  // ends up under the status bar. Android resizes the window for the
  // keyboard instead (windowHeight already shrinks), so nothing to subtract.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillShow', (e) => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // Whole sheet stays below the status bar with a small gap; its content
  // scrolls inside when it doesn't fit.
  const sheetMaxHeight = windowHeight - keyboardHeight - insets.top - 12;

  function resetForm() {
    setName('');
    setIsPublic(true);
    setMeta(EMPTY_FOLDER_METADATA_FORM);
    setShowDetails(false);
  }

  async function handleCreate() {
    if (!name.trim() || loading) return;
    const metadata = folderMetadataPatch(meta);
    if (!metadata.ok) {
      setShowDetails(true);
      Alert.alert('Check details', metadata.message);
      return;
    }
    setLoading(true);
    const { error } = await supabase.from('folders').insert({
      user_id: userId,
      name: name.trim(),
      is_public: isPublic,
      parent_folder_id: parentFolderId ?? null,
      // Filled-in details only; empty ones are left to the columns' NULL.
      ...changedFolderMetadata(metadata.patch),
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
      resetForm();
      // Mark the own-profile cache stale — one wiring point covers every
      // caller of this shared modal (Collections tab, folder detail's Add
      // Folder, and Profile's own inline "+"). userId here is always the
      // person creating their own folder. See lib/own-profile-cache.ts's
      // own invalidateOwnProfileCache comment.
      invalidateOwnProfileCache(userId);
      onCreated();
    }
    setLoading(false);
  }

  function handleClose() {
    resetForm();
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
        <View style={[styles.sheet, { maxHeight: sheetMaxHeight }, keyboardHeight > 0 && styles.sheetKeyboardUp]}>
          <View style={styles.handle} />
          <Text style={styles.title}>New Folder</Text>
          {/* Shrinks to whatever the capped sheet (sheetMaxHeight) leaves
              after the handle and title, then scrolls; the default name +
              privacy sheet fits as before. */}
          <ScrollView
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheetBody}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            showsVerticalScrollIndicator={false}>
            <TextInput
              style={styles.input}
              placeholder="Folder name"
              placeholderTextColor={PV2.textTertiary}
              value={name}
              onChangeText={setName}
              returnKeyType="done"
              onSubmitEditing={handleCreate}
            />

            {/* Expands/collapses the optional details. Collapsing only hides
                the fields — anything already typed is kept and still saved. */}
            <TouchableOpacity
              style={styles.detailsToggle}
              onPress={() => setShowDetails((open) => !open)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityState={{ expanded: showDetails }}>
              <IconSymbol name={showDetails ? 'chevron.up' : 'plus'} size={14} color={PV2.actionPrimary} />
              <Text style={styles.detailsToggleText}>{showDetails ? 'Hide details' : 'Add details'}</Text>
            </TouchableOpacity>
            {showDetails && <FolderMetadataFields value={meta} onChange={setMeta} />}

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
          </ScrollView>
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
  // The home-indicator padding isn't needed while the keyboard covers it —
  // gives that space back to the fields.
  sheetKeyboardUp: {
    paddingBottom: 12,
  },
  sheetScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: PV2.border,
    alignSelf: 'center',
    marginBottom: 8,
  },
  sheetBody: {
    gap: 12,
  },
  detailsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
  },
  detailsToggleText: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.actionPrimary,
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
    backgroundColor: PV2.actionPrimaryFill,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    backgroundColor: PV2.actionDisabled,
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
