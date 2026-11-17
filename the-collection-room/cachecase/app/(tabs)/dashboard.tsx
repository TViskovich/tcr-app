import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useFocusEffect, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatCount, PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useDashboardAnalytics } from '@/hooks/use-dashboard-analytics';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { useProfile } from '@/hooks/use-profile';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useTaggingAvailable } from '@/hooks/use-tagging-available';
import { useAuth } from '@/lib/auth';
import { CACHECASE_FEATURES_URL } from '@/lib/cachecase-website';
import { supabase } from '@/lib/supabase';
import { SUPPORT_CONTACT, supportMailto } from '@/lib/support-contact';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

// The collector's Dashboard (right-hand bottom-nav tab): Analytics,
// How-To & Knowledge Base (How CacheCase Works → the website Features page),
// Support & Contact, Account & Security, plus the admin-only Waitlist entry.
//
// Beta scope: Transfers and the CC#ID Registry are not launching in the
// beta, so nothing here shows, counts, links to or explains them. Their
// screens, components and data are untouched for future releases.
//
// Every number is read from data CacheCase already stores — profile totals
// from useProfile (the same counts Profile V2 shows), everything else from
// useDashboardAnalytics. A count that couldn't be loaded says so; it is
// never shown as zero. Nothing here adds tables, events or server code.

const GRAIL_SLOT_COUNT = 9;

type IconName = ComponentProps<typeof IconSymbol>['name'];

// ── Dashboard palette ──────────────────────────────────────────────────────
// Premium dark charcoal with warm bronze/gold accents — Dashboard only (the
// app-wide PV2 theme is unchanged). Built from colors CacheCase already
// uses: the premium empty-state card's gold (#D4A520 / rgba(214,160,42,…))
// and vault charcoals (components/ui/premium-empty-card.tsx), with PV2's
// white/gray text. Gold on the card fill is ~8:1, well above WCAG AA.
const DASH = {
  bg: '#0a0908', // premium card's near-black vault base
  card: '#1A1510', // VAULT_COLORS[0]: warm dark charcoal
  cardBorder: 'rgba(214,160,42,0.22)', // subtle bronze edge
  gold: '#D4A520', // counts, icons, selected states
  goldSoft: 'rgba(214,160,42,0.14)', // icon tiles, bar tracks
  divider: 'rgba(214,160,42,0.12)',
  textPrimary: PV2.textPrimary,
  textSecondary: PV2.textSecondary,
  textTertiary: PV2.textTertiary,
} as const;

// ── Screen ─────────────────────────────────────────────────────────────────
export default function DashboardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session, signOut } = useAuth();
  const userId = session?.user?.id;
  const email = session?.user?.email ?? null;
  // UI gate only — /admin/waitlist re-checks membership itself, and its
  // Edge Functions are the real authorization boundary.
  const isAdmin = useIsAdmin();
  const taggingAvailable = useTaggingAvailable();
  useScrollResponsiveNavbar({ enabled: false });

  // Loaded on focus below, not at mount, so the first visit loads once.
  const { profile, stats, loading: profileLoading, refresh: refreshProfile } = useProfile(userId, null, true);
  const analytics = useDashboardAnalytics(userId);
  const { refresh: refreshAnalytics } = analytics;
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      refreshProfile();
      refreshAnalytics();
    }, [refreshProfile, refreshAnalytics]),
  );

  async function handleRefresh() {
    setRefreshing(true);
    await Promise.all([refreshProfile(), refreshAnalytics()]);
    setRefreshing(false);
  }

  // useProfile only ever commits profile + stats together, so a loaded
  // profile means the stats are real; no profile after loading = failed.
  const profileReady = profile !== null;
  const profileFailed = !profileReady && !profileLoading;

  function handleSignOut() {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ]);
  }

  async function openUrl(url: string) {
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch {
      Alert.alert('Couldn’t open link', 'Please try again later.');
    }
  }
  async function openMail(address: string, subject?: string) {
    const url = supportMailto(subject);
    if (!url) return;
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('No mail app available', `You can email ${address} from any mail app.`);
    }
  }

  const supportRows: { key: string; title: string; detail: string; icon: IconName; onPress: (() => void) | null }[] = [
    {
      key: 'help',
      title: 'Help Center',
      detail: SUPPORT_CONTACT.helpCenterUrl ? 'Guides and answers on the web' : 'Not available yet',
      icon: 'list.bullet',
      onPress: SUPPORT_CONTACT.helpCenterUrl ? () => openUrl(SUPPORT_CONTACT.helpCenterUrl!) : null,
    },
    {
      key: 'contact',
      title: 'Contact Support',
      detail: SUPPORT_CONTACT.email ?? 'Not available yet',
      icon: 'paperplane.fill',
      onPress: SUPPORT_CONTACT.email ? () => openMail(SUPPORT_CONTACT.email!, 'CacheCase support') : null,
    },
    {
      key: 'report',
      title: 'Report a Problem',
      detail: SUPPORT_CONTACT.reportIssueUrl || SUPPORT_CONTACT.email ? 'Tell us what went wrong' : 'Not available yet',
      icon: 'bell.fill',
      onPress: SUPPORT_CONTACT.reportIssueUrl
        ? () => openUrl(SUPPORT_CONTACT.reportIssueUrl!)
        : SUPPORT_CONTACT.email
          ? () => openMail(SUPPORT_CONTACT.email!, 'CacheCase problem report')
          : null,
    },
  ];
  // Only destinations that work are listed — no "not available yet" rows.
  const liveSupportRows = supportRows.filter((r) => r.onPress);
  const supportConfigured = liveSupportRows.length > 0;

  const { categories, views, engagement, showcase, loading: analyticsLoading } = analytics;
  const categoryMax = Math.max(1, ...(categories ?? []).map((c) => c.count));

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={DASH.gold} />}>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Dashboard
          </Text>
          {profile?.username ? <Text style={styles.subtitle}>@{profile.username}</Text> : null}
        </View>

        {/* ── Analytics ── */}
        <SectionHeader icon="sparkles" title="Analytics" />
        <Card title="Collection">
          {profileFailed ? (
            <LoadFailed onRetry={refreshProfile} />
          ) : (
            <View style={styles.statGrid}>
              <StatTile label="Items" value={profileReady ? stats.itemCount : null} />
              <StatTile label="Collections" value={profileReady ? stats.folderCount : null} />
              <StatTile label="Graded" value={profileReady ? stats.gradedCount : null} />
              <StatTile
                label="Grails"
                value={showcase?.grailSlots ?? null}
                suffix={`/${GRAIL_SLOT_COUNT}`}
                failed={!analyticsLoading && !showcase}
              />
              <StatTile label="Posts" value={profileReady ? stats.postCount : null} />
            </View>
          )}
        </Card>

        <Card title="Categories">
          {categories ? (
            categories.length === 0 ? (
              <Text style={styles.muted}>Add items to see your collection by category.</Text>
            ) : (
              categories.map((c) => (
                <View key={c.label} style={styles.barRow} accessible accessibilityLabel={`${c.label}: ${c.count}`}>
                  <View style={styles.barLabelRow}>
                    <Text style={styles.barLabel}>{c.label}</Text>
                    <Text style={styles.barValue}>{formatCount(c.count)}</Text>
                  </View>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${(c.count / categoryMax) * 100}%` }]} />
                  </View>
                </View>
              ))
            )
          ) : analyticsLoading ? (
            <Loading />
          ) : (
            <LoadFailed onRetry={refreshAnalytics} />
          )}
        </Card>

        <Card title="Item Views">
          {views ? (
            <>
              <View style={styles.viewsHeadline} accessible accessibilityLabel={`${views.totalViews} item views across ${views.viewedItems} items`}>
                <Text style={styles.bigNumber}>{formatCount(views.totalViews)}</Text>
                <Text style={styles.muted}>
                  {views.viewedItems === 0
                    ? 'No views yet'
                    : `views across ${formatCount(views.viewedItems)} ${views.viewedItems === 1 ? 'item' : 'items'}`}
                </Text>
              </View>
              {views.top.length > 0 && <Text style={styles.subheading}>Most viewed</Text>}
              {views.top.map((t, i) => (
                <Pressable
                  key={t.id}
                  onPress={() => router.push({ pathname: '/item/[id]', params: { id: t.id } })}
                  style={({ pressed }) => [styles.listRow, i > 0 && styles.listRowBorder, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.title}, ${t.views} ${t.views === 1 ? 'view' : 'views'}`}>
                  <Text style={styles.listRowTitle} numberOfLines={1}>
                    {t.title}
                  </Text>
                  <Text style={styles.listRowValue}>{formatCount(t.views)}</Text>
                  <IconSymbol name="chevron.right" size={13} color={DASH.textTertiary} />
                </Pressable>
              ))}
              <Text style={styles.footnote}>
                Counts views of your items by other signed-in collectors, at most once per collector every 30 minutes,
                since view tracking began.
              </Text>
            </>
          ) : analyticsLoading ? (
            <Loading />
          ) : (
            <LoadFailed onRetry={refreshAnalytics} />
          )}
        </Card>

        <Card title="Engagement">
          {profileFailed ? null : (
            <View style={[styles.statGrid, styles.statGridSpaced]}>
              <StatTile label="Followers" value={profileReady ? stats.followerCount : null} />
              <StatTile label="Following" value={profileReady ? stats.followingCount : null} />
            </View>
          )}
          {engagement ? (
            <>
              <MetricRow label="Post likes" value={engagement.postLikes} first />
              <MetricRow label="Post comments" value={engagement.postComments} />
              <MetricRow label="Item likes" value={engagement.itemLikes} />
              <MetricRow label="Item comments" value={engagement.itemComments} />
              <MetricRow label="Collection likes" value={engagement.collectionLikes} />
              <MetricRow label="Collection comments" value={engagement.collectionComments} />
              {engagement.timesTagged !== null && <MetricRow label="Times tagged" value={engagement.timesTagged} />}
              <Text style={styles.footnote}>Likes, comments and tags from other collectors, all time.</Text>
            </>
          ) : analyticsLoading ? (
            <Loading />
          ) : (
            <LoadFailed onRetry={refreshAnalytics} />
          )}
        </Card>

        <Card>
          <Text style={styles.muted}>
            Profile views, Top 9 / Grails impressions and link clicks aren’t recorded yet, so they aren’t shown here.
          </Text>
        </Card>

        {/* ── How-To & Knowledge Base ── */}
        <SectionHeader icon="list.bullet" title="How-To & Knowledge Base" />
        <View style={styles.card}>
          <Pressable
            onPress={() => openUrl(CACHECASE_FEATURES_URL)}
            style={({ pressed }) => [styles.navRow, pressed && styles.pressed]}
            accessibilityRole="link"
            accessibilityLabel="How CacheCase Works, explore features and guides"
            accessibilityHint="Opens cachecase.com in the in-app browser">
            <View style={styles.iconTile}>
              <IconSymbol name="list.bullet" size={18} color={DASH.gold} />
            </View>
            <View style={styles.navRowText}>
              <Text style={styles.navRowTitle}>How CacheCase Works</Text>
              <Text style={styles.navRowDetail}>Explore features and guides</Text>
            </View>
            <IconSymbol name="chevron.right" size={13} color={DASH.textTertiary} />
          </Pressable>
        </View>
        {/* ── Support & Contact ── */}
        <SectionHeader icon="paperplane.fill" title="Support & Contact" />
        {supportConfigured && (
        <View style={styles.card}>
          {liveSupportRows.map((r, i) => (
            <Pressable
              key={r.key}
              onPress={r.onPress ?? undefined}
              disabled={!r.onPress}
              style={({ pressed }) => [styles.navRow, i > 0 && styles.listRowBorder, pressed && styles.pressed]}
              accessibilityRole={r.onPress ? 'button' : 'text'}
              accessibilityState={{ disabled: !r.onPress }}
              accessibilityLabel={`${r.title}${r.onPress ? '' : ', not available yet'}`}>
              <View style={styles.iconTile}>
                <IconSymbol name={r.icon} size={16} color={r.onPress ? DASH.gold : DASH.textTertiary} />
              </View>
              <View style={styles.navRowText}>
                <Text style={[styles.navRowTitle, !r.onPress && styles.disabledText]}>{r.title}</Text>
                <Text style={styles.navRowDetail}>{r.detail}</Text>
              </View>
              {r.onPress ? <IconSymbol name="chevron.right" size={13} color={DASH.textTertiary} /> : null}
            </Pressable>
          ))}
        </View>
        )}
        {!supportConfigured && (
          <Text style={styles.sectionNote}>Support contact details are being finalized and will appear here.</Text>
        )}

        {/* ── Account & Security ── */}
        <SectionHeader icon="person.fill" title="Account & Security" />
        <Card>
          <Text style={styles.subheading}>Signed in as</Text>
          <Text style={styles.email} selectable>
            {email ?? 'Email unavailable'}
          </Text>
        </Card>
        <Card title="Privacy">
          <Bullet>Your profile — name, username, photo, bio and Grails — is visible to other collectors.</Bullet>
          <Bullet>Public collections and items are visible to other collectors. Private ones are visible only to you.</Bullet>
          <Bullet>Messages are visible only to the people in the conversation.</Bullet>
          {taggingAvailable && (
            <Bullet>When you’re tagged, the tag is visible to anyone who can see that item or collection.</Bullet>
          )}
        </Card>
        <View style={styles.card}>
          <Pressable
            onPress={() => router.push('/account/password')}
            style={({ pressed }) => [styles.navRow, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Change Password">
            <View style={styles.navRowText}>
              <Text style={styles.navRowTitle}>Change Password</Text>
              <Text style={styles.navRowDetail}>Confirm your current password to choose a new one</Text>
            </View>
            <IconSymbol name="chevron.right" size={13} color={DASH.textTertiary} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/account/blocked')}
            style={({ pressed }) => [styles.navRow, styles.listRowBorder, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Blocked Collectors">
            <View style={styles.navRowText}>
              <Text style={styles.navRowTitle}>Blocked Collectors</Text>
              <Text style={styles.navRowDetail}>See who you’ve blocked and unblock them</Text>
            </View>
            <IconSymbol name="chevron.right" size={13} color={DASH.textTertiary} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/account/delete')}
            style={({ pressed }) => [styles.navRow, styles.listRowBorder, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Delete Account"
            accessibilityHint="Explains the 14-day recovery period before anything is scheduled">
            <View style={styles.navRowText}>
              <Text style={[styles.navRowTitle, styles.deleteText]}>Delete Account</Text>
              <Text style={styles.navRowDetail}>Hidden right away, deleted after 14 days unless you cancel</Text>
            </View>
            <IconSymbol name="chevron.right" size={13} color={DASH.textTertiary} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/account/export')}
            style={({ pressed }) => [styles.navRow, styles.listRowBorder, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Download My Data">
            <View style={styles.navRowText}>
              <Text style={styles.navRowTitle}>Download My Data</Text>
              <Text style={styles.navRowDetail}>A ZIP of your collections, items, photos and more</Text>
            </View>
            <IconSymbol name="chevron.right" size={13} color={DASH.textTertiary} />
          </Pressable>
        </View>
        <TouchableOpacity
          style={styles.signOut}
          onPress={handleSignOut}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Sign out">
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>

        {isAdmin === true ? (
          <>
            <SectionHeader icon="gearshape.fill" title="Admin Tools" />
            <TouchableOpacity
              style={styles.adminRow}
              onPress={() => router.push('/admin/waitlist')}
              accessibilityRole="button">
              <View style={styles.navRowText}>
                <Text style={styles.navRowTitle}>Waitlist Management</Text>
                <Text style={styles.navRowDetail}>Review signups, grant access, and manage invite status.</Text>
              </View>
              <IconSymbol name="chevron.right" size={14} color={DASH.textTertiary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.adminRow, styles.adminRowSpaced]}
              onPress={() => router.push('/admin/reports')}
              accessibilityRole="button">
              <View style={styles.navRowText}>
                <Text style={styles.navRowTitle}>Reports</Text>
                <Text style={styles.navRowDetail}>Review, claim and resolve reported content.</Text>
              </View>
              <IconSymbol name="chevron.right" size={14} color={DASH.textTertiary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.adminRow, styles.adminRowSpaced]}
              onPress={() => router.push('/admin/monitoring')}
              accessibilityRole="button">
              <View style={styles.navRowText}>
                <Text style={styles.navRowTitle}>Moderation Monitoring</Text>
                <Text style={styles.navRowDetail}>Open issues, quarantine queue, alert delivery and purge approvals.</Text>
              </View>
              <IconSymbol name="chevron.right" size={14} color={DASH.textTertiary} />
            </TouchableOpacity>
            <AccountDeletionHealth />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

// Admin-only: health of account deletion and Download My Data (server:
// account_deletion_admin_summary, which checks admin membership itself and
// returns counts, times and codes only — no identities). Details are in the
// server logs and the deployment runbook.
type DeletionSummary = {
  status: 'healthy' | 'attention';
  issues: string[];
  scheduler: { active: boolean; configured: boolean; last_successful_run_at: string | null; consecutive_failed_calls: number };
  deletions: { overdue_scheduled: number; in_progress: number; stuck_over_1h: number; expired_leases: number; failed: number; failure_codes: Record<string, number> };
  exports: { failed_24h: number; abandoned_24h: number; stuck: number };
  alerts: {
    monitor_active: boolean;
    channel_configured: boolean | null; // null until the alert function has reported
    email: string | null;
    webhook: string | null;
    open: number;
    undelivered: number;
    last_delivery_error: string | null;
  };
};
const CHANNEL_PROBLEMS: Record<string, string> = {
  missing_recipients: 'email recipients missing',
  missing_sender: 'email sender missing',
  invalid_url: 'webhook URL invalid',
};
function alertsLine(a: DeletionSummary['alerts']): string {
  const monitor = a.monitor_active ? 'Alerts on' : 'Alerts off (monitor job inactive)';
  if (a.channel_configured === null) return `${monitor} · delivery not checked yet`;
  const configured = [a.email === 'configured' && 'email', a.webhook === 'configured' && 'webhook'].filter(Boolean);
  const problems = [a.email, a.webhook].map((v) => (v ? CHANNEL_PROBLEMS[v] : undefined)).filter(Boolean);
  const channels = configured.length ? `via ${configured.join(' + ')}` : 'no delivery channel configured';
  return `${monitor} · ${channels}${problems.length ? ` (${problems.join(', ')})` : ''}`;
}
const ISSUE_LABELS: Record<string, string> = {
  scheduler_not_configured: 'Scheduler not configured',
  scheduler_inactive: 'Scheduler inactive with deletions pending',
  maintenance_runs_missing: 'No successful maintenance run in 30 min',
  maintenance_calls_failing: 'Maintenance calls failing',
  deletions_failed: 'Failed deletions',
  deletions_overdue: 'Overdue scheduled deletions',
  deletions_stuck: 'Deletions in progress over 1 h',
  deletion_leases_expired: 'Expired deletion leases',
  exports_failing: 'Exports failing',
  exports_stuck: 'Exports stuck',
};
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
function AccountDeletionHealth() {
  const [summary, setSummary] = useState<DeletionSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    supabase.rpc('account_deletion_admin_summary').then(({ data, error }) => {
      if (cancelled) return;
      if (error) setFailed(true);
      else setSummary(data as DeletionSummary);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const attention = summary?.status === 'attention';
  let lines: string[];
  if (failed) lines = ['Couldn’t load deletion status.'];
  else if (!summary) lines = ['Checking…'];
  else {
    const { scheduler: s, deletions: d, exports: e, alerts: a } = summary;
    lines = [
      attention ? `Needs attention: ${summary.issues.map((c) => ISSUE_LABELS[c] ?? c).join(', ')}.` : 'Healthy.',
      `Scheduler ${s.active ? 'active' : 'inactive'}${s.configured ? '' : ', not configured'} · last successful run ${ago(s.last_successful_run_at)}${
        s.consecutive_failed_calls ? ` · ${s.consecutive_failed_calls} failed calls` : ''}`,
      `Deletions: ${d.overdue_scheduled} overdue · ${d.in_progress} in progress (${d.stuck_over_1h} over 1 h) · ${d.failed} failed${
        d.failed ? ` (${Object.entries(d.failure_codes).map(([code, n]) => `${code} ${n}`).join(', ')})` : ''}`,
      `Exports (24 h): ${e.failed_24h} failed · ${e.abandoned_24h} abandoned${e.stuck ? ` · ${e.stuck} stuck` : ''}`,
      alertsLine(a),
      ...(a.undelivered ? [`${a.undelivered} alert${a.undelivered === 1 ? '' : 's'} not delivered${a.last_delivery_error ? ` (${a.last_delivery_error})` : ''}`] : []),
    ];
  }
  return (
    <View style={[styles.adminRow, styles.adminRowSpaced]} accessible accessibilityLabel={`Account deletions. ${lines.join(' ')}`}>
      <View style={styles.navRowText}>
        <Text style={[styles.navRowTitle, attention && styles.deleteText]}>Account Deletions</Text>
        {lines.map((line) => (
          <Text key={line} style={styles.navRowDetail}>
            {line}
          </Text>
        ))}
      </View>
    </View>
  );
}
function SectionHeader({ icon, title }: { icon: IconName; title: string }) {
  return (
    <View style={styles.sectionHeader}>
      <IconSymbol name={icon} size={15} color={DASH.gold} />
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
    </View>
  );
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={[styles.card, styles.cardPadded]}>
      {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

// `value` null = not known yet (loading) or, with `failed`, couldn't load.
function StatTile({ label, value, suffix, failed }: { label: string; value: number | null; suffix?: string; failed?: boolean }) {
  const shown = value === null ? (failed ? '—' : '…') : `${formatCount(value)}${suffix ?? ''}`;
  return (
    <View
      style={styles.statTile}
      accessible
      accessibilityLabel={
        value === null ? `${label}: ${failed ? 'couldn’t load' : 'loading'}` : `${label}: ${value}${suffix ?? ''}`
      }>
      <Text style={styles.statValue}>{shown}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function MetricRow({ label, value, first }: { label: string; value: number; first?: boolean }) {
  return (
    <View style={[styles.listRow, !first && styles.listRowBorder]} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.listRowTitle}>{label}</Text>
      <Text style={styles.listRowValue}>{formatCount(value)}</Text>
    </View>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <View style={styles.bullet}>
      <View style={styles.bulletDot} />
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

function Loading() {
  return (
    <View style={styles.stateRow}>
      <ActivityIndicator color={DASH.gold} />
    </View>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.stateRow}>
      <Text style={styles.muted}>Couldn’t load this right now.</Text>
      <Pressable style={styles.retryButton} onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry">
        <Text style={styles.retryButtonText}>Retry</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: DASH.bg,
  },
  flex: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 4,
  },
  title: {
    color: DASH.textPrimary,
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 4,
    color: DASH.textSecondary,
    fontSize: 15,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 28,
    marginBottom: 10,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    color: DASH.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  sectionNote: {
    color: DASH.textTertiary,
    fontSize: 12,
    marginHorizontal: 20,
    marginTop: -2,
    marginBottom: 10,
  },
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 14,
    backgroundColor: DASH.card,
    borderWidth: 1,
    borderColor: DASH.cardBorder,
    overflow: 'hidden',
  },
  cardPadded: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  cardTitle: {
    color: DASH.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: 14,
  },
  statGridSpaced: {
    marginBottom: 8,
  },
  statTile: {
    width: '33.33%',
    gap: 2,
  },
  statValue: {
    color: DASH.gold,
    fontSize: 22,
    fontWeight: '800',
  },
  statLabel: {
    color: DASH.textSecondary,
    fontSize: 12,
  },
  barRow: {
    marginBottom: 12,
  },
  barLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  barLabel: {
    color: DASH.textPrimary,
    fontSize: 14,
  },
  barValue: {
    color: DASH.gold,
    fontSize: 14,
    fontWeight: '600',
  },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: DASH.goldSoft,
    overflow: 'hidden',
  },
  barFill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: DASH.gold,
  },
  viewsHeadline: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 8,
  },
  bigNumber: {
    color: DASH.gold,
    fontSize: 30,
    fontWeight: '800',
  },
  subheading: {
    color: DASH.textTertiary,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 4,
    marginBottom: 2,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
  },
  listRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: DASH.divider,
  },
  listRowTitle: {
    flex: 1,
    color: DASH.textPrimary,
    fontSize: 15,
  },
  listRowValue: {
    color: DASH.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  muted: {
    color: DASH.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  footnote: {
    color: DASH.textTertiary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  iconTile: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: DASH.goldSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: DASH.cardBorder,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  navRowText: {
    flex: 1,
    gap: 2,
  },
  navRowTitle: {
    color: DASH.textPrimary,
    fontSize: 16,
    fontWeight: '500',
  },
  navRowDetail: {
    color: DASH.textSecondary,
    fontSize: 13,
  },
  disabledText: {
    color: DASH.textTertiary,
  },
  deleteText: {
    color: PV2.statusNegative,
  },
  email: {
    color: DASH.textPrimary,
    fontSize: 16,
  },
  bullet: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginTop: 8,
    backgroundColor: DASH.textTertiary,
  },
  bulletText: {
    flex: 1,
    color: DASH.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  signOut: {
    marginHorizontal: 16,
    marginTop: 4,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: DASH.card,
    borderWidth: 1,
    borderColor: DASH.cardBorder,
  },
  signOutText: {
    color: PV2.statusNegative,
    fontSize: 16,
    fontWeight: '600',
  },
  adminRowSpaced: {
    marginTop: 10,
  },
  adminRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: DASH.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: DASH.cardBorder,
  },
  stateRow: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  retryButton: {
    backgroundColor: DASH.card,
    borderWidth: 1,
    borderColor: DASH.cardBorder,
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 18,
  },
  retryButtonText: {
    color: DASH.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.75,
  },
});
