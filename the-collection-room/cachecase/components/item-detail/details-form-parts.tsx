import { StyleSheet, Switch, Text, TextInput, type TextInputProps, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

// Shared building blocks for the Other-category detail forms (Sneakers,
// Watches): the same visual spec as Add Item's own fieldStyles / section
// headers / toggle rows (app/item/new.tsx), so these forms are
// indistinguishable from the built-in ones.

export function DetailsSectionHeader({ title }: { title: string }) {
  return <Text style={formStyles.sectionHeader}>{title}</Text>;
}

export function DetailsTextField({
  label,
  value,
  onChange,
  hint,
  multiline = false,
  ...inputProps
}: Omit<TextInputProps, 'value' | 'onChange' | 'onChangeText'> & {
  label: string;
  value: string;
  onChange: (value: string) => void;
  // Small helper line under the input.
  hint?: string;
}) {
  return (
    <View style={formStyles.wrap}>
      <Text style={formStyles.label}>{label}</Text>
      <TextInput
        style={[formStyles.input, multiline && formStyles.multiline]}
        value={value}
        onChangeText={onChange}
        placeholder={label}
        placeholderTextColor={PV2.textTertiary}
        multiline={multiline}
        numberOfLines={multiline ? 4 : undefined}
        textAlignVertical={multiline ? 'top' : undefined}
        {...inputProps}
      />
      {hint ? <Text style={formStyles.hint}>{hint}</Text> : null}
    </View>
  );
}

// Two short inputs on one row with a separator between them — e.g. edition
// "23 / 100" or a size "18 × 24".
export function DetailsPairField({
  label,
  first,
  second,
  onChangeFirst,
  onChangeSecond,
  firstPlaceholder,
  secondPlaceholder,
  separator,
  hint,
  keyboardType = 'number-pad',
}: {
  label: string;
  first: string;
  second: string;
  onChangeFirst: (value: string) => void;
  onChangeSecond: (value: string) => void;
  firstPlaceholder: string;
  secondPlaceholder: string;
  separator: string;
  hint?: string;
  keyboardType?: TextInputProps['keyboardType'];
}) {
  return (
    <View style={formStyles.wrap}>
      <Text style={formStyles.label}>{label}</Text>
      <View style={formStyles.pairRow}>
        <TextInput
          style={[formStyles.input, formStyles.pairInput]}
          value={first}
          onChangeText={onChangeFirst}
          placeholder={firstPlaceholder}
          placeholderTextColor={PV2.textTertiary}
          keyboardType={keyboardType}
        />
        <Text style={formStyles.pairSeparator}>{separator}</Text>
        <TextInput
          style={[formStyles.input, formStyles.pairInput]}
          value={second}
          onChangeText={onChangeSecond}
          placeholder={secondPlaceholder}
          placeholderTextColor={PV2.textTertiary}
          keyboardType={keyboardType}
        />
      </View>
      {hint ? <Text style={formStyles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function DetailsToggleRow({
  label,
  sublabel,
  value,
  onChange,
}: {
  label: string;
  sublabel: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={formStyles.toggleRow}>
      <View style={formStyles.toggleTextArea}>
        <Text style={formStyles.toggleLabel}>{label}</Text>
        <Text style={formStyles.toggleSub}>{sublabel}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: PV2.collectorPanelBg, true: PV2.actionPrimary }}
        thumbColor="#fff"
      />
    </View>
  );
}

export function DetailsTipCard({ title, body }: { title: string; body: string }) {
  return (
    <View style={formStyles.tipCard}>
      <Text style={formStyles.tipTitle}>{title}</Text>
      <Text style={formStyles.tipBody}>{body}</Text>
    </View>
  );
}

const formStyles = StyleSheet.create({
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: PV2.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 12,
  },
  wrap: {
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: PV2.collectorPanelBg,
    color: PV2.textPrimary,
  },
  multiline: {
    height: 100,
    paddingTop: 12,
  },
  hint: {
    marginTop: 4,
    fontSize: 12,
    color: PV2.textTertiary,
  },
  pairRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pairInput: {
    flex: 1,
  },
  pairSeparator: {
    fontSize: 15,
    color: PV2.textSecondary,
  },
  tipCard: {
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    backgroundColor: PV2.panel,
    padding: 14,
    marginBottom: 12,
  },
  tipTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
    marginBottom: 4,
  },
  tipBody: {
    fontSize: 13,
    color: PV2.textSecondary,
    lineHeight: 18,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: PV2.panel,
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
  },
  toggleTextArea: {
    flex: 1,
    marginRight: 12,
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  toggleSub: {
    fontSize: 12,
    color: PV2.textSecondary,
    marginTop: 2,
  },
});
