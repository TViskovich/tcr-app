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
//   3. The Storage API deletes exactly that one object with the service role;
//      the database's Storage guard re-checks the claim, child safety, holds
//      and job state inside that delete and refuses anything else.
//   4. admin_retention_confirm_copy records completion only if the object is
//      gone AND the guard consumed the claim; otherwise the item is retried
//      (bounded) or flagged for manual investigation.
// A crash between 3 and 4 is settled by step 1 of the next run.
//
// Deploy with gateway JWT verification (the default).

import { createClient } from 'npm:@supabase/supabase-js@2';

import { requireAdmin } from '../_shared/admin-auth.ts';
import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';

const TIME_BUDGET_MS = 25_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH = /^q\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/original$/;

// ── Local-only fault injection (tests) ──────────────────────────────────────
// Honoured ONLY against a local stack AND with the local flag set.
const LOCAL_HOSTS = ['kong', 'localhost', '127.0.0.1', 'host.docker.internal'];
const FAULTS = new Set(['storage_error', 'crash_after_delete', 'crash_before_delete']);
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
    if (claimed.bucket !== 'moderation-quarantine' || !claimed.path || !PATH.test(claimed.path)) {
      await caller.rpc('admin_retention_confirm_copy', { p_run_id: runId, p_item_id: claimed.item_id, p_storage_error: 'unexpected_target' });
      results.push({ item_id: claimed.item_id, outcome: 'refused_unexpected_target' });
      continue;
    }
    if (fault === 'crash_before_delete') {
      return jsonResponse({ status: 'interrupted', results }, 200);
    }
    let storageError: string | null = null;
    if (fault === 'storage_error') {
      storageError = 'storage_unavailable';
    } else {
      const { error: removeError } = await service.storage.from('moderation-quarantine').remove([claimed.path]);
      if (removeError) storageError = 'storage_delete_failed';
    }
    if (fault === 'crash_after_delete') {
      return jsonResponse({ status: 'interrupted', results }, 200);
    }
    const confirm = await caller.rpc('admin_retention_confirm_copy', {
      p_run_id: runId, p_item_id: claimed.item_id, p_storage_error: storageError,
    });
    const outcome = confirm.error ? 'confirm_failed' : String((confirm.data as { outcome?: string })?.outcome ?? 'unknown');
    console.log(JSON.stringify({ fn: 'admin-retention-purge', run: runId, item: claimed.item_id, outcome, storage_error: storageError }));
    results.push({ item_id: claimed.item_id, outcome });
    if (storageError) break;   // don't hammer a failing Storage API; the claim lease will expire
  }
  console.log(JSON.stringify({ fn: 'admin-retention-purge', admin: admin.userId, run: runId, processed: results.length }));
  return jsonResponse({ status: 'ok', results }, 200);
});
