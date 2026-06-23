import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';

export default function SettingsScreen() {
  const { signOut, session } = useAuth();

  async function handleSignOut() {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ]);
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Settings', headerBackTitle: '' }} />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        {session?.user?.email ? (
          <Text style={styles.email}>{session.user.email}</Text>
        ) : null}
        <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
    backgroundColor: '#f8f9fa',
  },
  email: {
    fontSize: 14,
    color: '#687076',
  },
  signOutButton: {
    borderWidth: 1,
    borderColor: '#FF3B30',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 32,
  },
  signOutText: {
    color: '#FF3B30',
    fontSize: 16,
    fontWeight: '600',
  },
});
