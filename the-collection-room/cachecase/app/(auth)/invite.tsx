import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Link, useRouter } from 'expo-router';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import {
  formatInviteCodeInput,
  INVITE_CODE_PLACEHOLDER,
  isCompleteInviteCode,
} from '@/lib/invite-code';
import { usePendingInvite } from '@/lib/pending-invite';
import { checkInviteCode } from '@/lib/waitlist-invite';

const ERROR_COPY = {
  invalid: 'That invite code isn’t valid.',
  expired: 'This invite has expired.',
  used: 'This invite has already been used.',
  network: 'We couldn’t verify your invite. Try again.',
} as const;

// Step 1 of new-account creation (invite-only). The check here is
// informational — redeem-waitlist-invite re-validates and consumes the
// invite atomically when the account is actually created.
export default function InviteScreen() {
  const router = useRouter();
  const { setInvite } = usePendingInvite();
  const [code, setCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = isCompleteInviteCode(code);

  async function handleContinue() {
    if (checking) return;
    if (!complete) {
      setError(ERROR_COPY.invalid);
      return;
    }
    setChecking(true);
    setError(null);
    const result = await checkInviteCode(code);
    setChecking(false);
    if (result.kind === 'valid') {
      setInvite({ code, name: result.name, reservedUsername: result.reservedUsername });
      router.push('/(auth)/sign-up');
      return;
    }
    setError(ERROR_COPY[result.kind]);
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.inner}>
        <CacheCaseLogo variant="light" size="md" style={styles.logo} />
        <Text style={styles.title}>You’re invited</Text>
        <Text style={styles.subtitle}>Enter the access code from your CacheCase invitation.</Text>

        <TextInput
          testID="invite-code-input"
          style={styles.codeInput}
          placeholder={INVITE_CODE_PLACEHOLDER}
          placeholderTextColor={PV2.textTertiary}
          value={code}
          onChangeText={(text) => {
            setCode(formatInviteCodeInput(text));
            if (error) setError(null);
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          keyboardType={Platform.OS === 'ios' ? 'ascii-capable' : 'visible-password'}
          returnKeyType="go"
          onSubmitEditing={handleContinue}
          accessibilityLabel="Invite code"
        />

        {error ? (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        <TouchableOpacity
          style={[styles.button, (!complete || checking) && styles.buttonDisabled]}
          onPress={handleContinue}
          disabled={checking}
          accessibilityRole="button"
          accessibilityState={{ disabled: !complete || checking, busy: checking }}>
          {checking ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Continue</Text>}
        </TouchableOpacity>

        <Link href="/(auth)/login" style={styles.link}>
          Already have an account? Sign in
        </Link>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  inner: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
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
    color: PV2.textPrimary,
  },
  subtitle: {
    fontSize: 16,
    color: PV2.textSecondary,
    textAlign: 'center',
    marginBottom: 12,
  },
  codeInput: {
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 16,
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 1.5,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    backgroundColor: PV2.collectorPanelBg,
    color: PV2.textPrimary,
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
  buttonDisabled: {
    opacity: 0.5,
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
