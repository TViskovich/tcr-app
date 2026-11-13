import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { ReportEnforcement } from '@/components/admin/report-enforcement';
import { enforcementErrorText, outcomeMessage, type EnforceResult, type Enforcement, type EnforcementAction } from '@/lib/admin-enforcement-view';
import { loadEnforcement, loadReportCase, runCaseAction } from '@/lib/admin-reports';
import {
  actionLabel,
  adminName,
  ago,
  blockedText,
  claimLabel,
  codeLabel,
  confirmCopy,
  DISMISS_OPTIONS,
  evidenceNotice,
  failureMessage,
  losesAccess,
  mediaSummary,
  NOTE_MAX,
  previewFields,
  REASON_LABEL,
  REOPEN_REASONS,
  STATUS_LABEL,
  STATUS_TONE,
  TARGET_LABEL,
  type ApiFailure,
  type ApiResult,
  type CaseAction,
  type MediaSummary,
  type ReportCase,
  type Tone,
} from '@/lib/admin-reports-view';

// Admin-only: one report (Phase 2B M5.1). Data comes from admin_report_case,
// which re-checks the admin server-side and returns admin_get_report with
// media URLs withheld: report facts, the stored evidence, the reported row
// as it is now, the reported account's username and state, prior report
// counts and the audit history. Nothing about the reporter but whether the
// account still exists.
//
// Reported content starts hidden and is shown only on request (child-safety
// reports ask for an extra confirmation). Media is never loaded here: only
// how many files exist and whether they are still available.
//
// Actions are the existing case-management functions — claim, release,
// dismiss (enforcement-free outcomes only) and reopen — through
// admin_report_case_action, which refuses with report_changed if the report
// moved on since this screen loaded it. No hide, remove, restore, suspend or
// delete operation exists here (M5.2).

const TONE_COLOR: Record<Tone, string> = {
  critical: PV2.statusNegative, warning: '#FF9F0A', ok: PV2.statusPositive, neutral: PV2.link, off: PV2.textTertiary,
};
type Panel = null | 'dismiss' | 'reopen';

export default function ReportScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isAdmin = useIsAdmin();
  useScrollResponsiveNavbar({ enabled: false });

  const [data, setData] = useState<ReportCase | null>(null);
  const [enf, setEnf] = useState<Enforcement | 'error' | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error' | 'not_found'>('loading');
  const [access, setAccess] = useState<ApiFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<CaseAction | null>(null);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<{ text: string; tone: Tone } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }, [router]);

  useEffect(() => {
    if (isAdmin === false) leave();
  }, [isAdmin, leave]);

  // The case and its enforcement state are always loaded together, so the
  // screen never shows a decision next to an out-of-date restriction.
  const fetchBoth = (reportId: string) => Promise.all([loadReportCase(reportId), loadEnforcement(reportId)] as const);
  const apply = useCallback(([res, e]: Awaited<ReturnType<typeof fetchBoth>>) => {
    setNow(Date.now());
    const lost = [res, e].find((x) => x.kind !== 'ok' && losesAccess(x)) as ApiFailure | undefined;
    if (lost) {
      setData(null); // drop everything already shown
      setEnf(null);
      setAccess(lost);
      return;
    }
    if (res.kind === 'ok') {
      setData(res.data);
      setEnf(e.kind === 'ok' ? e.data : 'error');
      setState('ok');
    } else setState(res.kind === 'not_found' ? 'not_found' : 'error');
  }, []);
  const load = useCallback(async () => {
    if (typeof id === 'string') apply(await fetchBoth(id));
  }, [id, apply]);

  useEffect(() => {
    if (isAdmin !== true || typeof id !== 'string') return;
    let cancelled = false;
    fetchBoth(id).then((res) => {
      if (!cancelled) apply(res);
    });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, id, apply]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const closePanel = () => {
    setPanel(null);
    setOutcome(null);
    setReason(null);
    setNote('');
  };

  const run = useCallback(
    async (action: CaseAction, opts: { outcome?: string; reason?: string; note?: string } = {}) => {
      if (!data || busyRef.current) return;
      busyRef.current = true;
      setBusy(action);
      setNotice(null);
      const res = await runCaseAction(data.report.id, action, data.case.version, opts);
      busyRef.current = false;
      setBusy(null);
      if (res.kind !== 'ok' && losesAccess(res)) {
        setData(null);
        setAccess(res);
        return;
      }
      if (res.kind === 'ok') {
        closePanel();
        setNotice({
          text: { claim: 'Claimed. You are reviewing this report.', release: 'Released to the open queue.', dismiss: 'Report dismissed.', reopen: 'Report reopened.' }[action],
          tone: 'ok',
        });
      } else {
        setNotice({ text: failureMessage(res), tone: res.kind === 'conflict' ? 'warning' : 'critical' });
      }
      await load(); // always show the server's current state afterwards
    },
    [data, load],
  );

  const onEnforced = useCallback(
    async (_action: EnforcementAction, res: ApiResult<EnforceResult>) => {
      if (res.kind !== 'ok' && losesAccess(res)) {
        setData(null);
        setEnf(null);
        setAccess(res);
        return;
      }
      if (res.kind === 'ok') setNotice(outcomeMessage(res.data));
      else {
        const code = 'code' in res ? res.code : '';
        setNotice({ text: enforcementErrorText(code) ?? failureMessage(res), tone: res.kind === 'conflict' || res.kind === 'refused' ? 'warning' : 'critical' });
      }
      await load(); // the server's state, not the button that was pressed
    },
    [load],
  );

  const confirm = useCallback(
    (action: CaseAction, opts: { outcome?: string; reason?: string; note?: string } = {}) => {
      if (!data) return;
      const c = confirmCopy(action, data.case, opts);
      Alert.alert(c.title, c.message, [
        { text: 'Cancel', style: 'cancel' },
        { text: c.confirm, style: c.destructive ? 'destructive' : 'default', onPress: () => void run(action, opts) },
      ]);
    },
    [data, run],
  );

  const reveal = useCallback(() => {
    if (!data?.case.child_safety) return setRevealed(true);
    Alert.alert(
      'Show child-safety content',
      'This report concerns child safety. Text is shown only to administrators reviewing it; media is never displayed in the app. Do not copy or share it.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Show text', style: 'destructive', onPress: () => setRevealed(true) },
      ],
    );
  }, [data]);

  if (access) {
    return (
      <>
        <Stack.Screen options={{ title: 'Report', headerBackTitle: '' }} />
        <View style={styles.centered}>
          <Text style={styles.empty}>{failureMessage(access)}</Text>
          <TouchableOpacity style={styles.button} onPress={leave} accessibilityRole="button">
            <Text style={styles.buttonText}>Back</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  }
  if (isAdmin !== true || state === 'loading') {
    return (
      <>
        <Stack.Screen options={{ title: '', headerBackTitle: '' }} />
        <View style={styles.centered}>{isAdmin !== false ? <ActivityIndicator color={PV2.textSecondary} accessibilityLabel="Loading report" /> : null}</View>
      </>
    );
  }
  if (state !== 'ok' || !data) {
    return (
      <>
        <Stack.Screen options={{ title: 'Report', headerBackTitle: '' }} />
        <View style={styles.centered}>
          <Text style={styles.empty}>{state === 'not_found' ? 'This report no longer exists.' : 'Couldn’t load this report.'}</Text>
          {state === 'error' ? (
            <TouchableOpacity style={styles.button} onPress={() => { setState('loading'); load(); }} accessibilityRole="button">
              <Text style={styles.buttonText}>Try again</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </>
    );
  }

  const r = data.report;
  const c = data.case;
  const ev = evidenceNotice(data, now);
  const evidenceFields = previewFields(data.evidence);
  const currentFields = previewFields(data.current.content);
  const claim = claimLabel(c.claim, r.status);

  return (
    <>
      <Stack.Screen
        options={{
          title: `${REASON_LABEL[r.reason] ?? r.reason} report`,
          headerBackTitle: '',
          headerRight: () => (
            <TouchableOpacity onPress={onRefresh} disabled={refreshing} accessibilityRole="button" accessibilityLabel="Refresh report">
              <Text style={[styles.headerAction, refreshing && styles.dim]}>Refresh</Text>
            </TouchableOpacity>
          ),
        }}
      />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PV2.link} />}>
          <View style={styles.badges}>
            {c.child_safety ? <Badge label="Child safety" tone="critical" /> : r.priority === 'urgent' ? <Badge label="Urgent" tone="warning" /> : null}
            <Badge label={STATUS_LABEL[r.status]} tone={STATUS_TONE[r.status]} />
            {c.legal_hold ? <Badge label="Legal hold" tone="neutral" /> : null}
            {c.content_restricted ? <Badge label="Content restricted" tone="warning" /> : null}
            {c.reopen_count ? <Badge label={`Reopened${c.reopen_count > 1 ? ` ×${c.reopen_count}` : ''}`} tone="neutral" /> : null}
          </View>

          {notice ? (
            <Text style={[styles.notice, { borderLeftColor: TONE_COLOR[notice.tone] }]} accessibilityLiveRegion="polite">
              {notice.text}
            </Text>
          ) : null}

          <Card title="Report">
            <Fact label="Reason" value={REASON_LABEL[r.reason] ?? r.reason} />
            <Fact label="Content type" value={TARGET_LABEL[r.target_type] ?? r.target_type} />
            <Fact label="Submitted" value={`${ago(r.created_at, now)} (${new Date(r.created_at).toLocaleString()})`} />
            <Fact label="Status" value={STATUS_LABEL[r.status]} />
            <Fact label="Claim" value={claim ? `${claim}${r.claimed_by && c.claim !== 'mine' ? ` (${adminName(r.claimed_by)})` : ''} · ${ago(r.claimed_at, now)}` : 'Not claimed'} warn={c.claim === 'stale'} />
            {r.resolution ? <Fact label="Decision" value={`${codeLabel(r.resolution)} — ${codeLabel(r.resolution_reason)}`} /> : null}
            {r.reviewed_at ? <Fact label="Decided" value={`${ago(r.reviewed_at, now)} by ${adminName(r.reviewed_by)}`} /> : null}
            <Fact label="Reporter" value={data.reporter.present ? 'Account exists (identity withheld)' : 'Account no longer exists'} />
          </Card>

          <Actions data={data} busy={busy} onClaim={() => confirm('claim')} onRelease={() => confirm('release')}
                   onOpenPanel={(p) => { closePanel(); setPanel(p); }} />

          {panel === 'dismiss' ? (
            <Card title="Dismiss — no content or account is changed">
              {DISMISS_OPTIONS.map((o) => (
                <View key={o.outcome} style={styles.optionGroup}>
                  <Text style={styles.optionTitle}>{codeLabel(o.outcome)}</Text>
                  <View style={styles.chips}>
                    {o.reasons.map((rc) => (
                      <Chip key={rc} label={codeLabel(rc)} active={outcome === o.outcome && reason === rc}
                            onPress={() => { setOutcome(o.outcome); setReason(rc); }} />
                    ))}
                  </View>
                </View>
              ))}
              <NoteInput value={note} onChange={setNote} />
              <PanelButtons
                disabled={!outcome || !reason || busy !== null}
                label="Confirm dismissal…"
                onCancel={closePanel}
                onSubmit={() => outcome && reason && confirm('dismiss', { outcome, reason, note })}
              />
            </Card>
          ) : null}
          {panel === 'reopen' ? (
            <Card title="Reopen">
              <View style={styles.chips}>
                {REOPEN_REASONS.map((rc) => (
                  <Chip key={rc} label={codeLabel(rc)} active={reason === rc} onPress={() => setReason(rc)} />
                ))}
              </View>
              <NoteInput value={note} onChange={setNote} />
              <PanelButtons disabled={!reason || busy !== null} label="Confirm reopen…" onCancel={closePanel}
                            onSubmit={() => reason && confirm('reopen', { reason, note })} />
            </Card>
          ) : null}

          {enf === 'error' ? (
            <Text style={styles.note}>Couldn’t load the enforcement state. Pull to refresh to try again; no enforcement action is offered until it loads.</Text>
          ) : enf ? (
            <ReportEnforcement reportId={r.id} data={enf} owner={data.owner.present ? data.owner.username ?? null : null} now={now} onResult={onEnforced} />
          ) : null}

          <Card title="Reported content">
            <Text style={[styles.note, { color: TONE_COLOR[ev.tone] }]}>{ev.text}</Text>
            {c.evidence === 'available' ? (
              revealed ? (
                <>
                  <Text style={styles.sub}>As reported (captured when the report was filed)</Text>
                  <Preview fields={evidenceFields} media={mediaSummary(data.evidence)} />
                  {r.details ? (
                    <>
                      <Text style={styles.sub}>Reporter’s details</Text>
                      <Text style={styles.quote} selectable={false}>{r.details}</Text>
                    </>
                  ) : null}
                  <Text style={styles.sub}>As it is now</Text>
                  {data.current.exists ? (
                    <Preview fields={currentFields} media={mediaSummary(data.current.content)} />
                  ) : (
                    <Text style={styles.note}>The reported content has since been deleted.</Text>
                  )}
                  <TouchableOpacity onPress={() => setRevealed(false)} accessibilityRole="button">
                    <Text style={styles.link}>Hide reported content</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity style={styles.revealBox} onPress={reveal} accessibilityRole="button" accessibilityLabel="Show reported content">
                  <Text style={styles.revealText}>
                    {c.child_safety ? 'Child-safety content is hidden. Tap to review the text.' : 'Content is hidden. Tap to show it.'}
                  </Text>
                </TouchableOpacity>
              )
            ) : (
              <Text style={styles.note}>
                {data.current.exists ? 'The reported content still exists, but this report’s evidence can’t be shown.' : 'The reported content no longer exists.'}
              </Text>
            )}
            {data.moderation ? (
              <Fact
                label="Restriction"
                value={`${data.moderation.state}${data.moderation.active ? '' : ' (lifted)'} · ${codeLabel(data.moderation.reason_code)}`}
              />
            ) : null}
          </Card>

          <Card title="Reported account">
            <Fact label="Account" value={data.owner.present ? `@${data.owner.username ?? 'unknown'}` : 'Deleted'} />
            <Fact label="State" value={data.owner.account_state.replace(/_/g, ' ')} />
            <Fact label="Other reports, same content" value={countLine(data.prior.same_target)} />
            {data.prior.same_owner ? <Fact label="Other reports, same account" value={countLine(data.prior.same_owner)} /> : null}
          </Card>

          <Card title="History">
            {data.history.length === 0 ? <Text style={styles.empty}>No actions yet.</Text> : null}
            {data.history.map((h, n) => (
              <View key={`${h.created_at}-${n}`} style={styles.event}>
                <Text style={styles.eventMain}>
                  {actionLabel(h.action)} by {adminName(h.admin)} · {ago(h.created_at, now)}
                </Text>
                {h.outcome || h.reason_code ? (
                  <Text style={styles.eventSide}>{[h.outcome && codeLabel(h.outcome), h.reason_code && codeLabel(h.reason_code)].filter(Boolean).join(' — ')}</Text>
                ) : null}
                {h.note ? <Text style={styles.eventNote}>“{h.note}”</Text> : null}
              </View>
            ))}
          </Card>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function countLine(c: Record<string, number>): string {
  const parts = (['open', 'reviewing', 'actioned', 'dismissed'] as const).filter((k) => c[k]).map((k) => `${c[k]} ${STATUS_LABEL[k].toLowerCase()}`);
  return parts.length ? parts.join(' · ') : 'none';
}

function Actions({ data, busy, onClaim, onRelease, onOpenPanel }: {
  data: ReportCase; busy: CaseAction | null; onClaim: () => void; onRelease: () => void; onOpenPanel: (p: Panel) => void;
}) {
  const c = data.case;
  const resolved = data.report.status === 'actioned' || data.report.status === 'dismissed';
  const buttons: { key: CaseAction; label: string; onPress: () => void; show: boolean }[] = [
    { key: 'claim', label: c.claim === 'stale' ? 'Take over claim' : 'Claim', onPress: onClaim, show: c.can.claim },
    { key: 'release', label: c.claim === 'stale' ? 'Release stale claim' : 'Release', onPress: onRelease, show: c.can.release },
    { key: 'dismiss', label: 'Dismiss…', onPress: () => onOpenPanel('dismiss'), show: c.can.dismiss },
    { key: 'reopen', label: 'Reopen…', onPress: () => onOpenPanel('reopen'), show: c.can.reopen },
  ];
  const blocked = resolved ? blockedText(c.blocked.reopen) : blockedText(c.blocked.dismiss);
  return (
    <Card title="Case">
      <View style={styles.chips}>
        {buttons.filter((b) => b.show).map((b) => (
          <TouchableOpacity key={b.key} style={[styles.button, busy !== null && styles.dim]} onPress={b.onPress} disabled={busy !== null} accessibilityRole="button">
            {busy === b.key ? <ActivityIndicator color={PV2.textPrimary} /> : <Text style={styles.buttonText}>{b.label}</Text>}
          </TouchableOpacity>
        ))}
      </View>
      {blocked ? <Text style={styles.note}>{blocked}</Text> : null}
      <Text style={styles.note}>
        Every action is re-checked by the server and recorded in the audit history. Enforcement decisions are in the Enforcement section below.
      </Text>
    </Card>
  );
}

function Preview({ fields, media }: { fields: { label: string; text: string }[]; media: MediaSummary }) {
  return (
    <View style={styles.preview}>
      {fields.length === 0 ? <Text style={styles.note}>No text.</Text> : null}
      {fields.map((f, n) => (
        <View key={`${f.label}-${n}`}>
          <Text style={styles.factLabel}>{f.label}</Text>
          <Text style={styles.quote} selectable={false}>{f.text}</Text>
        </View>
      ))}
      {media.total || media.withheld ? (
        <Text style={styles.note}>
          {media.total ? `${media.total} media file${media.total === 1 ? '' : 's'}${media.total ? ` (${media.available} still available)` : ''}` : 'Linked media'} — not displayed here.
        </Text>
      ) : null}
    </View>
  );
}

function NoteInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.optionGroup}>
      <Text style={styles.optionTitle}>Internal note (optional, visible to administrators)</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        maxLength={NOTE_MAX}
        multiline
        placeholder="Why this decision"
        placeholderTextColor={PV2.textTertiary}
        accessibilityLabel="Internal note"
      />
    </View>
  );
}
function PanelButtons({ disabled, label, onCancel, onSubmit }: { disabled: boolean; label: string; onCancel: () => void; onSubmit: () => void }) {
  return (
    <View style={styles.chips}>
      <TouchableOpacity style={[styles.button, disabled && styles.dim]} disabled={disabled} onPress={onSubmit} accessibilityRole="button">
        <Text style={styles.buttonText}>{label}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.secondary} onPress={onCancel} accessibilityRole="button">
        <Text style={styles.link}>Cancel</Text>
      </TouchableOpacity>
    </View>
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
function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PV2.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: PV2.bg },
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  headerAction: { color: PV2.link, fontSize: 15, fontWeight: '600' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badge: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  notice: { fontSize: 13, color: PV2.textPrimary, backgroundColor: PV2.panel, padding: 10, borderRadius: 8, borderLeftWidth: 4 },
  card: { backgroundColor: PV2.panel, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.panelBorder, padding: 12, gap: 8 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: PV2.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 },
  fact: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  factLabel: { fontSize: 12, color: PV2.textTertiary },
  factValue: { flexShrink: 1, textAlign: 'right', fontSize: 13, color: PV2.textPrimary },
  sub: { fontSize: 12, fontWeight: '700', color: PV2.textSecondary, marginTop: 4 },
  note: { fontSize: 12, color: PV2.textSecondary },
  quote: { fontSize: 14, color: PV2.textPrimary },
  preview: { gap: 6, padding: 8, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.04)' },
  revealBox: { padding: 14, borderRadius: 8, borderWidth: 1, borderStyle: 'dashed', borderColor: PV2.border, alignItems: 'center' },
  revealText: { fontSize: 13, color: PV2.link, fontWeight: '600', textAlign: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.border },
  chipActive: { backgroundColor: PV2.textPrimary, borderColor: PV2.textPrimary },
  chipText: { fontSize: 13, color: PV2.textSecondary, fontWeight: '500' },
  chipTextActive: { color: PV2.bg },
  optionGroup: { gap: 4 },
  optionTitle: { fontSize: 12, fontWeight: '600', color: PV2.textSecondary },
  input: {
    minHeight: 60, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.border, padding: 8,
    color: PV2.textPrimary, fontSize: 14, textAlignVertical: 'top',
  },
  button: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8, backgroundColor: PV2.actionPrimaryFill, minWidth: 80, alignItems: 'center' },
  buttonText: { color: PV2.textPrimary, fontSize: 14, fontWeight: '600' },
  secondary: { paddingVertical: 10, paddingHorizontal: 12 },
  dim: { opacity: 0.4 },
  link: { color: PV2.link, fontSize: 13, fontWeight: '600' },
  event: { gap: 2, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: PV2.dividerColor },
  eventMain: { fontSize: 13, color: PV2.textPrimary },
  eventSide: { fontSize: 12, color: PV2.textTertiary },
  eventNote: { fontSize: 12, color: PV2.textSecondary, fontStyle: 'italic' },
  empty: { fontSize: 13, color: PV2.textSecondary, textAlign: 'center' },
});
