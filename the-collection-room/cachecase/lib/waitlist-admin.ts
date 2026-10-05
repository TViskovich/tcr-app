import { FunctionsHttpError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

// Client for the admin-only waitlist Edge Functions:
//   list-waitlist-signups — the only read path for waitlist_signups
//   grant-waitlist-access — grant / regenerate (emails the invite)
// supabase.functions.invoke sends the signed-in user's JWT; each function
// re-checks admin membership server-side. No secret lives in the app.

export type WaitlistStatus = 'waitlisted' | 'access_granted' | 'onboarded';

export type WaitlistSignup = {
  id: string;
  name: string;
  email: string;
  reserved_username: string | null;
  status: WaitlistStatus;
  created_at: string;
  access_granted_at: string | null;
  access_code_expires_at: string | null;
  onboarded_at: string | null;
};

export type ListResult =
  | { kind: 'ok'; signups: WaitlistSignup[] }
  | { kind: 'forbidden' }
  | { kind: 'error' };

export type GrantResult =
  // Access granted / regenerated and the invite email sent.
  | { kind: 'ok'; status: WaitlistStatus | null; accessGrantedAt: string | null; expiresAt: string | null }
  // Grant committed but the email failed — regenerate to retry.
  | { kind: 'email_failed'; status: WaitlistStatus | null; accessGrantedAt: string | null; expiresAt: string | null }
  // Row changed underneath us (already granted / onboarded / not granted).
  | { kind: 'conflict' }
  | { kind: 'forbidden' }
  | { kind: 'error' };

type InvokeOutcome = { httpStatus: number | null; body: Record<string, unknown> | null };

async function invoke(fn: string, body: Record<string, unknown>): Promise<InvokeOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke(fn, { body });
    if (!error) return { httpStatus: 200, body: (data ?? null) as Record<string, unknown> | null };
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response;
      try {
        return { httpStatus: res.status, body: (await res.json()) as Record<string, unknown> };
      } catch {
        return { httpStatus: res.status, body: null };
      }
    }
    return { httpStatus: null, body: null };
  } catch {
    return { httpStatus: null, body: null };
  }
}

export async function listWaitlistSignups(): Promise<ListResult> {
  const { httpStatus, body } = await invoke('list-waitlist-signups', {});
  if (httpStatus === 401 || httpStatus === 403) return { kind: 'forbidden' };
  if (httpStatus === 200 && body?.status === 'ok' && Array.isArray(body.signups)) {
    return { kind: 'ok', signups: body.signups as WaitlistSignup[] };
  }
  return { kind: 'error' };
}

export async function grantWaitlistAccess(signupId: string, regenerate: boolean): Promise<GrantResult> {
  const { httpStatus, body } = await invoke('grant-waitlist-access', {
    waitlist_signup_id: signupId,
    regenerate,
  });
  if (httpStatus === 401 || httpStatus === 403) return { kind: 'forbidden' };
  if (httpStatus === 409 || httpStatus === 404) return { kind: 'conflict' };
  if (httpStatus === 200 && (body?.status === 'ok' || body?.status === 'email_failed')) {
    const fields = {
      status: (body.signup_status as WaitlistStatus | undefined) ?? null,
      accessGrantedAt: (body.access_granted_at as string | null | undefined) ?? null,
      expiresAt: (body.access_code_expires_at as string | null | undefined) ?? null,
    };
    return body.status === 'ok' ? { kind: 'ok', ...fields } : { kind: 'email_failed', ...fields };
  }
  return { kind: 'error' };
}
