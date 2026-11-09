import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
} from 'react-native';

import { Redirect, Stack, useRouter } from 'expo-router';

import { authFormStyles as styles } from '@/components/auth/auth-form-styles';
import { useCountdown } from '@/components/auth/use-countdown';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { PASSWORD_UPDATE_COPY } from '@/lib/account-credentials';
import { useAuth, type RecoveryVerifyResult } from '@/lib/auth';
import { newPasswordProblem, PASSWORD_HINT } from '@/lib/password-policy';

// Reset Password: the emailed one-time code plus a new password.
//   1. the new password is checked on the device first (lib/password-policy);
//   2. the code is verified (verifyOtp, type 'recovery') — under the
//      recovery hold, so the session it creates stays on this screen;
//   3. the password is saved (updateUser) and other sessions signed out.
// If step 3 fails after step 2, the code is spent but the hold remains: the
// screen asks only for a new password ("Code confirmed"). The code lives in
// this screen's state only — never in the URL, storage or logs.
const VERIFY_COPY: Record<Exclude<RecoveryVerifyResult, 'ok'>, string> = {
  invalid: 'That code is invalid or has expired. Check the email or request a new code.',
  too_many: 'Too many attempts. Wait a few minutes and try again.',
  network: 'Couldn’t reach CacheCase. Check your connection and try again.',
};
const CODE_SHAPE = /^\d{6,10}$/;

export default function ResetPasswordScreen() {
  const router = useRouter();
  const { session, recoveryHold, recoveryEmail, verifyRecoveryCode, completePasswordReset, cancelRecovery, requestPasswordReset, resetCooldownUntil } =
    useAuth();
  const verified = recoveryHold && !!session;
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const wait = useCountdown(resetCooldownUntil);

  // Finished (the root layout is routing on) — or nothing to reset.
  if (finishing) {
    return (
      <KeyboardAvoidingView style={styles.container}>
        <ScrollView contentContainerStyle={styles.inner}>
          <ActivityIndicator color={PV2.textSecondary} />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }
  if (!verified && !recoveryEmail) return <Redirect href="/(auth)/forgot-password" />;

  async function submit() {
    if (busy) return;
    const problem = newPasswordProblem(password, confirmation);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    if (!verified) {
      const digits = code.replace(/\s/g, '');
      if (!CODE_SHAPE.test(digits) || !recoveryEmail) {
        setBusy(false);
        setError('Enter the code from the email.');
        return;
      }
      const result = await verifyRecoveryCode(recoveryEmail, digits);
      if (result !== 'ok') {
        setBusy(false);
        setError(VERIFY_COPY[result]);
        return;
      }
      setCode('');
    }
    setFinishing(true);
    const done = await completePasswordReset(password);
    setBusy(false);
    if (done.ok) {
      Alert.alert(
        'Password updated',
        done.otherSessionsSignedOut
          ? 'You’re signed in with your new password. Your other devices have been signed out.'
          : 'You’re signed in with your new password. We couldn’t sign out your other devices — sign out there, or change your password again.',
      );
      return; // the root layout now leaves the reset screen
    }
    setFinishing(false);
    setPassword('');
    setConfirmation('');
    setError(
      done.reason === 'session_expired' ? 'Your reset session has ended. Request a new code to try again.' : PASSWORD_UPDATE_COPY[done.reason],
    );
  }

  async function resend() {
    if (wait > 0 || busy || !recoveryEmail) return;
    setError(null);
    const result = await requestPasswordReset(recoveryEmail);
    setNotice(result === 'sent' ? 'If an account uses that email, we’ve sent it a new code.' : VERIFY_COPY.network);
  }

  async function cancel() {
    await cancelRecovery();
    router.replace('/(auth)/login');
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {/* No swipe-back once the code is confirmed: leave with Cancel. */}
      <Stack.Screen options={{ gestureEnabled: !verified }} />
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} accessibilityRole="header">
          Reset password
        </Text>
        <Text style={styles.subtitle}>
          {verified
            ? 'Code confirmed. Choose a new password to finish.'
            : `If an account uses ${recoveryEmail}, we’ve sent it a code. Enter it below with your new password.`}
        </Text>

        {!verified ? (
          <TextInput
            testID="reset-code-input"
            style={styles.codeInput}
            placeholder="Code"
            placeholderTextColor={PV2.textTertiary}
            value={code}
            onChangeText={(v) => setCode(v.replace(/[^\d]/g, '').slice(0, 10))}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            autoCorrect={false}
            maxLength={10}
            accessibilityLabel="Code from the email"
          />
        ) : null}
        <TextInput
          testID="reset-password-input"
          style={styles.input}
          placeholder="New password"
          placeholderTextColor={PV2.textTertiary}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
          accessibilityLabel="New password"
        />
        <Text style={styles.hint}>{PASSWORD_HINT}</Text>
        <TextInput
          testID="reset-confirm-input"
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
        />

        {error ? (
          <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
        {notice ? (
          <Text style={styles.notice} accessibilityLiveRegion="polite">
            {notice}
          </Text>
        ) : null}

        <TouchableOpacity
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={submit}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Reset password"
          accessibilityState={{ disabled: busy, busy }}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Reset password</Text>}
        </TouchableOpacity>

        {!verified ? (
          <Pressable onPress={resend} disabled={wait > 0} accessibilityRole="button" accessibilityLabel={wait > 0 ? `Send a new code, available in ${wait} seconds` : 'Send a new code'}>
            <Text style={[styles.link, wait > 0 && styles.linkDisabled]}>{wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code'}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={cancel} accessibilityRole="button" accessibilityLabel="Cancel password reset">
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
