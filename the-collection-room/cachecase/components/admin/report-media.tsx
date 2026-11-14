import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { REASONS, reasonLabel, type EnforceResult, type Enforcement } from '@/lib/admin-enforcement-view';
import {
  HOLD_EFFECT,
  holdLine,
  jobLabel,
  jobPhase,
  mediaAvailability,
  mediaLabel,
  PHASE_LABEL,
  PHASE_TONE,
  restorableJobs,
  restoreBlockedText,
  restoreConfirm,
  restoreSummary,
  signedUrl,
  viewRefusalText,
  type Evidence,
  type EvidenceMedia,
} from '@/lib/admin-media-view';
import { restoreReportMedia, runEnforcement, viewReportMedia } from '@/lib/admin-reports';
import { NOTE_MAX, type ApiFailure, type ApiResult, type Tone } from '@/lib/admin-reports-view';
import { supabaseUrl } from '@/lib/supabase';

// Admin-only: the report's own media, its quarantine/restoration jobs and
// the legal holds that apply (Phase 2B M5.3).
//
// * Nothing is loaded until the admin taps View, one image at a time. The
//   server (admin-report-media → report_media_authorize) decides whether it
//   may be shown, signs it for 60 seconds, and logs the request. The URL is
//   kept only in this component's state and never cached to disk.
// * Child-safety media needs an explicit warning confirmation, is shown
//   blurred, and is revealed only on a second tap.
// * Image-level hide/remove is offered only for an image the admin has
//   opened, so they know which image they act on.
// * Media restoration uses the existing admin-media-restore, scoped to this
//   report; only the server's 'restored' counts as done.

const TONE_COLOR: Record<Tone, string> = {
  critical: PV2.statusNegative, warning: '#FF9F0A', ok: PV2.statusPositive, neutral: PV2.link, off: PV2.textTertiary,
};
type Shown = { url: string; childSafety: boolean; revealed: boolean; failed: boolean };

export function ReportMedia({ reportId, targetType, evidence, enforcement, now, onNotice, onAccessLost, onChanged }: {
  reportId: string;
  targetType: string;
  evidence: Evidence;
  enforcement: Enforcement | null;
  now: number;
  onNotice: (n: { text: string; tone: Tone }) => void;
  onAccessLost: (f: ApiFailure) => void;
  onChanged: () => Promise<void>;
}) {
  const [shown, setShown] = useState<Record<number, Shown>>({});
  const [viewed, setViewed] = useState<Set<number>>(new Set());
  const [loadingRef, setLoadingRef] = useState<number | null>(null);
  const [imageAction, setImageAction] = useState<{ ref: number; action: 'hide' | 'remove'; reason: string | null; note: string } | null>(null);
  const [restoreCs, setRestoreCs] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const open = useCallback(async (m: EvidenceMedia, confirm: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoadingRef(m.ref);
    const r = await viewReportMedia(reportId, m.ref, confirm);
    busyRef.current = false;
    setLoadingRef(null);
    if (r.kind === 'session_expired' || r.kind === 'forbidden') return onAccessLost({ kind: r.kind });
    if (r.kind === 'refused') return onNotice({ text: viewRefusalText(r.reason), tone: 'warning' });
    if (r.kind !== 'ok') return onNotice({ text: 'Couldn’t open this media. Try again.', tone: 'critical' });
    const url = signedUrl(supabaseUrl, r.signed_path);
    if (!url) return onNotice({ text: 'Couldn’t open this media. Try again.', tone: 'critical' });
    setShown((s) => ({ ...s, [m.ref]: { url, childSafety: r.child_safety, revealed: !r.child_safety, failed: false } }));
    setViewed((v) => new Set(v).add(m.ref));
  }, [reportId, onAccessLost, onNotice]);

  const view = useCallback((m: EvidenceMedia) => {
    if (!m.child_safety) return void open(m, false);
    Alert.alert(
      'Child-safety media',
      'This image is part of a child-safety report. It is shown blurred, only to you, for review. Do not screenshot, copy or share it. Each view is recorded.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Show blurred', style: 'destructive', onPress: () => void open(m, true) },
      ],
    );
  }, [open]);

  const close = (ref: number) => setShown((s) => {
    const next = { ...s };
    delete next[ref];
    return next;
  });

  const runImageAction = useCallback(async () => {
    if (!imageAction?.reason || !enforcement || busyRef.current) return;
    const m = evidence.media.find((x) => x.ref === imageAction.ref);
    if (!m || m.image_index === null) return;
    busyRef.current = true;
    setBusy(true);
    const res: ApiResult<EnforceResult> = await runEnforcement(reportId, imageAction.action, enforcement.version, imageAction.reason, imageAction.note,
      { image_index: m.image_index });
    busyRef.current = false;
    setBusy(false);
    if (res.kind === 'ok') {
      setImageAction(null);
      onNotice({ text: `${mediaLabel(m)} ${imageAction.action === 'hide' ? 'hidden' : 'removed'}; the item and its other images are unchanged.`, tone: 'ok' });
    } else if (res.kind === 'session_expired' || res.kind === 'forbidden' || res.kind === 'inactive') {
      return onAccessLost(res);
    } else {
      onNotice({ text: res.kind === 'conflict' && res.code === 'report_changed'
        ? 'This report changed since you opened it. The latest state is shown.' : 'The image action was refused. Review the latest state.', tone: 'warning' });
    }
    await onChanged();
  }, [imageAction, enforcement, evidence.media, reportId, onNotice, onAccessLost, onChanged]);

  const confirmImageAction = () => {
    const m = evidence.media.find((x) => x.ref === imageAction?.ref);
    if (!imageAction?.reason || !m) return;
    const verb = imageAction.action === 'hide' ? 'Hide' : 'Remove';
    Alert.alert(`${verb} ${mediaLabel(m).toLowerCase()}`, [
      `${verb}s only ${mediaLabel(m)} (the one you viewed) of this collection item · reason: ${reasonLabel(imageAction.reason)}.`,
      'The item and its other images are not changed. Nothing is deleted; the image is queued for quarantine if public copies exist.',
      'Reversible: Restore content.',
    ].join('\n\n'), [
      { text: 'Cancel', style: 'cancel' },
      { text: verb, style: 'destructive', onPress: () => void runImageAction() },
    ]);
  };

  const jobs = restorableJobs(evidence.jobs).slice(0, 10);
  const restore = useCallback(async () => {
    if (busyRef.current || !jobs.length) return;
    busyRef.current = true;
    setBusy(true);
    const r = await restoreReportMedia(reportId, jobs.map((j) => j.id), restoreCs);
    busyRef.current = false;
    setBusy(false);
    if (r.kind === 'session_expired' || r.kind === 'forbidden') return onAccessLost({ kind: r.kind });
    onNotice(r.kind === 'ok' ? restoreSummary(r.results) : { text: 'Media restoration could not be requested. Nothing was changed; try again.', tone: 'critical' });
    setRestoreCs(false);
    await onChanged();
  }, [jobs, reportId, restoreCs, onAccessLost, onNotice, onChanged]);

  const confirmRestore = () => {
    const c = restoreConfirm(jobs);
    Alert.alert(c.title, c.message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Restore', onPress: () => void restore() },
    ]);
  };
  const csJobs = jobs.some((j) => j.child_safety);
  const imageActionsAllowed = targetType === 'collection_item' && enforcement?.claim === 'mine'
    && (enforcement.report_status === 'open' || enforcement.report_status === 'reviewing');

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle} accessibilityRole="header">
          Evidence media
        </Text>
        {evidence.media.length === 0 ? <Text style={styles.note}>This report recorded no media.</Text> : null}
        {evidence.media.map((m) => {
          const a = mediaAvailability(m);
          const s = shown[m.ref];
          return (
            <View key={m.ref} style={styles.row}>
              <View style={styles.rowTop}>
                <Text style={styles.rowTitle}>
                  {mediaLabel(m)}
                  {m.child_safety ? ' · child safety' : ''}
                  {m.image_restricted ? ' · restricted' : ''}
                </Text>
                {a.viewable && !s ? (
                  <TouchableOpacity onPress={() => view(m)} disabled={loadingRef !== null} accessibilityRole="button" accessibilityLabel={`View ${mediaLabel(m)}`}>
                    {loadingRef === m.ref ? <ActivityIndicator color={PV2.link} /> : <Text style={styles.link}>View</Text>}
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text style={[styles.note, { color: TONE_COLOR[a.tone] }]}>{a.text}</Text>
              {s ? (
                <View style={styles.viewer}>
                  {s.failed ? (
                    <Text style={styles.note}>The link expired or the image couldn’t load. Close and view it again.</Text>
                  ) : (
                    <Image
                      source={{ uri: s.url }}
                      style={styles.image}
                      contentFit="contain"
                      cachePolicy="none"
                      blurRadius={s.revealed ? 0 : 40}
                      accessibilityLabel={`${mediaLabel(m)}${s.revealed ? '' : ' (blurred)'}`}
                      onError={() => setShown((x) => ({ ...x, [m.ref]: { ...s, failed: true } }))}
                    />
                  )}
                  <View style={styles.rowTop}>
                    {!s.revealed && !s.failed ? (
                      <TouchableOpacity onPress={() => setShown((x) => ({ ...x, [m.ref]: { ...s, revealed: true } }))} accessibilityRole="button">
                        <Text style={styles.link}>Reveal image</Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity onPress={() => close(m.ref)} accessibilityRole="button" accessibilityLabel={`Close ${mediaLabel(m)}`}>
                      <Text style={styles.link}>Close</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
              {m.image_index !== null && viewed.has(m.ref) && imageActionsAllowed && !m.image_restricted ? (
                <View style={styles.rowTop}>
                  {(['hide', 'remove'] as const).map((act) => (
                    <TouchableOpacity key={act} style={styles.small} onPress={() => setImageAction({ ref: m.ref, action: act, reason: null, note: '' })}
                      accessibilityRole="button" accessibilityLabel={`${act === 'hide' ? 'Hide' : 'Remove'} ${mediaLabel(m)}`}>
                      <Text style={styles.smallText}>{act === 'hide' ? 'Hide this image…' : 'Remove this image…'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
              {imageAction?.ref === m.ref ? (
                <View style={styles.panel}>
                  <View style={styles.chips}>
                    {REASONS[imageAction.action].map((rc) => (
                      <TouchableOpacity key={rc} style={[styles.chip, imageAction.reason === rc && styles.chipActive]}
                        onPress={() => setImageAction({ ...imageAction, reason: rc })} accessibilityRole="button" accessibilityState={{ selected: imageAction.reason === rc }}>
                        <Text style={[styles.chipText, imageAction.reason === rc && styles.chipTextActive]}>{reasonLabel(rc)}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput style={styles.input} value={imageAction.note} onChangeText={(note) => setImageAction({ ...imageAction, note })} maxLength={NOTE_MAX}
                    multiline placeholder="Internal note (optional)" placeholderTextColor={PV2.textTertiary} accessibilityLabel="Image action note" />
                  <View style={styles.rowTop}>
                    <TouchableOpacity style={[styles.button, (!imageAction.reason || busy) && styles.dim]} disabled={!imageAction.reason || busy}
                      onPress={confirmImageAction} accessibilityRole="button" accessibilityLabel="Review image action">
                      {busy ? <ActivityIndicator color={PV2.textPrimary} /> : <Text style={styles.buttonText}>Review…</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setImageAction(null)} accessibilityRole="button">
                      <Text style={styles.link}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
        {targetType === 'collection_item' && evidence.media.some((m) => m.image_index !== null) && !imageActionsAllowed ? (
          <Text style={styles.note}>Image-level hide/remove is available to the administrator who has claimed this pending report, after viewing the image.</Text>
        ) : null}
      </View>

      {evidence.jobs.length ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle} accessibilityRole="header">
            Media restoration
          </Text>
          <Text style={styles.note}>Restoring the content lifts the restriction; restoring its media is a separate, manual step below. The private quarantine copy is always kept.</Text>
          {evidence.jobs.map((j) => {
            const ph = jobPhase(j);
            return (
              <View key={j.id} style={styles.row} accessible accessibilityLabel={`${jobLabel(j)}: ${PHASE_LABEL[ph]}`}>
                <View style={styles.rowTop}>
                  <Text style={styles.rowTitle}>{jobLabel(j)}{j.child_safety ? ' · child safety' : ''}</Text>
                  <Text style={[styles.badge, { color: TONE_COLOR[PHASE_TONE[ph]], borderColor: TONE_COLOR[PHASE_TONE[ph]] }]}>{PHASE_LABEL[ph]}</Text>
                </View>
                <Text style={styles.note}>
                  {j.legal_hold ? 'Evidence copy under legal hold · ' : ''}
                  {j.error ? `Last error: ${j.error} · ` : ''}
                  {j.restored_at ? `restored ${new Date(j.restored_at).toLocaleString()}` : `updated ${new Date(j.updated_at).toLocaleString()}`}
                </Text>
                {j.restore_blocked && j.desired === 'restore' && j.state !== 'restored' ? (
                  <Text style={styles.note}>{restoreBlockedText(j.restore_blocked)}</Text>
                ) : null}
              </View>
            );
          })}
          {jobs.length ? (
            <>
              {csJobs ? (
                <TouchableOpacity style={styles.toggle} onPress={() => setRestoreCs(!restoreCs)} accessibilityRole="checkbox" accessibilityState={{ checked: restoreCs }}
                  accessibilityLabel="I completed the child-safety review and confirm restoring this media.">
                  <View style={[styles.box, restoreCs && styles.boxOn]}>{restoreCs ? <Text style={styles.tick}>✓</Text> : null}</View>
                  <Text style={styles.toggleText}>I completed the child-safety review and confirm restoring this media.</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={[styles.button, (busy || (csJobs && !restoreCs)) && styles.dim]} disabled={busy || (csJobs && !restoreCs)}
                onPress={confirmRestore} accessibilityRole="button" accessibilityLabel="Restore media">
                {busy ? <ActivityIndicator color={PV2.textPrimary} /> : <Text style={styles.buttonText}>Restore media ({jobs.length})…</Text>}
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle} accessibilityRole="header">
          Legal holds
        </Text>
        {evidence.legal_holds.length === 0 ? <Text style={styles.line}>No active legal hold on this report, its media or the reported account.</Text> : null}
        {evidence.legal_holds.map((h, n) => (
          <Text key={n} style={styles.line}>{holdLine(h, now)}</Text>
        ))}
        <Text style={styles.note}>{HOLD_EFFECT}</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: PV2.panel, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.panelBorder, padding: 12, gap: 8 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: PV2.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 },
  line: { fontSize: 13, color: PV2.textPrimary },
  note: { fontSize: 12, color: PV2.textSecondary },
  row: { gap: 4, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: PV2.dividerColor },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  rowTitle: { flex: 1, fontSize: 14, fontWeight: '600', color: PV2.textPrimary },
  link: { color: PV2.link, fontSize: 13, fontWeight: '600' },
  viewer: { gap: 6 },
  image: { width: '100%', height: 260, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.04)' },
  small: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.border },
  smallText: { fontSize: 13, color: PV2.textPrimary, fontWeight: '600' },
  panel: { gap: 8, padding: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.04)' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.border },
  chipActive: { backgroundColor: PV2.textPrimary, borderColor: PV2.textPrimary },
  chipText: { fontSize: 13, color: PV2.textSecondary, fontWeight: '500' },
  chipTextActive: { color: PV2.bg },
  input: {
    minHeight: 50, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.border, padding: 8,
    color: PV2.textPrimary, fontSize: 14, textAlignVertical: 'top',
  },
  button: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, backgroundColor: PV2.actionPrimaryFill, minWidth: 80, alignItems: 'center' },
  buttonText: { color: PV2.textPrimary, fontSize: 14, fontWeight: '600' },
  dim: { opacity: 0.4 },
  badge: { fontSize: 11, fontWeight: '700', borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  toggle: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  box: { width: 20, height: 20, borderRadius: 4, borderWidth: 1, borderColor: PV2.border, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: PV2.textPrimary, borderColor: PV2.textPrimary },
  tick: { color: PV2.bg, fontSize: 13, fontWeight: '700' },
  toggleText: { flex: 1, fontSize: 13, color: PV2.textPrimary },
});
