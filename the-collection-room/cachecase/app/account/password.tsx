import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Stack } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { CHANGE_PASSWORD_COPY, changePassword } from '@/lib/account-credentials';
import { useAuth } from '@/lib/auth';
import { newPasswordProblem, PASSWORD_HINT } from '@/lib/password-policy';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

// Dashboard → Account & Security → Change Password. Confirms the current
// password with a fresh sign-in, saves the new one (Supabase updateUser) and
// signs out every other session (signOut scope 'others'), reporting
// honestly if that last step couldn't be confirmed.
export default function ChangePasswordScreen() {
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const email = session?.user?.email ?? null;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { otherSessionsSignedOut: boolean }>(null);

  async function submit() {
    if (busy) return;
    if (!current) {
      setError('Enter your current password.');
      return;
    }
    const problem = newPasswordProblem(next, confirmation);
    if (problem) {
      setError(problem);
      return;
    }
    if (!email) {
      setError(CHANGE_PASSWORD_COPY.session_expired);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await changePassword(email, current, next);
    setBusy(false);
    setCurrent('');
    if (!result.ok) {
      setError(CHANGE_PASSWORD_COPY[result.reason]);
      if (result.reason !== 'wrong_password') {
        setNext('');
        setConfirmation('');
      }
      return;
    }
    setNext('');
    setConfirmation('');
    setDone({ otherSessionsSignedOut: result.otherSessionsSignedOut });
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <BackButton fallbackHref="/(tabs)/dashboard" />
        <Text style={styles.headerTitle} accessibilityRole="header">
          Change Password
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled">
          {done ? (
            <View style={styles.card} accessibilityLiveRegion="polite">
              <Text style={styles.title}>Password changed</Text>
              <Text style={styles.body}>
                {done.otherSessionsSignedOut
                  ? 'Use your new password from now on. Your other devices have been signed out.'
                  : 'Use your new password from now on. We couldn’t sign out your other devices — sign out there, or change your password again.'}
              </Text>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.body}>Enter your current password, then choose a new one. Your other devices will be signed out.</Text>
              <TextInput
                testID="change-current-input"
                style={styles.input}
                placeholder="Current password"
                placeholderTextColor={PV2.textTertiary}
                value={current}
                onChangeText={setCurrent}
                secureTextEntry
                autoComplete="current-password"
                textContentType="password"
                accessibilityLabel="Current password"
                editable={!busy}
              />
              <TextInput
                testID="change-new-input"
                style={styles.input}
                placeholder="New password"
                placeholderTextColor={PV2.textTertiary}
                value={next}
                onChangeText={setNext}
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
                accessibilityLabel="New password"
                editable={!busy}
              />
              <Text style={styles.hint}>{PASSWORD_HINT}</Text>
              <TextInput
                testID="change-confirm-input"
                style={styles.input}
                placeholder="Confirm new password"
                placeholderTextColor={PV2.textTertiary}
                value={confirmation}
                onChangeText={setConfirmation}
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
                returnKeyType="done"
                onSubmitEditing={submit}
                accessibilityLabel="Confirm new password"
                editable={!busy}
              />
              {error ? (
                <View style={styles.errorBox} accessibilityRole="alert">
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}
              <Pressable
                style={({ pressed }) => [styles.primary, busy && styles.disabled, pressed && styles.pressed]}
                onPress={submit}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Change password"
                accessibilityState={{ disabled: busy, busy }}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Change Password</Text>}
              </Pressable>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PV2.bg },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  headerTitle: { flex: 1, textAlign: 'center', color: PV2.textPrimary, fontSize: 17, fontWeight: '700' },
  headerSpacer: { width: 36 },
  content: { padding: 20, gap: 14 },
  card: {
    borderRadius: 14,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    padding: 16,
    gap: 10,
  },
  title: { color: PV2.textPrimary, fontSize: 16, fontWeight: '700' },
  body: { color: PV2.textSecondary, fontSize: 14, lineHeight: 20 },
  hint: { color: PV2.textTertiary, fontSize: 12, marginTop: -4 },
  input: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: PV2.textPrimary,
    backgroundColor: PV2.bg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
  },
  primary: { paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: PV2.actionPrimaryFill },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  errorBox: { borderRadius: 12, padding: 12, backgroundColor: 'rgba(255,59,48,0.12)' },
  errorText: { color: PV2.textPrimary, fontSize: 14, lineHeight: 20 },
});
