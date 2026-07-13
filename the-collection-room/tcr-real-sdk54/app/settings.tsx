import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';

type Row = {
  label: string;
  onPress: () => void;
  destructive?: boolean;
};

export default function SettingsScreen() {
  const { signOut, session } = useAuth();

  function handleActivity() {
    Alert.alert('Activity', 'Coming soon.');
  }

  function handleSignOut() {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ]);
  }

  const rows: Row[] = [
    { label: 'Activity', onPress: handleActivity },
    { label: 'Sign Out', onPress: handleSignOut, destructive: true },
  ];

  return (
    <>
      <Stack.Screen options={{ title: 'Settings', headerBackTitle: '' }} />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        {session?.user?.email ? (
          <Text style={styles.email}>{session.user.email}</Text>
        ) : null}

        <View style={styles.list}>
          {rows.map((row, i) => (
            <TouchableOpacity
              key={row.label}
              style={[styles.row, i > 0 && styles.rowBorder]}
              onPress={row.onPress}>
              <Text style={[styles.rowLabel, row.destructive && styles.rowLabelDestructive]}>
                {row.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  email: {
    fontSize: 13,
    color: '#687076',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  list: {
    marginTop: 8,
    marginHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  row: {
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  rowLabel: {
    fontSize: 16,
    color: '#11181C',
  },
  rowLabelDestructive: {
    color: '#FF3B30',
  },
});
