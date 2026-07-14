import { Pressable, StyleSheet, View } from 'react-native';

import { FOLDER_COLOR_KEYS, LEATHER_TONES, type FolderColorKey } from './folder-card';

type Props = {
  value: FolderColorKey;
  onChange: (key: FolderColorKey) => void;
};

// Six swatches matching the binder leather tones in folder-card.tsx exactly,
// so the choice made here is a true preview of how the folder will render.
export function FolderColorPicker({ value, onChange }: Props) {
  return (
    <View style={styles.row}>
      {FOLDER_COLOR_KEYS.map((key) => (
        <Pressable
          key={key}
          onPress={() => onChange(key)}
          hitSlop={6}
          style={[
            styles.swatch,
            { backgroundColor: LEATHER_TONES[key].base },
            value === key && styles.swatchSelected,
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  swatchSelected: {
    borderColor: '#0a7ea4',
  },
});
