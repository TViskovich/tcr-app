import { TouchableOpacity } from 'react-native';

import MaterialIcons from '@expo/vector-icons/MaterialIcons';

type Props = {
  isSaved: boolean;
  onPress: () => void;
  disabled?: boolean;
};

export function BookmarkButton({ isSaved, onPress, disabled = false }: Props) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.55}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={isSaved ? 'Remove bookmark' : 'Bookmark'}
      accessibilityState={{ selected: isSaved, disabled }}>
      <MaterialIcons
        name={isSaved ? 'bookmark' : 'bookmark-border'}
        size={32}
        color={isSaved ? '#0a7ea4' : '#687076'}
      />
    </TouchableOpacity>
  );
}
