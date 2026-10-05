import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import {
  grantWaitlistAccess,
  listWaitlistSignups,
  type GrantResult,
  type ListResult,
  type WaitlistSignup,
  type WaitlistStatus,
} from '@/lib/waitlist-admin';

// Admin-only. The client gate here (useIsAdmin) only decides what renders —
// the list and every grant go through Edge Functions that re-check
// admin_users membership server-side, so a non-admin who reaches this
// route still gets nothing.

type Filter = 'pending' | 'granted' | 'onboarded' | 'all';

const FILTERS: { key: Filter; label: string; status: WaitlistStatus | null }[] = [
  { key: 'pending', label: 'Pending', status: 'waitlisted' },
  { key: 'granted', label: 'Granted', status: 'access_granted' },
  { key: 'onboarded', label: 'Onboarded', status: 'onboarded' },
  { key: 'all', label: 'All', status: null },
];

const STATUS_LABEL: Record<WaitlistStatus, string> = {
  waitlisted: 'Waitlisted',
  access_granted: 'Access granted',
  onboarded: 'Onboarded',
};

type Notice = { text: string; tone: 'ok' | 'error' };

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function WaitlistAdminScreen() {
  const router = useRouter();
  const isAdmin = useIsAdmin();
  useScrollResponsiveNavbar({ enabled: false });

  const [signups, setSignups] = useState<WaitlistSignup[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('pending');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }, [router]);

  // Non-admins (including a deep link straight to /admin/waitlist) are sent
  // away as soon as membership is known.
  useEffect(() => {
    if (isAdmin === false) leave();
  }, [isAdmin, leave]);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  const showNotice = useCallback((next: Notice) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const applyList = useCallback(
    (res: ListResult) => {
      if (res.kind === 'ok') {
        setSignups(res.signups);
        setLoadFailed(false);
        // Expiry is judged against the time of the last load, not render time.
        setNow(Date.now());
      } else if (res.kind === 'forbidden') {
        leave();
      } else {
        setLoadFailed(true);
      }
    },
    [leave],
  );

  const load = useCallback(() => listWaitlistSignups().then(applyList), [applyList]);

  useEffect(() => {
    if (isAdmin !== true) return;
    let cancelled = false;
    listWaitlistSignups().then((res) => {
      if (!cancelled) applyList(res);
    });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, applyList]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { pending: 0, granted: 0, onboarded: 0, all: 0 };
    for (const s of signups ?? []) {
      c.all += 1;
      if (s.status === 'waitlisted') c.pending += 1;
      else if (s.status === 'access_granted') c.granted += 1;
      else if (s.status === 'onboarded') c.onboarded += 1;
    }
    return c;
  }, [signups]);

  const visible = useMemo(() => {
    const status = FILTERS.find((f) => f.key === filter)?.status ?? null;
    const q = query.trim().toLowerCase().replace(/^@/, '');
    return (signups ?? []).filter((s) => {
      if (status && s.status !== status) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q) ||
        (s.reserved_username?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [signups, filter, query]);

  const runGrant = useCallback(
    async (signup: WaitlistSignup, regenerate: boolean) => {
      setBusyId(signup.id);
      const res: GrantResult = await grantWaitlistAccess(signup.id, regenerate);
      setBusyId(null);

      if (res.kind === 'ok' || res.kind === 'email_failed') {
        setNow(Date.now());
        setSignups((prev) =>
          (prev ?? []).map((s) =>
            s.id === signup.id
              ? {
                  ...s,
                  status: res.status ?? 'access_granted',
                  access_granted_at: res.accessGrantedAt ?? s.access_granted_at,
                  access_code_expires_at: res.expiresAt ?? s.access_code_expires_at,
                }
              : s,
          ),
        );
        if (res.kind === 'ok') {
          showNotice({ text: regenerate ? 'Invite regenerated and emailed.' : 'Invite sent.', tone: 'ok' });
        } else {
          showNotice({
            text: 'Access granted, but the email didn’t send. Use Regenerate Invite to retry.',
            tone: 'error',
          });
        }
        return;
      }
      if (res.kind === 'forbidden') {
        leave();
        return;
      }
      if (res.kind === 'conflict') {
        showNotice({ text: 'This signup changed. List refreshed.', tone: 'error' });
        load();
        return;
      }
      showNotice({
        text: regenerate ? 'Couldn’t regenerate the invite. Try again.' : 'Couldn’t grant access. Try again.',
        tone: 'error',
      });
    },
    [leave, load, showNotice],
  );

  const onRegenerate = useCallback(
    (signup: WaitlistSignup) => {
      Alert.alert('Regenerate invite', 'Generate a new invite code? The previous code will stop working.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Regenerate', style: 'destructive', onPress: () => runGrant(signup, true) },
      ]);
    },
    [runGrant],
  );

  const renderItem = useCallback(
    ({ item }: { item: WaitlistSignup }) => (
      <SignupRow
        signup={item}
        now={now}
        busy={busyId === item.id}
        disabled={busyId !== null}
        onGrant={() => runGrant(item, false)}
        onRegenerate={() => onRegenerate(item)}
      />
    ),
    [busyId, now, runGrant, onRegenerate],
  );

  if (isAdmin !== true) {
    // Loading membership, or about to redirect — render nothing admin-related.
    return (
      <>
        <Stack.Screen options={{ title: '', headerBackTitle: '' }} />
        <View style={styles.centered}>
          {isAdmin === null ? <ActivityIndicator color={PV2.textSecondary} /> : null}
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Waitlist', headerBackTitle: '' }} />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <Text style={styles.subtitle}>Beta access management</Text>

        <View style={styles.searchWrap}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search name, email, username"
            placeholderTextColor={PV2.textTertiary}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>

        <View style={styles.filters}>
          {FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <TouchableOpacity
                key={f.key}
                style={[styles.filter, active && styles.filterActive]}
                onPress={() => setFilter(f.key)}>
                <Text style={[styles.filterText, active && styles.filterTextActive]}>
                  {f.label}
                  {signups ? ` ${counts[f.key]}` : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {notice ? (
          <View style={[styles.notice, notice.tone === 'error' && styles.noticeError]}>
            <Text style={styles.noticeText}>{notice.text}</Text>
          </View>
        ) : null}

        {signups === null ? (
          <View style={styles.centered}>
            {loadFailed ? (
              <>
                <Text style={styles.emptyText}>Couldn’t load the waitlist.</Text>
                <TouchableOpacity
                  style={styles.retry}
                  onPress={() => {
                    setLoadFailed(false);
                    load();
                  }}>
                  <Text style={styles.retryText}>Try again</Text>
                </TouchableOpacity>
              </>
            ) : (
              <ActivityIndicator color={PV2.textSecondary} />
            )}
          </View>
        ) : (
          <FlatList
            data={visible}
            keyExtractor={(s) => s.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PV2.link} />}
            ListHeaderComponent={
              loadFailed ? <Text style={styles.staleText}>Couldn’t refresh. Showing the last loaded list.</Text> : null
            }
            ListEmptyComponent={
              <Text style={[styles.emptyText, styles.emptyList]}>
                {query.trim() ? 'No matches.' : 'Nothing here.'}
              </Text>
            }
          />
        )}
      </SafeAreaView>
    </>
  );
}

function SignupRow({
  signup,
  now,
  busy,
  disabled,
  onGrant,
  onRegenerate,
}: {
  signup: WaitlistSignup;
  now: number;
  busy: boolean;
  disabled: boolean;
  onGrant: () => void;
  onRegenerate: () => void;
}) {
  const expired =
    signup.status === 'access_granted' &&
    !!signup.access_code_expires_at &&
    new Date(signup.access_code_expires_at).getTime() <= now;

  let detail: string | null = null;
  if (signup.status === 'access_granted') {
    detail = signup.access_code_expires_at
      ? `${expired ? 'Expired' : 'Expires'} ${formatDate(signup.access_code_expires_at)}`
      : 'No expiry recorded';
  } else if (signup.status === 'onboarded') {
    detail = `Onboarded ${formatDate(signup.onboarded_at)}`;
  }

  const action =
    signup.status === 'waitlisted'
      ? { label: 'Grant Access', onPress: onGrant, primary: true }
      : signup.status === 'access_granted'
        ? { label: 'Regenerate Invite', onPress: onRegenerate, primary: false }
        : null;

  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <View style={styles.rowIdentity}>
          <Text style={styles.name} numberOfLines={1}>
            {signup.name}
          </Text>
          <Text style={styles.email} numberOfLines={1}>
            {signup.email}
          </Text>
          {signup.reserved_username ? (
            <Text style={styles.username} numberOfLines={1}>
              @{signup.reserved_username}
            </Text>
          ) : null}
        </View>
        <View style={[styles.pill, pillStyle(signup.status)]}>
          <Text style={styles.pillText}>{STATUS_LABEL[signup.status] ?? signup.status}</Text>
        </View>
      </View>

      <View style={styles.rowBottom}>
        <View style={styles.meta}>
          <Text style={styles.metaText}>Joined {formatDate(signup.created_at)}</Text>
          {detail ? <Text style={[styles.metaText, expired && styles.metaExpired]}>{detail}</Text> : null}
        </View>
        {action ? (
          <TouchableOpacity
            style={[styles.action, action.primary ? styles.actionPrimary : styles.actionSecondary, disabled && !busy && styles.actionDisabled]}
            onPress={action.onPress}
            disabled={disabled}>
            {busy ? (
              <ActivityIndicator size="small" color={PV2.textPrimary} />
            ) : (
              <Text style={styles.actionText}>{action.label}</Text>
            )}
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

function pillStyle(status: WaitlistStatus) {
  if (status === 'access_granted') return styles.pillGranted;
  if (status === 'onboarded') return styles.pillOnboarded;
  return styles.pillWaitlisted;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.bg,
    gap: 12,
  },
  subtitle: {
    fontSize: 13,
    color: PV2.textSecondary,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  searchWrap: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 10,
    backgroundColor: PV2.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PV2.panelBorder,
  },
  searchInput: {
    fontSize: 15,
    color: PV2.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  filters: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  filter: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PV2.border,
  },
  filterActive: {
    backgroundColor: PV2.textPrimary,
    borderColor: PV2.textPrimary,
  },
  filterText: {
    fontSize: 13,
    color: PV2.textSecondary,
    fontWeight: '500',
  },
  filterTextActive: {
    color: PV2.bg,
  },
  notice: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(52,199,89,0.16)',
  },
  noticeError: {
    backgroundColor: PV2.accentSoft,
  },
  noticeText: {
    fontSize: 13,
    color: PV2.textPrimary,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 8,
  },
  staleText: {
    fontSize: 12,
    color: PV2.textTertiary,
    paddingBottom: 4,
  },
  emptyText: {
    fontSize: 14,
    color: PV2.textSecondary,
  },
  emptyList: {
    textAlign: 'center',
    paddingTop: 40,
  },
  retry: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: PV2.panel,
  },
  retryText: {
    fontSize: 14,
    color: PV2.link,
  },
  row: {
    backgroundColor: PV2.panel,
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  rowIdentity: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  email: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  username: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
  pill: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  pillWaitlisted: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  pillGranted: {
    backgroundColor: 'rgba(90,169,240,0.18)',
  },
  pillOnboarded: {
    backgroundColor: 'rgba(52,199,89,0.18)',
  },
  pillText: {
    fontSize: 11,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  rowBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  meta: {
    flex: 1,
    gap: 2,
  },
  metaText: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
  metaExpired: {
    color: PV2.accent,
  },
  action: {
    minWidth: 112,
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  actionPrimary: {
    backgroundColor: PV2.accent,
  },
  actionSecondary: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PV2.borderStrong,
  },
  actionDisabled: {
    opacity: 0.4,
  },
  actionText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
});
