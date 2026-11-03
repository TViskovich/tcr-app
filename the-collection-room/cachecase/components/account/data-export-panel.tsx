import { useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SupportEmailLine } from '@/components/account/support-email-line';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { type RequestFailure, useAccountExport } from '@/lib/account-export';

// Download My Data (Dashboard Milestone 2, Checkpoint 3). Used by the
// Dashboard's export screen (app/account/export.tsx) and the Pending
// Deletion screen. States: none → Preparing → Ready to Download (7 days) →
// Expired; Failed. Requesting a new export asks for the password (the
// server requires a sign-in from the last 10 minutes).

const REQUEST_ERRORS: Record<RequestFailure, string> = {
  wrong_password: 'That password isn’t right. Please try again.',
  reauthentication_required: 'For your security, please enter your password again.',
  session_expired: 'Your session has expired. Sign in again and retry.',
  network: 'Couldn’t reach CacheCase. Check your connection and try again.',
  server: 'Something went wrong. Please try again.',
  unavailable: 'Download My Data isn’t available right now.',
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
const formatSize = (bytes: number | null) => {
  if (!bytes) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

export function DataExportPanel({ compact = false }: { compact?: boolean }) {
  const { loaded, available, info, request, downloadLink } = useAccountExport();
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRequest() {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    const result = await request(password);
    setBusy(false);
    if (!result.ok) {
      setError(REQUEST_ERRORS[result.reason]);
      if (result.reason === 'wrong_password' || result.reason === 'reauthentication_required') setPassword('');
      return;
    }
    setAsking(false);
    setPassword('');
  }

  async function handleDownload() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await downloadLink();
    setBusy(false);
    if (!result.ok) {
      setError(result.reason === 'network' ? REQUEST_ERRORS.network : 'This download isn’t available any more.');
      return;
    }
    if (Platform.OS === 'web') window.open(result.url, '_blank');
    else await Linking.openURL(result.url);
  }

  if (!loaded) {
    return (
      <View style={[styles.card, styles.center]}>
        <ActivityIndicator color={PV2.textSecondary} />
      </View>
    );
  }
  if (!available) {
    return (
      <View style={styles.card} accessible accessibilityLabel="Download My Data, not available right now">
        <Text style={styles.title}>Download My Data</Text>
        <Text style={styles.body}>Download My Data isn’t available right now. Please try again later.</Text>
      </View>
    );
  }

  const state = info?.state ?? null;
  const askForPassword = asking ? (
    <View style={styles.ask}>
      <Text style={styles.label}>Enter your password to prepare a new download</Text>
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
        accessibilityLabel="Password for Download My Data"
        editable={!busy}
      />
      <Pressable
        style={({ pressed }) => [styles.primary, (!password || busy) && styles.disabled, pressed && styles.pressed]}
        onPress={handleRequest}
        disabled={!password || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: !password || busy, busy }}
        accessibilityLabel="Prepare my data">
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Prepare My Data</Text>}
      </Pressable>
    </View>
  ) : null;

  const startButton = (label: string) =>
    asking ? null : (
      <Pressable
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
        onPress={() => {
          setError(null);
          setAsking(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={label}>
        <Text style={styles.primaryText}>{label}</Text>
      </Pressable>
    );

  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        Download My Data
      </Text>

      {state === null ? (
        <>
          {!compact ? (
            <Text style={styles.body}>
              Get one ZIP file with your profile, collections (with nesting), items with all their details, original
              photos, Grails, posts, comments, messages you sent and the collectors you follow — as JSON, plus CSV for
              collections and items.
            </Text>
          ) : (
            <Text style={styles.body}>Get one ZIP file with your profile, collections, items, photos and more.</Text>
          )}
          {startButton('Request my data')}
        </>
      ) : null}

      {state === 'preparing' && info ? (
        <View accessible accessibilityLabel={`Preparing your data, ${info.progress.percent} percent`}>
          <Text style={styles.status}>Preparing…</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.max(3, info.progress.percent)}%` }]} />
          </View>
          <Text style={styles.note}>
            {info.progress.total ? `${info.progress.percent}% · ` : ''}Keep this screen open. If you leave, it continues
            when you come back.
          </Text>
        </View>
      ) : null}

      {state === 'ready' && info ? (
        <>
          <Text style={styles.status}>Ready to Download</Text>
          <Text style={styles.body}>
            {[formatSize(info.size_bytes), info.expires_at ? `available until ${formatDate(info.expires_at)}` : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.primary, busy && styles.disabled, pressed && styles.pressed]}
            onPress={handleDownload}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Download my data">
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Download</Text>}
          </Pressable>
          <Text style={styles.note}>Download links work for a few minutes; tap Download again for a new one.</Text>
          {!asking ? (
            <Pressable onPress={() => setAsking(true)} accessibilityRole="button" accessibilityLabel="Prepare a new copy">
              <Text style={styles.link}>Prepare a new copy</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      {state === 'failed' ? (
        <>
          <Text style={[styles.status, styles.failed]}>Failed</Text>
          <Text style={styles.body}>We couldn’t prepare your data. Nothing was shared. Please try again.</Text>
          <SupportEmailLine prefix="If it keeps failing, contact" subject="CacheCase Download My Data" style={styles.body} />
          {startButton('Try again')}
        </>
      ) : null}

      {state === 'expired' && info ? (
        <>
          <Text style={styles.status}>Expired</Text>
          <Text style={styles.body}>
            Your last download {info.expires_at ? `expired on ${formatDate(info.expires_at)}` : 'has expired'} and has
            been deleted.
          </Text>
          {startButton('Request my data again')}
        </>
      ) : null}

      {askForPassword}
      {error ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>{error}</Text>
          {error === REQUEST_ERRORS.server ? (
            <SupportEmailLine prefix="If this keeps happening, contact" subject="CacheCase Download My Data" style={styles.errorText} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    padding: 16,
    gap: 10,
  },
  center: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  title: {
    color: PV2.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  status: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 6,
  },
  failed: {
    color: PV2.statusNegative,
  },
  body: {
    color: PV2.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  note: {
    color: PV2.textTertiary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
  },
  link: {
    color: PV2.actionPrimary,
    fontSize: 14,
    fontWeight: '600',
    paddingVertical: 4,
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: PV2.emptyCardBg,
    overflow: 'hidden',
  },
  fill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: PV2.actionPrimary,
  },
  ask: {
    gap: 8,
  },
  label: {
    color: PV2.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
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
  primary: {
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.actionPrimaryFill,
  },
  primaryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.75,
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
});
