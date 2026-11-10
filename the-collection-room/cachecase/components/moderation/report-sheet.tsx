import { useCallback, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import {
  REPORT_COPY,
  REPORT_DETAILS_MAX,
  REPORT_REASONS,
  REPORT_TITLES,
  type ReportReason,
  type ReportTarget,
  submitReport,
} from '@/lib/content-reports';
import { blockCollector, getBlockStatus } from '@/lib/user-blocks';

// One report sheet for every reportable thing (lib/content-reports.ts),
// built on the same bottom-sheet shell as the Registry transfer/custody
// sheets. Rendered by the screen (or sheet) that opens it — via
// useReportFlow below — so it nests correctly inside other modals.
//
// Never auto-blocks: after a report it only OFFERS the existing Block
// Collector action (lib/user-blocks.ts) when the collector is known.
// Never claims a review time or outcome.

type Phase = 'form' | 'submitting' | 'done';

type Props = {
  target: ReportTarget | null;
  viewerId: string | null | undefined;
  onClose: () => void;
};

export function ReportSheet({ target, viewerId, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const [alreadyReported, setAlreadyReported] = useState(false);
  const [blockState, setBlockState] = useState<'unknown' | 'available' | 'blocking' | 'blocked' | 'hidden'>('unknown');
  const [blockError, setBlockError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const canOfferBlock = !!target?.ownerId && !!target.ownerUsername && target.ownerId !== viewerId;

  async function submit() {
    if (!target || !reason || submittingRef.current) return;
    submittingRef.current = true;
    setPhase('submitting');
    setError(null);
    const result = await submitReport(target, reason, details);
    submittingRef.current = false;
    if (!result.ok) {
      // Reason and explanation stay as they were, for a retry.
      setPhase('form');
      setError(result.message);
      AccessibilityInfo.announceForAccessibility(result.message);
      return;
    }
    setAlreadyReported(result.alreadyReported);
    setPhase('done');
    AccessibilityInfo.announceForAccessibility(result.alreadyReported ? REPORT_COPY.alreadyReported : REPORT_COPY.received);
    if (canOfferBlock && target.ownerId) {
      const status = await getBlockStatus(target.ownerId);
      setBlockState(status.ok && status.value.blockedByMe ? 'hidden' : 'available');
    }
  }

  async function block() {
    if (!target?.ownerId || !viewerId || blockState !== 'available') return;
    setBlockState('blocking');
    setBlockError(null);
    const result = await blockCollector(viewerId, target.ownerId);
    if (!result.ok) {
      setBlockState('available');
      setBlockError(result.message);
      return;
    }
    setBlockState('blocked');
    AccessibilityInfo.announceForAccessibility(`Blocked @${target.ownerUsername}.`);
  }

  const busy = phase === 'submitting';
  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Modal visible={!!target} transparent animationType="slide" statusBarTranslucent onRequestClose={close}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityRole="button" accessibilityLabel="Close report" />
        {target ? (
          <View
            style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16), maxHeight: height * 0.9 }]}
            accessibilityViewIsModal
            testID="report-sheet">
            <View style={styles.handle} />
            <Text style={styles.title} accessibilityRole="header">
              {REPORT_TITLES[target.type]}
            </Text>
            <Text style={styles.subject} numberOfLines={2}>
              {target.label}
            </Text>

            {phase === 'done' ? (
              <View style={styles.done} accessibilityLiveRegion="polite">
                <Text style={styles.doneTitle}>Report sent</Text>
                <Text style={styles.body}>{alreadyReported ? REPORT_COPY.alreadyReported : REPORT_COPY.received}</Text>
                <Text style={styles.bodyMuted}>{REPORT_COPY.private}</Text>
                {canOfferBlock && blockState !== 'unknown' && blockState !== 'hidden' ? (
                  <View style={styles.blockBox}>
                    {blockState === 'blocked' ? (
                      <Text style={styles.body} accessibilityLiveRegion="polite">
                        Blocked @{target.ownerUsername}. You can unblock them from Blocked Collectors.
                      </Text>
                    ) : (
                      <>
                        <Text style={styles.bodyMuted}>
                          You can also block @{target.ownerUsername} so they can’t message, follow or interact with you.
                        </Text>
                        <Pressable
                          onPress={block}
                          disabled={blockState === 'blocking'}
                          style={({ pressed }) => [styles.secondary, (pressed || blockState === 'blocking') && styles.pressed]}
                          accessibilityRole="button"
                          accessibilityLabel={`Block @${target.ownerUsername}`}
                          accessibilityState={{ disabled: blockState === 'blocking', busy: blockState === 'blocking' }}>
                          {blockState === 'blocking' ? (
                            <ActivityIndicator size="small" color={PV2.textPrimary} />
                          ) : (
                            <Text style={styles.secondaryDestructiveText}>Block @{target.ownerUsername}</Text>
                          )}
                        </Pressable>
                        {blockError ? (
                          <Text style={styles.errorText} accessibilityRole="alert">
                            {blockError}
                          </Text>
                        ) : null}
                      </>
                    )}
                  </View>
                ) : null}
                <Pressable onPress={onClose} style={({ pressed }) => [styles.primary, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Done">
                  <Text style={styles.primaryText}>Done</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollContent}>
                  <Text style={styles.sectionLabel}>Why are you reporting this?</Text>
                  <View accessibilityRole="radiogroup" accessibilityLabel="Report reason">
                    {REPORT_REASONS.map((r) => {
                      const selected = reason === r.value;
                      return (
                        <Pressable
                          key={r.value}
                          onPress={() => setReason(r.value)}
                          disabled={busy}
                          style={({ pressed }) => [styles.reason, selected && styles.reasonSelected, pressed && styles.pressed]}
                          accessibilityRole="radio"
                          accessibilityLabel={r.label}
                          accessibilityHint={r.hint}
                          accessibilityState={{ checked: selected, disabled: busy }}
                          aria-checked={selected}>
                          <View style={[styles.radio, selected && styles.radioOn]}>{selected ? <View style={styles.radioDot} /> : null}</View>
                          <View style={styles.reasonText}>
                            <Text style={styles.reasonLabel}>{r.label}</Text>
                            <Text style={styles.reasonHint}>{r.hint}</Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                  <Text style={styles.sectionLabel}>Anything else? (optional)</Text>
                  <TextInput
                    value={details}
                    onChangeText={setDetails}
                    editable={!busy}
                    multiline
                    maxLength={REPORT_DETAILS_MAX}
                    placeholder="Add context that would help us review this"
                    placeholderTextColor={PV2.textTertiary}
                    style={styles.input}
                    accessibilityLabel="Additional details, optional"
                    accessibilityHint={`Up to ${REPORT_DETAILS_MAX} characters`}
                    testID="report-details-input"
                  />
                  <Text style={styles.counter} accessibilityLabel={`${details.length} of ${REPORT_DETAILS_MAX} characters used`}>
                    {details.length}/{REPORT_DETAILS_MAX}
                  </Text>
                </ScrollView>
                {/* Outside the scrolling list, right above the buttons, so
                    it's always in view. */}
                {error ? (
                  <View style={styles.errorBox} accessibilityRole="alert" accessibilityLiveRegion="assertive">
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                ) : null}
                <View style={styles.actions}>
                  <Pressable
                    onPress={close}
                    disabled={busy}
                    style={({ pressed }) => [styles.secondary, styles.flex, (pressed || busy) && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel">
                    <Text style={styles.secondaryText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={submit}
                    disabled={!reason || busy}
                    style={({ pressed }) => [styles.primary, styles.flex, (!reason || busy) && styles.disabled, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Submit report"
                    accessibilityState={{ disabled: !reason || busy, busy }}>
                    {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Submit</Text>}
                  </Pressable>
                </View>
              </>
            )}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Each screen (or sheet) owns its own report sheet instance:
//   const report = useReportFlow(currentUserId);
//   report.open({ type: 'comment', id: comment.id, label: …, ownerId, ownerUsername });
//   … {report.sheet}
export function useReportFlow(viewerId: string | null | undefined) {
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const open = useCallback((next: ReportTarget) => setTarget(next), []);
  const close = useCallback(() => setTarget(null), []);
  // Keyed by target, so every new report starts from a fresh, empty form.
  const key = target ? `${target.type}:${target.id}` : 'closed';
  return { open, sheet: <ReportSheet key={key} target={target} viewerId={viewerId} onClose={close} /> };
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: PV2.panel,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    borderBottomWidth: 0,
    paddingTop: 12,
    paddingHorizontal: 20,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: PV2.dividerColor, alignSelf: 'center', marginBottom: 14 },
  title: { color: PV2.textPrimary, fontSize: 18, fontWeight: '700' },
  subject: { color: PV2.textTertiary, fontSize: 13, marginTop: 2, marginBottom: 10 },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingBottom: 8 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
    marginTop: 10,
    marginBottom: 6,
  },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'transparent',
    marginBottom: 4,
  },
  reasonSelected: { borderColor: PV2.collectorPanelBorder, backgroundColor: PV2.collectorPanelBg },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: PV2.textTertiary, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: PV2.actionPrimaryFill },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: PV2.actionPrimaryFill },
  reasonText: { flex: 1, gap: 1 },
  reasonLabel: { color: PV2.textPrimary, fontSize: 15, fontWeight: '600' },
  reasonHint: { color: PV2.textTertiary, fontSize: 12 },
  input: {
    minHeight: 84,
    maxHeight: 140,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.bg,
    color: PV2.textPrimary,
    padding: 12,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  counter: { color: PV2.textTertiary, fontSize: 12, alignSelf: 'flex-end', marginTop: 4 },
  errorBox: { borderRadius: 12, padding: 12, marginTop: 8, backgroundColor: 'rgba(255,59,48,0.12)' },
  errorText: { color: PV2.textPrimary, fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: 10, paddingTop: 10 },
  flex: { flex: 1 },
  primary: { paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: PV2.actionPrimaryFill },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondary: { paddingVertical: 12, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: PV2.border },
  secondaryText: { color: PV2.textPrimary, fontSize: 15, fontWeight: '600' },
  secondaryDestructiveText: { color: '#ff6b6b', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  done: { gap: 10, paddingTop: 6, paddingBottom: 4 },
  doneTitle: { color: PV2.textPrimary, fontSize: 16, fontWeight: '700' },
  body: { color: PV2.textSecondary, fontSize: 14, lineHeight: 20 },
  bodyMuted: { color: PV2.textTertiary, fontSize: 13, lineHeight: 19 },
  blockBox: { gap: 8, paddingVertical: 4 },
});
