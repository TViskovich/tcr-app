import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { confirmPassword, invokeEdge, invokeEdgeWithFreshSession } from '@/lib/edge-functions';

// Download My Data (Dashboard Milestone 2, Checkpoint 3) — the client side
// of the account-export Edge Function. The function identifies the
// collector from their session; nothing here names an export, user or path.
//
// The archive is built in small server-side steps. While an export is
// preparing and this hook is mounted (the export screen is open), it asks
// for the next step as soon as the previous one finishes; leaving the
// screen pauses the work and coming back resumes it.

export type ExportState = 'preparing' | 'ready' | 'failed' | 'expired';
export type ExportInfo = {
  state: ExportState;
  progress: { done: number; total: number; percent: number };
  size_bytes: number | null;
  created_at: string;
  ready_at: string | null;
  expires_at: string | null;
  error: string | null;
};
export type RequestFailure = 'wrong_password' | 'reauthentication_required' | 'session_expired' | 'network' | 'server' | 'unavailable';

type StatusPayload = { export: ExportInfo | null };
const STEP_DELAY_MS = 400;
const STEP_RETRY_DELAY_MS = 3000;

export function useAccountExport() {
  const { session } = useAuth();
  const email = session?.user?.email ?? null;
  // available false: the backend isn't reachable or deployed, so the
  // feature is shown as unavailable rather than broken.
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(true);
  const [info, setInfo] = useState<ExportInfo | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((payload: StatusPayload) => {
    if (!mounted.current) return;
    setInfo(payload.export ?? null);
    setAvailable(true);
    setLoaded(true);
  }, []);

  const refresh = useCallback(async () => {
    const result = await invokeEdgeWithFreshSession<StatusPayload>('account-export', { action: 'status' });
    if (!mounted.current) return;
    if (result.ok) apply(result.data);
    else {
      if (result.reason === 'unavailable' || result.reason === 'network') setAvailable(false);
      setLoaded(true);
    }
  }, [apply]);

  // Initial load (a promise chain, so state is only set once it answers).
  useEffect(() => {
    let cancelled = false;
    invokeEdgeWithFreshSession<StatusPayload>('account-export', { action: 'status' }).then((result) => {
      if (cancelled || !mounted.current) return;
      if (result.ok) apply(result.data);
      else {
        if (result.reason === 'unavailable' || result.reason === 'network') setAvailable(false);
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  // Drive the build while preparing.
  const preparing = info?.state === 'preparing';
  useEffect(() => {
    if (!preparing) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stepOnce = async () => {
      const result = await invokeEdge<StatusPayload>('account-export', { action: 'advance' });
      if (stopped || !mounted.current) return;
      if (result.ok) apply(result.data);
      if (result.ok && result.data.export?.state === 'preparing') timer = setTimeout(stepOnce, STEP_DELAY_MS);
      else if (!result.ok) timer = setTimeout(stepOnce, STEP_RETRY_DELAY_MS);
    };
    timer = setTimeout(stepOnce, STEP_DELAY_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [preparing, apply]);

  const request = useCallback(
    async (password: string): Promise<{ ok: true } | { ok: false; reason: RequestFailure }> => {
      if (!email) return { ok: false, reason: 'session_expired' };
      const signedIn = await confirmPassword(email, password);
      if (signedIn !== 'ok') return { ok: false, reason: signedIn };
      const result = await invokeEdgeWithFreshSession<StatusPayload>('account-export', { action: 'request' });
      if (!result.ok) {
        const known: RequestFailure[] = ['reauthentication_required', 'session_expired', 'network', 'unavailable'];
        return { ok: false, reason: known.includes(result.reason as RequestFailure) ? (result.reason as RequestFailure) : 'server' };
      }
      apply(result.data);
      return { ok: true };
    },
    [email, apply],
  );

  // A signed link (valid a few minutes) to the ready archive.
  const downloadLink = useCallback(async (): Promise<{ ok: true; url: string } | { ok: false; reason: string }> => {
    const result = await invokeEdgeWithFreshSession<{ url: string }>('account-export', { action: 'download' });
    if (!result.ok) {
      if (result.reason === 'no_ready_export') void refresh();
      return { ok: false, reason: result.reason };
    }
    return { ok: true, url: result.data.url };
  }, [refresh]);

  return { loaded, available, info, refresh, request, downloadLink };
}
