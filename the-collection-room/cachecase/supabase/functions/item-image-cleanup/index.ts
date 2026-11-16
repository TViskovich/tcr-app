// Scheduled item-images deletion worker (P2.3 Issue 1). Server-to-server only:
// called by the item-image-cleanup pg_cron sweep (private.run_item_image_cleanup)
// or by an operator. Everything is OFF by default (20261204120000_item_image_
// deletion_ledger.sql): the database switch, the cron job and this function's
// secret must all be turned on in a separate, approved step.
//
// POST { trigger?: 'sweep' | 'operator', limit?: 1-50 }   (≤ 1 KB)
//   Authorization: Bearer <ITEM_IMAGE_CLEANUP_WORKER_SECRET>
// → { status: 'ok', run_id, claimed, outcomes: { deleted, retry, failed, stale_claim, complete_failed } }
//   | { status: 'skipped', reason: 'disabled' | 'busy' }
//
// Authorization, in order:
//   1. ONLY ITEM_IMAGE_CLEANUP_WORKER_SECRET (≥ 32 characters; otherwise every
//      request is refused), compared in constant time. No API key or user JWT
//      is accepted. Gateway JWT verification is off (config.toml).
//   2. item_image_cleanup_begin() — refused unless the switch is on and no
//      other run is active.
//
// What is deleted is decided by the DATABASE, never here:
//   * item_image_deletion_claim re-checks each due ledger entry under the
//     per-path lock every new reference takes; referenced, held, moderated,
//     report-evidence and exported objects are kept or deferred there.
//   * withoutHeldPaths is checked again right before removal.
//   * item_image_deletion_complete marks an entry deleted ONLY when the object
//     is really gone from storage.objects; otherwise it is retried, then
//     marked failed — never silently dropped.
//   * Once claimed, an object is CONDEMNED: the database refuses every new
//     reference to it, permanently. So a Storage call that lands late (a
//     stalled request, a timed-out function, an overlapping run) can never
//     remove a live image. The lease/deadline below only bound the work.
// Only the item-images bucket is ever touched. Responses and logs carry counts
// and codes only — never paths, owners or the secret.

import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse } from '../_shared/registry-image.ts';
import { tryResolveServiceKey } from '../_shared/service-key.ts';
import { withoutHeldPaths } from '../_shared/media-holds.ts';
import {
  asCompletionOutcome,
  completionCode,
  LEASE_SECONDS,
  parseFault,
  pastDeadline,
  removablePaths,
  STORAGE_TIMEOUT_MS,
  tally,
  withTimeout,
  type ClaimedDeletion,
  type CompletionOutcome,
} from '../_shared/item-image-cleanup.ts';

const BUCKET = 'item-images';
const TIME_BUDGET_MS = 25_000;
const BATCH = 25;
const MAX_LIMIT = 50;
const MAX_BODY_BYTES = 1024;
const TRIGGERS = new Set(['sweep', 'operator']);

const SECRET = (() => {
  const value = Deno.env.get('ITEM_IMAGE_CLEANUP_WORKER_SECRET') ?? '';
  return value.length >= 32 ? value : '';
})();
const SERVICE_KEY = tryResolveServiceKey();
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'item-image-cleanup', ...fields }));

function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function bearer(req: Request): string {
  const h = req.headers.get('Authorization') ?? '';
  const m = /^Bearer ([\x21-\x7e]{32,512})$/.exec(h);
  return m ? m[1] : '';
}

async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return null;
  const text = await req.text();
  return new TextEncoder().encode(text).length > MAX_BODY_BYTES ? null : text;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);
  if (!SECRET) {
    log({ outcome: 'not_configured' });
    return jsonResponse({ status: 'failed', reason: 'not_configured' }, 503);
  }
  if (!sameSecret(bearer(req), SECRET)) {
    log({ outcome: 'unauthorized' });
    return jsonResponse({ status: 'failed', reason: 'unauthorized' }, 401);
  }
  const text = await readBody(req);
  if (text === null) return jsonResponse({ status: 'failed', reason: 'payload_too_large' }, 413);
  let body: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
    }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)
      || Object.keys(body).some((k) => k !== 'trigger' && k !== 'limit')) {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }
  const trigger = body.trigger === undefined ? 'operator' : body.trigger;
  const limit = body.limit === undefined ? MAX_LIMIT : body.limit;
  if (typeof trigger !== 'string' || !TRIGGERS.has(trigger)) return jsonResponse({ status: 'failed', reason: 'invalid_trigger' }, 400);
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return jsonResponse({ status: 'failed', reason: 'invalid_limit' }, 400);
  }
  const url = Deno.env.get('SUPABASE_URL');
  if (!SERVICE_KEY || !url) {
    log({ outcome: 'server_key_unavailable' });
    return jsonResponse({ status: 'failed', reason: 'server_misconfigured' }, 500);
  }
  const client = createClient(url, SERVICE_KEY.key, { auth: { autoRefreshToken: false, persistSession: false } });

  const begin = await client.rpc('item_image_cleanup_begin', { p_trigger: trigger });
  if (begin.error) {
    log({ outcome: 'begin_failed', db_code: begin.error.code });
    return jsonResponse({ status: 'failed', reason: 'begin_failed' }, 500);
  }
  const b = begin.data as { ok: boolean; reason?: string; run_id?: string };
  if (!b.ok || !b.run_id) {
    log({ outcome: 'skipped', reason: b.reason, trigger });
    return jsonResponse({ status: 'skipped', reason: b.reason ?? 'refused' }, 200);
  }
  const runId = b.run_id;
  const started = Date.now();
  const fault = parseFault(req.headers.get('x-cachecase-local-fault'), url, Deno.env.get('CACHECASE_TEST_IIC_FAULTS'));
  const outcomes: Partial<Record<CompletionOutcome, number>> = {};
  let claimedTotal = 0;
  let error: string | null = null;

  try {
    while (claimedTotal < limit && Date.now() < started + TIME_BUDGET_MS) {
      const { data, error: claimError } = await client.rpc('item_image_deletion_claim', {
        p_limit: Math.min(BATCH, limit - claimedTotal),
        p_lease_seconds: LEASE_SECONDS,
      });
      if (claimError) {
        error = 'claim_failed';
        log({ outcome: 'claim_failed', db_code: claimError.code, run: runId });
        break;
      }
      const claims = (data ?? []) as ClaimedDeletion[];
      if (!claims.length) break;
      claimedTotal += claims.length;
      const claimedAt = Date.now();

      // Re-check moderation holds right before removal; a failed check removes nothing.
      const notHeld = await withoutHeldPaths(client, BUCKET, claims.map((c) => c.path));
      const deadlinePassed = fault === 'deadline_exceeded' || pastDeadline(claimedAt, Date.now());
      const toRemove = deadlinePassed ? [] : removablePaths(claims, notHeld);
      let storageFailed = false;
      if (toRemove.length) {
        if (fault === 'storage_error') {
          storageFailed = true;
        } else {
          const res = await withTimeout(client.storage.from(BUCKET).remove(toRemove), STORAGE_TIMEOUT_MS);
          if (res.timedOut || res.value.error) storageFailed = true;
        }
        if (storageFailed) log({ outcome: 'storage_error', run: runId, batch: toRemove.length });
      }
      if (fault === 'crash_after_remove') {
        // Local fault injection simulating a worker that dies after removing:
        // no completion — the run is reaped as abandoned and the lease expires.
        log({ outcome: 'interrupted', run: runId });
        return jsonResponse({ status: 'interrupted', run_id: runId }, 200);
      }

      for (const claim of claims) {
        const code = completionCode(claim, notHeld, toRemove, storageFailed, deadlinePassed);
        const { data: result, error: completeError } = await client.rpc('item_image_deletion_complete', {
          p_id: claim.id,
          p_claim_token: claim.claim_token,
          p_error_code: code,
        });
        if (completeError) {
          // The claim's lease expires and the entry is re-claimed later.
          log({ outcome: 'complete_failed', db_code: completeError.code, run: runId });
          tally(outcomes, 'complete_failed');
          error = error ?? 'complete_failed';
          continue;
        }
        tally(outcomes, asCompletionOutcome(result));
      }
    }
  } catch {
    error = 'worker_error';
  }

  const ms = Date.now() - started;
  const fin = await client.rpc('item_image_cleanup_finish', {
    p_run_id: runId, p_status: error ? 'failed' : 'completed', p_claimed: claimedTotal,
    p_outcomes: outcomes, p_error: error, p_duration_ms: ms,
  });
  if (fin.error) log({ outcome: 'finish_failed', db_code: fin.error.code, run: runId });
  log({ outcome: 'run', run: runId, trigger, claimed: claimedTotal, outcomes, ms, error });
  return jsonResponse({ status: error ? 'failed' : 'ok', run_id: runId, claimed: claimedTotal, outcomes }, 200);
});
