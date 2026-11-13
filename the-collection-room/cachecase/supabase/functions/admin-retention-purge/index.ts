// Executes an APPROVED retention purge run of quarantine copies (Phase 2B M4
// step 4B). Admin only; manual only; never scheduled.
//
// POST { run_id: uuid, limit?: 1-10 }   Authorization: Bearer <admin user JWT>
// → { status: 'ok', results: [{ item_id, outcome }] }   (ids and outcome codes only)
//
// Every decision is the database's, made under the caller's own identity
// (auth.uid()): the run must be approved by a second admin, still inside its
// execution window, and the caller must not be the admin who prepared it.
//   1. admin_retention_reconcile_run settles anything left in flight.
//   2. admin_retention_claim_copy re-checks the next item and returns the
//      exact bucket/path FROM THE JOB RECORD (this function accepts no path),
//      under a two-admin claim with a short lease.
//   3. The Storage API deletes exactly that one object with the service role,
//      through its single-object route (20261129120000):
//        DELETE /storage/v1/object/moderation-quarantine/q/<uuid>/original
//      (not the batch route, which can drop per-key backend errors). The
//      database's Storage guard re-checks the claim, child safety, holds and
//      job state inside that delete and refuses anything else. Then a fresh
//      read of the same object checks it is unavailable through the API.
//   4. admin_retention_confirm_copy records the API outcome as evidence and
//      completes the item only if the object's metadata is gone AND the guard
//      consumed the claim; otherwise the item is retried (bounded) or flagged
//      for manual investigation. A successful HTTP response is never taken as
//      proof of erasure, and physical erasure is never claimed.
// A crash between 3 and 4 is settled by step 1 of the next run.
//
// Deploy with gateway JWT verification (the default).

import { createClient } from 'npm:@supabase/supabase-js@2';

import { requireAdmin } from '../_shared/admin-auth.ts';
import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';
import { storageAuthHeaders, tryResolveServiceKey, type ServiceKey } from '../_shared/service-key.ts';

const TIME_BUDGET_MS = 25_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH = /^q\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/original$/;
const BUCKET = 'moderation-quarantine';
const STORAGE_TIMEOUT_MS = 15_000;

// ── Local-only fault injection (tests) ──────────────────────────────────────
// Honoured ONLY against a local stack AND with the local flag set.
const LOCAL_HOSTS = ['kong', 'localhost', '127.0.0.1', 'host.docker.internal'];
// storage_error / storage_500 / storage_timeout: the delete is NOT sent and the
// call reports that failure. storage_timeout_after_delete: sent, but the
// response is "lost" (reported as a timeout). storage_noop: NOT sent, yet
// reported as accepted (a success that deleted nothing).
const FAULTS = new Set(['storage_error', 'storage_500', 'storage_timeout', 'storage_timeout_after_delete', 'storage_noop',
                        'crash_after_delete', 'crash_before_delete']);
function requestFault(req: Request): string | null {
  const url = Deno.env.get('SUPABASE_URL');
  let local = false;
  try {
    const host = new URL(url ?? '').hostname;
    local = LOCAL_HOSTS.includes(host) || /^supabase_kong_[a-z0-9_-]+$/.test(host);
  } catch {
    local = false;
  }
  if (!local || Deno.env.get('CACHECASE_TEST_RP_FAULTS') !== '1') return null;
  const f = req.headers.get('x-cachecase-local-fault');
  return f && FAULTS.has(f) ? f : null;
}

type ApiOutcome = 'accepted' | 'not_found' | 'refused' | 'http_error' | 'timeout' | 'unreachable' | 'unexpected';
type Unavailable = 'not_found' | 'still_readable' | 'error' | 'not_checked';
const objectUrl = (base: string, kind: '' | 'authenticated/', path: string) =>
  `${base.replace(/\/$/, '')}/storage/v1/object/${kind}${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;

// Storage error bodies carry their own statusCode (e.g. "404" with HTTP 400).
async function bodyStatus(res: Response): Promise<string> {
  try {
    const j = await res.json() as { statusCode?: unknown; error?: unknown };
    return String(j?.statusCode ?? '');
  } catch {
    return '';
  }
}

// One exact object, through the single-object route. Every outcome is
// explicit; only the database decides what it means.
async function deleteOne(base: string, key: ServiceKey, path: string): Promise<ApiOutcome> {
  let res: Response;
  try {
    res = await fetch(objectUrl(base, '', path), {
      method: 'DELETE', headers: storageAuthHeaders(key), redirect: 'manual', signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
  } catch (e) {
    return (e as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable';
  }
  if (res.status === 200 || res.status === 204) {
    await res.body?.cancel();
    return 'accepted';
  }
  const code = await bodyStatus(res);
  if (res.status === 404 || code === '404') return 'not_found';
  if (res.status === 403 || code === '403') return 'refused';
  if (res.status >= 400) return 'http_error';
  return 'unexpected';   // e.g. a redirect or another 2xx/3xx
}

// After an accepted delete: the same object must no longer be readable
// through the API (this checks availability, not physical erasure).
async function checkUnavailable(base: string, key: ServiceKey, path: string): Promise<Unavailable> {
  try {
    const res = await fetch(objectUrl(base, 'authenticated/', path), {
      method: 'GET', headers: storageAuthHeaders(key), redirect: 'manual', signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (res.ok) {
      await res.body?.cancel();
      return 'still_readable';
    }
    const code = await bodyStatus(res);
    return res.status === 404 || code === '404' ? 'not_found' : 'error';
  } catch {
    return 'error';
  }
}

type Claimed = { item_id?: string; outcome?: string; bucket?: string; path?: string; done?: boolean };

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);

  let body: { run_id?: unknown; limit?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }
  const runId = body.run_id;
  const limit = body.limit === undefined ? 5 : body.limit;
  if (typeof runId !== 'string' || !UUID.test(runId)) return jsonResponse({ status: 'failed', reason: 'invalid_run' }, 400);
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    return jsonResponse({ status: 'failed', reason: 'invalid_limit' }, 400);
  }

  const service = serviceRoleClient();
  const admin = await requireAdmin(service, req, 'admin-retention-purge');
  if (!admin.ok) return admin.response;
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = tryResolveServiceKey();
  if (!url || !serviceKey) return jsonResponse({ status: 'failed', reason: 'server_misconfigured' }, 500);
  // The caller's own session: every RPC below is authorised by auth.uid().
  const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const fault = requestFault(req);

  const reconcile = await caller.rpc('admin_retention_reconcile_run', { p_run_id: runId });
  if (reconcile.error) return jsonResponse({ status: 'failed', reason: reconcile.error.message }, 409);

  const results: { item_id: string; outcome: string }[] = [];
  const deadline = Date.now() + TIME_BUDGET_MS;
  while (results.length < limit && Date.now() < deadline) {
    const { data, error } = await caller.rpc('admin_retention_claim_copy', { p_run_id: runId });
    if (error) return jsonResponse({ status: 'failed', reason: error.message, results }, 409);
    const claimed = data as Claimed;
    if (claimed.done) break;
    if (!claimed.item_id) break;
    if (claimed.outcome !== 'claimed') {
      results.push({ item_id: claimed.item_id, outcome: claimed.outcome ?? 'unknown' });
      continue;
    }
    // Defence in depth: the database chose the object; refuse anything that
    // is not exactly one private quarantine copy.
    if (claimed.bucket !== BUCKET || !claimed.path || !PATH.test(claimed.path)) {
      await caller.rpc('admin_retention_confirm_copy', {
        p_run_id: runId, p_item_id: claimed.item_id, p_storage_error: 'unexpected_target', p_result: { api: 'unknown', unavailable: 'not_checked' },
      });
      results.push({ item_id: claimed.item_id, outcome: 'refused_unexpected_target' });
      continue;
    }
    if (fault === 'crash_before_delete') {
      return jsonResponse({ status: 'interrupted', results }, 200);
    }
    let api: ApiOutcome;
    if (fault === 'storage_error') api = 'unreachable';
    else if (fault === 'storage_500') api = 'http_error';
    else if (fault === 'storage_timeout') api = 'timeout';
    else if (fault === 'storage_noop') api = 'accepted';
    else {
      api = await deleteOne(url, serviceKey, claimed.path);
      if (fault === 'storage_timeout_after_delete') api = 'timeout';
    }
    if (fault === 'crash_after_delete') {
      return jsonResponse({ status: 'interrupted', results }, 200);
    }
    const unavailable: Unavailable = api === 'accepted' && fault !== 'storage_noop' ? await checkUnavailable(url, serviceKey, claimed.path) : 'not_checked';
    const storageError = api === 'accepted' ? null : `storage_${api}`;
    const confirm = await caller.rpc('admin_retention_confirm_copy', {
      p_run_id: runId, p_item_id: claimed.item_id, p_storage_error: storageError, p_result: { api, unavailable },
    });
    const outcome = confirm.error ? 'confirm_failed' : String((confirm.data as { outcome?: string })?.outcome ?? 'unknown');
    console.log(JSON.stringify({ fn: 'admin-retention-purge', run: runId, item: claimed.item_id, outcome, api, unavailable }));
    results.push({ item_id: claimed.item_id, outcome });
    if (storageError) break;   // don't hammer a failing Storage API; the claim lease will expire
  }
  console.log(JSON.stringify({ fn: 'admin-retention-purge', admin: admin.userId, run: runId, processed: results.length }));
  return jsonResponse({ status: 'ok', results }, 200);
});
