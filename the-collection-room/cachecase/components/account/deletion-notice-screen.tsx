import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { type DeletionNotice, useAccountLifecycle } from '@/lib/account-lifecycle';
import { SupportEmailLine } from '@/components/account/support-email-line';

// After a permanent deletion started on this device, once the account and
// its session are gone (app/_layout.tsx shows this over sign-in). The state
// comes only from the server's job status: "deleted" is said only when the
// server has confirmed completion.
const COPY: Record<DeletionNotice['state'], { title: string; body: string; done: boolean }> = {
  in_progress: {
    title: 'Your account is being deleted',
    body: 'This can take a few minutes. You don’t need to keep the app open.',
    done: false,
  },
  completed: {
    title: 'Your account has been deleted',
    body:
      'Your CacheCase account, your content and your photos have been permanently deleted. Copies in our backups are removed within 7 days. Thanks for collecting with us.',
    done: true,
  },
  failed: {
    title: 'Deletion isn’t finished yet',
    body: 'Something stopped your account deletion from finishing. Our team can see this and will finish it. Until then your account stays hidden from everyone.',
    done: true,
  },
  unknown: {
    title: 'Checking your account deletion…',
    body: 'We couldn’t confirm its status yet. We’ll keep checking.',
    done: false,
  },
};

export function DeletionNoticeScreen({ notice }: { notice: DeletionNotice }) {
  const { dismissDeletionNotice } = useAccountLifecycle();
  const copy = COPY[notice.state];
  return (
    <View style={[StyleSheet.absoluteFill, styles.container]} accessibilityViewIsModal>
      {!copy.done ? <ActivityIndicator color={PV2.textSecondary} /> : null}
      <Text style={styles.title} accessibilityRole="header">
        {copy.title}
      </Text>
      <Text style={styles.body}>{copy.body}</Text>
      {notice.state === 'failed' ? (
        <SupportEmailLine prefix="Questions? Contact" subject="CacheCase account deletion" style={styles.body} />
      ) : null}
      {copy.done ? (
        <Pressable
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
          onPress={dismissDeletionNotice}
          accessibilityRole="button"
          accessibilityLabel="OK">
          <Text style={styles.primaryText}>OK</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: PV2.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 14,
  },
  title: {
    color: PV2.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    color: PV2.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  primary: {
    alignSelf: 'stretch',
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.actionPrimaryFill,
  },
  primaryText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.75,
  },
});
