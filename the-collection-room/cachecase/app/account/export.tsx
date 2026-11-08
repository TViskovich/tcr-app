import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Stack } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { DataExportPanel } from '@/components/account/data-export-panel';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

// Dashboard → Account & Security → Download My Data (Dashboard Milestone 2,
// Checkpoint 3). Collectors pending deletion use the same panel on the
// Pending Deletion screen instead.

// What the archive contains and leaves out, in plain words. The archive's own
// README.txt and manifest.json (supabase/functions/account-export/collect.ts:
// README and NOT_INCLUDED) are the detailed source of truth — keep these in
// step with them, and never promise "everything".
const INCLUDED = [
  'Your account and profile, and your waitlist signup if you joined with an invite',
  'Your collections, items and their original photos, and your Grails',
  'Your posts and comments',
  'Your likes, saves, Rate My Grails scores and tags',
  'Who you follow and who follows you',
  'Messages you sent, including photos you attached',
  'Your notifications and conversation details, such as when you last read a conversation',
];
const NOT_INCLUDED = [
  'Messages and photos other collectors sent you — they belong to them',
  'Other collectors’ private information. Other collectors appear by public username only',
  'Some internal records, such as security and system logs, and features that aren’t released yet',
];

// One bullet with a hanging indent; read as a single item by screen readers.
function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bulletRow} accessible accessibilityLabel={text}>
      <Text style={styles.bulletMark} importantForAccessibility="no" accessibilityElementsHidden>
        •
      </Text>
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

export default function DownloadMyDataScreen() {
  const insets = useSafeAreaInsets();
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
      {/* Bottom padding clears the floating tab bar (lib/tab-visibility-context). */}
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled">
        <DataExportPanel />
        <View style={styles.section}>
          <Text style={styles.sectionTitle} accessibilityRole="header">
            What’s included
          </Text>
          {INCLUDED.map((line) => (
            <Bullet key={line} text={line} />
          ))}
        </View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle} accessibilityRole="header">
            What’s not included
          </Text>
          {NOT_INCLUDED.map((line) => (
            <Bullet key={line} text={line} />
          ))}
        </View>
        <Text style={styles.note}>
          This is a copy of your main CacheCase data, not of every record CacheCase keeps. The ZIP includes a README and
          a list of everything it contains and leaves out.
        </Text>
        <Text style={styles.note}>
          Only you can download this file, using a link that works for a few minutes. Each copy is kept for 7 days, then
          deleted.
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
  },
  section: {
    gap: 6,
  },
  sectionTitle: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  bulletRow: {
    flexDirection: 'row',
    gap: 8,
  },
  bulletMark: {
    color: PV2.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  bulletText: {
    flex: 1,
    color: PV2.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  note: {
    color: PV2.textTertiary,
    fontSize: 13,
    lineHeight: 19,
  },
});
