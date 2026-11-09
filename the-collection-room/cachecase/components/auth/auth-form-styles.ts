import { StyleSheet } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

// Shared look of the signed-out password screens (Forgot Password, Reset
// Password) — the same tokens and sizes as app/(auth)/login.tsx and
// invite.tsx.
export const authFormStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  inner: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
    gap: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    color: PV2.textPrimary,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 22,
    color: PV2.textSecondary,
    textAlign: 'center',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    backgroundColor: PV2.collectorPanelBg,
    color: PV2.textPrimary,
  },
  codeInput: {
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 16,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: 3,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    backgroundColor: PV2.collectorPanelBg,
    color: PV2.textPrimary,
  },
  hint: {
    fontSize: 13,
    color: PV2.textTertiary,
    marginTop: -4,
  },
  notice: {
    fontSize: 15,
    lineHeight: 21,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  error: {
    fontSize: 14,
    lineHeight: 20,
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  button: {
    backgroundColor: PV2.actionPrimaryFill,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  link: {
    textAlign: 'center',
    color: PV2.link,
    fontSize: 15,
    paddingVertical: 6,
  },
  linkDisabled: {
    color: PV2.textTertiary,
  },
});
