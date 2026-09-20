import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Link } from 'expo-router';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { supabase } from '@/lib/supabase';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function signIn() {
    if (!email.trim() || !password) return;
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) Alert.alert('Sign in failed', error.message);
    setLoading(false);
  }

  // Password field's onSubmitEditing bypasses the button's disabled={loading}
  // guard — without this, hitting return while a request is in flight fires
  // a second concurrent signIn().
  function handleSubmitEditing() {
    if (loading) return;
    signIn();
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.inner}>
        <CacheCaseLogo variant="light" size="lg" style={styles.logo} />

        <TextInput
          testID="login-email-input"
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={PV2.textTertiary}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          returnKeyType="next"
        />
        <TextInput
          testID="login-password-input"
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={PV2.textTertiary}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          returnKeyType="done"
          onSubmitEditing={handleSubmitEditing}
        />

        <TouchableOpacity style={styles.button} onPress={signIn} disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Log In</Text>
          )}
        </TouchableOpacity>

        <Link href="/(auth)/sign-up" style={styles.link}>
          Don&apos;t have an account? Sign up
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
  button: {
    backgroundColor: PV2.accent,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
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
