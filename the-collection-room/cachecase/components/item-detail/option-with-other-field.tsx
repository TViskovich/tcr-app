import { StyleSheet, TextInput, View } from 'react-native';

import { SelectField } from '@/components/item-detail/select-field';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';

const UNSET = '-';
const OTHER = 'Other';

// A dropdown with an "Other" escape hatch, on the shared SelectField — the
// Pokémon Details Rarity / Language / Edition fields and the Trading Card
// Franchise field, used identically by Add Item and Edit Item.
//
// `value` is the form's string ('' = unset, saved as null — "-" is only the
// display). Picking a listed option stores that exact string. Picking
// "Other" reveals a text box: whatever is typed is stored, or "Other" when
// it's left empty. A saved value that isn't in the list — an older
// free-text entry — opens as "Other" with its text in the box, so it's
// shown, editable, and never dropped or rewritten unless the collector
// changes it. A value matching an option apart from letter case shows as
// that option, and is likewise left as saved until changed.
export function OptionWithOtherField({
  label,
  options,
  value,
  onChange,
  customPlaceholder,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
  // The revealed text box's placeholder (default "Custom <label>").
  customPlaceholder?: string;
}) {
  const saved = value.trim();
  const match = saved
    ? options.find((option) => option !== OTHER && option.toLowerCase() === saved.toLowerCase())
    : undefined;
  const isCustom = !!saved && !match;
  const selected = !saved ? UNSET : (match ?? OTHER);

  return (
    <View>
      <SelectField
        label={label}
        value={selected}
        options={[UNSET, ...options]}
        scrollable
        onChange={(next) => {
          if (next === UNSET) onChange('');
          // Re-picking "Other" keeps any custom text already entered.
          else if (next === OTHER) {
            if (!isCustom) onChange(OTHER);
          } else onChange(next);
        }}
      />
      {isCustom && (
        <TextInput
          style={styles.customInput}
          value={saved === OTHER ? '' : value}
          onChangeText={(text) => onChange(text.trim() ? text : OTHER)}
          placeholder={customPlaceholder ?? `Custom ${label.toLowerCase()}`}
          placeholderTextColor={PV2.textTertiary}
          maxLength={60}
          autoCorrect={false}
          accessibilityLabel={`Custom ${label}`}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Same box as SelectField's trigger, directly under its dropdown.
  customInput: {
    marginTop: -4,
    marginBottom: 12,
    minHeight: 44,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: PV2.collectorPanelBg,
    color: PV2.textPrimary,
    fontSize: 15,
  },
});
