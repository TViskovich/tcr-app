import { ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '@react-navigation/native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Props = {
  title: string;
  onBack: () => void;
  rightContent?: ReactNode;
};

export function ScreenHeader({ title, onBack, rightContent }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
      <View style={styles.row}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn} hitSlop={8} activeOpacity={0.55} accessibilityLabel="Back" accessibilityRole="button">
          <MaterialIcons name="chevron-left" size={32} color={colors.primary} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.rightSlot}>
          {rightContent ?? null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    minWidth: 44,
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    marginHorizontal: 8,
  },
  rightSlot: {
    minWidth: 44,
    alignItems: 'flex-end',
    paddingRight: 8,
    justifyContent: 'center',
  },
});
