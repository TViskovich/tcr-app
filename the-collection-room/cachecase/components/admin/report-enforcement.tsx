import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { runEnforcement } from '@/lib/admin-reports';
import {
  ACTION_LABEL,
  actionState,
  awaitingSecondAdmin,
  blockedEnforcementText,
  childSafetyReversal,
  confirmEnforcement,
  dispositionsFor,
  emptyParams,
  enforceOptions,
  EXPIRY_PRESETS,
  FIELD_LABEL,
  fieldsFor,
  mediaLine,
  missingInput,
  reasonLabel,
  reasonsFor,
  relevantActions,
  restrictionLine,
  suspensionLine,
  type EnforceParams,
  type EnforceResult,
  type Enforcement,
  type EnforcementAction,
} from '@/lib/admin-enforcement-view';
import { NOTE_MAX, type ApiResult, type Tone } from '@/lib/admin-reports-view';

// Admin-only Enforcement section of the report screen (Phase 2B M5.2).
// Every action goes through admin_report_enforce, which re-checks the admin,
// the report version and the claim, derives the content/profile/account from
// the report on the server, and calls the EXISTING enforcement function
// (child-safety, second-administrator, legal-hold and audit rules included).
// What is shown here is a convenience: unavailable actions are listed with
// the reason, never offered as buttons.

const TONE_COLOR: Record<Tone, string> = {
  critical: PV2.statusNegative, warning: '#FF9F0A', ok: PV2.statusPositive, neutral: PV2.link, off: PV2.textTertiary,
};

export function ReportEnforcement({ reportId, data, owner, now, onResult }: {
  reportId: string;
  data: Enforcement;
  owner: string | null;
  now: number;
  onResult: (action: EnforcementAction, res: ApiResult<EnforceResult>) => Promise<void>;
}) {
  const [action, setAction] = useState<EnforcementAction | null>(null);
  const [params, setParams] = useState<EnforceParams>(emptyParams('hide'));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const open = (a: EnforcementAction) => {
    setAction(a);
    setParams(emptyParams(a));
  };
  const close = () => setAction(null);
  const set = (p: Partial<EnforceParams>) => setParams((x) => ({ ...x, ...p }));

  const submit = useCallback(async () => {
    if (!action || busyRef.current || !params.reason) return;
    busyRef.current = true;
    setBusy(true);
    const res = await runEnforcement(reportId, action, data.version, params.reason, params.note, enforceOptions(action, params, Date.now()));
    busyRef.current = false;
    setBusy(false);
    if (res.kind === 'ok') setAction(null);
    await onResult(action, res);
  }, [action, params, reportId, data.version, onResult]);

  const review = useCallback(() => {
    if (!action) return;
    const c = confirmEnforcement(action, data, params, owner);
    Alert.alert(c.title, c.message, [
      { text: 'Cancel', style: 'cancel' },
      { text: c.confirm, style: c.destructive ? 'destructive' : 'default', onPress: () => void submit() },
    ]);
  }, [action, data, params, owner, submit]);

  const r = restrictionLine(data, now);
  const m = mediaLine(data.media);
  const s = suspensionLine(data, now);
  const actions = relevantActions(data);
  const missing = action ? missingInput(action, data, params) : null;
  const fields = action ? fieldsFor(action, data) : [];
  const dispositions = action ? dispositionsFor(action, data, params.fields) : [];
  const cs = action ? childSafetyReversal(action, data) : false;

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle} accessibilityRole="header">
        Enforcement
      </Text>
      <Text style={[styles.line, { color: r ? TONE_COLOR[r.tone] : PV2.textSecondary }]}>{r ? r.text : 'No restriction on this content.'}</Text>
      {m ? <Text style={[styles.line, { color: TONE_COLOR[m.tone] }]}>{m.text}</Text> : null}
      {data.profile?.restricted_fields.length ? (
        <Text style={styles.line}>
          Cleared profile fields: {data.profile.restricted_fields.map((f) => `${FIELD_LABEL[f.field] ?? f.field}${f.current_is_cleared ? '' : ' (collector set a new value)'}`).join(', ')}
        </Text>
      ) : null}
      <Text style={[styles.line, { color: TONE_COLOR[s.tone] }]}>Account: {s.text}</Text>
      {data.legal_hold ? <Text style={styles.note}>This report’s evidence is under a legal hold; enforcement does not change the hold.</Text> : null}
      {awaitingSecondAdmin(data) ? (
        <Text style={[styles.banner, { borderLeftColor: TONE_COLOR.warning }]} accessibilityLiveRegion="polite">
          Awaiting a second administrator: you imposed this child-safety decision, so another administrator must review any reversal.
        </Text>
      ) : null}

      <View style={styles.buttons}>
        {actions.filter((a) => actionState(data, a).available).map((a) => (
          <TouchableOpacity
            key={a}
            style={[styles.button, action === a && styles.buttonActive, busy && styles.dim]}
            disabled={busy}
            onPress={() => (action === a ? close() : open(a))}
            accessibilityRole="button"
            accessibilityState={{ expanded: action === a }}>
            <Text style={styles.buttonText}>{ACTION_LABEL[a]}…</Text>
          </TouchableOpacity>
        ))}
      </View>
      {actions.filter((a) => !actionState(data, a).available).map((a) => (
        <Text key={a} style={styles.note}>
          {ACTION_LABEL[a]}: {blockedEnforcementText(actionState(data, a).blocked)}
        </Text>
      ))}

      {action ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>{ACTION_LABEL[action]}</Text>
          <Group title="Reason">
            {reasonsFor(action, data).map((rc) => (
              <Chip key={rc} label={reasonLabel(rc)} active={params.reason === rc} onPress={() => set({ reason: rc })} />
            ))}
          </Group>
          {fields.length ? (
            <Group title={action === 'clear_profile_fields' ? 'Fields to clear' : action === 'release_profile_fields' ? 'Fields to release (owner may edit)' : 'Fields to restore'}>
              {fields.map((f) => (
                <Chip
                  key={f}
                  label={FIELD_LABEL[f] ?? f}
                  active={params.fields.includes(f)}
                  onPress={() => set({ fields: params.fields.includes(f) ? params.fields.filter((x) => x !== f) : [...params.fields, f], disposition: null })}
                />
              ))}
            </Group>
          ) : null}
          {dispositions.length ? (
            <Group title="Linked reports">
              {dispositions.map((d) => (
                <Chip key={d} label={reasonLabel(d)} active={params.disposition === d} onPress={() => set({ disposition: d })} />
              ))}
            </Group>
          ) : null}
          {action === 'suspend' ? (
            <Group title="Duration">
              {EXPIRY_PRESETS.map((p) => (
                <Chip key={p.key} label={p.label} active={params.expiry === p.key} onPress={() => set({ expiry: p.key })} />
              ))}
            </Group>
          ) : null}
          {(action === 'remove' || action === 'clear_profile_fields') && data.target.other_pending_reports > 0 ? (
            <Toggle
              label={`Also resolve ${data.target.other_pending_reports} other pending report(s) on this ${action === 'remove' ? 'content' : 'profile'}`}
              value={params.includeRelated}
              onChange={(v) => set({ includeRelated: v })}
            />
          ) : null}
          {cs ? (
            <Toggle
              label="I completed the child-safety review and confirm this reversal."
              value={params.confirmChildSafety}
              onChange={(v) => set({ confirmChildSafety: v })}
            />
          ) : null}
          <Text style={styles.groupTitle}>{cs ? 'Review note (required)' : 'Internal note (optional)'}</Text>
          <TextInput
            style={styles.input}
            value={params.note}
            onChangeText={(note) => set({ note })}
            maxLength={NOTE_MAX}
            multiline
            placeholder="Why this decision"
            placeholderTextColor={PV2.textTertiary}
            accessibilityLabel={`${ACTION_LABEL[action]} note`}
          />
          {missing ? <Text style={styles.note}>{missing}</Text> : null}
          <View style={styles.buttons}>
            <TouchableOpacity
              style={[styles.button, (missing !== null || busy) && styles.dim]}
              disabled={missing !== null || busy}
              onPress={review}
              accessibilityRole="button"
              accessibilityLabel={`Review ${ACTION_LABEL[action]}`}>
              {busy ? <ActivityIndicator color={PV2.textPrimary} /> : <Text style={styles.buttonText}>Review…</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondary} onPress={close} disabled={busy} accessibilityRole="button">
              <Text style={styles.link}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title}</Text>
      <View style={styles.chips}>{children}</View>
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
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <TouchableOpacity style={styles.toggle} onPress={() => onChange(!value)} accessibilityRole="checkbox" accessibilityState={{ checked: value }} accessibilityLabel={label}>
      <View style={[styles.box, value && styles.boxOn]}>{value ? <Text style={styles.tick}>✓</Text> : null}</View>
      <Text style={styles.toggleText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: PV2.panel, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.panelBorder, padding: 12, gap: 8 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: PV2.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 },
  line: { fontSize: 13, color: PV2.textPrimary },
  note: { fontSize: 12, color: PV2.textSecondary },
  banner: { fontSize: 13, color: PV2.textPrimary, backgroundColor: 'rgba(255,159,10,0.12)', padding: 10, borderRadius: 8, borderLeftWidth: 4 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  button: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, backgroundColor: PV2.actionPrimaryFill, minWidth: 80, alignItems: 'center' },
  buttonActive: { borderWidth: 1, borderColor: PV2.textPrimary },
  buttonText: { color: PV2.textPrimary, fontSize: 14, fontWeight: '600' },
  secondary: { paddingVertical: 10, paddingHorizontal: 12 },
  link: { color: PV2.link, fontSize: 13, fontWeight: '600' },
  dim: { opacity: 0.4 },
  panel: { gap: 8, padding: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.04)' },
  panelTitle: { fontSize: 14, fontWeight: '700', color: PV2.textPrimary },
  group: { gap: 4 },
  groupTitle: { fontSize: 12, fontWeight: '600', color: PV2.textSecondary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.border },
  chipActive: { backgroundColor: PV2.textPrimary, borderColor: PV2.textPrimary },
  chipText: { fontSize: 13, color: PV2.textSecondary, fontWeight: '500' },
  chipTextActive: { color: PV2.bg },
  toggle: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  box: { width: 20, height: 20, borderRadius: 4, borderWidth: 1, borderColor: PV2.border, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: PV2.textPrimary, borderColor: PV2.textPrimary },
  tick: { color: PV2.bg, fontSize: 13, fontWeight: '700' },
  toggleText: { flex: 1, fontSize: 13, color: PV2.textPrimary },
  input: {
    minHeight: 60, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.border, padding: 8,
    color: PV2.textPrimary, fontSize: 14, textAlignVertical: 'top',
  },
});
