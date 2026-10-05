// CacheCase waitlist admin — read path for the in-app admin screen
// (app/admin/waitlist.tsx). waitlist_signups has no client read access at
// all (RLS on, zero policies, anon/authenticated grants revoked), so this
// service-role function is the only way the app can see it.
//
// SECURITY — same model as grant-waitlist-access: deployed WITH gateway JWT
// verification (the default), then requireAdmin (../_shared/admin-auth.ts)
// requires the caller to have a row in public.admin_users.
//
// Request:  POST {}   (no parameters — the app filters/searches locally)
// Response: 200 { status: 'ok', signups: Signup[] }   newest first
//           401 unauthorized · 403 forbidden · 405 method_not_allowed · 500 list_failed
//
// Explicit column list: access_code (the invite-code hash) and
// onboarded_user_id are never returned.

import { requireAdmin } from '../_shared/admin-auth.ts';
import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';

const COLUMNS =
  'id, name, email, reserved_username, status, created_at, access_granted_at, access_code_expires_at, onboarded_at';

// Generous ceiling for a beta waitlist; raise (or paginate) if it's ever hit.
const MAX_ROWS = 5000;

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') {
    return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);
  }

  const client = serviceRoleClient();
  const admin = await requireAdmin(client, req, 'list-waitlist-signups');
  if (!admin.ok) return admin.response;

  const { data, error } = await client
    .from('waitlist_signups')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);
  if (error) {
    console.log(JSON.stringify({ fn: 'list-waitlist-signups', outcome: 'list_failed', db_code: error.code }));
    return jsonResponse({ status: 'failed', reason: 'list_failed' }, 500);
  }

  console.log(JSON.stringify({ fn: 'list-waitlist-signups', outcome: 'ok', admin_user_id: admin.userId, count: data.length }));
  return jsonResponse({ status: 'ok', signups: data }, 200);
});
