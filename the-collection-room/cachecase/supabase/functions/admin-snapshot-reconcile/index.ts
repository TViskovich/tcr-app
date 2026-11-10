// Manual reconciliation of abandoned and unreferenced share-snapshot copies
// (Phase 2B M2.3d). Admin only; never scheduled.
//
// POST { dry_run?: boolean (default true), grace_hours?: >= 24 (default 168),
//        limit?: 1-50 (default 20) }
//   Authorization: Bearer <admin user JWT>
// dry run → { status: 'ok', dry_run: true, candidates: { <reason>: n }, unledgered_orphans: n }
// run     → { status: 'ok', dry_run: false, results: [{ id, reason, outcome }] }
//           (ledger ids and codes only — never paths)
//
// Acts only on copies the M2.3a ledger proves an operation created
// (private.share_snapshot_copies), older than the grace period:
//   abandoned / rejected / discarded  — never became (or stopped being) a post's image
//   unreferenced                      — published, but no row links to it
//   staging                           — a post-photo staging source left "deleting"
// Each candidate is re-checked by the database under the same per-path lock
// every new reference takes, claimed (discarded: no new reference can attach),
// and only then are its own recorded objects removed. Held files are never
// eligible, and the database refuses to delete a held object anyway. Older
// share-snapshots objects outside the ledger are only counted, for an
// operator to review — never deleted.

import { requireAdmin } from '../_shared/admin-auth.ts';
import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);

  let body: { dry_run?: unknown; grace_hours?: unknown; limit?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }
  const dryRun = body.dry_run === undefined ? true : body.dry_run;
  const grace = body.grace_hours === undefined ? 168 : body.grace_hours;
  const limit = body.limit === undefined ? 20 : body.limit;
  if (typeof dryRun !== 'boolean' || typeof grace !== 'number' || !Number.isInteger(grace) || grace < 24 || grace > 24 * 365
      || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    return jsonResponse({ status: 'failed', reason: 'invalid_arguments' }, 400);
  }

  const client = serviceRoleClient();
  const admin = await requireAdmin(client, req, 'admin-snapshot-reconcile');
  if (!admin.ok) return admin.response;
  const { data: auth, error: authError } = await client.rpc('media_quarantine_authorize', { p_admin: admin.userId, p_action: 'quarantine' });
  if (authError || !auth?.ok) return jsonResponse({ status: 'failed', reason: 'forbidden' }, 403);

  const { data: candidates, error } = await client.rpc('share_snapshot_reconcile_candidates', { p_grace_hours: grace, p_limit: limit });
  if (error) return jsonResponse({ status: 'failed', reason: 'lookup_failed' }, 200);
  const rows = (candidates ?? []) as { copy_id: string; reason: string }[];

  if (dryRun) {
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
    const { data: orphans } = await client.rpc('share_snapshot_unledgered_orphans', { p_grace_hours: grace });
    console.log(JSON.stringify({ fn: 'admin-snapshot-reconcile', admin: admin.userId, dry_run: true, candidates: rows.length }));
    return jsonResponse({ status: 'ok', dry_run: true, candidates: counts, unledgered_orphans: orphans ?? null }, 200);
  }

  const results: { id: string; reason: string; outcome: string }[] = [];
  for (const r of rows) {
    const { data: claim, error: claimError } = await client.rpc('share_snapshot_reconcile_claim', { p_copy_id: r.copy_id, p_grace_hours: grace });
    if (claimError || !claim?.ok) {
      results.push({ id: r.copy_id, reason: r.reason, outcome: claimError ? 'claim_failed' : `skipped_${claim?.reason ?? 'unknown'}` });
      continue;
    }
    const { error: removeError } = await client.storage.from(claim.bucket as string).remove(claim.paths as string[]);
    if (removeError) {
      // Left claimed ("discarded"): the next run retries the removal.
      results.push({ id: r.copy_id, reason: claim.reason, outcome: 'remove_failed' });
      continue;
    }
    const mark = claim.reason === 'staging'
      ? await client.rpc('share_snapshot_copy_source_removed', { p_copy_id: r.copy_id })
      : await client.rpc('share_snapshot_copy_removed', { p_copy_ids: [r.copy_id] });
    results.push({ id: r.copy_id, reason: claim.reason, outcome: mark.error ? 'mark_failed' : 'removed' });
  }
  console.log(JSON.stringify({ fn: 'admin-snapshot-reconcile', admin: admin.userId, dry_run: false, processed: results.length,
    removed: results.filter((x) => x.outcome === 'removed').length }));
  return jsonResponse({ status: 'ok', dry_run: false, results }, 200);
});
