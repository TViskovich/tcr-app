import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useIsAdmin } from '@/hooks/use-is-admin';

// Placeholder only — establishes the /(tabs)/dashboard route and its
// visual foundation (dark CacheCase background, safe-area aware, page
// heading) as the new right-hand bottom-nav destination, ahead of the
// real Dashboard feature set (analytics, tools, etc.), which hasn't been
// designed yet. No data, no metrics: those come in a later pass.
export default function DashboardScreen() {
  const router = useRouter();
  // UI gate only — /admin/waitlist re-checks membership itself, and its
  // Edge Functions are the real authorization boundary.
  const isAdmin = useIsAdmin();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.content}>
        <Text style={styles.title}>Professional Dashboard</Text>
        <Text style={styles.subtitle}>Dashboard tools coming soon.</Text>

        {isAdmin === true ? (
          <View style={styles.adminSection}>
            <Text style={styles.adminLabel}>ADMIN TOOLS</Text>
            <TouchableOpacity
              style={styles.adminRow}
              onPress={() => router.push('/admin/waitlist')}
              accessibilityRole="button">
              <View style={styles.adminRowText}>
                <Text style={styles.adminRowTitle}>Waitlist Management</Text>
                <Text style={styles.adminRowDetail}>Review signups, grant access, and manage invite status.</Text>
              </View>
              <IconSymbol name="chevron.right" size={14} color={PV2.textTertiary} />
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  title: {
    color: PV2.textPrimary,
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 12,
    color: PV2.textSecondary,
    fontSize: 15,
  },
  adminSection: {
    marginTop: 32,
  },
  adminLabel: {
    color: PV2.textTertiary,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  adminRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: PV2.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PV2.panelBorder,
  },
  adminRowText: {
    flex: 1,
    gap: 2,
  },
  adminRowTitle: {
    color: PV2.textPrimary,
    fontSize: 16,
    fontWeight: '500',
  },
  adminRowDetail: {
    color: PV2.textSecondary,
    fontSize: 13,
  },
});
