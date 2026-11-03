import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DeleteNowPanel } from '@/components/account/delete-now-panel';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { type ScheduleFailure, useAccountLifecycle } from '@/lib/account-lifecycle';

// Dashboard → Account & Security → Delete Account (Dashboard Milestone 2,
// Checkpoints 2 and 4). Two choices: delete after a 14-day recovery window
// (below), or Delete Permanently Now (DeleteNowPanel). For the first:
// explain the 14-day recovery window, then confirm with the
// password (a fresh sign-in — the server requires one from the last 10
// minutes) and the typed word DELETE. On success the app switches to the
// Pending Deletion screen on its own (app/_layout.tsx).

const CONFIRMATION_WORD = 'DELETE';
const RECOVERY_DAYS = 14;

const ERRORS: Record<ScheduleFailure, string> = {
  wrong_password: 'That password isn’t right. Please try again.',
  reauthentication_required: 'For your security, please enter your password again.',
  confirmation_required: `Type ${CONFIRMATION_WORD} exactly to confirm.`,
  deletion_in_progress: 'This account is already being deleted.',
  session_expired: 'Your session has expired. Sign in again and retry.',
  network: 'Couldn’t reach CacheCase. Check your connection and try again. Nothing has changed.',
  server: 'Something went wrong. Please try again. Nothing has changed.',
};

export default function DeleteAccountScreen() {
  const { scheduleDeletion } = useAccountLifecycle();
  const [step, setStep] = useState<'explain' | 'confirm'>('explain');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ScheduleFailure | null>(null);

  const ready = password.length > 0 && confirmation === CONFIRMATION_WORD && !busy;

  async function handleSchedule() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const result = await scheduleDeletion(password, confirmation);
    // On success this screen is replaced by the Pending Deletion screen.
    if (!result.ok) {
      setBusy(false);
      setError(result.reason);
      if (result.reason === 'wrong_password' || result.reason === 'reauthentication_required') setPassword('');
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <BackButton fallbackHref="/(tabs)/dashboard" />
        <Text style={styles.headerTitle} accessibilityRole="header">
          Delete Account
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {step === 'explain' ? (
            <>
              <Text style={styles.title}>Delete your account after {RECOVERY_DAYS} days</Text>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Right away</Text>
                <Bullet>Your profile, collections, items, Grails, posts and messages are hidden from everyone.</Bullet>
                <Bullet>You can’t post, message, follow, tag or upload.</Bullet>
                <Bullet>You’re signed out on your other devices.</Bullet>
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>For the next {RECOVERY_DAYS} days</Text>
                <Bullet>Nothing is deleted. Sign in and tap Cancel Deletion to get your account back exactly as it was.</Bullet>
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>After {RECOVERY_DAYS} days</Text>
                <Bullet>Your account, content and photos are permanently deleted. This can’t be undone.</Bullet>
                <Bullet>Copies of your items in other collectors’ posts are removed; their posts stay.</Bullet>
                <Bullet>Messages others sent you stay with them; the conversation shows “Deleted account”.</Bullet>
                <Bullet>Your username can’t be used by anyone for 90 days.</Bullet>
                <Bullet>Copies in our backups are removed within 7 days after that.</Bullet>
              </View>
              <Text style={styles.note}>
                Want a copy first? Use Download My Data in your Dashboard — it also stays available during the{' '}
                {RECOVERY_DAYS} days.
              </Text>
              <Pressable
                style={({ pressed }) => [styles.destructive, pressed && styles.pressed]}
                onPress={() => setStep('confirm')}
                accessibilityRole="button"
                accessibilityLabel="Continue to confirmation">
                <Text style={styles.destructiveText}>Continue</Text>
              </Pressable>
              <Text style={styles.orLabel}>Or, without a recovery period</Text>
              <DeleteNowPanel />
            </>
          ) : (
            <>
              <Text style={styles.title}>Confirm account deletion</Text>
              <Text style={styles.body}>
                Your account will be hidden now and permanently deleted in {RECOVERY_DAYS} days unless you cancel.
              </Text>
              <Text style={styles.label}>Password</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="password"
                placeholder="Your password"
                placeholderTextColor={PV2.textTertiary}
                accessibilityLabel="Password"
                editable={!busy}
              />
              <Text style={styles.label}>Type {CONFIRMATION_WORD} to confirm</Text>
              <TextInput
                style={styles.input}
                value={confirmation}
                onChangeText={setConfirmation}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder={CONFIRMATION_WORD}
                placeholderTextColor={PV2.textTertiary}
                accessibilityLabel={`Type ${CONFIRMATION_WORD} to confirm`}
                editable={!busy}
              />
              {error ? (
                <View style={styles.errorBox} accessibilityRole="alert">
                  <Text style={styles.errorText}>{ERRORS[error]}</Text>
                </View>
              ) : null}
              <Pressable
                style={({ pressed }) => [styles.destructive, !ready && styles.disabled, pressed && ready && styles.pressed]}
                onPress={handleSchedule}
                disabled={!ready}
                accessibilityRole="button"
                accessibilityState={{ disabled: !ready, busy }}
                accessibilityLabel={`Delete my account in ${RECOVERY_DAYS} days`}>
                {busy ? <ActivityIndicator color="#fff" /> : (
                  <Text style={styles.destructiveText}>Delete My Account in {RECOVERY_DAYS} Days</Text>
                )}
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
                onPress={() => setStep('explain')}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Back to details">
                <Text style={styles.secondaryText}>Back</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Bullet({ children }: { children: string }) {
  return (
    <View style={styles.bullet}>
      <View style={styles.bulletDot} />
      <Text style={styles.body}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  flex: {
    flex: 1,
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
    gap: 12,
    paddingBottom: 48,
  },
  title: {
    color: PV2.textPrimary,
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 4,
  },
  card: {
    borderRadius: 14,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    padding: 16,
    gap: 6,
  },
  cardTitle: {
    color: PV2.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 2,
  },
  bullet: {
    flexDirection: 'row',
    gap: 10,
  },
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginTop: 8,
    backgroundColor: PV2.textTertiary,
  },
  body: {
    flex: 1,
    color: PV2.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  orLabel: {
    color: PV2.textTertiary,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 12,
  },
  note: {
    color: PV2.textTertiary,
    fontSize: 13,
  },
  label: {
    color: PV2.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 6,
  },
  input: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: PV2.textPrimary,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
  },
  errorBox: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: 'rgba(255,59,48,0.12)',
  },
  errorText: {
    color: PV2.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  destructive: {
    marginTop: 8,
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.statusNegative,
  },
  destructiveText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.4,
  },
  secondary: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  secondaryText: {
    color: PV2.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.75,
  },
});
