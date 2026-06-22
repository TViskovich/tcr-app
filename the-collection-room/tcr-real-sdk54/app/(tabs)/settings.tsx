import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

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
    <View style={styles.container}>
      <Text style={styles.heading}>Settings</Text>

      {session?.user?.email ? (
        <Text style={styles.email}>{session.user.email}</Text>
      ) : null}

      <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  heading: {
    fontSize: 24,
    fontWeight: '600',
    color: '#11181C',
  },
  email: {
    fontSize: 14,
    color: '#687076',
  },
  signOutButton: {
    marginTop: 8,
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
