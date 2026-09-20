import { Pressable, StyleProp, StyleSheet, Text, TextInput, View, ViewStyle } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  style?: StyleProp<ViewStyle>;
};

// Shared by the Collection page and the folder detail/group screen — both
// filter already-loaded data client-side (see hooks/use-collection.ts's
// itemMatchesSearch), so this is a pure controlled input, no query of its own.
export function CollectionSearchBar({ value, onChange, placeholder, style }: Props) {
  return (
    <View style={[styles.row, style]}>
      <IconSymbol name="magnifyingglass" size={15} color={PV2.textTertiary} />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={PV2.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      {value.length > 0 && (
        <Pressable onPress={() => onChange('')} hitSlop={8}>
          <Text style={styles.clear}>✕</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: PV2.emptyCardBg,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: PV2.textPrimary,
    padding: 0,
  },
  clear: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
});
