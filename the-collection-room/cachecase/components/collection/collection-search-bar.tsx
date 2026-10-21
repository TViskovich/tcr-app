import type { Ref } from 'react';
import { Pressable, StyleProp, StyleSheet, Text, TextInput, View, ViewStyle } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

// The bar's horizontal geometry — exported so a row below it can line up
// with the magnifying glass and the text (Profile V2's List View switch).
export const SEARCH_BAR_BORDER = 1;
export const SEARCH_BAR_PADDING_H = 12;
export const SEARCH_BAR_ICON_SIZE = 15;
export const SEARCH_BAR_ICON_GAP = 8;

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  style?: StyleProp<ViewStyle>;
  // Optional — lets a caller focus the field itself (e.g. a sheet that
  // opens the keyboard once it's shown).
  inputRef?: Ref<TextInput>;
  // Optional — focus (and open the keyboard) as soon as it mounts.
  autoFocus?: boolean;
  onFocus?: () => void;
};

// Shared by the Collection page and the folder detail/group screen — both
// filter already-loaded data client-side (see hooks/use-collection.ts's
// itemMatchesSearch), so this is a pure controlled input, no query of its own.
export function CollectionSearchBar({ value, onChange, placeholder, style, inputRef, autoFocus, onFocus }: Props) {
  return (
    <View style={[styles.row, style]}>
      <IconSymbol name="magnifyingglass" size={SEARCH_BAR_ICON_SIZE} color={PV2.textTertiary} style={styles.icon} />
      <TextInput
        ref={inputRef}
        autoFocus={autoFocus}
        onFocus={onFocus}
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
    gap: SEARCH_BAR_ICON_GAP,
    // 7 + the input's 22 + 7 — the same overall bar height as before.
    paddingVertical: 7,
    paddingHorizontal: SEARCH_BAR_PADDING_H,
    borderRadius: 12,
    backgroundColor: PV2.emptyCardBg,
    borderWidth: SEARCH_BAR_BORDER,
    borderColor: PV2.border,
  },
  // An explicit height, taller than the 15pt font's line box, with the text
  // centered in it — with padding 0 and no height the field was only as tall
  // as that line box, which clipped descenders (the bottoms of g, y, p) in
  // the text and placeholder.
  input: {
    flex: 1,
    height: 22,
    fontSize: 15,
    color: PV2.textPrimary,
    padding: 0,
    textAlignVertical: 'center',
    // Android: no extra font padding above the text, which otherwise sits
    // it lower than the icon.
    includeFontPadding: false,
  },
  // The row centers the icon's box and the text's line box, but text reads
  // by its lowercase letters, whose visual middle sits ~1.5pt below the
  // line box's middle (the line reserves room for capitals above). Nudging
  // the glass down by that much lines it up with the text's optical center.
  icon: {
    transform: [{ translateY: 1.5 }],
  },
  clear: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
});
