import { StyleSheet, Text, View } from 'react-native';

import { SafeAreaView } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

// Placeholder only — establishes the /(tabs)/dashboard route and its
// visual foundation (dark CacheCase background, safe-area aware, page
// heading) as the new right-hand bottom-nav destination, ahead of the
// real Dashboard feature set (analytics, tools, etc.), which hasn't been
// designed yet. No data, no metrics: those come in a later pass.
export default function DashboardScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.content}>
        <Text style={styles.title}>Professional Dashboard</Text>
        <Text style={styles.subtitle}>Dashboard tools coming soon.</Text>
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
});
