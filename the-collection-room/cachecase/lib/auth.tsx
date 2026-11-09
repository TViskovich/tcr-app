import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { isAuthRetryableFetchError, type AuthError, type Session } from '@supabase/supabase-js';

import { signOutOtherSessions, updatePassword, type PasswordUpdateFailure } from './account-credentials';
import {
  DM_ATTACHMENTS_CACHE_DOMAIN,
  FOLDER_COVERS_CACHE_DOMAIN,
  ITEM_IMAGES_CACHE_DOMAIN,
  purgePersistedSignedUrlCache,
  setActiveSignedUrlIdentity,
} from './persisted-signed-url-cache';
import { purgeOwnProfileCache, readOwnProfileCache } from './own-profile-cache';
import { supabase } from './supabase';
import { clearInboxSnapshot } from './dm-inbox';
import { clearRecentProfilesMemory } from './recent-profiles';
import { clearVisitedProfiles } from './visited-profile-cache';

// ── Password recovery (email code) ──────────────────────────────────────────
// Forgot Password → Supabase emails a one-time code (resetPasswordForEmail;
// the recovery email template shows {{ .Token }}, no link) → the collector
// enters it with a new password (verifyOtp type 'recovery', then
// updateUser). Verifying the code signs the collector in, so until the new
// password is saved a RECOVERY HOLD keeps that session on the reset screen:
//   * set (and persisted) BEFORE verifyOtp runs, so the session it creates
//     can never reach the app — the root layout (app/_layout.tsx) routes a
//     held session only to /(auth)/reset-password: no tabs, no account
//     screens (Delete Account, Download My Data, Pending Deletion's actions);
//   * persisted (just a flag, never the code) so a relaunch returns to the
//     reset screen instead of the app;
//   * cleared only by a successful password change, Cancel, sign-out, or the
//     session ending.
// The code itself lives only in the reset screen's input state.
const RECOVERY_HOLD_KEY = 'cachecase.password-recovery-hold';
export const RESET_COOLDOWN_MS = 60_000;

export type RecoveryRequestResult = 'sent' | 'network';
export type RecoveryVerifyResult = 'ok' | 'invalid' | 'too_many' | 'network';
export type RecoveryCompleteResult = { ok: true; otherSessionsSignedOut: boolean } | { ok: false; reason: PasswordUpdateFailure };

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
  // Recovery
  recoveryHold: boolean;
  recoveryEmail: string | null;
  setRecoveryEmail: (email: string | null) => void;
  resetCooldownUntil: number;
  requestPasswordReset: (email: string) => Promise<RecoveryRequestResult>;
  verifyRecoveryCode: (email: string, code: string) => Promise<RecoveryVerifyResult>;
  completePasswordReset: (password: string) => Promise<RecoveryCompleteResult>;
  cancelRecovery: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  session: null,
  loading: true,
  signOut: async () => {},
  recoveryHold: false,
  recoveryEmail: null,
  setRecoveryEmail: () => {},
  resetCooldownUntil: 0,
  requestPasswordReset: async () => 'network',
  verifyRecoveryCode: async () => 'network',
  completePasswordReset: async () => ({ ok: false, reason: 'server' }),
  cancelRecovery: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [recoveryHold, setRecoveryHold] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState<string | null>(null);
  const [resetCooldownUntil, setResetCooldownUntil] = useState(0);

  // The identity string (session.user.id, or 'anon' with no session) the
  // private-image hooks' persisted signed-URL caches key on
  // (hooks/use-signed-item-images.ts, hooks/use-signed-folder-covers.ts) —
  // `undefined` until the very first session state has actually been
  // observed (from whichever of getSession()/onAuthStateChange's own
  // initial delivery settles first), so that first observation is only
  // ever recorded, never treated as an "outgoing" identity to purge.
  const identityRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Purges both private-image persisted signed-URL caches (Phase 1 of
    // the private-image caching upgrade — see
    // lib/persisted-signed-url-cache.ts) for whichever identity this app
    // was JUST acting as, the moment a DIFFERENT identity takes over:
    // sign-out (session -> null, identity -> 'anon'), sign-in, or a direct
    // account switch all funnel through this one check. Imports the shared
    // cache helper directly (never hooks/use-signed-item-images.ts or
    // hooks/use-signed-folder-covers.ts themselves) — both of those hooks
    // already import useAuth from this file, so importing anything back
    // from them here would create a circular module dependency; see
    // ITEM_IMAGES_CACHE_DOMAIN's own comment in
    // lib/persisted-signed-url-cache.ts for the same reasoning.
    //
    // This is defense-in-depth, not the only thing preventing cross-user
    // exposure: every persisted (and in-memory) entry is already keyed by
    // identity, so a lookup under a NEW identity could never read a
    // different identity's entry even without this. What this adds is
    // bounded storage growth and prompt removal of a departed identity's
    // signed-URL metadata on a shared device, rather than letting it
    // accumulate indefinitely across however many accounts sign in over
    // time.
    function handleIdentityChange(newSession: Session | null) {
      const nextIdentity = newSession?.user?.id ?? 'anon';
      const previousIdentity = identityRef.current;
      identityRef.current = nextIdentity;
      // Before any purge below, so a signing request still in flight for the
      // previous identity can't write its result back afterwards.
      setActiveSignedUrlIdentity(nextIdentity);

      // Best-effort warm of the (possibly new) identity's own-profile cache
      // into memory, the moment a real session is known — including the
      // very first observation on a cold launch — well before the user
      // could possibly navigate to the Profile tab, so ProfileV2Screen's
      // own peekOwnProfileCacheSync (used in its useState lazy
      // initializers) is already warm by the time it mounts. No-ops
      // harmlessly if there's nothing persisted yet.
      if (nextIdentity !== 'anon' && nextIdentity !== previousIdentity) {
        readOwnProfileCache(nextIdentity).catch(() => {});
      }

      if (previousIdentity === undefined || previousIdentity === nextIdentity) return;
      purgePersistedSignedUrlCache(ITEM_IMAGES_CACHE_DOMAIN, previousIdentity).catch(() => {});
      purgePersistedSignedUrlCache(FOLDER_COVERS_CACHE_DOMAIN, previousIdentity).catch(() => {});
      purgePersistedSignedUrlCache(DM_ATTACHMENTS_CACHE_DOMAIN, previousIdentity).catch(() => {});
      // Own-profile cache (lib/own-profile-cache.ts, Profile V2 startup
      // caching) is keyed by real user id only — 'anon' never has one.
      if (previousIdentity !== 'anon') purgeOwnProfileCache(previousIdentity).catch(() => {});
      // Other users' profiles as the previous identity saw them (memory only).
      clearVisitedProfiles();
      // Find User's recent collectors — in-memory mirror only; each
      // account's persisted list stays keyed to that account.
      clearRecentProfilesMemory();
      // Messages tab warm-up snapshot (memory only, keyed by user id).
      clearInboxSnapshot();
    }

    // The session and the persisted recovery hold are both known before the
    // route tree renders (loading stays true until then), so a relaunch with
    // an unfinished recovery can't flash the app.
    Promise.all([
      supabase.auth.getSession(),
      AsyncStorage.getItem(RECOVERY_HOLD_KEY).catch(() => null),
    ]).then(([{ data }, held]) => {
      handleIdentityChange(data.session);
      setSession(data.session);
      if (held && data.session) setRecoveryHold(true);
      else if (held) AsyncStorage.removeItem(RECOVERY_HOLD_KEY).catch(() => {});
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      handleIdentityChange(newSession);
      setSession(newSession);
      // A recovery hold only means something while its session exists.
      if (!newSession) {
        AsyncStorage.removeItem(RECOVERY_HOLD_KEY).catch(() => {});
        setRecoveryHold(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const clearRecoveryHold = useCallback(async () => {
    await AsyncStorage.removeItem(RECOVERY_HOLD_KEY).catch(() => {});
    setRecoveryHold(false);
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    setSession(null);
    await clearRecoveryHold();
    setRecoveryEmail(null);
  }

  // Same answer whether or not an account uses the address: anything but a
  // network failure (including Supabase's per-address rate limit, which only
  // applies to real accounts) is reported as 'sent'. The cooldown starts
  // either way.
  async function requestPasswordReset(email: string): Promise<RecoveryRequestResult> {
    const address = email.trim().toLowerCase();
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(address);
      if (error && isAuthRetryableFetchError(error)) return 'network';
    } catch (e) {
      if (isAuthRetryableFetchError(e)) return 'network';
    }
    setRecoveryEmail(address);
    setResetCooldownUntil(Date.now() + RESET_COOLDOWN_MS);
    return 'sent';
  }

  async function verifyRecoveryCode(email: string, code: string): Promise<RecoveryVerifyResult> {
    // Hold first: verifyOtp's own auth event must find the session held.
    await AsyncStorage.setItem(RECOVERY_HOLD_KEY, '1').catch(() => {});
    setRecoveryHold(true);
    let error: AuthError | null = null;
    try {
      ({ error } = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code, type: 'recovery' }));
    } catch (e) {
      error = e as AuthError;
    }
    if (!error) return 'ok';
    await clearRecoveryHold();
    if (isAuthRetryableFetchError(error)) return 'network';
    if (error.code === 'over_request_rate_limit' || error.status === 429) return 'too_many';
    return 'invalid'; // wrong, expired and already-used codes look the same
  }

  async function completePasswordReset(password: string): Promise<RecoveryCompleteResult> {
    const updated = await updatePassword(password);
    if (!updated.ok) {
      // The session has gone: nothing left to hold.
      if (updated.reason === 'session_expired') await clearRecoveryHold();
      return updated;
    }
    const otherSessionsSignedOut = await signOutOtherSessions();
    await clearRecoveryHold();
    setRecoveryEmail(null);
    return { ok: true, otherSessionsSignedOut };
  }

  // Leaves recovery: the half-finished session is signed out (this device
  // only) and the hold cleared.
  async function cancelRecovery() {
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch {}
    setSession(null);
    await clearRecoveryHold();
    setRecoveryEmail(null);
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        signOut,
        recoveryHold,
        recoveryEmail,
        setRecoveryEmail,
        resetCooldownUntil,
        requestPasswordReset,
        verifyRecoveryCode,
        completePasswordReset,
        cancelRecovery,
      }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
