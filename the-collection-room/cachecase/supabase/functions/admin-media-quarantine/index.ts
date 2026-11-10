// Runs queued media-quarantine jobs (Phase 2B M2.3c). Admin only.
//
// POST { limit?: 1-10 }   Authorization: Bearer <admin user JWT>
// → { status: 'ok', results: [{ id, outcome }] }   (job ids and outcome codes only)
//
// The caller is authenticated (requireAdmin) and then re-authorized by the
// database (media_quarantine_authorize: admin membership AND account
// lifecycle). Jobs come only from the database queue — this function accepts
// no path, bucket or job id — and are claimed one at a time under a lease
// (media_quarantine_claim), so concurrent runs never work on the same job and
// an expired lease is simply picked up again from the recorded state. Each run
// is bounded by `limit` and a time budget well inside the Edge runtime limit.
// See ../_shared/media-quarantine-worker.ts for the per-job guarantees.
//
// Deploy with gateway JWT verification (the default). Not scheduled: a
// production scheduler is a separate, approved change.

import { requireAdmin } from '../_shared/admin-auth.ts';
import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';
import { Interrupted, requestFault, Worker, type ClaimedJob, type Outcome } from '../_shared/media-quarantine-worker.ts';

const LEASE_SECONDS = 120;
const TIME_BUDGET_MS = 25_000;

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);

  let body: { limit?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }
  const limit = body.limit === undefined ? 5 : body.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    return jsonResponse({ status: 'failed', reason: 'invalid_limit' }, 400);
  }

  const client = serviceRoleClient();
  const admin = await requireAdmin(client, req, 'admin-media-quarantine');
  if (!admin.ok) return admin.response;
  const { data: auth, error: authError } = await client.rpc('media_quarantine_authorize', { p_admin: admin.userId, p_action: 'quarantine' });
  if (authError || !auth?.ok) return jsonResponse({ status: 'failed', reason: 'forbidden' }, 403);

  const worker = new Worker(client, admin.userId, requestFault(req));
  const deadline = Date.now() + TIME_BUDGET_MS;
  const results: { id: string; outcome: Outcome }[] = [];
  while (results.length < limit && Date.now() < deadline) {
    const { data: claimed, error } = await client.rpc('media_quarantine_claim', { p_limit: 1, p_lease_seconds: LEASE_SECONDS });
    if (error) return jsonResponse({ status: 'failed', reason: 'claim_failed', results }, 200);
    const job = (claimed as ClaimedJob[] | null)?.[0];
    if (!job) break;
    let outcome: Outcome;
    try {
      outcome = await worker.quarantine(job);
    } catch (e) {
      // An interruption leaves the job leased in its recorded state; the
      // lease expires and the next run resumes it.
      outcome = 'interrupted';
      if (!(e instanceof Interrupted)) console.error(JSON.stringify({ fn: 'admin-media-quarantine', job: job.id, outcome, error: 'unexpected' }));
    }
    results.push({ id: job.id, outcome });
  }
  console.log(JSON.stringify({ fn: 'admin-media-quarantine', admin: admin.userId, processed: results.length }));
  return jsonResponse({ status: 'ok', results }, 200);
});
