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
import { supabase } from '@/lib/supabase';
import { SUPPORT_CONTACT } from '@/lib/support-contact';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

// The collector's Dashboard (right-hand bottom-nav tab): Analytics,
// How-To & Knowledge Base, Support & Contact, Account & Security, plus the
// admin-only Waitlist entry.
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

// ── Knowledge base content ─────────────────────────────────────────────────
// Guides describe only what the app does today. Planned features are listed
// separately (COMING_LATER) so the two are never mixed.
type Guide = { key: string; title: string; icon: IconName; steps: string[]; note?: string };

// Shown only where the database has collector tagging (useTaggingAvailable).
const TAGGING_GUIDE: Guide = {
  key: 'tagging',
  title: 'Tagging collectors',
  icon: 'tag',
  steps: [
    'On your own item or collection, tap Tag and choose the collectors to tag (up to 20).',
    'Items and collections you’re tagged in appear on the Tagged tab of your profile.',
    'You can remove yourself from anything you’ve been tagged in.',
  ],
};

const GUIDES: Guide[] = [
  {
    key: 'collections',
    title: 'Collections',
    icon: 'folder.fill',
    steps: [
      'Create a collection from the Collections tab on your profile, then add items to it.',
      'Each collection and each item is Public or Private. Private ones are visible only to you, and an item inside a private collection is private too.',
      'Long-press a collection on your profile to reorder your collections.',
      'Inside a collection, search finds items by name and details such as player, set and grade.',
    ],
  },
  {
    key: 'grails',
    title: 'Top 9 / Grails',
    icon: 'crown.fill',
    steps: [
      'Your Grails are the nine showcase slots at the top of your profile.',
      'Tap an empty slot and choose Single Item or Collection to add a Grail.',
      'Long-press a Grail to rearrange them by dragging. While rearranging, tap a Grail to Replace or Remove it. Removing a Grail never deletes the item or collection.',
      'Anything in your Grails is shown on your profile to other collectors.',
    ],
  },
  {
    key: 'messages',
    title: 'Messages',
    icon: 'message.fill',
    steps: [
      'Start a conversation from Messages with the compose button, then choose a collector.',
      'To send an item, open it, tap Share and choose Direct Message. Only public items can be shared in DMs.',
      'Tap the name at the top of a conversation to open that collector’s profile.',
    ],
  },
];

const COMING_LATER = [
  'Profile views, Top 9 / Grails impressions and link clicks in Analytics',
  'Account freeze',
  'Private profile',
];

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
  const [openGuide, setOpenGuide] = useState<string | null>(null);

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
    const url = `mailto:${address}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
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
  const supportConfigured = supportRows.some((r) => r.onPress);

  const { categories, views, engagement, showcase, loading: analyticsLoading } = analytics;
  const guides = taggingAvailable ? [...GUIDES, TAGGING_GUIDE] : GUIDES;
  const categoryMax = Math.max(1, ...(categories ?? []).map((c) => c.count));

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={PV2.textSecondary} />}>
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
                  <IconSymbol name="chevron.right" size={13} color={PV2.textTertiary} />
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
          {guides.map((g, i) => {
            const open = openGuide === g.key;
            return (
              <View key={g.key} style={i > 0 && styles.listRowBorder}>
                <Pressable
                  onPress={() => setOpenGuide(open ? null : g.key)}
                  style={({ pressed }) => [styles.guideHeader, pressed && styles.pressed]}
                  accessibilityRole="button"
                  aria-expanded={open}
                  accessibilityLabel={`${g.title} guide`}>
                  <IconSymbol name={g.icon} size={16} color={PV2.actionPrimary} />
                  <Text style={styles.guideTitle}>{g.title}</Text>
                  <IconSymbol name={open ? 'chevron.up' : 'chevron.down'} size={13} color={PV2.textTertiary} />
                </Pressable>
                {open && (
                  <View style={styles.guideBody}>
                    {g.steps.map((s, n) => (
                      <View key={n} style={styles.step}>
                        <Text style={styles.stepNumber}>{n + 1}</Text>
                        <Text style={styles.stepText}>{s}</Text>
                      </View>
                    ))}
                    {g.note ? <Text style={styles.footnote}>{g.note}</Text> : null}
                  </View>
                )}
              </View>
            );
          })}
        </View>
        <Card title="Coming later">
          {COMING_LATER.map((c) => (
            <View key={c} style={styles.laterRow}>
              <Badge text="Planned" />
              <Text style={styles.laterText}>{c}</Text>
            </View>
          ))}
          <Text style={styles.footnote}>These aren’t available in the app yet.</Text>
        </Card>

        {/* ── Support & Contact ── */}
        <SectionHeader icon="paperplane.fill" title="Support & Contact" />
        <View style={styles.card}>
          {supportRows.map((r, i) => (
            <Pressable
              key={r.key}
              onPress={r.onPress ?? undefined}
              disabled={!r.onPress}
              style={({ pressed }) => [styles.navRow, i > 0 && styles.listRowBorder, pressed && styles.pressed]}
              accessibilityRole={r.onPress ? 'button' : 'text'}
              accessibilityState={{ disabled: !r.onPress }}
              accessibilityLabel={`${r.title}${r.onPress ? '' : ', not available yet'}`}>
              <IconSymbol name={r.icon} size={16} color={r.onPress ? PV2.actionPrimary : PV2.textTertiary} />
              <View style={styles.navRowText}>
                <Text style={[styles.navRowTitle, !r.onPress && styles.disabledText]}>{r.title}</Text>
                <Text style={styles.navRowDetail}>{r.detail}</Text>
              </View>
              {r.onPress ? <IconSymbol name="chevron.right" size={13} color={PV2.textTertiary} /> : null}
            </Pressable>
          ))}
        </View>
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
            onPress={() => router.push('/account/delete')}
            style={({ pressed }) => [styles.navRow, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Delete Account"
            accessibilityHint="Explains the 14-day recovery period before anything is scheduled">
            <View style={styles.navRowText}>
              <Text style={[styles.navRowTitle, styles.deleteText]}>Delete Account</Text>
              <Text style={styles.navRowDetail}>Hidden right away, deleted after 14 days unless you cancel</Text>
            </View>
            <IconSymbol name="chevron.right" size={13} color={PV2.textTertiary} />
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
            <IconSymbol name="chevron.right" size={13} color={PV2.textTertiary} />
          </Pressable>
          {['Freeze Account', 'Private Profile'].map((label) => (
            <View
              key={label}
              style={[styles.navRow, styles.listRowBorder]}
              accessible
              accessibilityLabel={`${label}, not available yet`}>
              <Text style={[styles.navRowTitle, styles.disabledText, styles.flex]}>{label}</Text>
              <Badge text="Coming later" />
            </View>
          ))}
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
              <IconSymbol name="chevron.right" size={14} color={PV2.textTertiary} />
            </TouchableOpacity>
            <AccountDeletionHealth />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

// Admin-only: permanent account deletions that failed and need attention
// (server: account_deletion_admin_summary, which checks admin membership
// itself and returns no identities). Details are in the server logs.
type DeletionSummary = { failed: number; in_progress: number; failure_codes: Record<string, number> };
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
  const attention = (summary?.failed ?? 0) > 0;
  const detail = failed
    ? 'Couldn’t load deletion status.'
    : !summary
      ? 'Checking…'
      : attention
        ? `${summary.failed} failed — ${Object.entries(summary.failure_codes).map(([code, n]) => `${code} (${n})`).join(', ')}. See server logs.`
        : `No failed deletions${summary.in_progress ? ` · ${summary.in_progress} in progress` : ''}.`;
  return (
    <View style={[styles.adminRow, styles.adminRowSpaced]} accessible accessibilityLabel={`Account deletions. ${detail}`}>
      <View style={styles.navRowText}>
        <Text style={[styles.navRowTitle, attention && styles.deleteText]}>Account Deletions</Text>
        <Text style={styles.navRowDetail}>{detail}</Text>
      </View>
    </View>
  );
}
function SectionHeader({ icon, title }: { icon: IconName; title: string }) {
  return (
    <View style={styles.sectionHeader}>
      <IconSymbol name={icon} size={15} color={PV2.textSecondary} />
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

function Badge({ text }: { text: string }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{text}</Text>
    </View>
  );
}

function Loading() {
  return (
    <View style={styles.stateRow}>
      <ActivityIndicator color={PV2.textSecondary} />
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
    backgroundColor: PV2.bg,
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
    color: PV2.textPrimary,
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 4,
    color: PV2.textSecondary,
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
    color: PV2.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  sectionNote: {
    color: PV2.textTertiary,
    fontSize: 12,
    marginHorizontal: 20,
    marginTop: -2,
    marginBottom: 10,
  },
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 14,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    overflow: 'hidden',
  },
  cardPadded: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  cardTitle: {
    color: PV2.textPrimary,
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
    color: PV2.textPrimary,
    fontSize: 22,
    fontWeight: '800',
  },
  statLabel: {
    color: PV2.textSecondary,
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
    color: PV2.textPrimary,
    fontSize: 14,
  },
  barValue: {
    color: PV2.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: PV2.emptyCardBg,
    overflow: 'hidden',
  },
  barFill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: PV2.actionPrimary,
  },
  viewsHeadline: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 8,
  },
  bigNumber: {
    color: PV2.textPrimary,
    fontSize: 30,
    fontWeight: '800',
  },
  subheading: {
    color: PV2.textTertiary,
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
    borderTopColor: PV2.dividerColor,
  },
  listRowTitle: {
    flex: 1,
    color: PV2.textPrimary,
    fontSize: 15,
  },
  listRowValue: {
    color: PV2.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  muted: {
    color: PV2.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  footnote: {
    color: PV2.textTertiary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  guideHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  guideTitle: {
    flex: 1,
    color: PV2.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  guideBody: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 10,
  },
  step: {
    flexDirection: 'row',
    gap: 10,
  },
  stepNumber: {
    width: 20,
    height: 20,
    borderRadius: 10,
    overflow: 'hidden',
    textAlign: 'center',
    lineHeight: 20,
    fontSize: 12,
    fontWeight: '700',
    color: PV2.actionPrimary,
    backgroundColor: PV2.actionPrimarySoft,
  },
  stepText: {
    flex: 1,
    color: PV2.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  laterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  laterText: {
    flex: 1,
    color: PV2.textSecondary,
    fontSize: 14,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  badgeText: {
    color: PV2.textTertiary,
    fontSize: 11,
    fontWeight: '600',
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
    color: PV2.textPrimary,
    fontSize: 16,
    fontWeight: '500',
  },
  navRowDetail: {
    color: PV2.textSecondary,
    fontSize: 13,
  },
  disabledText: {
    color: PV2.textTertiary,
  },
  deleteText: {
    color: PV2.statusNegative,
  },
  email: {
    color: PV2.textPrimary,
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
    backgroundColor: PV2.textTertiary,
  },
  bulletText: {
    flex: 1,
    color: PV2.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  signOut: {
    marginHorizontal: 16,
    marginTop: 4,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
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
    backgroundColor: PV2.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PV2.panelBorder,
  },
  stateRow: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  retryButton: {
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 18,
  },
  retryButtonText: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.75,
  },
});
