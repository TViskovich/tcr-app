import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
} from 'react-native';

import { Link, useRouter } from 'expo-router';

import { authFormStyles as styles } from '@/components/auth/auth-form-styles';
import { useCountdown } from '@/components/auth/use-countdown';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useAuth } from '@/lib/auth';

// Forgot Password: asks Supabase to email a one-time recovery code
// (lib/auth.tsx requestPasswordReset). The answer never reveals whether an
// account uses the address — every outcome except a network failure shows
// the same screen next. A 60-second cooldown limits repeat requests.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const { recoveryEmail, requestPasswordReset, resetCooldownUntil } = useAuth();
  const [email, setEmail] = useState(recoveryEmail ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wait = useCountdown(resetCooldownUntil);

  async function send() {
    if (busy || wait > 0) return;
    if (!EMAIL_SHAPE.test(email.trim())) {
      setError('Enter the email you use for CacheCase.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await requestPasswordReset(email);
    setBusy(false);
    if (result === 'network') {
      setError('Couldn’t reach CacheCase. Check your connection and try again.');
      return;
    }
    router.push('/(auth)/reset-password');
  }

  const disabled = busy || wait > 0;
  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} accessibilityRole="header">
          Forgot password?
        </Text>
        <Text style={styles.subtitle}>Enter the email you use for CacheCase. We’ll send you a code to choose a new password.</Text>

        <TextInput
          testID="forgot-email-input"
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={PV2.textTertiary}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="send"
          onSubmitEditing={send}
          accessibilityLabel="Email"
        />

        {error ? (
          <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        <TouchableOpacity
          style={[styles.button, disabled && styles.buttonDisabled]}
          onPress={send}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={wait > 0 ? `Send code, available in ${wait} seconds` : 'Send code'}
          accessibilityState={{ disabled, busy }}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>{wait > 0 ? `Send again in ${wait}s` : 'Send code'}</Text>
          )}
        </TouchableOpacity>

        {recoveryEmail ? (
          <Pressable onPress={() => router.push('/(auth)/reset-password')} accessibilityRole="button" accessibilityLabel="I have a code">
            <Text style={styles.link}>I have a code</Text>
          </Pressable>
        ) : null}

        <Link href="/(auth)/login" style={styles.link}>
          Back to sign in
        </Link>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
