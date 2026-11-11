import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatDeletionDate } from '@/components/account/pending-deletion-screen';
import { DataExportPanel } from '@/components/account/data-export-panel';
import { SupportEmailLine } from '@/components/account/support-email-line';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { type SuspensionCategory, useAccountLifecycle } from '@/lib/account-lifecycle';
import { useAuth } from '@/lib/auth';

// Shown INSTEAD of the app (app/_layout.tsx) while the signed-in collector's
// account is suspended (Phase 2B M3). The database already hides the account
// and refuses its activity; this screen only offers what is still possible:
// Download My Data, Delete Account, contacting support, and signing out. It
// shows a broad category and the end date — never the internal reason, any
// note, the report, the reporter, or which admin decided.

export const SUSPENSION_CATEGORY_TEXT: Record<SuspensionCategory, string> = {
  community_guidelines: 'Violating the CacheCase Community Guidelines',
  spam_or_scams: 'Spam, scams or fraudulent activity',
  impersonation: 'Impersonating another person or organization',
  intellectual_property: 'Infringing someone else’s intellectual property',
  ban_evasion: 'Evading a previous enforcement action',
};

export function SuspendedAccountScreen() {
  const { suspension, refresh } = useAccountLifecycle();
  const { session, signOut } = useAuth();
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const category = suspension?.category ?? 'community_guidelines';
  const expiresAt = suspension?.expiresAt ?? null;

  async function checkAgain() {
    if (checking) return;
    setChecking(true);
    await refresh();
    setChecking(false);
  }

  function handleSignOut() {
    Alert.alert('Sign out', 'You can sign in again at any time.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ]);
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content} testID="account-suspended-screen">
        <View style={styles.iconWrap}>
          <IconSymbol name="bell.fill" size={26} color={PV2.statusNegative} />
        </View>
        <Text style={styles.title} accessibilityRole="header">Your account is suspended</Text>
        {session?.user?.email ? <Text style={styles.email}>{session.user.email}</Text> : null}

        <View style={styles.card} accessible accessibilityLabel={`Reason: ${SUSPENSION_CATEGORY_TEXT[category]}. ${expiresAt ? `Until ${formatDeletionDate(expiresAt)}.` : 'No end date.'}`}>
          <Text style={styles.cardLabel}>Reason</Text>
          <Text style={styles.value}>{SUSPENSION_CATEGORY_TEXT[category]}</Text>
          <Text style={[styles.cardLabel, styles.spaced]}>{expiresAt ? 'Suspended until' : 'Duration'}</Text>
          <Text style={styles.value}>{expiresAt ? formatDeletionDate(expiresAt) : 'No end date — it stays in place until it’s reviewed and lifted.'}</Text>
        </View>

        <View style={styles.card}>
          <Bullet>While your account is suspended, your profile, collections, posts and messages are hidden from everyone.</Bullet>
          <Bullet>You can’t post, comment, message, follow or upload.</Bullet>
          <Bullet>{`Nothing has been deleted. ${expiresAt ? 'Your account returns to normal automatically when the suspension ends.' : 'If the suspension is lifted, your account returns exactly as it was.'}`}</Bullet>
          <Bullet>You can still download your data or delete your account.</Bullet>
        </View>

        <SupportEmailLine prefix="Questions, or think this is a mistake? Contact" subject="CacheCase account suspension" style={styles.support} />

        <Pressable
          style={({ pressed }) => [styles.secondary, (pressed || checking) && styles.pressed]}
          onPress={checkAgain}
          disabled={checking}
          accessibilityRole="button"
          accessibilityState={{ disabled: checking, busy: checking }}
          accessibilityLabel="Check again">
          {checking ? <ActivityIndicator color={PV2.textPrimary} /> : <Text style={styles.secondaryText}>Check Again</Text>}
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          onPress={handleSignOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out">
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>

        <DataExportPanel compact />

        <Pressable
          style={({ pressed }) => [styles.danger, pressed && styles.pressed]}
          onPress={() => router.push('/account/delete')}
          accessibilityRole="button"
          accessibilityLabel="Delete account"
          testID="account-suspended-delete">
          <Text style={styles.dangerText}>Delete Account</Text>
        </Pressable>
      </ScrollView>
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
  container: { flex: 1, backgroundColor: PV2.bg },
  content: { padding: 20, paddingTop: 32, gap: 14 },
  iconWrap: {
    width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,59,48,0.14)',
  },
  title: { color: PV2.textPrimary, fontSize: 26, fontWeight: '700' },
  email: { color: PV2.textSecondary, fontSize: 14, marginTop: -6 },
  card: {
    borderRadius: 14, backgroundColor: PV2.collectorPanelBg, borderWidth: 1, borderColor: PV2.collectorPanelBorder,
    padding: 16, gap: 6,
  },
  cardLabel: { color: PV2.textTertiary, fontSize: 12, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase' },
  spaced: { marginTop: 8 },
  value: { color: PV2.textPrimary, fontSize: 16, fontWeight: '600' },
  body: { color: PV2.textSecondary, fontSize: 15, lineHeight: 21, flex: 1 },
  bullet: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  bulletDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: PV2.textTertiary, marginTop: 8 },
  support: { color: PV2.textSecondary, fontSize: 14, lineHeight: 20 },
  secondary: {
    borderRadius: 12, borderWidth: 1, borderColor: PV2.border, paddingVertical: 14, alignItems: 'center',
  },
  secondaryText: { color: PV2.textPrimary, fontSize: 16, fontWeight: '600' },
  signOutText: { color: PV2.textSecondary, fontSize: 16, fontWeight: '600' },
  danger: {
    borderRadius: 12, borderWidth: 1, borderColor: PV2.statusNegative, paddingVertical: 14, alignItems: 'center',
  },
  dangerText: { color: PV2.statusNegative, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
