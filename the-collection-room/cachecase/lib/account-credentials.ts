import { isAuthRetryableFetchError, type AuthError } from '@supabase/supabase-js';

import { confirmPassword } from './edge-functions';
import { supabase } from './supabase';

// Password changes shared by password recovery (lib/auth.tsx) and Change
// Password (app/account/password.tsx). Uses only Supabase Auth's supported
// APIs: updateUser({ password }) for the change, signOut({ scope: 'others' })
// to end every other session afterwards. Nothing here logs a password, a
// recovery code or an email address.

export type PasswordUpdateFailure =
  | 'same_password'
  | 'weak_password'
  | 'session_expired'
  | 'reauthentication_needed'
  | 'rate_limited'
  | 'network'
  | 'server';

export const PASSWORD_UPDATE_COPY: Record<PasswordUpdateFailure, string> = {
  same_password: 'Choose a password different from your current one.',
  weak_password: 'That password is too weak. Use at least 8 characters.',
  session_expired: 'Your session has ended. Please start again.',
  reauthentication_needed: 'For your security, please sign in again and retry.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  network: 'Couldn’t reach CacheCase. Check your connection and try again.',
  server: 'Something went wrong. Please try again.',
};

export function classifyPasswordUpdateError(error: AuthError | Error | null | undefined): PasswordUpdateFailure {
  if (!error) return 'server';
  if (isAuthRetryableFetchError(error)) return 'network';
  const code = (error as AuthError).code;
  const status = (error as AuthError).status;
  if (code === 'same_password') return 'same_password';
  if (code === 'weak_password') return 'weak_password';
  if (code === 'reauthentication_needed' || code === 'reauth_nonce_missing' || code === 'reauthentication_not_valid') return 'reauthentication_needed';
  if (code === 'over_request_rate_limit' || status === 429) return 'rate_limited';
  if (
    code === 'session_not_found' || code === 'session_expired' || code === 'bad_jwt' || code === 'refresh_token_not_found'
    || code === 'user_not_found' || status === 401 || status === 403
  ) return 'session_expired';
  return 'server';
}

export async function updatePassword(password: string): Promise<{ ok: true } | { ok: false; reason: PasswordUpdateFailure }> {
  try {
    const { error } = await supabase.auth.updateUser({ password });
    return error ? { ok: false, reason: classifyPasswordUpdateError(error) } : { ok: true };
  } catch (e) {
    return { ok: false, reason: classifyPasswordUpdateError(e as Error) };
  }
}

// Ends every session of this account except the current one. Returns
// whether Supabase confirmed it (the caller reports a failure honestly
// rather than assuming other devices were signed out).
export async function signOutOtherSessions(): Promise<boolean> {
  try {
    const { error } = await supabase.auth.signOut({ scope: 'others' });
    return !error;
  } catch {
    return false;
  }
}

export type ChangePasswordFailure = PasswordUpdateFailure | 'wrong_password';
export type ChangePasswordResult = { ok: true; otherSessionsSignedOut: boolean } | { ok: false; reason: ChangePasswordFailure };

export const CHANGE_PASSWORD_COPY: Record<ChangePasswordFailure, string> = {
  ...PASSWORD_UPDATE_COPY,
  wrong_password: 'Your current password isn’t right. Please try again.',
};

// Signed-in password change: proves the current password with a fresh
// sign-in (which also makes this a "recent sign-in"), sets the new one,
// then signs out every other session.
export async function changePassword(email: string, currentPassword: string, newPassword: string): Promise<ChangePasswordResult> {
  const proof = await confirmPassword(email, currentPassword);
  if (proof === 'wrong_password') return { ok: false, reason: 'wrong_password' };
  if (proof !== 'ok') return { ok: false, reason: proof === 'network' ? 'network' : 'server' };
  const updated = await updatePassword(newPassword);
  if (!updated.ok) return updated;
  return { ok: true, otherSessionsSignedOut: await signOutOtherSessions() };
}
