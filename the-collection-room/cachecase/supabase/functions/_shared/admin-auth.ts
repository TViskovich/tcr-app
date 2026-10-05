// Admin authorization for Edge Functions. An admin is an authenticated user
// with a row in public.admin_users (migration 20261007120000). Clients can
// only read their own row there and can never write it, so membership is
// managed exclusively from the SQL editor.
//
// Every admin-only function calls requireAdmin() before doing anything else.
// Deploy those functions WITH gateway JWT verification (the default) — that
// is a first filter only; this check is what actually authorizes.
//
// Never logs the token. Only the caller's user id and the outcome are logged,
// and a non-admin learns nothing beyond "forbidden".

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, resolveCaller } from './registry-image.ts';

export type AdminCheck =
  | { ok: true; userId: string }
  | { ok: false; response: Response };

export async function requireAdmin(client: SupabaseClient, req: Request, fn: string): Promise<AdminCheck> {
  const caller = await resolveCaller(client, req);
  if (!caller.userId) {
    console.log(JSON.stringify({ fn, outcome: 'unauthorized' }));
    return { ok: false, response: jsonResponse({ status: 'failed', reason: 'unauthorized' }, 401) };
  }

  const { data, error } = await client
    .from('admin_users')
    .select('user_id')
    .eq('user_id', caller.userId)
    .maybeSingle();
  if (error) {
    // Fail closed — a lookup error is never treated as membership.
    console.log(JSON.stringify({ fn, outcome: 'admin_check_failed', user_id: caller.userId, db_code: error.code }));
    return { ok: false, response: jsonResponse({ status: 'failed', reason: 'forbidden' }, 403) };
  }
  if (!data) {
    console.log(JSON.stringify({ fn, outcome: 'forbidden', user_id: caller.userId }));
    return { ok: false, response: jsonResponse({ status: 'failed', reason: 'forbidden' }, 403) };
  }

  return { ok: true, userId: caller.userId };
}
