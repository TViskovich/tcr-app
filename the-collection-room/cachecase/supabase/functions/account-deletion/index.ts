// Account deletion — Dashboard Milestone 2, Checkpoints 2 and 4.
//
//   POST { action: 'status' }
//   POST { action: 'schedule', confirmation: 'DELETE' }     14-day recovery window
//   POST { action: 'cancel' }
//   POST { action: 'delete_now', confirmation: 'DELETE' }   permanent, no recovery window
//   POST { action: 'job_status', job_id }                   after the account is gone
//
// The collector is ALWAYS the owner of the verified access token — no user
// id is ever read from the request. State changes go through the
// server-only transition functions from
// supabase/migrations/20261103120000_add_account_lifecycle.sql, which
// enforce the allowed transitions themselves (a deletion in progress can
// never be cancelled).
//
// schedule: needs a password sign-in within the last 10 minutes
//   (_shared/recent-auth.ts) and the typed confirmation word.
//   Repeating it is safe: an account that's already pending gets its
//   existing date back. After scheduling, every OTHER session of the
//   collector is signed out; the calling session stays so recovery remains
//   possible (and any session can sign in again to recover).
// cancel: any valid session of the collector — no password prompt. Safe to
//   repeat (an active account reports restored: false).
// status: the collector's own state and exact scheduled time; while the
//   account is being deleted, the deletion job's progress; and whether
//   Delete Now is available (the deletion worker is configured).
// delete_now: recent sign-in + the typed word; refused when the deletion
//   worker or its scheduler isn't configured and active, so an account is never left in 'deleting' with
//   nothing to finish it. Moves the account to 'deleting' (cancellation
//   impossible from then on), queues the job and asks the worker to start.
//   Repeating it returns the same job.
// job_status: { state: in_progress | completed | failed } for a job id the
//   app received — the only way to confirm completion once the account (and
//   its session) no longer exist. Reveals nothing else.
//
// Responses are { status: 'ok', … } or { status: 'failed', reason } with a
// controlled reason — never a raw database or auth error.

import {
  handleCorsPreflight,
  jsonResponse,
  serviceRoleClient,
} from '../_shared/registry-image.ts';
import { signedInRecently } from '../_shared/recent-auth.ts';

const CONFIRMATION_WORD = 'DELETE';
const RECOVERY_DAYS = 14;
// At least 32 characters, otherwise treated as unset (Delete Now unavailable).
const MAINTENANCE_SECRET = (() => {
  const value = Deno.env.get('ACCOUNT_MAINTENANCE_SECRET') ?? '';
  return value.length >= 32 ? value : '';
})();
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const KICK_AFTER_MS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type JobRow = { id: string; status: string; objects_total: number | null; objects_deleted: number; updated_at: string };

// Asks the maintenance worker to process one job now, without waiting.
function kickWorker(jobId: string) {
  if (!MAINTENANCE_SECRET) return;
  const call = fetch(`${SUPABASE_URL}/functions/v1/account-maintenance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MAINTENANCE_SECRET}` },
    body: JSON.stringify({ job_id: jobId }),
  }).catch(() => {});
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(call);
}

const publicJob = (job: JobRow | null) =>
  job ? { id: job.id, status: job.status, objects_total: job.objects_total, objects_deleted: job.objects_deleted } : null;

type Lifecycle = {
  state: 'pending_deletion' | 'deleting';
  mode: 'scheduled' | 'immediate';
  requested_at: string;
  scheduled_for: string | null;
};

const failed = (reason: string, status: number) => jsonResponse({ status: 'failed', reason }, status);

function describe(row: Lifecycle | null) {
  if (!row) return { state: 'active' as const, scheduled_for: null, requested_at: null };
  return { state: row.state, scheduled_for: row.scheduled_for, requested_at: row.requested_at };
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return failed('method_not_allowed', 405);

  let body: { action?: unknown; confirmation?: unknown; job_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return failed('invalid_body', 400);
  }
  const action = body.action;
  if (!['status', 'schedule', 'cancel', 'delete_now', 'job_status'].includes(action as string)) {
    return failed('invalid_action', 400);
  }

  const client = serviceRoleClient();

  if (action === 'job_status') {
    if (typeof body.job_id !== 'string' || !UUID_RE.test(body.job_id)) return failed('invalid_job', 400);
    const { data } = await client.from('account_deletion_jobs').select('status').eq('id', body.job_id).maybeSingle();
    const status = (data as { status?: string } | null)?.status;
    const state = !status ? 'unknown' : status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'in_progress';
    return jsonResponse({ status: 'ok', state }, 200);
  }

  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  if (!token) return failed('invalid_token', 401);

  // Deliberately not resolveCaller: that refuses hidden accounts, and this
  // function exists to serve them (status and cancel).
  const { data: userData, error: userError } = await client.auth.getUser(token);
  if (userError || !userData?.user) return failed('invalid_token', 401);
  const userId = userData.user.id;

  const readState = async (): Promise<{ row: Lifecycle | null } | null> => {
    const { data, error } = await client
      .from('account_lifecycle')
      .select('state, mode, requested_at, scheduled_for')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error(JSON.stringify({ fn: 'account-deletion', action, outcome: 'state_read_failed', db_code: error.code }));
      return null;
    }
    return { row: (data as Lifecycle | null) ?? null };
  };

  const latestJob = async (): Promise<JobRow | null> => {
    const { data } = await client.from('account_deletion_jobs')
      .select('id, status, objects_total, objects_deleted, updated_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    return (data as JobRow | null) ?? null;
  };
  // Permanent deletion needs the worker's secret, the username key and an
  // active, configured scheduler (account_deletion_preflight).
  const deletionAvailable = async (): Promise<boolean> => {
    if (!MAINTENANCE_SECRET) return false;
    const { data } = await client.rpc('account_deletion_preflight');
    return (data as { ready?: boolean } | null)?.ready === true;
  };

  if (action === 'status') {
    const current = await readState();
    if (!current) return failed('server_error', 500);
    let job: JobRow | null = null;
    if (current.row?.state === 'deleting') {
      job = await latestJob();
      if (job && job.status !== 'completed' && Date.now() - Date.parse(job.updated_at) > KICK_AFTER_MS) kickWorker(job.id);
    }
    return jsonResponse({ status: 'ok', ...describe(current.row), job: publicJob(job), delete_now_available: await deletionAvailable() }, 200);
  }

  if (action === 'delete_now') {
    if (body.confirmation !== CONFIRMATION_WORD) return failed('confirmation_required', 400);
    if (!signedInRecently(token)) return failed('reauthentication_required', 403);
    const current = await readState();
    if (!current) return failed('server_error', 500);
    if (current.row?.state !== 'deleting' && !(await deletionAvailable())) return failed('deletion_unavailable', 503);
    const { data, error } = await client.rpc('account_deletion_start', { p_user_id: userId, p_mode: 'immediate' });
    if (error) {
      console.error(JSON.stringify({ fn: 'account-deletion', action, outcome: 'start_failed', db_code: error.code }));
      return failed('server_error', 500);
    }
    const job = data as JobRow;
    kickWorker(job.id);
    console.log(JSON.stringify({ fn: 'account-deletion', action, outcome: 'deleting', job_id: job.id }));
    const after = await readState();
    return jsonResponse({ status: 'ok', ...describe(after?.row ?? null), job: publicJob(job) }, 200);
  }

  if (action === 'cancel') {
    const { data, error } = await client.rpc('cancel_account_deletion', { p_user_id: userId });
    if (error) {
      if (error.message === 'account_lifecycle_deleting_is_final') return failed('deletion_in_progress', 409);
      console.error(JSON.stringify({ fn: 'account-deletion', action, outcome: 'cancel_failed', db_code: error.code }));
      return failed('server_error', 500);
    }
    console.log(JSON.stringify({ fn: 'account-deletion', action, outcome: data ? 'restored' : 'already_active', user_id: userId }));
    return jsonResponse({ status: 'ok', state: 'active', restored: data === true }, 200);
  }

  // ── schedule ──
  if (body.confirmation !== CONFIRMATION_WORD) return failed('confirmation_required', 400);
  if (!signedInRecently(token)) return failed('reauthentication_required', 403);

  const current = await readState();
  if (!current) return failed('server_error', 500);
  let row = current.row;
  let alreadyScheduled = false;
  if (row?.state === 'deleting') return failed('deletion_in_progress', 409);
  if (row?.state === 'pending_deletion') {
    alreadyScheduled = true;
  } else {
    const { data, error } = await client.rpc('schedule_account_deletion', {
      p_user_id: userId,
      p_recovery_days: RECOVERY_DAYS,
    });
    if (error) {
      // A concurrent request may have scheduled it first: report that state.
      const again = await readState();
      if (again?.row?.state === 'pending_deletion') {
        row = again.row;
        alreadyScheduled = true;
      } else {
        console.error(JSON.stringify({ fn: 'account-deletion', action, outcome: 'schedule_failed', db_code: error.code }));
        return failed(again?.row?.state === 'deleting' ? 'deletion_in_progress' : 'server_error', again?.row?.state === 'deleting' ? 409 : 500);
      }
    } else {
      row = data as Lifecycle;
    }
  }

  // Sign out every OTHER session (repeated on a retry, in case the first
  // attempt failed). The database already blocks those sessions' activity;
  // this ends them so they can't refresh. The calling session stays.
  const { error: signOutError } = await client.auth.admin.signOut(token, 'others');
  if (signOutError) {
    console.error(JSON.stringify({ fn: 'account-deletion', action, outcome: 'sign_out_others_failed', user_id: userId }));
  }

  console.log(JSON.stringify({ fn: 'account-deletion', action, outcome: alreadyScheduled ? 'already_scheduled' : 'scheduled', user_id: userId }));
  return jsonResponse(
    {
      status: 'ok',
      ...describe(row),
      already_scheduled: alreadyScheduled,
      other_sessions_signed_out: !signOutError,
    },
    200,
  );
});
