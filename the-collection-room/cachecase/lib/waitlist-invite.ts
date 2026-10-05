import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

// Client for the public invite endpoints (Phase 2B). The waitlist table is
// never read from the app — these Edge Functions are the only path:
//   validate-waitlist-invite — informational check for the code screen
//   redeem-waitlist-invite   — the only way a new account is created
// The plaintext code is passed through and never stored or logged here.

export type InviteCheck =
  | { kind: 'valid'; name: string | null; reservedUsername: string | null }
  | { kind: 'invalid' | 'expired' | 'used' }
  | { kind: 'network' };

export type RedeemResult =
  | { kind: 'ok' }
  | {
      kind: 'failed';
      reason:
        | 'invalid'
        | 'expired'
        | 'used'
        | 'email_mismatch'
        | 'username_taken'
        | 'username_mismatch'
        | 'account_exists'
        | 'invalid_email'
        | 'invalid_username'
        | 'invalid_password'
        | 'retry'
        | 'signup_failed';
    };

// Non-2xx responses carry a JSON body the server deliberately shaped;
// supabase-js surfaces them as FunctionsHttpError with the Response on
// `context`. Anything else (fetch failure, unparseable body) is a network
// outcome.
async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    const { data, error } = await supabase.functions.invoke(fn, { body });
    if (!error) return data as T;
    if (error instanceof FunctionsHttpError) {
      try {
        return (await (error.context as Response).json()) as T;
      } catch {
        return null;
      }
    }
    if (error instanceof FunctionsFetchError) return null;
    return null;
  } catch {
    return null;
  }
}

export async function checkInviteCode(code: string): Promise<InviteCheck> {
  const res = await invoke<{
    valid?: boolean;
    reason?: string;
    name?: string | null;
    reserved_username?: string | null;
  }>('validate-waitlist-invite', { code });
  if (!res || typeof res.valid !== 'boolean') return { kind: 'network' };
  if (res.valid) {
    return { kind: 'valid', name: res.name ?? null, reservedUsername: res.reserved_username ?? null };
  }
  if (res.reason === 'expired' || res.reason === 'used') return { kind: res.reason };
  return { kind: 'invalid' };
}

const REDEEM_REASONS = new Set([
  'invalid',
  'expired',
  'used',
  'email_mismatch',
  'username_taken',
  'username_mismatch',
  'account_exists',
  'invalid_email',
  'invalid_username',
  'invalid_password',
  'retry',
  'signup_failed',
]);

export async function redeemInvite(args: {
  code: string;
  email: string;
  password: string;
  username: string;
}): Promise<RedeemResult> {
  const res = await invoke<{ status?: string; reason?: string }>('redeem-waitlist-invite', args);
  if (res?.status === 'ok') return { kind: 'ok' };
  const reason = res?.reason && REDEEM_REASONS.has(res.reason) ? res.reason : 'retry';
  return { kind: 'failed', reason: reason as Extract<RedeemResult, { kind: 'failed' }>['reason'] };
}
