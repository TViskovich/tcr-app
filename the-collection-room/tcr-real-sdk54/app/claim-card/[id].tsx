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
  View,
} from 'react-native';

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { ClaimFolderPicker } from '@/components/registry/claim-folder-picker';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { useAuth } from '@/lib/auth';
import { claimRegisteredCard, copyRegistrySnapshotImageToNewItem } from '@/lib/registry-claim';
import { supabase } from '@/lib/supabase';
import type { Folder, RegisteredCard } from '@/types';

type FormState = {
  title: string;
  player: string;
  team: string;
  year: string;
  brand: string;
  grade: string;
  gradingCompany: string;
  serialNumber: string;
};

// Prefilled ONLY from registered_cards' own durable snapshot/grading
// columns — never from any collection_items row (the former owner's or
// anyone else's). Matches exactly the approved safe-field mapping: no
// description, no estimated_value, no folder_id, no former-owner images,
// no acquisition/purchase data, no tags, no social data — none of those
// exist on registered_cards in the first place, so there is nothing here
// that could read them.
function buildInitialForm(record: RegisteredCard): FormState {
  return {
    title: record.snapshot_title ?? '',
    player: record.snapshot_player ?? '',
    team: record.snapshot_team ?? '',
    year: record.snapshot_year != null ? String(record.snapshot_year) : '',
    brand: record.snapshot_brand ?? '',
    grade: record.grade ?? '',
    gradingCompany: record.grade_company ?? '',
    serialNumber: record.serial_number ?? '',
  };
}

// Strict — blank is valid (no year given), exactly four digits is valid,
// anything else blocks submission with a friendly alert rather than
// silently truncating (parseInt('20a6', 10) === 20, parseInt('1999abc',
// 10) === 1999 — both wrong and both previously possible here). Also
// rejects "12345" (5 digits), "-1", "0", or any other non-4-digit input,
// since none of those are real card years.
function parseClaimYear(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!/^\d{4}$/.test(trimmed)) return { ok: false };
  return { ok: true, value: parseInt(trimmed, 10) };
}

function field(
  label: string,
  key: keyof FormState,
  form: FormState,
  update: (k: keyof FormState) => (v: string) => void,
  extra?: object,
) {
  return (
    <View style={fieldStyles.wrap}>
      <Text style={fieldStyles.label}>{label}</Text>
      <TextInput
        style={fieldStyles.input}
        value={form[key]}
        onChangeText={update(key)}
        placeholderTextColor={PV2.textTertiary}
        placeholder={label}
        {...extra}
      />
    </View>
  );
}

type Step = 'folder' | 'review';

// Dedicated recipient-claim route — deliberately NOT a mode flag added to
// app/item/new.tsx. That screen hard-requires a locally picked image
// before it will save at all, and its submit handler is a plain client
// INSERT; this flow needs neither (image is optional and copied
// separately post-claim, and the "insert" half happens inside the atomic
// claim_registered_card RPC together with the registered_cards link) —
// threading a claim-mode conditional through image handling and the
// submit target would risk regressing the ordinary create-item path for
// a flow that shares little more than field names with it.
export default function ClaimCardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;

  const [record, setRecord] = useState<RegisteredCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>('folder');
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      setLoadError('No card specified.');
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      const { data, error } = await supabase
        .from('registered_cards')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setLoadError(error?.message ?? 'Registry record not found.');
        setLoading(false);
        return;
      }
      const row = data as RegisteredCard;
      setRecord(row);
      setForm(buildInitialForm(row));
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function update(key: keyof FormState) {
    return (value: string) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleSelectFolder(folder: Folder) {
    setSelectedFolder(folder);
    setStep('review');
  }

  function handleBack() {
    if (step === 'review') {
      setStep('folder');
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }

  async function handleSubmit() {
    if (!record || !selectedFolder || !form || !currentUserId || submitting) return;

    const yearResult = parseClaimYear(form.year);
    if (!yearResult.ok) {
      Alert.alert('Check the Year field', 'Year must be blank or exactly 4 digits, e.g. 1999.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await claimRegisteredCard({
        registeredCardId: record.id,
        folderId: selectedFolder.id,
        title: form.title.trim() || null,
        player: form.player.trim() || null,
        year: yearResult.value,
        brand: form.brand.trim() || null,
        team: form.team.trim() || null,
        grade: form.grade.trim() || null,
        gradingCompany: form.gradingCompany.trim() || null,
        serialNumber: form.serialNumber.trim() || null,
      });

      if (result.error !== null) {
        // claim_registered_card's own RAISE EXCEPTION messages (e.g.
        // "This card is already linked to a collection item", "Only the
        // current owner may claim this card") are already hand-authored,
        // user-safe strings — shown directly, same convention as the
        // Ownership Transfer initiation flow.
        Alert.alert('Unable to add to collection', result.error);
        return;
      }

      const newItem = result.data;

      // Post-claim only, never before — the claim itself is already fully
      // committed at this point regardless of what happens next. Only
      // attempted when the record's own already-loaded snapshot status is
      // 'ready'; every other value (pending/failed/unavailable, or any
      // unexpected future value) safely skips — copyRegistrySnapshotImageToNewItem
      // independently re-verifies status === 'ready' server-side too, via
      // get-registry-snapshot-image-url's own check.
      if (record.snapshot_image_status === 'ready') {
        const imageResult = await copyRegistrySnapshotImageToNewItem(record.id, newItem.id, currentUserId);
        if (imageResult.status === 'failed') {
          Alert.alert(
            'Added to Your Collection',
            'The card was added, but the registry image could not be copied. You can add a photo later.',
            [{ text: 'OK', onPress: () => finishClaim(newItem.id) }],
          );
          return;
        }
      }

      finishClaim(newItem.id);
    } finally {
      setSubmitting(false);
    }
  }

  function finishClaim(newItemId: string) {
    // Closes the claim flow back to the registry page. app/registry/[id].tsx's
    // own load now runs on every focus (useFocusEffect), not just on
    // mount/id-change, so returning here always re-fetches the record and
    // flips its panel from "Add to My Collection" to "View in My
    // Collection" without any extra signal needing to be passed back.
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/item/[id]', params: { id: newItemId } });
  }

  const headerBackLeft = () => <BackButton onPress={handleBack} />;

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Add to My Collection', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      </>
    );
  }

  if (loadError || !record || !form) {
    return (
      <>
        <Stack.Screen options={{ title: 'Add to My Collection', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>{loadError ?? 'Registry record not found.'}</Text>
        </View>
      </>
    );
  }

  // Defense in depth — the panel button that opens this route only ever
  // renders for the owner of an unlinked card (see app/registry/[id].tsx),
  // and claim_registered_card re-verifies both conditions server-side
  // regardless. This just avoids showing a doomed form to anyone who
  // reaches this route with stale state.
  const isOwner = !!currentUserId && record.current_owner_id === currentUserId;
  if (!isOwner || record.collection_item_id) {
    return (
      <>
        <Stack.Screen options={{ title: 'Add to My Collection', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>
            {record.collection_item_id ? 'This card is already linked to a collection item.' : 'Not available.'}
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: step === 'folder' ? 'Choose a Folder' : 'Review Details',
          headerLeft: headerBackLeft,
        }}
      />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? undefined : 'height'}>
        {step === 'folder' ? (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.folderContent}>
            <ClaimFolderPicker userId={currentUserId ?? ''} onSelect={handleSelectFolder} />
          </ScrollView>
        ) : (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
            <Text style={styles.ccIdLabel}>{record.cc_id}</Text>

            <Pressable onPress={() => setStep('folder')} style={styles.folderRow} accessibilityRole="button">
              <Text style={styles.folderRowLabel}>Folder</Text>
              <Text style={styles.folderRowValue}>{selectedFolder?.name}</Text>
            </Pressable>

            {record.snapshot_image_status !== 'ready' && (
              <Text style={styles.noImageNote}>
                No registry image is available. You can add a photo later.
              </Text>
            )}

            <Text style={styles.sectionHeader}>Card Details</Text>
            {field('Title', 'title', form, update)}
            {field('Player', 'player', form, update)}
            {field('Team', 'team', form, update)}
            {field('Year', 'year', form, update, { keyboardType: 'number-pad', maxLength: 4 })}

            <Text style={styles.sectionHeader}>Card Info</Text>
            {field('Brand', 'brand', form, update)}
            {field('Grade', 'grade', form, update, { autoCapitalize: 'characters' })}
            {field('Grading Company', 'gradingCompany', form, update)}
            {field('Serial Number', 'serialNumber', form, update)}

            <Pressable
              style={({ pressed }) => [styles.submitButton, (submitting || pressed) && styles.submitButtonPressed]}
              onPress={handleSubmit}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Add to My Collection">
              {submitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.submitButtonText}>Add to My Collection</Text>
              )}
            </Pressable>
          </ScrollView>
        )}
      </KeyboardAvoidingView>
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
    color: PV2.textTertiary,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: PV2.panel,
    color: PV2.textPrimary,
  },
});

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.bg,
    paddingHorizontal: 24,
  },
  errorText: {
    fontSize: 15,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  scroll: {
    flex: 1,
  },
  folderContent: {
    paddingTop: 20,
    paddingBottom: 40,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  ccIdLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: PV2.textTertiary,
    marginBottom: 16,
  },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 16,
  },
  folderRowLabel: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
  folderRowValue: {
    fontSize: 14,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  noImageNote: {
    fontSize: 13,
    color: PV2.textTertiary,
    marginBottom: 16,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    color: PV2.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 12,
  },
  submitButton: {
    backgroundColor: PV2.accent,
    borderRadius: 12,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  submitButtonPressed: {
    opacity: 0.85,
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
