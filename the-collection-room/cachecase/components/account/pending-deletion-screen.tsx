import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SafeAreaView } from 'react-native-safe-area-context';

import { DataExportPanel } from '@/components/account/data-export-panel';
import { DeleteNowPanel } from '@/components/account/delete-now-panel';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { type CancelFailure, useAccountLifecycle } from '@/lib/account-lifecycle';
import { useAuth } from '@/lib/auth';
import { SUPPORT_CONTACT } from '@/lib/support-contact';

// Shown INSTEAD of the app (app/_layout.tsx) while the signed-in collector's
// account is pending deletion or being deleted. The database already hides
// the account and blocks its activity; this screen only offers what is
// still possible: cancelling during the recovery window, Download My Data
// (its server path serves pending accounts), Delete Permanently Now (only
// when the server's deletion worker is ready) and signing out. While the
// account is being deleted the screen shows the job's real progress and
// never says "deleted" — that confirmation comes from the server after the
// account is gone (DeletionNoticeScreen).

export function formatDeletionDate(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
}

export function formatRemaining(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'The recovery period has ended.';
  const totalHours = Math.floor(ms / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}${hours ? `, ${hours} ${hours === 1 ? 'hour' : 'hours'}` : ''} left to recover your account`;
  const minutes = Math.max(1, Math.floor((ms % 3_600_000) / 60_000));
  return totalHours >= 1
    ? `${totalHours} ${totalHours === 1 ? 'hour' : 'hours'} left to recover your account`
    : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left to recover your account`;
}

const CANCEL_ERRORS: Record<CancelFailure, string> = {
  network: 'Couldn’t reach CacheCase. Check your connection and try again — your account can still be recovered.',
  session_expired: 'Your session has expired. Sign in again to cancel the deletion.',
  deletion_in_progress: 'Deletion has already started and can’t be cancelled.',
  server: 'Something went wrong. Please try again — your account can still be recovered.',
};

export function PendingDeletionScreen() {
  const { status, scheduledFor, cancelDeletion, loadDeletionInfo, deletionJob } = useAccountLifecycle();
  const { session, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CancelFailure | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const deleting = status === 'deleting';

  async function handleCancel() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await cancelDeletion();
    setBusy(false);
    if (!result.ok) setError(result.reason);
  }

  function handleSignOut() {
    Alert.alert(
      'Sign out',
      deleting ? 'You’ll be signed out.' : 'You can sign in again any time before the deletion date to recover your account.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: signOut },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.iconWrap}>
          <IconSymbol name="bell.fill" size={26} color={PV2.statusNegative} />
        </View>
        <Text style={styles.title} accessibilityRole="header">
          {deleting ? 'Your account is being deleted' : 'Your account is scheduled for deletion'}
        </Text>
        {session?.user?.email ? <Text style={styles.email}>{session.user.email}</Text> : null}

        {!deleting && scheduledFor ? (
          <View style={styles.card} accessible accessibilityLabel={`Deletion on ${formatDeletionDate(scheduledFor)}. ${formatRemaining(scheduledFor, now)}.`}>
            <Text style={styles.cardLabel}>Permanent deletion</Text>
            <Text style={styles.date}>{formatDeletionDate(scheduledFor)}</Text>
            <Text style={styles.remaining}>{formatRemaining(scheduledFor, now)}</Text>
          </View>
        ) : null}

        <View style={styles.card}>
          {deleting ? (
            <View accessible accessibilityLabel={deletionProgressLabel(deletionJob)}>
              <Text style={styles.body}>
                Deletion has started and can no longer be cancelled. You don’t need to do anything else — you’ll be
                signed out when it’s finished.
              </Text>
              <Text style={styles.progress}>{deletionProgressLabel(deletionJob)}</Text>
            </View>
          ) : (
            <>
              <Bullet>Your profile, collections, items, Grails, posts and messages are hidden from everyone.</Bullet>
              <Bullet>Nothing has been deleted yet. Cancelling restores your account exactly as it was.</Bullet>
              <Bullet>Until you cancel, you can’t post, message, follow, tag or upload.</Bullet>
              <Bullet>If you don’t cancel, your account will be permanently deleted on the date above.</Bullet>
            </>
          )}
        </View>

        {error ? (
          <View style={styles.errorBox} accessibilityRole="alert">
            <Text style={styles.errorText}>{CANCEL_ERRORS[error]}</Text>
          </View>
        ) : null}

        {!deleting ? (
          <Pressable
            style={({ pressed }) => [styles.primary, (pressed || busy) && styles.pressed]}
            onPress={error === 'session_expired' ? signOut : handleCancel}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy, busy }}
            accessibilityLabel={error === 'session_expired' ? 'Sign in again' : 'Cancel deletion'}>
            {busy ? <ActivityIndicator color="#fff" /> : (
              <Text style={styles.primaryText}>{error === 'session_expired' ? 'Sign In Again' : 'Cancel Deletion'}</Text>
            )}
          </Pressable>
        ) : (
          <Pressable
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            onPress={() => void loadDeletionInfo()}
            accessibilityRole="button"
            accessibilityLabel="Check status">
            <Text style={styles.secondaryText}>Check Status</Text>
          </Pressable>
        )}

        <Pressable
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          onPress={handleSignOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out">
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>

        {!deleting ? <DataExportPanel compact /> : null}
        {!deleting ? <DeleteNowPanel /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// Honest progress: queued, removing files (with counts), finishing — never
// "deleted" (only the server's confirmation after sign-out says that).
function deletionProgressLabel(job: { status: string; objects_total: number | null; objects_deleted: number } | null): string {
  if (!job) return 'Starting…';
  if (job.status === 'queued') return 'Waiting to start…';
  if (job.status === 'cleaning_storage') {
    return job.objects_total ? `Removing your files: ${job.objects_deleted} of ${job.objects_total}` : 'Removing your files…';
  }
  if (job.status === 'deleting_account') return 'Finishing — removing your account…';
  if (job.status === 'failed') {
    return `This is taking longer than expected. Our team can see it and will finish it.${SUPPORT_CONTACT.email ? ` Questions? Contact ${SUPPORT_CONTACT.email}.` : ''}`;
  }
  return 'Finishing…';
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
  content: {
    padding: 20,
    paddingTop: 32,
    gap: 14,
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,59,48,0.14)',
  },
  title: {
    color: PV2.textPrimary,
    fontSize: 26,
    fontWeight: '700',
  },
  email: {
    color: PV2.textSecondary,
    fontSize: 14,
    marginTop: -6,
  },
  card: {
    borderRadius: 14,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    padding: 16,
    gap: 6,
  },
  cardLabel: {
    color: PV2.textTertiary,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  date: {
    color: PV2.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  remaining: {
    color: PV2.textSecondary,
    fontSize: 14,
  },
  bullet: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 4,
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
  primary: {
    marginTop: 4,
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.actionPrimaryFill,
  },
  primaryText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
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
  signOutText: {
    color: PV2.statusNegative,
    fontSize: 16,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.75,
  },
  progress: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    marginTop: 10,
  },
  unavailableList: {
    marginTop: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    overflow: 'hidden',
  },
  unavailableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  unavailableLabel: {
    color: PV2.textTertiary,
    fontSize: 15,
  },
  unavailableBadge: {
    color: PV2.textTertiary,
    fontSize: 12,
    fontWeight: '600',
  },
});
