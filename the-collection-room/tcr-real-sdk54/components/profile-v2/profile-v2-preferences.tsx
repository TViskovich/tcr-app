import { StyleSheet, Text, View } from 'react-native';

import { PV2 } from './profile-v2-theme';

type Props = {
  favoriteSports: string[];
  favoriteTeams: string[];
  collectingCategories: string[];
  collectorTags: string[];
};

type Section = { label: string; values: string[] };

// View-mode only — no remove buttons, no add input, identical for owner
// and visitor (same data, same read-only rendering). Renders nothing at
// all when every section is empty, including the "Collector Profile"
// header itself — never shows an owner- or visitor-facing empty message.
export function ProfileV2Preferences({
  favoriteSports,
  favoriteTeams,
  collectingCategories,
  collectorTags,
}: Props) {
  const sections: Section[] = [
    { label: 'Favorite Sports', values: favoriteSports },
    { label: 'Favorite Teams', values: favoriteTeams },
    { label: 'Collecting Categories', values: collectingCategories },
    { label: 'Collector Tags', values: collectorTags },
  ].filter((section) => section.values.length > 0);

  if (sections.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.header}>Collector Profile</Text>
      {sections.map((section) => (
        <View key={section.label} style={styles.section}>
          <Text style={styles.sectionLabel}>{section.label}</Text>
          <View style={styles.chipRow}>
            {/* Keyed by normalized (lowercased) value — every value in a
                section is already unique by construction (the edit-mode
                chip editor rejects case-insensitive duplicates before they
                ever reach the database), so this is a real stable key. */}
            {section.values.map((value) => (
              <View key={value.toLowerCase()} style={styles.chip}>
                <Text style={styles.chipText}>{value}</Text>
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 18,
    paddingHorizontal: 16,
  },
  header: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
    marginBottom: 10,
  },
  section: {
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: PV2.textSecondary,
    marginBottom: 6,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  // Deliberately lighter than the edit-mode chip editor's chips (which use
  // PV2.panel/panelBorder) and much lighter than the primary follow/edit
  // buttons (PV2.accent or a solid outline) — this is read-only
  // informational display, not an interactive control.
  chip: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: PV2.emptyCardBg,
    borderWidth: 1,
    borderColor: PV2.dividerColor,
  },
  chipText: {
    color: PV2.textSecondary,
    fontSize: 12,
    fontWeight: '500',
  },
});
