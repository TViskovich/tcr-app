import { StyleSheet, Text, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

type Props = {
  title: string;
  // e.g. ["2026 Topps Chrome", "RC • #5"] — rendered as stacked lines under
  // the title. The caller decides what belongs here from real item fields;
  // this component only lays it out. Empty/falsy lines are skipped.
  subtitleLines?: (string | null | undefined)[];
};

// Clean, premium identity block — no pills, no glass, no background panel.
export function ItemIdentity({ title, subtitleLines = [] }: Props) {
  const lines = subtitleLines.filter((line): line is string => !!line);

  return (
    <View style={styles.wrap}>
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      {lines.map((line, index) => (
        <Text key={index} style={styles.subtitle} numberOfLines={1}>
          {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 20,
    paddingTop: 14,
    gap: 3,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  subtitle: {
    fontSize: 15,
    color: PV2.textSecondary,
  },
});
