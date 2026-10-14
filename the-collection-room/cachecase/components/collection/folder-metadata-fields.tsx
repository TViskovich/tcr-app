import { StyleSheet, Text, TextInput, View } from 'react-native';

import { SelectField } from '@/components/item-detail/select-field';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import {
  FOLDER_COLLECTION_TYPES,
  FOLDER_DESCRIPTION_MAX,
  FOLDER_GENRE_MAX,
  FOLDER_TYPE_NONE_LABEL,
  folderCollectionTypeFromLabel,
  folderCollectionTypeLabel,
  type FolderMetadataForm,
} from '@/lib/folder-metadata';

type Props = {
  value: FolderMetadataForm;
  onChange: (next: FolderMetadataForm) => void;
};

const TYPE_OPTIONS = [FOLDER_TYPE_NONE_LABEL, ...FOLDER_COLLECTION_TYPES.map((t) => t.label)];

// Optional Collection/Gallery metadata inputs — Description, Year, Type,
// Genre — shared by CreateFolderModal and FolderEditModal so both forms
// look and validate the same (validation itself is lib/folder-metadata.ts's
// folderMetadataPatch, run by each modal on submit). Year and Type share a
// row to keep the form short. Visuals match SelectField's own label/trigger
// specs so the dropdown sits naturally among the text fields.
export function FolderMetadataFields({ value, onChange }: Props) {
  const set = <K extends keyof FolderMetadataForm>(key: K, next: FolderMetadataForm[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <View style={styles.wrap}>
      <View>
        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={value.description}
          onChangeText={(text) => set('description', text)}
          placeholder="What's in this collection? (optional)"
          placeholderTextColor={PV2.textTertiary}
          multiline
          maxLength={FOLDER_DESCRIPTION_MAX}
          textAlignVertical="top"
        />
      </View>

      <View style={styles.row}>
        <View style={styles.yearCol}>
          <Text style={styles.label}>Year</Text>
          <TextInput
            style={styles.input}
            value={value.year}
            onChangeText={(text) => set('year', text.replace(/[^0-9]/g, ''))}
            placeholder="YYYY"
            placeholderTextColor={PV2.textTertiary}
            keyboardType="number-pad"
            maxLength={4}
          />
        </View>
        <View style={styles.typeCol}>
          <SelectField
            label="Type"
            value={folderCollectionTypeLabel(value.type)}
            options={TYPE_OPTIONS}
            placeholder="Optional"
            onChange={(label) => set('type', folderCollectionTypeFromLabel(label))}
          />
        </View>
      </View>

      <View>
        <Text style={styles.label}>Genre</Text>
        <TextInput
          style={styles.input}
          value={value.genre}
          onChangeText={(text) => set('genre', text)}
          placeholder="e.g. Basketball, Anime, Vintage (optional)"
          placeholderTextColor={PV2.textTertiary}
          maxLength={FOLDER_GENRE_MAX}
          autoCapitalize="words"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 12,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
    // Cancels SelectField's own wrap marginBottom so this row spaces like
    // the other fields (wrap's gap alone).
    marginBottom: -12,
  },
  yearCol: {
    width: 96,
  },
  typeCol: {
    flex: 1,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
    marginBottom: 4,
  },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: PV2.textPrimary,
    backgroundColor: PV2.collectorPanelBg,
  },
  multiline: {
    minHeight: 76,
  },
});
