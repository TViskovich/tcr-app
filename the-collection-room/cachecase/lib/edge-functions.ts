import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

// Calls an Edge Function that answers { status: 'ok', … } or
// { status: 'failed', reason } (account-deletion, account-export).
// `reason` is the function's controlled failure reason, 'network' when the
// request never got an answer, or 'unavailable' when the function isn't
// deployed (404 without a reason).
export type EdgeResult<T> = { ok: true; data: T } | { ok: false; reason: string; httpStatus: number | null };

export async function invokeEdge<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<EdgeResult<T>> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return { ok: true, data: (data ?? {}) as T };
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response;
    let reason: string | null = null;
    try {
      const json = (await response.json()) as { reason?: unknown };
      if (typeof json.reason === 'string') reason = json.reason;
    } catch {}
    return { ok: false, reason: reason ?? (response.status === 404 ? 'unavailable' : 'server'), httpStatus: response.status };
  }
  if (error instanceof FunctionsFetchError) return { ok: false, reason: 'network', httpStatus: null };
  return { ok: false, reason: 'server', httpStatus: null };
}

// Retries once with a refreshed session when the access token was rejected;
// reports 'session_expired' when the session can't be refreshed.
export async function invokeEdgeWithFreshSession<T = Record<string, unknown>>(
  name: string,
  body: Record<string, unknown>,
): Promise<EdgeResult<T>> {
  const first = await invokeEdge<T>(name, body);
  if (first.ok || first.reason !== 'invalid_token') return first;
  const { error } = await supabase.auth.refreshSession();
  if (error) return { ok: false, reason: 'session_expired', httpStatus: 401 };
  const second = await invokeEdge<T>(name, body);
  if (!second.ok && second.reason === 'invalid_token') return { ok: false, reason: 'session_expired', httpStatus: 401 };
  return second;
}

// A fresh password sign-in — the "recently authenticated" proof the server
// checks for sensitive account actions (it reads the token's sign-in time).
export async function confirmPassword(email: string, password: string): Promise<'ok' | 'wrong_password' | 'network' | 'server'> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error) return 'ok';
  const status = (error as { status?: number }).status;
  if (status === 400 || error.message.toLowerCase().includes('invalid login')) return 'wrong_password';
  return status ? 'server' : 'network';
}
