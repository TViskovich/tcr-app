import { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { PV2 } from './profile-v2-theme';

// Shared beta limits for every Collector Preferences chip editor (Favorite
// Sports/Teams, Collecting Categories, Collector Tags) — exported so
// profile-v2-screen.tsx's save-time validation re-checks against the exact
// same numbers rather than duplicating magic constants.
export const TAG_EDITOR_MAX_ITEMS = 12;
export const TAG_EDITOR_MAX_ITEM_LENGTH = 40;

type Props = {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
};

// One reusable chip/tag editor for all four Collector Preferences arrays —
// local input + Add action, removable chips, case-insensitive dedup, and
// the two beta limits above, all enforced here at the point of entry (plus
// a defensive re-check in profile-v2-screen.tsx's handleSave). No new
// route/modal — renders inline exactly where profile-v2-screen.tsx's
// existing edit-mode fields already live.
export function ProfileV2TagEditor({ label, values, onChange, placeholder }: Props) {
  const [draft, setDraft] = useState('');

  function commitDraft() {
    const trimmed = draft.trim();
    if (!trimmed) {
      // Empty/whitespace-only input is silently ignored (not an error) —
      // pressing Add/submit with nothing typed shouldn't produce an alert.
      setDraft('');
      return;
    }
    if (trimmed.length > TAG_EDITOR_MAX_ITEM_LENGTH) {
      Alert.alert('Too Long', `${label} values must be ${TAG_EDITOR_MAX_ITEM_LENGTH} characters or fewer.`);
      return;
    }
    if (values.length >= TAG_EDITOR_MAX_ITEMS) {
      Alert.alert('Limit Reached', `You can add up to ${TAG_EDITOR_MAX_ITEMS} ${label.toLowerCase()}.`);
      return;
    }
    const isDuplicate = values.some((v) => v.toLowerCase() === trimmed.toLowerCase());
    if (isDuplicate) {
      Alert.alert('Already Added', `"${trimmed}" is already in ${label}.`);
      return;
    }
    // Preserves the user's entered capitalization exactly — dedup above is
    // case-insensitive for the *check*, but the stored/displayed value is
    // never re-cased.
    onChange([...values, trimmed]);
    setDraft('');
  }

  function removeValue(value: string) {
    onChange(values.filter((v) => v !== value));
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>

      {values.length > 0 && (
        <View style={styles.chipRow}>
          {/* Keyed by the value itself (not index) — dedup above already
              guarantees every value in this array is unique, so this is a
              real stable key, and removal never causes a neighboring chip
              to inherit the wrong key. */}
          {values.map((value) => (
            <View key={value} style={styles.chip}>
              <Text style={styles.chipText}>{value}</Text>
              <TouchableOpacity
                onPress={() => removeValue(value)}
                hitSlop={14}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${value} from ${label}`}>
                <Text style={styles.chipRemove}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor="rgba(255,255,255,0.35)"
          maxLength={TAG_EDITOR_MAX_ITEM_LENGTH}
          onSubmitEditing={commitDraft}
          returnKeyType="done"
          accessibilityLabel={`Add a ${label.toLowerCase()} value`}
        />
        <TouchableOpacity
          style={styles.addBtn}
          onPress={commitDraft}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={`Add to ${label}`}>
          <Text style={styles.addBtnLabel}>Add</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
    marginBottom: 6,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  chipText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
  },
  chipRemove: {
    color: PV2.textTertiary,
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 15,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: PV2.panel,
    color: '#fff',
  },
  addBtn: {
    paddingHorizontal: 18,
    // Explicit, matching `input`'s own paddingVertical exactly — previously
    // relied on implicit flex-row stretch (inputRow has no explicit
    // alignItems) to reach a comparable height, which worked but wasn't a
    // reliable way to guarantee a real touch target.
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnLabel: {
    color: PV2.link,
    fontSize: 14,
    fontWeight: '600',
  },
});
