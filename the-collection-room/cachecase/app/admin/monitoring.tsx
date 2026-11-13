import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import {
  loadDeliveryHistory,
  loadIssueHistory,
  loadMonitoringOverview,
  loadPurgeDashboard,
  loadQuarantineOverview,
  loadSchedulerRuns,
  loadSchedulerStatus,
  type Delivery,
  type DeliveryHistory,
  type IssueHistoryItem,
  type PurgeDashboard,
  type QuarantineOverview,
  type Result,
  type SchedulerRun,
  type SchedulerStatusFull,
} from '@/lib/admin-monitoring';
import {
  age,
  ago,
  CATEGORY_LABEL,
  channelHealth,
  channelLabel,
  channelTone,
  groupIssues,
  issueStatus,
  issueTitle,
  monitoringSummary,
  purgeApproval,
  PURGE_STATUS_LABEL,
  PURGE_STATUS_TONE,
  queueSummary,
  RUN_STATUS_TONE,
  schedulerSummary,
  SEVERITY_LABEL,
  severityTone,
  STATUS_LABEL,
  type MonitoringOverview,
  type OpenIssue,
  type PurgeRun,
  type Severity,
  type Tone,
} from '@/lib/admin-monitoring-view';

// Admin-only operations dashboard: moderation issues, quarantine queue and
// scheduler, alert delivery, and manual purge runs (read-only).
//
// useIsAdmin only decides what renders. Every number on this screen comes
// from an admin RPC that re-checks the caller server-side
// (private.require_admin()); a non-admin gets 'forbidden' and is sent away.
// Nothing here changes a scheduler, sends an alert, approves or executes a
// purge. The only action is acknowledging an issue (issue screen), which
// never resolves it.

type Section<T> = { state: 'loading' } | { state: 'error' } | { state: 'ok'; data: T };
const loading = { state: 'loading' } as const;

const TONE_COLOR: Record<Tone, string> = {
  critical: PV2.statusNegative, warning: '#FF9F0A', ok: PV2.statusPositive, neutral: PV2.link, off: PV2.textTertiary,
};
const TONE_BG: Record<Tone, string> = {
  critical: 'rgba(255,59,48,0.16)', warning: 'rgba(255,159,10,0.16)', ok: PV2.statusPositiveSoft, neutral: PV2.actionPrimarySoft,
  off: 'rgba(255,255,255,0.08)',
};
const PURGE_FILTERS: (PurgeRun['status'] | null)[] = [null, 'prepared', 'approved', 'needs_attention', 'expired', 'completed', 'cancelled'];

export default function MonitoringScreen() {
  const router = useRouter();
  const isAdmin = useIsAdmin();
  useScrollResponsiveNavbar({ enabled: false });

  const [overview, setOverview] = useState<Section<MonitoringOverview>>(loading);
  const [quarantine, setQuarantine] = useState<Section<QuarantineOverview>>(loading);
  const [scheduler, setScheduler] = useState<Section<SchedulerStatusFull>>(loading);
  const [runs, setRuns] = useState<Section<{ items: SchedulerRun[]; next: string | null }>>(loading);
  const [deliveries, setDeliveries] = useState<Section<DeliveryHistory>>(loading);
  const [purge, setPurge] = useState<Section<PurgeDashboard>>(loading);
  const [purgeFilter, setPurgeFilter] = useState<PurgeRun['status'] | null>(null);
  const [issueTab, setIssueTab] = useState<'open' | 'resolved'>('open');
  const [resolved, setResolved] = useState<Section<{ items: IssueHistoryItem[]; next: string | null }>>(loading);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [showAllFlagged, setShowAllFlagged] = useState(false);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }, [router]);

  useEffect(() => {
    if (isAdmin === false) leave();
  }, [isAdmin, leave]);

  // Applies one RPC result to one section; 'forbidden' anywhere leaves.
  const apply = useCallback(
    <T,>(res: Result<T>, set: (s: Section<T>) => void) => {
      if (res.kind === 'ok') set({ state: 'ok', data: res.data });
      else if (res.kind === 'forbidden') leave();
      else set({ state: 'error' });
    },
    [leave],
  );

  const loadPurge = useCallback(
    async (filter: PurgeRun['status'] | null) => apply(await loadPurgeDashboard(filter), setPurge),
    [apply],
  );

  // Fetching is separate from applying, so the initial load can be applied
  // only if the screen is still mounted.
  const fetchAll = useCallback(
    () =>
      Promise.all([
        loadMonitoringOverview(), loadQuarantineOverview(), loadSchedulerStatus(), loadSchedulerRuns(), loadDeliveryHistory(),
        loadPurgeDashboard(purgeFilter),
        issueTab === 'resolved' ? loadIssueHistory('resolved') : Promise.resolve(null),
      ] as const),
    [purgeFilter, issueTab],
  );
  const applyAll = useCallback(
    ([o, q, s, r, d, p, h]: Awaited<ReturnType<typeof fetchAll>>) => {
      setNow(Date.now());
      apply(o, setOverview);
      apply(q, setQuarantine);
      apply(s, setScheduler);
      apply(r.kind === 'ok' ? { kind: 'ok' as const, data: { items: r.data.items, next: r.data.next_before } } : r, setRuns);
      apply(d, setDeliveries);
      apply(p, setPurge);
      if (h) apply(h.kind === 'ok' ? { kind: 'ok' as const, data: { items: h.data.items, next: h.data.next_before } } : h, setResolved);
    },
    [apply],
  );
  const loadAll = useCallback(async () => applyAll(await fetchAll()), [applyAll, fetchAll]);

  useEffect(() => {
    if (isAdmin !== true) return;
    let cancelled = false;
    fetchAll().then((results) => {
      if (!cancelled) applyAll(results);
    });
    return () => {
      cancelled = true;
    };
    // The initial load runs once per admin session; filters reload their own section.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  const selectIssueTab = useCallback(
    async (tab: 'open' | 'resolved') => {
      setIssueTab(tab);
      if (tab === 'resolved') {
        setResolved(loading);
        const h = await loadIssueHistory('resolved');
        apply(h.kind === 'ok' ? { kind: 'ok' as const, data: { items: h.data.items, next: h.data.next_before } } : h, setResolved);
      }
    },
    [apply],
  );

  const moreResolved = useCallback(async () => {
    if (resolved.state !== 'ok' || !resolved.data.next) return;
    const h = await loadIssueHistory('resolved', resolved.data.next);
    if (h.kind === 'ok') setResolved({ state: 'ok', data: { items: [...resolved.data.items, ...h.data.items], next: h.data.next_before } });
    else if (h.kind === 'forbidden') leave();
  }, [resolved, leave]);

  const moreRuns = useCallback(async () => {
    if (runs.state !== 'ok' || !runs.data.next) return;
    const r = await loadSchedulerRuns(runs.data.next);
    if (r.kind === 'ok') setRuns({ state: 'ok', data: { items: [...runs.data.items, ...r.data.items], next: r.data.next_before } });
    else if (r.kind === 'forbidden') leave();
  }, [runs, leave]);

  const moreDeliveries = useCallback(async () => {
    if (deliveries.state !== 'ok' || !deliveries.data.next_before) return;
    const d = await loadDeliveryHistory(deliveries.data.next_before);
    if (d.kind === 'ok') setDeliveries({ state: 'ok', data: { ...d.data, items: [...deliveries.data.items, ...d.data.items] } });
    else if (d.kind === 'forbidden') leave();
  }, [deliveries, leave]);

  const morePurge = useCallback(async () => {
    if (purge.state !== 'ok' || !purge.data.next_before) return;
    const p = await loadPurgeDashboard(purgeFilter, purge.data.next_before);
    if (p.kind === 'ok') setPurge({ state: 'ok', data: { ...p.data, items: [...purge.data.items, ...p.data.items] } });
    else if (p.kind === 'forbidden') leave();
  }, [purge, purgeFilter, leave]);

  const choosePurgeFilter = useCallback(
    (f: PurgeRun['status'] | null) => {
      setPurgeFilter(f);
      setPurge(loading);
      loadPurge(f);
    },
    [loadPurge],
  );

  const openIssue = useCallback((id: string) => router.push({ pathname: '/admin/issue/[id]', params: { id } }), [router]);

  if (isAdmin !== true) {
    return (
      <>
        <Stack.Screen options={{ title: '', headerBackTitle: '' }} />
        <View style={styles.centered}>{isAdmin === null ? <ActivityIndicator color={PV2.textSecondary} /> : null}</View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Moderation Monitoring',
          headerBackTitle: '',
          headerRight: () => (
            <TouchableOpacity onPress={onRefresh} disabled={refreshing} accessibilityRole="button" accessibilityLabel="Refresh">
              <Text style={[styles.headerAction, refreshing && styles.dim]}>{refreshing ? 'Refreshing…' : 'Refresh'}</Text>
            </TouchableOpacity>
          ),
        }}
      />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PV2.link} />}>
          <Text style={styles.subtitle}>Updated {new Date(now).toLocaleTimeString()} · pull to refresh</Text>

          {/* ── Status strip ─────────────────────────────────────────── */}
          <SectionTitle title="Status" />
          <Card>
            <SectionBody section={overview} what="monitoring status">
              {(m) => {
                const s = monitoringSummary(m, now);
                return (
                  <>
                    <StatusRow label="Monitoring" value={s.label} tone={s.tone} detail={s.detail} />
                    <StatusRow label="Email channel" value={channelLabel(m.channels.email)} tone={channelTone(m.channels.email)} />
                    <StatusRow
                      label="Webhook channel"
                      value={channelLabel(m.channels.webhook)}
                      tone={channelTone(m.channels.webhook)}
                      detail={m.channels.reported_at ? `Reported ${ago(m.channels.reported_at, now)}` : 'The alert function has not reported its channels yet.'}
                    />
                  </>
                );
              }}
            </SectionBody>
            <SectionBody section={scheduler} what="scheduler status">
              {(s) => {
                const sum = schedulerSummary(s, now);
                return <StatusRow label="Quarantine scheduler" value={sum.label} tone={sum.tone} detail={sum.detail} />;
              }}
            </SectionBody>
          </Card>

          {/* ── Issues ───────────────────────────────────────────────── */}
          <SectionTitle title="Issues" />
          <View style={styles.tabs}>
            {(['open', 'resolved'] as const).map((t) => (
              <Chip key={t} label={t === 'open' ? 'Open' : 'Resolved'} active={issueTab === t} onPress={() => selectIssueTab(t)} />
            ))}
          </View>
          {issueTab === 'open' ? (
            <SectionBody section={overview} what="issues">
              {(m) => <OpenIssues issues={m.open} now={now} onOpen={openIssue} />}
            </SectionBody>
          ) : (
            <SectionBody section={resolved} what="resolved issues">
              {(h) =>
                h.items.length === 0 ? (
                  <Empty text="No resolved issues yet." />
                ) : (
                  <>
                    {h.items.map((i) => (
                      <IssueRow key={i.id} issue={i} now={now} status={issueStatus(i)} onPress={() => openIssue(i.id)} />
                    ))}
                    {h.next ? <More onPress={moreResolved} /> : null}
                  </>
                )
              }
            </SectionBody>
          )}

          {/* ── Quarantine ───────────────────────────────────────────── */}
          <SectionTitle title="Quarantine queue" />
          <SectionBody section={quarantine} what="the quarantine queue">
            {(q) => {
              const c = queueSummary(q.counts);
              const flagged = showAllFlagged ? q.needs_attention : q.needs_attention.slice(0, 5);
              return (
                <Card>
                  <View style={styles.stats}>
                    <Stat label="Waiting" value={c.waiting} tone={c.waiting ? 'warning' : 'ok'} />
                    <Stat label="Needs attention" value={q.needs_attention.length} tone={q.needs_attention.length ? 'critical' : 'ok'} />
                    <Stat label="Awaiting restore" value={c.restorePending} tone="neutral" />
                    <Stat label="Quarantined" value={c.quarantined} tone="off" />
                  </View>
                  <Text style={styles.meta}>Oldest open job: {q.oldest_open_at ? `${age(q.oldest_open_at, now)} old` : 'none'}</Text>
                  {q.needs_attention.length ? <Text style={styles.groupLabel}>Flagged jobs</Text> : null}
                  {flagged.map((j) => (
                    <View key={j.id} style={styles.line}>
                      <Text style={styles.lineMain} numberOfLines={1}>
                        {j.child_safety ? '⚠︎ Child safety · ' : ''}
                        {j.kind.replace(/_/g, ' ')} · {j.state} · {j.last_error ?? 'no error code'}
                      </Text>
                      <Text style={styles.lineSide}>
                        {j.attempts} attempts · {ago(j.updated_at, now)}
                      </Text>
                      <Text style={styles.refId} selectable>
                        {j.id}
                      </Text>
                    </View>
                  ))}
                  {q.needs_attention.length > 5 ? (
                    <More label={showAllFlagged ? 'Show fewer' : `Show all ${q.needs_attention.length}`} onPress={() => setShowAllFlagged((v) => !v)} />
                  ) : null}
                </Card>
              );
            }}
          </SectionBody>

          <SectionTitle title="Recent scheduled runs" />
          <SectionBody section={runs} what="scheduled runs">
            {(r) =>
              r.items.length === 0 ? (
                <Empty text="No scheduled runs recorded. (The scheduler has not run here.)" />
              ) : (
                <Card>
                  {r.items.map((run) => (
                    <View key={run.id} style={styles.line}>
                      <View style={styles.lineTop}>
                        <Pill label={run.status} tone={RUN_STATUS_TONE[run.status] ?? 'neutral'} />
                        <Text style={styles.lineMain}>
                          {run.trigger} · {run.jobs} job{run.jobs === 1 ? '' : 's'}
                          {run.error_code ? ` · ${run.error_code}` : ''}
                        </Text>
                      </View>
                      <Text style={styles.lineSide}>
                        {ago(run.started_at, now)}
                        {run.duration_ms !== null ? ` · ${run.duration_ms} ms` : ''}
                        {Object.keys(run.outcomes).length ? ` · ${Object.entries(run.outcomes).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}
                      </Text>
                    </View>
                  ))}
                  {r.next ? <More onPress={moreRuns} /> : null}
                </Card>
              )
            }
          </SectionBody>

          {/* ── Delivery ─────────────────────────────────────────────── */}
          <SectionTitle title="Alert delivery" />
          <SectionBody section={deliveries} what="alert delivery">
            {(d) => (
              <Card>
                <ChannelRow name="Email" totals={d.channels_24h.email} />
                <ChannelRow name="Webhook" totals={d.channels_24h.webhook} />
                {d.retrying.length ? <Text style={styles.groupLabel}>Notices being retried</Text> : null}
                {d.retrying.map((r) => (
                  <View key={r.issue_id} style={styles.line}>
                    <Text style={styles.lineMain}>
                      {issueTitle(r.code)} · {r.failures} failed attempt{r.failures === 1 ? '' : 's'}
                    </Text>
                    <Text style={styles.lineSide}>
                      {r.last_delivery_error ?? 'unknown error'} · last try {ago(r.last_attempt_at, now)}
                    </Text>
                  </View>
                ))}
                <Text style={styles.groupLabel}>Recent deliveries</Text>
                {d.items.length === 0 ? <Text style={styles.meta}>No delivery attempts recorded.</Text> : null}
                {d.items.map((x) => (
                  <DeliveryRow key={x.id} d={x} now={now} />
                ))}
                {d.next_before ? <More onPress={moreDeliveries} /> : null}
              </Card>
            )}
          </SectionBody>

          {/* ── Purge runs (read-only) ───────────────────────────────── */}
          <SectionTitle title="Manual purge runs" />
          <Text style={styles.note}>
            Read-only. Approval and execution are not available from this screen; the server re-checks both administrators on every
            purge action.
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
            {PURGE_FILTERS.map((f) => (
              <Chip key={f ?? 'all'} label={f ? PURGE_STATUS_LABEL[f] : 'All'} active={purgeFilter === f} onPress={() => choosePurgeFilter(f)} />
            ))}
          </ScrollView>
          <SectionBody section={purge} what="purge runs">
            {(p) => (
              <>
                <Text style={styles.meta}>
                  {p.pending_approval} awaiting approval · {p.needs_attention} need attention
                </Text>
                {p.items.length === 0 ? <Empty text="No purge runs." /> : null}
                {p.items.map((run) => (
                  <PurgeRow key={run.id} run={run} now={now} />
                ))}
                {p.next_before ? <More onPress={morePurge} /> : null}
              </>
            )}
          </SectionBody>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function OpenIssues({ issues, now, onOpen }: { issues: OpenIssue[]; now: number; onOpen: (id: string) => void }) {
  if (issues.length === 0) return <Empty text="No open issues." />;
  const g = groupIssues(issues);
  const acknowledged = issues.filter((i) => i.acknowledged_at).length;
  return (
    <>
      {acknowledged ? <Text style={styles.meta}>{acknowledged} acknowledged but not resolved</Text> : null}
      {(['critical', 'high', 'routine'] as Severity[]).map((sev) =>
        g[sev].length ? (
          <View key={sev}>
            <Text style={[styles.groupLabel, { color: TONE_COLOR[severityTone(sev)] }]}>
              {SEVERITY_LABEL[sev]} ({g[sev].length})
            </Text>
            {g[sev].map((i) => (
              <IssueRow key={i.id} issue={i} now={now} status={issueStatus(i)} onPress={() => onOpen(i.id)} />
            ))}
          </View>
        ) : null,
      )}
    </>
  );
}

function IssueRow({
  issue, now, status, onPress,
}: { issue: OpenIssue & { resolved_at?: string | null }; now: number; status: 'active' | 'acknowledged' | 'resolved'; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.issue, { borderLeftColor: TONE_COLOR[severityTone(issue.severity)] }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${SEVERITY_LABEL[issue.severity]} issue, ${issueTitle(issue.code)}, ${STATUS_LABEL[status]}, ${issue.count} affected`}>
      <View style={styles.lineTop}>
        <Pill label={SEVERITY_LABEL[issue.severity]} tone={severityTone(issue.severity)} />
        <Pill label={STATUS_LABEL[status]} tone={status === 'active' ? 'critical' : status === 'acknowledged' ? 'neutral' : 'ok'} />
        <Text style={styles.count}>{issue.count}</Text>
      </View>
      <Text style={styles.issueTitle}>{issueTitle(issue.code)}</Text>
      <Text style={styles.lineSide}>
        Oldest {age(issue.oldest_at, now)} · opened {ago(issue.opened_at, now)} ·{' '}
        {issue.resolved_at ? `resolved ${ago(issue.resolved_at, now)}` : `last seen ${ago(issue.last_seen_at, now)}`}
        {issue.last_delivery_error ? ` · alert failing (${issue.last_delivery_error})` : ''}
      </Text>
    </TouchableOpacity>
  );
}

function DeliveryRow({ d, now }: { d: Delivery; now: number }) {
  const tone: Tone = d.outcome === 'delivered' ? (d.partial ? 'warning' : 'ok') : d.outcome === 'in_flight' ? 'neutral' : 'critical';
  const errors = Object.entries(d.channel_errors).map(([ch, code]) => `${ch}: ${code}`);
  return (
    <View style={styles.line}>
      <View style={styles.lineTop}>
        <Pill label={d.partial ? 'partly delivered' : d.outcome.replace('_', ' ')} tone={tone} />
        <Text style={styles.lineMain}>
          {d.notice_count} notice{d.notice_count === 1 ? '' : 's'}
          {d.includes_summary ? ' + summary' : ''}
          {d.delivered_channels.length ? ` · via ${d.delivered_channels.join(' + ')}` : ''}
        </Text>
      </View>
      <Text style={styles.lineSide}>
        {ago(d.claimed_at, now)}
        {errors.length ? ` · failed ${errors.join(', ')}` : d.error_code ? ` · ${d.error_code}` : ''}
      </Text>
    </View>
  );
}

function ChannelRow({ name, totals }: { name: string; totals: { delivered: number; failed: number } }) {
  const h = channelHealth(totals);
  return <StatusRow label={`${name} (24 h)`} value={h.label} tone={h.tone} />;
}

function PurgeRow({ run, now }: { run: PurgeRun; now: number }) {
  const a = purgeApproval(run, now);
  const items = Object.entries(run.items_by_state).map(([s, n]) => `${s} ${n}`).join(' · ');
  return (
    <Card>
      <View style={styles.lineTop}>
        <Pill label={PURGE_STATUS_LABEL[run.status]} tone={PURGE_STATUS_TONE[run.status]} />
        <Text style={styles.lineMain}>
          {CATEGORY_LABEL[run.category] ?? run.category} · {run.item_count} item{run.item_count === 1 ? '' : 's'}
        </Text>
      </View>
      {a.minutesLeft !== null ? (
        <Text style={[styles.lineSide, a.minutesLeft <= 5 && { color: TONE_COLOR.warning }]}>
          Approval window closes in {a.minutesLeft} min ({new Date(run.approval_expires_at).toLocaleTimeString()})
        </Text>
      ) : null}
      <Text style={styles.lineSide}>
        Prepared {ago(run.prepared_at, now)}
        {run.approved_at ? ` · approved ${ago(run.approved_at, now)}` : ''}
        {run.closed_at ? ` · closed ${ago(run.closed_at, now)}` : ''}
        {items ? ` · ${items}` : ''}
      </Text>
      {a.note ? <Text style={styles.note}>{a.note}</Text> : null}
      <Text style={styles.refId} selectable>
        {run.id}
      </Text>
    </Card>
  );
}

function SectionBody<T>({ section, what, children }: { section: Section<T>; what: string; children: (data: T) => ReactNode }) {
  if (section.state === 'loading') return <ActivityIndicator style={styles.spinner} color={PV2.textSecondary} />;
  if (section.state === 'error') return <Text style={styles.error}>Couldn’t load {what}. Pull to refresh to try again.</Text>;
  return <>{children(section.data)}</>;
}
function SectionTitle({ title }: { title: string }) {
  return (
    <Text style={styles.sectionTitle} accessibilityRole="header">
      {title}
    </Text>
  );
}
function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}
function Pill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <View style={[styles.pill, { backgroundColor: TONE_BG[tone] }]}>
      <Text style={[styles.pillText, { color: TONE_COLOR[tone] }]}>{label}</Text>
    </View>
  );
}
function StatusRow({ label, value, tone, detail }: { label: string; value: string; tone: Tone; detail?: string }) {
  return (
    <View style={styles.statusRow} accessible accessibilityLabel={`${label}: ${value}. ${detail ?? ''}`}>
      <View style={styles.lineTop}>
        <Text style={styles.statusLabel}>{label}</Text>
        <Pill label={value} tone={tone} />
      </View>
      {detail ? <Text style={styles.lineSide}>{detail}</Text> : null}
    </View>
  );
}
function Stat({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: TONE_COLOR[tone] }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}
function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}
function More({ onPress, label = 'Load more' }: { onPress: () => void; label?: string }) {
  return (
    <TouchableOpacity style={styles.more} onPress={onPress} accessibilityRole="button">
      <Text style={styles.moreText}>{label}</Text>
    </TouchableOpacity>
  );
}
function Empty({ text }: { text: string }) {
  return <Text style={styles.empty}>{text}</Text>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PV2.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: PV2.bg },
  content: { padding: 16, paddingBottom: 40, gap: 8 },
  headerAction: { color: PV2.link, fontSize: 15, fontWeight: '600' },
  dim: { opacity: 0.5 },
  subtitle: { fontSize: 12, color: PV2.textTertiary },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: PV2.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 16 },
  card: { backgroundColor: PV2.panel, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.panelBorder, padding: 12, gap: 8 },
  statusRow: { gap: 2 },
  statusLabel: { flex: 1, fontSize: 14, color: PV2.textPrimary, fontWeight: '600' },
  pill: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999 },
  pillText: { fontSize: 11, fontWeight: '700' },
  tabs: { flexDirection: 'row', gap: 8, paddingVertical: 4 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.border },
  chipActive: { backgroundColor: PV2.textPrimary, borderColor: PV2.textPrimary },
  chipText: { fontSize: 13, color: PV2.textSecondary, fontWeight: '500' },
  chipTextActive: { color: PV2.bg },
  groupLabel: { fontSize: 12, fontWeight: '700', color: PV2.textSecondary, marginTop: 6 },
  issue: {
    backgroundColor: PV2.panel, borderRadius: 10, padding: 12, gap: 4, marginTop: 6, borderLeftWidth: 4,
    borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.panelBorder,
  },
  issueTitle: { fontSize: 15, fontWeight: '600', color: PV2.textPrimary },
  count: { marginLeft: 'auto', fontSize: 18, fontWeight: '700', color: PV2.textPrimary },
  line: { gap: 2, paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: PV2.dividerColor },
  lineTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  lineMain: { flexShrink: 1, fontSize: 13, color: PV2.textPrimary },
  lineSide: { fontSize: 12, color: PV2.textTertiary },
  refId: { fontSize: 11, color: PV2.textTertiary, fontFamily: 'Courier' },
  meta: { fontSize: 12, color: PV2.textTertiary },
  note: { fontSize: 12, color: PV2.textSecondary },
  stats: { flexDirection: 'row', justifyContent: 'space-between' },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 22, fontWeight: '700' },
  statLabel: { fontSize: 11, color: PV2.textTertiary, textAlign: 'center' },
  more: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 16 },
  moreText: { color: PV2.link, fontSize: 13, fontWeight: '600' },
  empty: { fontSize: 13, color: PV2.textSecondary, paddingVertical: 8 },
  error: { fontSize: 13, color: PV2.statusNegative, paddingVertical: 8 },
  spinner: { paddingVertical: 12 },
});
