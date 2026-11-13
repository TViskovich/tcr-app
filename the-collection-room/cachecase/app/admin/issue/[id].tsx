import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { acknowledgeIssue, loadIssueDetail, type IssueDetail } from '@/lib/admin-monitoring';
import { age, ago, issueTitle, SEVERITY_LABEL, severityTone, STATUS_LABEL, type Tone } from '@/lib/admin-monitoring-view';

// Admin-only: one monitoring issue — its lifecycle, recent history and the
// internal references (job, report, purge run/item ids, state and error
// code) of the records currently affected, so an admin can investigate.
// Those references come from admin_moderation_issue_detail (server-side
// require_admin) and never appear in alert payloads. No report text,
// evidence, paths, collector or reporter identities are shown.
//
// The only action is Acknowledge (admin_acknowledge_moderation_issue): it
// records that an admin is on it and never resolves the issue — the issue
// resolves on its own when the underlying condition clears.

const PAGE = 25;
const TONE_COLOR: Record<Tone, string> = {
  critical: PV2.statusNegative, warning: '#FF9F0A', ok: PV2.statusPositive, neutral: PV2.link, off: PV2.textTertiary,
};
const REF_LABEL: Record<string, string> = {
  quarantine_job: 'Quarantine job', content_report: 'Report', purge_run: 'Purge run', purge_item: 'Purge item',
};
const EVENT_LABEL: Record<string, string> = {
  opened: 'Detected', worsened: 'Got worse', acknowledged: 'Acknowledged', resolved: 'Resolved',
  notice_claimed: 'Alert prepared', notice_delivered: 'Alert delivered', notice_failed: 'Alert failed',
};

export default function IssueScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isAdmin = useIsAdmin();
  useScrollResponsiveNavbar({ enabled: false });

  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error' | 'not_found'>('loading');
  const [offset, setOffset] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [acking, setAcking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }, [router]);

  useEffect(() => {
    if (isAdmin === false) leave();
  }, [isAdmin, leave]);

  const applyDetail = useCallback(
    (res: Awaited<ReturnType<typeof loadIssueDetail>>, nextOffset: number) => {
      setNow(Date.now());
      if (res.kind === 'ok') {
        setDetail(res.data);
        setOffset(nextOffset);
        setState('ok');
      } else if (res.kind === 'forbidden') leave();
      else setState(res.kind === 'not_found' ? 'not_found' : 'error');
    },
    [leave],
  );
  const load = useCallback(
    async (nextOffset: number) => {
      if (typeof id === 'string') applyDetail(await loadIssueDetail(id, nextOffset, PAGE), nextOffset);
    },
    [id, applyDetail],
  );

  useEffect(() => {
    if (isAdmin !== true || typeof id !== 'string') return;
    let cancelled = false;
    loadIssueDetail(id, 0, PAGE).then((res) => {
      if (!cancelled) applyDetail(res, 0);
    });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, id, applyDetail]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(offset);
    setRefreshing(false);
  }, [load, offset]);

  const doAcknowledge = useCallback(async () => {
    if (!detail) return;
    setAcking(true);
    const res = await acknowledgeIssue(detail.issue.id);
    setAcking(false);
    if (res.kind === 'forbidden') return leave();
    if (res.kind === 'ok' && res.data.ok) setNotice('Acknowledged. The issue stays open until the condition clears.');
    else if (res.kind === 'ok' && res.data.reason === 'already_resolved') setNotice('This issue has already resolved.');
    else setNotice('Couldn’t acknowledge. Try again.');
    load(offset);
  }, [detail, leave, load, offset]);

  const confirmAcknowledge = useCallback(() => {
    Alert.alert(
      'Acknowledge issue',
      'This records that you are handling it and pauses routine reminders. It does not resolve the issue; critical reminders continue.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Acknowledge', onPress: doAcknowledge },
      ],
    );
  }, [doAcknowledge]);

  if (isAdmin !== true || state === 'loading') {
    return (
      <>
        <Stack.Screen options={{ title: '', headerBackTitle: '' }} />
        <View style={styles.centered}>{isAdmin !== false ? <ActivityIndicator color={PV2.textSecondary} /> : null}</View>
      </>
    );
  }
  if (state !== 'ok' || !detail) {
    return (
      <>
        <Stack.Screen options={{ title: 'Issue', headerBackTitle: '' }} />
        <View style={styles.centered}>
          <Text style={styles.empty}>{state === 'not_found' ? 'This issue no longer exists.' : 'Couldn’t load this issue.'}</Text>
          {state === 'error' ? (
            <TouchableOpacity style={styles.button} onPress={() => load(offset)}>
              <Text style={styles.buttonText}>Try again</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </>
    );
  }

  const i = detail.issue;
  const a = detail.affected;
  const statusTone: Tone = i.status === 'active' ? 'critical' : i.status === 'acknowledged' ? 'neutral' : 'ok';
  return (
    <>
      <Stack.Screen options={{ title: issueTitle(i.code), headerBackTitle: '' }} />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PV2.link} />}>
          <View style={styles.row}>
            <Badge label={SEVERITY_LABEL[i.severity]} tone={severityTone(i.severity)} />
            <Badge label={STATUS_LABEL[i.status]} tone={statusTone} />
            <Text style={styles.code}>{i.code}</Text>
          </View>
          <Text style={styles.description}>{i.description}</Text>
          {i.detection === 'origin_probe' ? (
            <Text style={styles.note}>This condition needs a hosted Storage-origin probe; it is not detected from database state.</Text>
          ) : null}

          <Card title="Timeline">
            <Fact label="First detected" value={`${ago(i.opened_at, now)} (${new Date(i.opened_at).toLocaleString()})`} />
            <Fact label="Last observed" value={ago(i.last_seen_at, now)} />
            <Fact label="Acknowledged" value={i.acknowledged_at ? ago(i.acknowledged_at, now) : 'not yet'} />
            <Fact label="Resolved" value={i.resolved_at ? ago(i.resolved_at, now) : 'no — still active'} />
            <Fact label="Affected now" value={i.status === 'resolved' ? '0' : `${i.count} (peak ${i.peak_count})`} />
            <Fact label="Oldest affected" value={i.status === 'resolved' ? '—' : `${age(i.oldest_at, now)} old`} />
            <Fact label="Last alert" value={i.notified_at ? ago(i.notified_at, now) : 'none sent'} />
            {i.last_delivery_error ? <Fact label="Alert delivery" value={`failing (${i.last_delivery_error}, ${i.delivery_failures}×)`} warn /> : null}
          </Card>

          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          {i.status === 'active' ? (
            <TouchableOpacity style={[styles.button, acking && styles.dim]} onPress={confirmAcknowledge} disabled={acking} accessibilityRole="button">
              {acking ? <ActivityIndicator color={PV2.textPrimary} /> : <Text style={styles.buttonText}>Acknowledge</Text>}
            </TouchableOpacity>
          ) : (
            <Text style={styles.note}>
              {i.status === 'acknowledged' ? 'Acknowledged — still unresolved until the condition clears.' : 'Resolved: the condition cleared.'}
            </Text>
          )}

          <Card title={a.live ? `Currently affected (${a.total})` : 'Currently affected'}>
            {!a.live ? <Text style={styles.empty}>The issue has resolved; nothing is affected now.</Text> : null}
            {a.live && a.items.length === 0 ? <Text style={styles.empty}>Nothing affected at this moment (refresh the dashboard).</Text> : null}
            {a.items.map((r) => (
              <View key={`${r.ref_kind}:${r.ref_id}`} style={styles.ref}>
                <Text style={styles.refMain}>
                  {r.child_safety ? '⚠︎ ' : ''}
                  {REF_LABEL[r.ref_kind] ?? r.ref_kind} · {r.state}
                  {r.detail_code ? ` · ${r.detail_code}` : ''}
                  {r.attempts !== null ? ` · ${r.attempts} attempts` : ''}
                </Text>
                <Text style={styles.refSide}>{r.since ? `${age(r.since, now)} old` : ''}</Text>
                <Text style={styles.refId} selectable accessibilityLabel={`${REF_LABEL[r.ref_kind]} id ${r.ref_id}`}>
                  {r.ref_id}
                </Text>
              </View>
            ))}
            {a.live && a.total > a.limit ? (
              <View style={styles.row}>
                <TouchableOpacity disabled={offset === 0} onPress={() => load(Math.max(0, offset - PAGE))}>
                  <Text style={[styles.link, offset === 0 && styles.dim]}>Previous</Text>
                </TouchableOpacity>
                <Text style={styles.refSide}>
                  {offset + 1}–{Math.min(offset + PAGE, a.total)} of {a.total}
                </Text>
                <TouchableOpacity disabled={offset + PAGE >= a.total} onPress={() => load(offset + PAGE)}>
                  <Text style={[styles.link, offset + PAGE >= a.total && styles.dim]}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            <Text style={styles.note}>
              {i.category === 'purge'
                ? 'Purge runs are listed on the Moderation Monitoring screen.'
                : 'Ids identify the record for investigation in the admin tools and runbooks. No report text, evidence or file paths are shown.'}
            </Text>
          </Card>

          <Card title="History">
            {detail.events.length === 0 ? <Text style={styles.empty}>No history.</Text> : null}
            {detail.events.map((e, n) => (
              <Text key={`${e.at}-${n}`} style={styles.event}>
                {ago(e.at, now)} · {EVENT_LABEL[e.event] ?? e.event}
                {e.notice_kind ? ` (${e.notice_kind})` : ''}
                {e.count !== null && ['opened', 'worsened'].includes(e.event) ? ` · ${e.count} affected` : ''}
                {e.error_code ? ` · ${e.error_code}` : ''}
                {e.actor_id ? ' · by an admin' : ''}
              </Text>
            ))}
          </Card>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}
function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, warn && { color: TONE_COLOR.warning }]}>{value}</Text>
    </View>
  );
}
function Badge({ label, tone }: { label: string; tone: Tone }) {
  return (
    <View style={[styles.badge, { borderColor: TONE_COLOR[tone] }]}>
      <Text style={[styles.badgeText, { color: TONE_COLOR[tone] }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PV2.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: PV2.bg },
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  code: { marginLeft: 'auto', fontSize: 11, color: PV2.textTertiary, fontFamily: 'Courier' },
  description: { fontSize: 15, color: PV2.textPrimary },
  note: { fontSize: 12, color: PV2.textSecondary },
  notice: { fontSize: 13, color: PV2.textPrimary, backgroundColor: PV2.actionPrimarySoft, padding: 10, borderRadius: 8 },
  card: { backgroundColor: PV2.panel, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.panelBorder, padding: 12, gap: 6 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: PV2.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 },
  fact: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  factLabel: { fontSize: 13, color: PV2.textTertiary },
  factValue: { flexShrink: 1, textAlign: 'right', fontSize: 13, color: PV2.textPrimary },
  badge: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  button: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8, backgroundColor: PV2.actionPrimaryFill },
  buttonText: { color: PV2.textPrimary, fontSize: 14, fontWeight: '600' },
  dim: { opacity: 0.4 },
  link: { color: PV2.link, fontSize: 13, fontWeight: '600' },
  ref: { gap: 2, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: PV2.dividerColor },
  refMain: { fontSize: 13, color: PV2.textPrimary },
  refSide: { fontSize: 12, color: PV2.textTertiary },
  refId: { fontSize: 11, color: PV2.textTertiary, fontFamily: 'Courier' },
  event: { fontSize: 12, color: PV2.textSecondary },
  empty: { fontSize: 13, color: PV2.textSecondary },
});
