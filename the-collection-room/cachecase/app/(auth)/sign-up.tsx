import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
} from 'react-native';

import { Link, Redirect, useRouter } from 'expo-router';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { usePendingInvite } from '@/lib/pending-invite';
import { supabase } from '@/lib/supabase';
import { redeemInvite, type RedeemResult } from '@/lib/waitlist-invite';

type FailReason = Extract<RedeemResult, { kind: 'failed' }>['reason'];

// Copy never reveals the invited email or any database detail.
const REDEEM_ERROR_COPY: Record<FailReason, string> = {
  invalid: 'That invite code isn’t valid.',
  expired: 'This invite has expired.',
  used: 'This invite has already been used.',
  email_mismatch: 'This invite can’t be used with that email.',
  username_taken: 'That username is taken. Try another.',
  username_mismatch: 'This invite reserves a different username.',
  account_exists: 'An account already exists for this email. Sign in instead.',
  invalid_email: 'Enter a valid email address.',
  invalid_username: 'Usernames are 3–30 letters, numbers, or underscores.',
  invalid_password: 'Password must be 6–72 characters.',
  retry: 'We couldn’t create your account. Try again.',
  signup_failed: 'Something went wrong creating your account. Try again.',
};

// Invite reasons that make the entered code unusable — the user needs a
// different code, not a different form entry.
const CODE_DEAD: FailReason[] = ['invalid', 'expired', 'used'];

// Step 2 of new-account creation. The account is created server-side by
// redeem-waitlist-invite (which re-checks and atomically consumes the
// invite); public supabase.auth.signUp() is no longer used by the app.
export default function SignUpScreen() {
  const router = useRouter();
  const { invite, setInvite } = usePendingInvite();
  const reserved = invite?.reservedUsername ?? null;
  const [username, setUsername] = useState(reserved ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeDead, setCodeDead] = useState(false);

  // No code in memory (cold deep link, or the stack was rebuilt) — the
  // invite step comes first.
  if (!invite) return <Redirect href="/(auth)/invite" />;
  const pendingInvite = invite;

  async function createAccount() {
    if (loading) return;
    const trimmedUsername = username.trim();
    const normalizedEmail = email.trim().toLowerCase();

    if (!trimmedUsername || !normalizedEmail || !password) {
      setError('Please fill in all fields.');
      return;
    }
    if (!/^[A-Za-z0-9_]{3,30}$/.test(trimmedUsername)) {
      setError(REDEEM_ERROR_COPY.invalid_username);
      return;
    }
    if (password.length < 6 || password.length > 72) {
      setError(REDEEM_ERROR_COPY.invalid_password);
      return;
    }

    setLoading(true);
    setError(null);
    const result = await redeemInvite({
      code: pendingInvite.code,
      email: normalizedEmail,
      password,
      username: trimmedUsername,
    });

    if (result.kind === 'failed') {
      setLoading(false);
      setError(REDEEM_ERROR_COPY[result.reason]);
      setCodeDead(CODE_DEAD.includes(result.reason));
      return;
    }

    // Account exists and the invite is consumed. Signing in hands the
    // session to AuthProvider; the root layout then leaves (auth).
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });
    setLoading(false);
    setInvite(null);
    if (signInError) {
      Alert.alert('Your account is ready', 'Sign in to continue.');
      router.replace('/(auth)/login');
    }
  }

  function enterDifferentCode() {
    setInvite(null);
    router.replace('/(auth)/invite');
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? undefined : 'height'}>
      <ScrollView
        contentContainerStyle={styles.inner}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
        <CacheCaseLogo variant="light" size="md" style={styles.logo} />
        <Text style={styles.title}>Create Account</Text>
        <Text style={styles.subtitle}>
          {pendingInvite.name ? `Welcome, ${pendingInvite.name}.` : 'Your invite is ready.'} Use the email your
          invite was sent to.
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={PV2.textTertiary}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="next"
        />
        <TextInput
          style={[styles.input, reserved ? styles.inputLocked : null]}
          placeholder="Username"
          placeholderTextColor={PV2.textTertiary}
          value={username}
          onChangeText={setUsername}
          editable={!reserved}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="username"
          returnKeyType="next"
        />
        {reserved ? <Text style={styles.hint}>This username is reserved for your invite.</Text> : null}
        <TextInput
          style={styles.input}
          placeholder="Password (min. 6 characters)"
          placeholderTextColor={PV2.textTertiary}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="done"
          onSubmitEditing={createAccount}
        />

        {error ? (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        {codeDead ? (
          <TouchableOpacity style={styles.button} onPress={enterDifferentCode} accessibilityRole="button">
            <Text style={styles.buttonText}>Enter a Different Code</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.button, loading && styles.buttonBusy]}
            onPress={createAccount}
            disabled={loading}
            accessibilityRole="button"
            accessibilityState={{ busy: loading }}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Create Account</Text>}
          </TouchableOpacity>
        )}

        <Link href="/(auth)/login" style={styles.link}>
          Already have an account? Sign in
        </Link>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  inner: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 48,
    gap: 12,
  },
  logo: {
    alignSelf: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 4,
    color: PV2.textPrimary,
  },
  subtitle: {
    fontSize: 16,
    color: PV2.textSecondary,
    textAlign: 'center',
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    backgroundColor: PV2.collectorPanelBg,
    color: PV2.textPrimary,
  },
  inputLocked: {
    opacity: 0.6,
  },
  hint: {
    fontSize: 13,
    color: PV2.textSecondary,
    marginTop: -6,
  },
  error: {
    fontSize: 14,
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  button: {
    backgroundColor: PV2.accent,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonBusy: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  link: {
    textAlign: 'center',
    color: PV2.link,
    marginTop: 8,
    fontSize: 15,
  },
});
