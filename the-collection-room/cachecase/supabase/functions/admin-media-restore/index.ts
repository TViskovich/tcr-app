// Restores quarantined media to its original path (Phase 2B M2.3c). Admin
// only, and never automatic.
//
// POST { job_ids: string[1-10], confirm_child_safety?: boolean }
//   Authorization: Bearer <admin user JWT>
// → { status: 'ok', results: [{ id, outcome, reason? }] }  (codes only)
//
// A job is restorable only when the database agrees
// (media_quarantine_authorize): every hold on it ended with "restore" through
// an audited admin decision (content restored, profile field restored), it is
// awaiting restoration, it isn't flagged, and its owner's account still exists
// and isn't pending deletion. Child-safety media additionally needs
// confirm_child_safety from an admin who imposed none of its restrictions.
// The destination must be empty (nothing is ever overwritten) and the bytes
// written back must hash to the verified original before the job is marked
// restored. The private copy is kept (no purge here; retention is M4).
// Concurrent requests for the same job are serialized by its lease.

import { requireAdmin } from '../_shared/admin-auth.ts';
import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';
import { Interrupted, requestFault, Worker, type ClaimedJob, type Outcome } from '../_shared/media-quarantine-worker.ts';

const LEASE_SECONDS = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);

  let body: { job_ids?: unknown; confirm_child_safety?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }
  const ids = body.job_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || !ids.every((x): x is string => typeof x === 'string' && UUID_RE.test(x))
      || new Set(ids).size !== ids.length) {
    return jsonResponse({ status: 'failed', reason: 'invalid_job_ids' }, 400);
  }
  if (body.confirm_child_safety !== undefined && typeof body.confirm_child_safety !== 'boolean') {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }

  const client = serviceRoleClient();
  const admin = await requireAdmin(client, req, 'admin-media-restore');
  if (!admin.ok) return admin.response;
  const { data: auth, error: authError } = await client.rpc('media_quarantine_authorize', {
    p_admin: admin.userId, p_action: 'restore', p_job_ids: ids, p_confirm_child_safety: body.confirm_child_safety === true,
  });
  if (authError || !auth?.ok) return jsonResponse({ status: 'failed', reason: 'forbidden' }, 403);

  const decisions = (auth.jobs ?? []) as { id: string; allowed: boolean; reason: string | null }[];
  const results: { id: string; outcome: Outcome | 'refused' | 'busy'; reason?: string }[] = decisions
    .filter((d) => !d.allowed).map((d) => ({ id: d.id, outcome: 'refused', reason: d.reason ?? 'not_restorable' }));
  const allowed = decisions.filter((d) => d.allowed).map((d) => d.id);
  if (allowed.length) {
    const { data: claimed, error } = await client.rpc('media_quarantine_claim_restore', { p_job_ids: allowed, p_lease_seconds: LEASE_SECONDS });
    if (error) return jsonResponse({ status: 'failed', reason: 'claim_failed' }, 200);
    const jobs = (claimed ?? []) as ClaimedJob[];
    const worker = new Worker(client, admin.userId, requestFault(req));
    for (const id of allowed) {
      const job = jobs.find((j) => j.id === id);
      if (!job) {
        results.push({ id, outcome: 'busy' }); // another request holds its lease
        continue;
      }
      let outcome: Outcome;
      try {
        outcome = await worker.restore(job);
      } catch (e) {
        outcome = 'interrupted';
        if (!(e instanceof Interrupted)) console.error(JSON.stringify({ fn: 'admin-media-restore', job: id, outcome, error: 'unexpected' }));
      }
      results.push({ id, outcome });
    }
  }
  console.log(JSON.stringify({ fn: 'admin-media-restore', admin: admin.userId, requested: ids.length }));
  return jsonResponse({ status: 'ok', results }, 200);
});
