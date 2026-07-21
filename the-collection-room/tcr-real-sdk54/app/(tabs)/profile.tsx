import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { SafeAreaView } from 'react-native-safe-area-context';

import { ProfileV2Screen } from '@/components/profile-v2/profile-v2-screen';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useAuth } from '@/lib/auth';

// Thin wrapper — all profile rendering/editing/data-ownership logic lives
// in ProfileV2Screen, shared with the public profile route
// (app/user/[username].tsx). This tab's only job is supplying the
// signed-in user's own id.
export default function ProfileScreen() {
  const { session } = useAuth();
  const userId = session?.user?.id;

  if (!userId) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.accent} />
        </View>
      </SafeAreaView>
    );
  }

  return <ProfileV2Screen userId={userId} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
