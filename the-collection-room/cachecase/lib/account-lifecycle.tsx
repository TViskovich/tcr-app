import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';

import { onAccountInactive } from '@/lib/account-lifecycle-events';
import { useAuth } from '@/lib/auth';
import { confirmPassword, invokeEdge, invokeEdgeWithFreshSession } from '@/lib/edge-functions';
import { supabase } from '@/lib/supabase';

// The signed-in collector's account lifecycle (Dashboard Milestone 2):
// active, or pending deletion (14-day recovery window), or being deleted.
//
// Source of truth is the database: the collector's own account_lifecycle
// row, readable only by them (supabase/migrations/20261103120000_*). Changes
// go through the account-deletion Edge Function, which takes the collector
// from the verified access token — never from anything sent here.
//
// The last known state (active or not) is cached per user on the device, so
// opening the app offline shows the right thing at once. When the state
// can't be read and this device has never seen it, the status is 'unknown'
// and the app is NOT shown (app/_layout.tsx): the check is retried every
// few seconds and on returning to the app. A cached 'active' can be stale
// if deletion was scheduled on another device; that device's sessions are
// signed out and every write is refused by the database, and the first
// account_inactive error or return to the app re-checks.

export type LifecycleStatus = 'checking' | 'unknown' | 'active' | 'pending_deletion' | 'deleting';

type Snapshot = { status: LifecycleStatus; scheduledFor: string | null; requestedAt: string | null };

export type ScheduleFailure =
  | 'wrong_password'
  | 'reauthentication_required'
  | 'confirmation_required'
  | 'deletion_in_progress'
  | 'session_expired'
  | 'network'
  | 'server';
export type CancelFailure = 'deletion_in_progress' | 'session_expired' | 'network' | 'server';
export type DeleteNowFailure = ScheduleFailure | 'deletion_unavailable';

// The permanent-deletion job (server: account_deletion_jobs) as the app
// sees it. Completion is only ever taken from the server.
export type DeletionJob = { id: string; status: string; objects_total: number | null; objects_deleted: number };
// Shown after the account (and its session) is gone: the job's outcome,
// read with this device's status capability. 'completed' only when the
// server says so; 'unconfirmed' when the capability is no longer accepted
// (expired or revoked), so this device can't learn the outcome any more.
export type DeletionNotice = { state: 'in_progress' | 'completed' | 'failed' | 'unconfirmed' | 'unknown' };

type ContextValue = Snapshot & {
  refresh: () => Promise<void>;
  scheduleDeletion: (password: string, confirmation: string) => Promise<{ ok: true } | { ok: false; reason: ScheduleFailure }>;
  cancelDeletion: () => Promise<{ ok: true } | { ok: false; reason: CancelFailure }>;
  // null until known; true only when the server's deletion worker is ready.
  deleteNowAvailable: boolean | null;
  loadDeletionInfo: () => Promise<void>;
  deleteNow: (password: string, confirmation: string) => Promise<{ ok: true } | { ok: false; reason: DeleteNowFailure }>;
  deletionJob: DeletionJob | null;
  deletionNotice: DeletionNotice | null;
  dismissDeletionNotice: () => void;
};

const ACTIVE: Snapshot = { status: 'active', scheduledFor: null, requestedAt: null };
const CHECKING: Snapshot = { status: 'checking', scheduledFor: null, requestedAt: null };
const UNKNOWN: Snapshot = { status: 'unknown', scheduledFor: null, requestedAt: null };
const UNKNOWN_RETRY_MS = 5000;
const DELETION_POLL_MS = 4000;
const cacheKey = (userId: string) => `cachecase.account-lifecycle.${userId}`;
// Device-wide: the status capability for the permanent deletion started from
// this device (server: account-deletion issues it; account-deletion-status
// accepts it), so the outcome can still be shown after the account and
// session are gone — including after the app is closed and reopened. It can
// only read processing / completed / failed.
const DELETION_STATUS_KEY = 'cachecase.account-deletion-status';
// Before status capabilities: a bare job id. Removed on sight.
const LEGACY_DELETION_JOB_KEY = 'cachecase.account-deletion-job';
type StatusCapability = { token: string; expiresAt: string };
type StatusPayload = { status_token?: string; status_token_expires_at?: string };

const AccountLifecycleContext = createContext<ContextValue>({
  ...ACTIVE,
  refresh: async () => {},
  scheduleDeletion: async () => ({ ok: false, reason: 'server' }),
  cancelDeletion: async () => ({ ok: false, reason: 'server' }),
  deleteNowAvailable: null,
  loadDeletionInfo: async () => {},
  deleteNow: async () => ({ ok: false, reason: 'server' }),
  deletionJob: null,
  deletionNotice: null,
  dismissDeletionNotice: () => {},
});

// Stores a capability the server just issued; returns whether one was stored.
async function rememberStatusCapability(payload: StatusPayload | null | undefined): Promise<boolean> {
  if (!payload?.status_token || !payload.status_token_expires_at) return false;
  const capability: StatusCapability = { token: payload.status_token, expiresAt: payload.status_token_expires_at };
  try {
    await AsyncStorage.setItem(DELETION_STATUS_KEY, JSON.stringify(capability));
    await AsyncStorage.removeItem(LEGACY_DELETION_JOB_KEY);
    return true;
  } catch {
    return false;
  }
}
async function readStatusCapability(): Promise<StatusCapability | null> {
  try {
    void AsyncStorage.removeItem(LEGACY_DELETION_JOB_KEY);
    const raw = await AsyncStorage.getItem(DELETION_STATUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StatusCapability;
    return typeof parsed?.token === 'string' && typeof parsed.expiresAt === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

type RemoteRow = { state: 'pending_deletion' | 'deleting'; scheduled_for: string | null; requested_at: string | null };
const fromRow = (row: RemoteRow | null): Snapshot =>
  row ? { status: row.state, scheduledFor: row.scheduled_for, requestedAt: row.requested_at } : ACTIVE;

async function readCache(userId: string): Promise<Snapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Snapshot;
    return ['active', 'pending_deletion', 'deleting'].includes(parsed.status) ? parsed : null;
  } catch {
    return null;
  }
}
async function writeCache(userId: string, snapshot: Snapshot) {
  try {
    if (['active', 'pending_deletion', 'deleting'].includes(snapshot.status)) {
      await AsyncStorage.setItem(cacheKey(userId), JSON.stringify(snapshot));
    }
  } catch {}
}

export function AccountLifecycleProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user?.id;
  const email = session?.user?.email ?? null;
  const [snapshot, setSnapshot] = useState<Snapshot>(CHECKING);
  const [deleteNowAvailable, setDeleteNowAvailable] = useState<boolean | null>(null);
  const [deletionJob, setDeletionJob] = useState<DeletionJob | null>(null);
  const [deletionNotice, setDeletionNotice] = useState<DeletionNotice | null>(null);
  const deletingRef = useRef(false);
  // The user the current snapshot belongs to; a late answer for a previous
  // user is ignored.
  const userRef = useRef<string | undefined>(userId);
  // Declared before the effects below, so it runs first.
  useEffect(() => {
    userRef.current = userId;
  }, [userId]);

  const commit = useCallback((forUser: string, next: Snapshot) => {
    if (userRef.current !== forUser) return;
    setSnapshot(next);
    void writeCache(forUser, next);
  }, []);

  const refresh = useCallback(async () => {
    const forUser = userRef.current;
    if (!forUser) return;
    const { data, error } = await supabase
      .from('account_lifecycle')
      .select('state, scheduled_for, requested_at')
      .maybeSingle();
    if (error) {
      // No lifecycle table (database without the migration): always active.
      if (error.code === 'PGRST205' || error.code === '42P01') {
        commit(forUser, ACTIVE);
        return;
      }
      if (__DEV__) console.warn('[AccountLifecycle] state check failed:', error.message);
      // Keep whatever is known; a first check that fails is 'unknown' (the
      // app stays hidden until it succeeds), never assumed active.
      if (userRef.current === forUser) setSnapshot((prev) => (prev.status === 'checking' ? UNKNOWN : prev));
      return;
    }
    commit(forUser, fromRow(data as RemoteRow | null));
  }, [commit]);

  // New signed-in user: show their cached state at once, then check.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void readCache(userId).then((cached) => {
      if (cancelled || userRef.current !== userId) return;
      setSnapshot(cached ?? CHECKING);
      void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [userId, refresh]);

  // Re-check on return to the app and whenever the server says this account
  // is inactive (e.g. scheduled from another device).
  useEffect(() => {
    if (!userId) return;
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    const unsubscribe = onAccountInactive(() => void refresh());
    return () => {
      appState.remove();
      unsubscribe();
    };
  }, [userId, refresh]);

  // Keep retrying while the state is unknown (e.g. offline at first launch).
  const unknown = snapshot.status === 'unknown';
  useEffect(() => {
    if (!userId || !unknown) return;
    const timer = setInterval(() => void refresh(), UNKNOWN_RETRY_MS);
    return () => clearInterval(timer);
  }, [userId, unknown, refresh]);

  const scheduleDeletion = useCallback<ContextValue['scheduleDeletion']>(
    async (password, confirmation) => {
      const forUser = userRef.current;
      if (!forUser || !email) return { ok: false, reason: 'session_expired' };
      // A fresh password sign-in is the "recently authenticated" proof the
      // Edge Function checks (the token's sign-in time).
      const signedIn = await confirmPassword(email, password);
      if (signedIn !== 'ok') return { ok: false, reason: signedIn };
      const result = await invokeEdgeWithFreshSession('account-deletion', { action: 'schedule', confirmation });
      if (!result.ok) {
        const known: ScheduleFailure[] = ['reauthentication_required', 'confirmation_required', 'deletion_in_progress', 'session_expired', 'network'];
        if (result.reason === 'deletion_in_progress') void refresh();
        return { ok: false, reason: known.includes(result.reason as ScheduleFailure) ? (result.reason as ScheduleFailure) : 'server' };
      }
      commit(forUser, {
        status: 'pending_deletion',
        scheduledFor: (result.data.scheduled_for as string) ?? null,
        requestedAt: (result.data.requested_at as string) ?? null,
      });
      return { ok: true };
    },
    [email, commit, refresh],
  );

  const cancelDeletion = useCallback<ContextValue['cancelDeletion']>(async () => {
    const forUser = userRef.current;
    if (!forUser) return { ok: false, reason: 'session_expired' };
    const result = await invokeEdgeWithFreshSession('account-deletion', { action: 'cancel' });
    if (!result.ok) {
      if (result.reason === 'deletion_in_progress') {
        void refresh();
        return { ok: false, reason: 'deletion_in_progress' };
      }
      if (result.reason === 'session_expired' || result.reason === 'network') return { ok: false, reason: result.reason };
      return { ok: false, reason: 'server' };
    }
    commit(forUser, ACTIVE);
    return { ok: true };
  }, [commit, refresh]);

  // Server-side status: Delete Now availability and, while deleting, the
  // job's progress.
  const loadDeletionInfo = useCallback(async () => {
    // While deleting, make sure this device holds a status capability (the
    // Delete Now answer may have been lost, or the app reinstalled).
    const wantToken = deletingRef.current && !(await readStatusCapability());
    const result = await invokeEdge<{ delete_now_available?: boolean; job?: DeletionJob | null; state?: string } & StatusPayload>('account-deletion', {
      action: 'status',
      ...(wantToken ? { want_status_token: true } : {}),
    });
    if (!result.ok) {
      if (result.reason === 'unavailable') setDeleteNowAvailable(false);
      // While deleting, a token that no longer verifies means the account
      // is gone: sign out on this device; the outcome is then confirmed with
      // the status capability (deletionNotice), never assumed.
      if (result.reason === 'invalid_token' && deletingRef.current) {
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      }
      return;
    }
    setDeleteNowAvailable(result.data.delete_now_available === true);
    if (result.data.job) setDeletionJob(result.data.job);
    await rememberStatusCapability(result.data);
  }, []);

  const deleteNow = useCallback<ContextValue['deleteNow']>(
    async (password, confirmation) => {
      const forUser = userRef.current;
      if (!forUser || !email) return { ok: false, reason: 'session_expired' };
      const signedIn = await confirmPassword(email, password);
      if (signedIn !== 'ok') return { ok: false, reason: signedIn };
      const result = await invokeEdgeWithFreshSession<{ job?: DeletionJob } & StatusPayload>('account-deletion', { action: 'delete_now', confirmation });
      if (!result.ok) {
        const known: DeleteNowFailure[] = ['reauthentication_required', 'confirmation_required', 'session_expired', 'network', 'deletion_unavailable'];
        if (result.reason === 'deletion_unavailable') setDeleteNowAvailable(false);
        const reason = known.includes(result.reason as DeleteNowFailure) ? (result.reason as DeleteNowFailure) : 'server';
        // The request may have reached the server even though no answer
        // came back: ask before reporting a failure, so a deletion that did
        // start is followed, never shown as "not started".
        if (reason === 'network' || reason === 'server') {
          // want_status_token: the lost answer carried this device's status
          // capability, so ask for a new one.
          const check = await invokeEdge<{ state?: string; job?: DeletionJob | null } & StatusPayload>('account-deletion', {
            action: 'status',
            want_status_token: true,
          });
          if (check.ok && check.data.state === 'deleting') {
            if (check.data.job) setDeletionJob(check.data.job);
            await rememberStatusCapability(check.data);
            commit(forUser, { status: 'deleting', scheduledFor: null, requestedAt: null });
            return { ok: true };
          }
        }
        return { ok: false, reason };
      }
      if (result.data.job) setDeletionJob(result.data.job);
      await rememberStatusCapability(result.data);
      commit(forUser, { status: 'deleting', scheduledFor: null, requestedAt: null });
      return { ok: true };
    },
    [email, commit],
  );

  // While deleting (signed in): follow the job's progress.
  const deleting = !!userId && snapshot.status === 'deleting';
  useEffect(() => {
    deletingRef.current = deleting;
  }, [deleting]);
  useEffect(() => {
    if (!deleting) return;
    let stopped = false;
    const poll = () => {
      void loadDeletionInfo().finally(() => {
        if (!stopped) timer = setTimeout(poll, DELETION_POLL_MS);
      });
    };
    let timer: ReturnType<typeof setTimeout> = setTimeout(poll, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [deleting, loadDeletionInfo]);

  // Signed out (the account is gone, or the collector signed out while it
  // was being deleted): show the outcome of the deletion started on this
  // device, read with its status capability. Runs again on every launch and
  // when the app returns to the foreground, until the outcome is final.
  useEffect(() => {
    if (userId) return;
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      if (!stopped) timer = setTimeout(() => void check(), ms);
    };
    const check = async () => {
      if (stopped || running) return;
      running = true;
      try {
        const capability = await readStatusCapability();
        if (stopped || !capability) return;
        if (Date.parse(capability.expiresAt) <= Date.now()) {
          setDeletionNotice({ state: 'unconfirmed' });
          return;
        }
        const result = await invokeEdge<{ state: 'processing' | 'completed' | 'failed' }>('account-deletion-status', { token: capability.token });
        if (stopped) return;
        if (result.ok) {
          const state = result.data.state === 'processing' ? 'in_progress' : result.data.state;
          setDeletionNotice({ state });
          if (state !== 'completed') schedule(DELETION_POLL_MS);
        } else if (result.reason === 'invalid_capability') {
          setDeletionNotice({ state: 'unconfirmed' });
        } else {
          // Offline, rate limited or a server error: keep what's shown and
          // look again shortly (the poll interval is above the server's
          // per-capability limit).
          setDeletionNotice((prev) => prev ?? { state: 'unknown' });
          schedule(DELETION_POLL_MS);
        }
      } finally {
        running = false;
      }
    };
    void check();
    const foreground = AppState.addEventListener('change', (next) => {
      if (next === 'active') void check();
    });
    return () => {
      stopped = true;
      foreground.remove();
      if (timer) clearTimeout(timer);
    };
  }, [userId]);

  const dismissDeletionNotice = useCallback(() => {
    setDeletionNotice(null);
    void AsyncStorage.removeItem(DELETION_STATUS_KEY).catch(() => {});
    void AsyncStorage.removeItem(LEGACY_DELETION_JOB_KEY).catch(() => {});
  }, []);

  const value = useMemo<ContextValue>(
    () => ({
      ...(userId ? snapshot : ACTIVE),
      refresh,
      scheduleDeletion,
      cancelDeletion,
      deleteNowAvailable,
      loadDeletionInfo,
      deleteNow,
      deletionJob,
      deletionNotice: userId ? null : deletionNotice,
      dismissDeletionNotice,
    }),
    [userId, snapshot, refresh, scheduleDeletion, cancelDeletion, deleteNowAvailable, loadDeletionInfo, deleteNow, deletionJob, deletionNotice, dismissDeletionNotice],
  );
  return <AccountLifecycleContext.Provider value={value}>{children}</AccountLifecycleContext.Provider>;
}

export const useAccountLifecycle = () => useContext(AccountLifecycleContext);
