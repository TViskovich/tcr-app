import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useAccountLifecycle } from '@/lib/account-lifecycle';
import { useAuth } from '@/lib/auth';

// Covers the app when the signed-in account's state couldn't be confirmed
// and this device has never seen it (e.g. the very first launch offline).
// The app isn't shown until the state is known — it might be pending
// deletion. The check also retries on its own every few seconds.
export function AccountStatusUnknown() {
  const { refresh } = useAccountLifecycle();
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    await refresh();
    setBusy(false);
  }

  return (
    <View style={[StyleSheet.absoluteFill, styles.container]} accessibilityViewIsModal>
      <Text style={styles.title} accessibilityRole="header">
        Can’t reach CacheCase
      </Text>
      <Text style={styles.body}>We couldn’t confirm your account. Check your connection — we’ll keep trying.</Text>
      <Pressable
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
        onPress={retry}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Try again">
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Try Again</Text>}
      </Pressable>
      <Pressable onPress={signOut} accessibilityRole="button" accessibilityLabel="Sign out">
        <Text style={styles.signOut}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: PV2.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 14,
  },
  title: {
    color: PV2.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    color: PV2.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  primary: {
    alignSelf: 'stretch',
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.actionPrimaryFill,
  },
  primaryText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  signOut: {
    color: PV2.statusNegative,
    fontSize: 15,
    fontWeight: '600',
    paddingVertical: 8,
  },
  pressed: {
    opacity: 0.75,
  },
});
