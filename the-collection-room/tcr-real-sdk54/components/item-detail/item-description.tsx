import { StyleSheet, Text, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

type Props = {
  description: string | null | undefined;
};

// Static two/three-line clamp for now — expansion (tap to read more) is a
// future addition, not implemented here.
export function ItemDescription({ description }: Props) {
  if (!description) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.text} numberOfLines={3}>
        {description}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  text: {
    fontSize: 14,
    lineHeight: 20,
    color: PV2.textSecondary,
  },
});
