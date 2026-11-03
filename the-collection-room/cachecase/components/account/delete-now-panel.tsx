import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SupportEmailLine } from '@/components/account/support-email-line';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { type DeleteNowFailure, useAccountLifecycle } from '@/lib/account-lifecycle';

// Delete Permanently Now (Dashboard Milestone 2, Checkpoint 4) — used on
// the Delete Account screen and the Pending Deletion screen. Offered only
// when the server reports its deletion worker is ready; until then it says
// so and has no button. Confirmation: the password (a sign-in from the last
// 10 minutes) and the typed word DELETE.

const CONFIRMATION_WORD = 'DELETE';
const ERRORS: Record<DeleteNowFailure, string> = {
  wrong_password: 'That password isn’t right. Please try again.',
  reauthentication_required: 'For your security, please enter your password again.',
  confirmation_required: `Type ${CONFIRMATION_WORD} exactly to confirm.`,
  deletion_in_progress: 'This account is already being deleted.',
  session_expired: 'Your session has expired. Sign in again and retry.',
  network: 'Couldn’t reach CacheCase. Check your connection and try again.',
  server: 'Something went wrong. Please try again.',
  deletion_unavailable: 'Permanent deletion isn’t available right now. Nothing has changed.',
};

export function DeleteNowPanel() {
  const { deleteNowAvailable, loadDeletionInfo, deleteNow } = useAccountLifecycle();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DeleteNowFailure | null>(null);

  useEffect(() => {
    void loadDeletionInfo();
  }, [loadDeletionInfo]);

  const ready = password.length > 0 && confirmation === CONFIRMATION_WORD && !busy;

  async function handleDelete() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const result = await deleteNow(password, confirmation);
    // On success the app shows "Deleting your account…" on its own.
    if (!result.ok) {
      setBusy(false);
      setError(result.reason);
      if (result.reason === 'wrong_password' || result.reason === 'reauthentication_required') setPassword('');
    }
  }

  if (deleteNowAvailable !== true) {
    return (
      <View style={styles.card} accessible accessibilityLabel="Delete Permanently Now, not available right now">
        <Text style={[styles.title, styles.muted]}>Delete Permanently Now</Text>
        <Text style={styles.body}>
          {deleteNowAvailable === null ? 'Checking…' : 'Not available right now. Please try again later.'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        Delete Permanently Now
      </Text>
      {!open ? (
        <>
          <Text style={styles.body}>Skip the recovery period. This can’t be undone.</Text>
          <Pressable
            style={({ pressed }) => [styles.outline, pressed && styles.pressed]}
            onPress={() => setOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Delete permanently now">
            <Text style={styles.outlineText}>Delete Permanently Now…</Text>
          </Pressable>
        </>
      ) : (
        <>
          <View style={styles.warning}>
            <Text style={styles.warningTitle}>This is permanent and immediate</Text>
            <Text style={styles.body}>• Your profile, collections, items, photos, Grails, posts, comments and messages you sent are deleted.</Text>
            <Text style={styles.body}>• Copies of your items in other collectors’ posts are removed; their posts stay.</Text>
            <Text style={styles.body}>• Messages others sent you stay with them; the conversation shows “Deleted account”.</Text>
            <Text style={styles.body}>• There is no recovery period and no way to cancel once it starts.</Text>
            <Text style={styles.body}>• Your username can’t be used by anyone for 90 days.</Text>
            <Text style={styles.body}>• Copies in our backups are removed within 7 days.</Text>
            <Text style={styles.body}>• Download My Data first if you want a copy.</Text>
          </View>
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
            accessibilityLabel="Password for permanent deletion"
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
            accessibilityLabel={`Type ${CONFIRMATION_WORD} to delete permanently`}
            editable={!busy}
          />
          {error ? (
            <View style={styles.errorBox} accessibilityRole="alert">
              <Text style={styles.errorText}>{ERRORS[error]}</Text>
              {error === 'server' ? (
                <SupportEmailLine prefix="If this keeps happening, contact" subject="CacheCase account deletion" style={styles.errorText} />
              ) : null}
            </View>
          ) : null}
          <Pressable
            style={({ pressed }) => [styles.destructive, !ready && styles.disabled, pressed && ready && styles.pressed]}
            onPress={handleDelete}
            disabled={!ready}
            accessibilityRole="button"
            accessibilityState={{ disabled: !ready, busy }}
            accessibilityLabel="Permanently delete my account now">
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.destructiveText}>Permanently Delete My Account</Text>}
          </Pressable>
          <Pressable onPress={() => setOpen(false)} disabled={busy} accessibilityRole="button" accessibilityLabel="Keep my account">
            <Text style={styles.link}>Keep my account</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.35)',
    backgroundColor: PV2.collectorPanelBg,
    padding: 16,
    gap: 10,
  },
  title: {
    color: PV2.statusNegative,
    fontSize: 16,
    fontWeight: '700',
  },
  muted: {
    color: PV2.textTertiary,
  },
  body: {
    color: PV2.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  warning: {
    borderRadius: 12,
    padding: 12,
    gap: 4,
    backgroundColor: 'rgba(255,59,48,0.10)',
  },
  warningTitle: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 2,
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
  outline: {
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: PV2.statusNegative,
  },
  outlineText: {
    color: PV2.statusNegative,
    fontSize: 15,
    fontWeight: '700',
  },
  destructive: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.statusNegative,
  },
  destructiveText: {
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
  link: {
    color: PV2.actionPrimary,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 6,
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
