import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DataExportPanel } from '@/components/account/data-export-panel';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';

// Dashboard → Account & Security → Download My Data (Dashboard Milestone 2,
// Checkpoint 3). Collectors pending deletion use the same panel on the
// Pending Deletion screen instead.
export default function DownloadMyDataScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <BackButton fallbackHref="/(tabs)/dashboard" />
        <Text style={styles.headerTitle} accessibilityRole="header">
          Download My Data
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <DataExportPanel />
        <Text style={styles.note}>
          Only you can download this file, using a link that works for a few minutes. Each copy is kept for 7 days, then
          deleted. Messages other collectors sent you aren’t included — they belong to them.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: PV2.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  headerSpacer: {
    width: 36,
  },
  content: {
    padding: 20,
    gap: 14,
    paddingBottom: 48,
  },
  note: {
    color: PV2.textTertiary,
    fontSize: 13,
    lineHeight: 19,
  },
});
