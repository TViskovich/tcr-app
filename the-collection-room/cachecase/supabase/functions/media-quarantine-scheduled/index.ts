// Scheduled media-quarantine worker (Phase 2B M4 step 5A). Server-to-server
// only: called by the database (pg_net kick after a quarantine job commits,
// and the media-quarantine-worker pg_cron sweep) or by an operator.
// Both dispatchers are OFF by default (20261126120000_media_quarantine_
// scheduler.sql); turning them on is a separate, approved step.
//
// POST { trigger?: 'kick' | 'sweep' | 'operator', limit?: 1-5 }   (≤ 1 KB)
//   Authorization: Bearer <MEDIA_QUARANTINE_WORKER_SECRET>
// → { status: 'ok', run_id, processed, outcomes: { <code>: n } }
//   | { status: 'skipped', reason: 'disabled' | 'busy' | 'rate_limited' }
//
// Authorization, in order:
//   1. ONLY MEDIA_QUARANTINE_WORKER_SECRET (≥ 32 characters; otherwise every
//      request is refused), compared in constant time. No Supabase API key or
//      user JWT is accepted, and the secret is accepted by no other function.
//      Gateway JWT verification is off (config.toml): the secret is not a JWT.
//   2. media_quarantine_scheduler_begin() — the database refuses unless the
//      scheduler switch is on, fewer than 2 scheduled runs are active and the
//      per-minute run limit is not exceeded.
// The secret therefore authorizes QUARANTINE processing only: this function
// claims only quarantine work (media_quarantine_claim), runs only
// Worker.quarantine, and the database refuses any scheduler step towards
// restoration. It never restores, purges, resolves reports or suspends.
//
// Every step is recorded as actor_kind 'scheduler' with the run id — no
// administrator id is used or invented. Per invocation: at most 5 jobs,
// ~25 s, and the existing hashing budget. Responses and logs carry outcome
// codes and counts only — never paths, owners, the secret or media.

import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse } from '../_shared/registry-image.ts';
import { tryResolveServiceKey } from '../_shared/service-key.ts';
import { HASH_BUDGET_BYTES, Interrupted, requestFault, Worker, type ClaimedJob, type Outcome } from '../_shared/media-quarantine-worker.ts';

const LEASE_SECONDS = 120;
const TIME_BUDGET_MS = 25_000;
const MAX_JOBS = 5;
const MAX_BODY_BYTES = 1024;
const TRIGGERS = new Set(['kick', 'sweep', 'operator']);

const SECRET = (() => {
  const value = Deno.env.get('MEDIA_QUARANTINE_WORKER_SECRET') ?? '';
  return value.length >= 32 ? value : '';
})();
const SERVICE_KEY = tryResolveServiceKey();
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'media-quarantine-scheduled', ...fields }));

function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// A bearer token of plausible shape, or ''. Never logged.
function bearer(req: Request): string {
  const h = req.headers.get('Authorization') ?? '';
  const m = /^Bearer ([\x21-\x7e]{32,512})$/.exec(h);
  return m ? m[1] : '';
}

async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return new TextDecoder().decode(all);
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
  const limit = body.limit === undefined ? MAX_JOBS : body.limit;
  if (typeof trigger !== 'string' || !TRIGGERS.has(trigger)) return jsonResponse({ status: 'failed', reason: 'invalid_trigger' }, 400);
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_JOBS) {
    return jsonResponse({ status: 'failed', reason: 'invalid_limit' }, 400);
  }
  const url = Deno.env.get('SUPABASE_URL');
  if (!SERVICE_KEY || !url) {
    log({ outcome: 'server_key_unavailable' });
    return jsonResponse({ status: 'failed', reason: 'server_misconfigured' }, 500);
  }
  const client = createClient(url, SERVICE_KEY.key, { auth: { autoRefreshToken: false, persistSession: false } });

  // Second, server-side authorization: switch on, concurrency, rate.
  const begin = await client.rpc('media_quarantine_scheduler_begin', { p_trigger: trigger });
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
  const worker = new Worker(client, null, requestFault(req), LEASE_SECONDS, runId);
  const outcomes: Partial<Record<Outcome, number>> = {};
  let processed = 0;
  let error: string | null = null;
  try {
    while (processed < limit && Date.now() < started + TIME_BUDGET_MS && worker.bytesHashed < HASH_BUDGET_BYTES) {
      const { data: claimed, error: claimError } = await client.rpc('media_quarantine_claim', { p_limit: 1, p_lease_seconds: LEASE_SECONDS });
      if (claimError) {
        error = 'claim_failed';
        break;
      }
      const job = (claimed as ClaimedJob[] | null)?.[0];
      if (!job) break;
      worker.claimed(job);
      processed++;
      let outcome: Outcome;
      try {
        outcome = await worker.quarantine(job);
      } catch (e) {
        if (e instanceof Interrupted) {
          // Local fault injection simulating a crash: stop exactly as a dead
          // worker would — no completion record; the run is reaped as
          // abandoned and the job's lease expires for the next run.
          log({ outcome: 'interrupted', run: runId, job: job.id });
          return jsonResponse({ status: 'interrupted', run_id: runId }, 200);
        }
        outcome = 'interrupted';
        error = 'worker_error';
      }
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      log({ outcome, run: runId, job: job.id });
    }
  } catch {
    error = 'worker_error';
  }
  const ms = Date.now() - started;
  const fin = await client.rpc('media_quarantine_scheduler_finish', {
    p_run_id: runId, p_status: error ? 'failed' : 'completed', p_jobs: processed,
    p_outcomes: outcomes, p_error: error, p_duration_ms: ms,
  });
  if (fin.error) log({ outcome: 'finish_failed', db_code: fin.error.code, run: runId });
  log({ outcome: 'run', run: runId, trigger, processed, ms, error });
  return jsonResponse({ status: error ? 'failed' : 'ok', run_id: runId, processed, outcomes }, 200);
});
