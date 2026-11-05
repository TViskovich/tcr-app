// Download My Data cleanup, shared by account-export (per collector, while
// serving their requests) and account-maintenance (the scheduled sweep).
//
// The sweep runs IN-PROCESS in the maintenance worker: no HTTP call between
// functions, so no server key ever crosses the gateway as a credential.
//   * ready exports past expires_at (7 days)          → expired
//   * in-progress exports untouched for 24 hours       → failed 'export_abandoned'
//     (resumable uploads expire after 24 h)
// Either way the archive's parts, partial uploads, staging files and plan
// rows are removed. Raw Storage (TUS) requests use storageAuthHeaders, so
// both secret API keys and legacy JWT keys work.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { type ServiceKey, storageAuthHeaders } from './service-key.ts';

export const EXPORT_BUCKET = 'account-exports';
export const EXPORT_ACTIVE_STATES = ['queued', 'collecting', 'archiving'];
const ABANDONED_AFTER_MS = 24 * 3_600_000;
const SWEEP_LIMIT = 100;

type ExportRow = { id: string; user_id: string; status: string };
type Log = (fields: Record<string, unknown>) => void;

export function exportCleanup<J extends ExportRow>(ctx: {
  client: SupabaseClient;
  supabaseUrl: string;
  // null when no server key is configured: callers refuse every request
  // before any of this runs.
  serviceKey: ServiceKey | null;
  log: Log;
}) {
  const { client, log } = ctx;
  const storageUrl = `${ctx.supabaseUrl}/storage/v1`;
  const tusHeaders: Record<string, string> = { ...(ctx.serviceKey ? storageAuthHeaders(ctx.serviceKey) : {}), 'Tus-Resumable': '1.0.0' };

  async function update(id: string, fields: Record<string, unknown>): Promise<J> {
    const { data, error } = await client.from('account_exports')
      .update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
    if (error) throw new Error(`job_update_failed: ${error.code}`);
    return data as J;
  }

  async function removePrefix(prefix: string) {
    const stack = [prefix];
    while (stack.length) {
      const dir = stack.pop()!;
      for (;;) {
        const { data } = await client.storage.from(EXPORT_BUCKET).list(dir, { limit: 1000 });
        const files = (data ?? []).filter((o) => o.id).map((o) => `${dir}/${o.name}`);
        for (const folder of (data ?? []).filter((o) => !o.id)) stack.push(`${dir}/${folder.name}`);
        if (files.length) await client.storage.from(EXPORT_BUCKET).remove(files);
        if (files.length < 1000) break;
      }
    }
  }

  // Ends a resumable upload in progress (best effort: it also expires).
  async function terminateUpload(url: string | null) {
    if (!url) return;
    try {
      await fetch(url, { method: 'DELETE', headers: tusHeaders });
    } catch {}
  }

  async function discardArchive(job: J) {
    const { data: parts } = await client.from('account_export_parts').select('upload_url').eq('export_id', job.id);
    for (const part of (parts ?? []) as { upload_url: string | null }[]) await terminateUpload(part.upload_url);
    await removePrefix(`${job.user_id}/${job.id}`);
    await client.from('account_export_entries').delete().eq('export_id', job.id);
    await client.from('account_export_parts').delete().eq('export_id', job.id);
  }

  async function failJob(job: J, code: string): Promise<J> {
    await discardArchive(job);
    log({ outcome: 'failed', export_id: job.id, code });
    return update(job.id, { status: 'failed', last_error_code: code, object_path: null, lease_until: null });
  }

  async function expireJob(job: J): Promise<J> {
    await discardArchive(job);
    log({ outcome: 'expired', export_id: job.id });
    return update(job.id, { status: 'expired', object_path: null, lease_until: null });
  }

  // The scheduled sweep. Throws if the database can't be read.
  async function sweep(): Promise<{ expired: number; abandoned: number }> {
    const { data: overdue, error: overdueError } = await client.from('account_exports').select('*').eq('status', 'ready')
      .lte('expires_at', new Date().toISOString()).limit(SWEEP_LIMIT);
    if (overdueError) throw new Error(`export_sweep_read_failed: ${overdueError.code}`);
    for (const job of (overdue ?? []) as J[]) await expireJob(job);
    const stale = new Date(Date.now() - ABANDONED_AFTER_MS).toISOString();
    const { data: stuck, error: stuckError } = await client.from('account_exports').select('*').in('status', EXPORT_ACTIVE_STATES)
      .lt('updated_at', stale).limit(SWEEP_LIMIT);
    if (stuckError) throw new Error(`export_sweep_read_failed: ${stuckError.code}`);
    for (const job of (stuck ?? []) as J[]) await failJob(job, 'export_abandoned');
    return { expired: (overdue ?? []).length, abandoned: (stuck ?? []).length };
  }

  return { update, removePrefix, terminateUpload, discardArchive, failJob, expireJob, sweep, tusHeaders, storageUrl };
}
