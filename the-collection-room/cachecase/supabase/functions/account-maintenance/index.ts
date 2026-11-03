// Account maintenance worker — Dashboard Milestone 2, Checkpoint 4.
//
// Called every 10 minutes by pg_cron (supabase/migrations/
// 20261106140000_account_maintenance_schedule.sql) and right after a
// collector chooses Delete Now. Each run, within a time budget:
//   1. starts deletion for accounts whose 14-day recovery window has ended
//      (they move to 'deleting' — no cancellation from then on);
//   2. advances deletion jobs it atomically claims (a lease, so concurrent
//      runs never share a job), one stage at a time:
//        queued           → durable manifest of every file to remove
//        cleaning_storage → files removed through the Storage API in
//                           batches; a file counts as removed only once it
//                           is gone from Storage; the manifest is rebuilt
//                           once more to catch late files
//        deleting_account → auth.admin.deleteUser; the database trigger
//                           applies the retention policy in the same
//                           transaction; an already-deleted user counts as
//                           done (safe recovery after an interruption)
//        → completed only after the account is verifiably gone
//      Failures back off (30 s … 1 h); after MAX_FAILURES consecutive
//      failures the job is 'failed' and an alert is logged (admins also
//      see it in the Dashboard).
//   3. expires Download My Data archives and abandoned exports;
//   4. removes files found in a recently completed deletion's folders (an
//      upload that was in flight while the account was deleted);
//   5. deletes job records 30 days after completion and expired username
//      reservations;
//   6. records the run (outcome, duration, controlled error codes) for
//      monitoring (20261108120000_account_deletion_monitoring), after the
//      work; a failure to record never fails the run.
// A deletion waits while one of the collector's Download My Data steps
// still holds its lease (no new step can start once the account is
// deleting), and the manifest is rebuilt once more after the auth user is
// deleted, so no file of theirs can land after the last check unnoticed.
//
// Authorization: the ACCOUNT_MAINTENANCE_SECRET (sent by the scheduler; at
// least 32 characters, otherwise treated as unset) or the service role key.
// Logs never contain emails or usernames.

import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse } from '../_shared/registry-image.ts';

const RUN_BUDGET_MS = 40_000;
const CLAIM_LIMIT = 3;
const LEASE_SECONDS = 120;
const REMOVE_BATCH = 100;
const MAX_FAILURES = 8;
// Every request this worker makes gives up after this long, so a stuck
// dependency (e.g. Storage unavailable) becomes a recorded, retried failure
// well inside the job lease instead of a run that outlives it.
const REQUEST_TIMEOUT_MS = 20_000;

type Job = {
  id: string;
  user_id: string | null;
  mode: string;
  status: 'queued' | 'cleaning_storage' | 'deleting_account' | 'completed' | 'failed';
  runs: number;
  step_failures: number;
  objects_total: number | null;
  objects_deleted: number;
};

const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const client = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }) },
});
const MAINTENANCE_SECRET = (() => {
  const value = Deno.env.get('ACCOUNT_MAINTENANCE_SECRET') ?? '';
  return value.length >= 32 ? value : '';
})();
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'account-maintenance', ...fields }));

class StepError extends Error {}

function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function setJob(id: string, fields: Record<string, unknown>) {
  const { error } = await client.from('account_deletion_jobs').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`job_update_failed: ${error.code}`);
}

async function remaining(jobId: string): Promise<number> {
  const { data, error } = await client.rpc('account_deletion_mark_removed', { p_job_id: jobId });
  if (error) throw new StepError('storage_check_failed');
  return Number(data);
}

// Removes pending manifest files in batches until done or out of time.
async function cleanStorage(job: Job, deadline: number): Promise<boolean> {
  for (;;) {
    if ((await remaining(job.id)) === 0) return true;
    if (Date.now() > deadline) return false;
    const { data: batch, error } = await client.from('account_deletion_storage_queue').select('bucket, path, attempts')
      .eq('job_id', job.id).is('deleted_at', null).order('bucket').order('path').limit(REMOVE_BATCH);
    if (error) throw new StepError('manifest_read_failed');
    const byBucket = new Map<string, string[]>();
    for (const r of (batch ?? []) as { bucket: string; path: string }[]) {
      byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r.path]);
    }
    let failedBucket = false;
    for (const [bucket, paths] of byBucket) {
      const { error: removeError } = await client.storage.from(bucket).remove(paths);
      if (removeError) {
        failedBucket = true;
        for (const path of paths) {
          await client.from('account_deletion_storage_queue')
            .update({ attempts: ((batch ?? []).find((b) => b.path === path)?.attempts ?? 0) + 1, last_error_code: 'remove_failed' })
            .eq('job_id', job.id).eq('bucket', bucket).eq('path', path);
        }
      }
    }
    const left = await remaining(job.id);
    if (left === 0) return true;
    if (failedBucket) throw new StepError('storage_remove_failed');
    // Removed without error but still present: treat as a failure to retry.
    if (left >= (batch ?? []).length && (batch ?? []).length > 0) throw new StepError('storage_remove_ineffective');
  }
}

async function processJob(job: Job, deadline: number): Promise<string> {
  if (!job.user_id) throw new StepError('job_without_user');
  const userId = job.user_id;

  if (job.status === 'queued') {
    // Let an export step that is still running finish first; once the
    // account is deleting no new step can take the lease.
    const { data: busy, error: busyError } = await client.rpc('account_deletion_export_busy', { p_job_id: job.id });
    if (busyError) throw new StepError('export_check_failed');
    if (busy === true) return 'waiting_for_export';
    const { data: total, error } = await client.rpc('account_deletion_build_manifest', { p_job_id: job.id });
    if (error) throw new StepError('manifest_failed');
    await setJob(job.id, { status: 'cleaning_storage' });
    log({ outcome: 'manifest', job_id: job.id, objects: Number(total) });
    job.status = 'cleaning_storage';
  }

  if (job.status === 'cleaning_storage') {
    if (!(await cleanStorage(job, deadline))) return 'storage_in_progress';
    // Catch anything that appeared since the manifest was built.
    const { error } = await client.rpc('account_deletion_build_manifest', { p_job_id: job.id });
    if (error) throw new StepError('manifest_failed');
    if (!(await cleanStorage(job, deadline))) return 'storage_in_progress';
    await setJob(job.id, { status: 'deleting_account' });
    log({ outcome: 'storage_clean', job_id: job.id });
    job.status = 'deleting_account';
  }

  if (job.status === 'deleting_account') {
    const { data: existing } = await client.auth.admin.getUserById(userId);
    if (existing?.user) {
      const { error } = await client.auth.admin.deleteUser(userId);
      if (error) {
        const { data: again } = await client.auth.admin.getUserById(userId);
        if (again?.user) throw new StepError('auth_delete_failed');
      }
    }
    // Verify before reporting success.
    const { data: gone } = await client.auth.admin.getUserById(userId);
    const { count: profiles } = await client.from('profiles').select('id', { count: 'exact', head: true }).eq('id', userId);
    if (gone?.user || (profiles ?? 0) > 0) throw new StepError('verification_failed');
    // Last sweep, now that nothing can write for the account any more.
    const { error: finalError } = await client.rpc('account_deletion_build_manifest', { p_job_id: job.id });
    if (finalError) throw new StepError('manifest_failed');
    if (!(await cleanStorage(job, deadline))) return 'storage_in_progress';
    if ((await remaining(job.id)) !== 0) throw new StepError('verification_failed');
    const now = Date.now();
    await setJob(job.id, {
      status: 'completed', completed_at: new Date(now).toISOString(), purge_after: new Date(now + 30 * 86_400_000).toISOString(),
      lease_until: null, step_failures: 0, last_error_code: null,
    });
    log({ outcome: 'completed', job_id: job.id, mode: job.mode });
    return 'completed';
  }
  return job.status;
}

async function run(onlyJob: string | null) {
  const started = Date.now();
  const deadline = started + RUN_BUDGET_MS;
  const summary: Record<string, unknown> = { started: 0, processed: [] as unknown[] };
  // Infrastructure problems this run hit (per-job failures are tracked on
  // the jobs themselves).
  const runErrors = new Set<string>();
  let jobErrors = 0;

  // Never start destructive work without the username-reservation key.
  const { data: preflight, error: preflightError } = await client.rpc('account_deletion_preflight');
  if (preflightError) runErrors.add('preflight_failed');
  const ready = (preflight as { username_key_configured?: boolean } | null)?.username_key_configured === true;
  summary.ready = ready;
  if (!ready) log({ alert: 'account_deletion_not_configured', reason: 'username_reservation_key_missing' });

  if (ready) {
    const { data: started_count, error } = await client.rpc('account_deletion_enqueue_due', { p_limit: 50 });
    if (error) {
      runErrors.add('enqueue_failed');
      log({ outcome: 'enqueue_failed', db_code: error.code });
    }
    summary.started = Number(started_count ?? 0);

    while (Date.now() < deadline) {
      const { data: claimed, error: claimError } = await client.rpc('account_deletion_claim', { p_limit: CLAIM_LIMIT, p_lease_seconds: LEASE_SECONDS });
      if (claimError) {
        runErrors.add('claim_failed');
        log({ outcome: 'claim_failed', db_code: claimError.code });
        break;
      }
      let jobs = (claimed ?? []) as Job[];
      if (onlyJob) {
        // Release anything else claimed in this run straight back.
        for (const other of jobs.filter((j) => j.id !== onlyJob)) await setJob(other.id, { lease_until: null });
        jobs = jobs.filter((j) => j.id === onlyJob);
      }
      if (jobs.length === 0) break;
      for (const job of jobs) {
        try {
          const outcome = await processJob(job, deadline);
          if (outcome === 'waiting_for_export') {
            // Not a failure: look again shortly, without spinning in this run.
            await setJob(job.id, { lease_until: null, next_attempt_at: new Date(Date.now() + 15_000).toISOString() });
          } else if (outcome !== 'completed') {
            await setJob(job.id, { lease_until: null, step_failures: 0 });
          }
          (summary.processed as unknown[]).push({ job_id: job.id, outcome });
        } catch (e) {
          const code = e instanceof StepError ? e.message : 'unexpected_error';
          jobErrors++;
          const failures = job.step_failures + 1;
          if (failures >= MAX_FAILURES) {
            await setJob(job.id, { status: 'failed', failed_at: new Date().toISOString(), last_error_code: code, step_failures: failures, lease_until: null });
            log({ alert: 'account_deletion_failed', job_id: job.id, code, failures });
          } else {
            const backoffSeconds = Math.min(30 * 2 ** (failures - 1), 3600);
            await setJob(job.id, {
              step_failures: failures, last_error_code: code, lease_until: null,
              next_attempt_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
            });
            log({ outcome: 'retry_scheduled', job_id: job.id, code, failures, backoff_seconds: backoffSeconds });
          }
          (summary.processed as unknown[]).push({ job_id: job.id, outcome: 'error', code });
        }
      }
      if (onlyJob) break;
    }
  }

  // Files that appeared in a completed deletion's folders afterwards.
  if (ready && !onlyJob && Date.now() < deadline) {
    const { data: late, error: lateError } = await client.rpc('account_deletion_late_files', { p_limit: 10 });
    if (lateError) {
      runErrors.add('late_files_check_failed');
      log({ outcome: 'late_files_check_failed', db_code: lateError.code });
    }
    for (const jobId of (late ?? []) as string[]) {
      try {
        const { error } = await client.rpc('account_deletion_build_manifest', { p_job_id: jobId });
        if (error) throw new StepError('manifest_failed');
        const clean = await cleanStorage({ id: jobId } as Job, deadline);
        log({ outcome: clean ? 'late_files_removed' : 'late_files_in_progress', job_id: jobId });
      } catch (e) {
        runErrors.add('late_files_failed');
        log({ alert: 'account_deletion_late_files_failed', job_id: jobId, code: e instanceof StepError ? e.message : 'unexpected_error' });
      }
    }
  }

  // Download My Data: expiry and abandoned jobs.
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/account-export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ action: 'sweep' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    summary.exports = res.ok ? await res.json() : { status: res.status };
    if (!res.ok) runErrors.add('export_sweep_failed');
  } catch {
    summary.exports = { status: 'unreachable' };
    runErrors.add('export_sweep_failed');
    log({ outcome: 'export_sweep_failed' });
  }

  const { data: housekeeping, error: housekeepingError } = await client.rpc('account_deletion_housekeeping');
  if (housekeepingError) runErrors.add('housekeeping_failed');
  summary.housekeeping = housekeeping;
  summary.ms = Date.now() - started;
  log({ outcome: 'run', ...summary, processed: (summary.processed as unknown[]).length });
  // A Delete Now kick-off (onlyJob) is not a maintenance run.
  if (!onlyJob) {
    await recordRun(!ready ? 'not_ready' : runErrors.size ? 'degraded' : 'ok', summary.ms as number,
      (summary.processed as unknown[]).length, jobErrors, [...runErrors]);
  }
  return summary;
}

// Monitoring only: never throws, never delays the next run.
async function recordRun(outcome: 'ok' | 'degraded' | 'not_ready' | 'failed', ms: number, processed: number, errors: number, codes: string[]) {
  try {
    const { error } = await client.rpc('account_maintenance_record_run', {
      p_outcome: outcome, p_duration_ms: ms, p_jobs_processed: processed, p_job_errors: errors, p_error_codes: codes,
    });
    if (error) log({ outcome: 'run_record_failed', db_code: error.code });
  } catch {
    log({ outcome: 'run_record_failed' });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  if (!sameSecret(token, MAINTENANCE_SECRET) && !sameSecret(token, SERVICE_KEY)) {
    return jsonResponse({ status: 'failed', reason: 'forbidden' }, 403);
  }
  let body: { job_id?: unknown } = {};
  try {
    body = await req.json();
  } catch {}
  const onlyJob = typeof body.job_id === 'string' && /^[0-9a-f-]{36}$/.test(body.job_id) ? body.job_id : null;
  try {
    return jsonResponse({ status: 'ok', ...(await run(onlyJob)) }, 200);
  } catch (e) {
    log({ outcome: 'run_failed', error: (e as Error).message.slice(0, 160) });
    if (!onlyJob) await recordRun('failed', 0, 0, 0, ['run_failed']);
    return jsonResponse({ status: 'failed', reason: 'server_error' }, 500);
  }
});
