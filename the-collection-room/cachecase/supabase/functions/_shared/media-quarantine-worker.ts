// Media quarantine and restoration workers (Phase 2B M2.3c; streaming since
// M2.3e). Shared by admin-media-quarantine and admin-media-restore.
//
// The database (supabase/migrations/20261119120000_media_quarantine_
// foundation.sql, 20261120120000_media_quarantine_worker.sql,
// 20261121120000_media_security_hardening.sql) owns the queue, the holds, the
// leases and the state machine, re-checks Storage before accepting any step,
// and refuses any write or delete at a held path outside the matching worker
// step. This module only performs Storage work for a job it has claimed, and
// every decision it takes is re-derived from a fresh media_quarantine_inspect()
// — never from a request body.
//
// Bounded memory (M2.3e): file bytes never pass through this function's
// memory as a whole. Copies are made by Storage itself (server-side copy,
// cross-bucket, never overwriting), and every SHA-256 is computed over a
// streamed download, one chunk at a time. Memory use is a few chunks whatever
// the file size, so the supported 50 MB limit fits the runtime comfortably.
//
// Guarantees:
//   * a source is never deleted before its private copy has been re-read and
//     its streamed SHA-256 and size match the source's;
//   * nothing is ever overwritten: Storage refuses a copy onto an existing
//     object (409), and an occupied destination is compared by streamed
//     SHA-256 and otherwise refused;
//   * a source that changed since it was queued (different object, version,
//     size, content type or bytes) is never removed — the job is flagged;
//   * removal is never inferred from a delete response: the database must no
//     longer list the object AND the Storage origin must not serve it;
//   * a worker whose lease is close to expiring starts no destructive step
//     (source removal, restore write), so a stale worker cannot remove or
//     write files after another worker has taken the job over;
//   * every step is resumable: a crash at any point leaves a state the next
//     claim continues from (copy present → compared, source gone → the
//     verified copy is the evidence);
//   * bounded CPU: within one request each object is hashed at most once —
//     the removal step reuses the checksums this request computed moments
//     earlier (the source's identity is still re-checked against the
//     database, and nothing but the worker can write a held path); a job
//     resumed in a later request re-hashes everything. Callers stop taking
//     new work once a request has hashed HASH_BUDGET_BYTES.
//   * responses and logs carry job ids and reason codes only — never paths,
//     owners or media.

import { createHash } from 'node:crypto';

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export type ClaimedJob = { id: string; lease_token: string };
export type Outcome =
  | 'quarantined' | 'restore_pending' | 'source_missing' | 'cancelled' | 'restored'
  | 'retry_scheduled' | 'needs_attention' | 'lease_lost' | 'interrupted' | 'skipped';

type ObjectInfo = { exists: boolean; object_id?: string; version?: string | null; size?: number | null; mime?: string | null };
type Advanced = { ok: boolean; reason?: string; needs_attention?: boolean; state?: string };
type Inspect = {
  ok: boolean; reason?: string;
  state: string; desired: string; child_safety: boolean;
  source_bucket: string; source_path: string; quarantine_bucket: string; quarantine_path: string;
  path_owned: boolean; active_holds: number; owner_exists: boolean; owner_hidden: boolean;
  recorded: { size: number | null; mime: string | null; object_id: string | null; version: string | null;
              source_sha256: string | null; quarantine_sha256: string | null };
  source: ObjectInfo; copy: ObjectInfo;
};

// A destructive step (removing a source, writing a restored file) is started
// only while at least this much of the worker's lease remains.
const LEASE_SAFETY_MS = 30_000;

// Stop taking new jobs once a request has streamed this many bytes through
// SHA-256: one 50 MB job hashes ~100 MB, comfortably inside the runtime's 2 s
// CPU limit; more work waits for the next run.
export const HASH_BUDGET_BYTES = 64 * 1048576;

// ── Local-only fault injection (tests) ──────────────────────────────────────
// Honoured ONLY when this function runs against a local stack AND the local
// flag is set; a hosted project ignores the header entirely.
const LOCAL_HOSTS = ['kong', 'localhost', '127.0.0.1', 'host.docker.internal'];
const FAULTS = new Set([
  'copy_fail', 'corrupt_copy', 'verify_read_fail', 'delete_noop',
  'crash_after_copy', 'crash_after_verify', 'crash_after_delete',
  'restore_upload_fail', 'crash_after_restore_upload', 'lease_nearly_expired',
]);
function isLocal(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return LOCAL_HOSTS.includes(host) || /^supabase_kong_[a-z0-9_-]+$/.test(host);
  } catch {
    return false;
  }
}
export function requestFault(req: Request): string | null {
  if (!isLocal(Deno.env.get('SUPABASE_URL')) || Deno.env.get('CACHECASE_TEST_MQ_FAULTS') !== '1') return null;
  const f = req.headers.get('x-cachecase-local-fault');
  return f && FAULTS.has(f) ? f : null;
}
export class Interrupted extends Error {}

// Runs one job and reports its duration (the edge runtime does not report
// isolate memory; capacity is measured from outside — see the M2.3e report).
// Never alters the job's outcome.
export async function measured<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await work();
  return { value, ms: Math.round(performance.now() - t0) };
}

// ── Streaming Storage helpers ───────────────────────────────────────────────
function statusOf(error: unknown): string {
  const e = error as { status?: number; statusCode?: string | number } | null;
  return String(e?.statusCode ?? e?.status ?? '');
}

type Digest = { ok: true; sha256: string; size: number } | { ok: false; missing: boolean };
// SHA-256 and byte count of an object, read as a stream (bounded memory).
async function digest(client: SupabaseClient, bucket: string, path: string): Promise<Digest> {
  const { data, error } = await client.storage.from(bucket).download(path).asStream();
  if (error || !data) {
    const s = statusOf(error);
    return { ok: false, missing: s === '400' || s === '404' || /not found/i.test((error as Error | null)?.message ?? '') };
  }
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of data as ReadableStream<Uint8Array>) {
      hash.update(chunk);
      size += chunk.length;
    }
  } catch {
    return { ok: false, missing: false };
  }
  return { ok: true, sha256: hash.digest('hex'), size };
}

type Copy = 'ok' | 'exists' | 'error';
// Server-side copy by Storage itself: the bytes never enter this function.
// Storage refuses to overwrite an existing destination (409).
async function serverCopy(client: SupabaseClient, fromBucket: string, fromPath: string, toBucket: string, toPath: string): Promise<Copy> {
  const { error } = await client.storage.from(fromBucket).copy(fromPath, toPath, { destinationBucket: toBucket });
  if (!error) return 'ok';
  return statusOf(error) === '409' || /already exists/i.test(error.message) ? 'exists' : 'error';
}

// The Storage origin must not serve the object any more: an unauthenticated
// GET of its public URL (public buckets) and a service-role read (every
// bucket) both fail. Only headers are read. (A CDN in front of a hosted
// project is checked separately.)
const PUBLIC_BUCKETS = new Set(['avatars', 'share-snapshots']);
async function absentAtOrigin(client: SupabaseClient, bucket: string, path: string): Promise<boolean> {
  if (PUBLIC_BUCKETS.has(bucket)) {
    const url = client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    await res.body?.cancel();
    if (res.ok) return false;
  }
  const { data, error } = await client.storage.from(bucket).download(path).asStream();
  if (data) {
    await (data as ReadableStream).cancel();
    return false;
  }
  const s = statusOf(error);
  return s === '400' || s === '404' || /not found/i.test((error as Error | null)?.message ?? '');
}

// A corrupted private copy, for the local-only corrupt_copy fault: replaces
// the freshly made copy with different bytes of the SAME size and type, so
// only the checksum can catch it. (Test fixtures are small; never used in a
// hosted project.)
async function corruptCopy(client: SupabaseClient, bucket: string, path: string, size: number, type: string): Promise<void> {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff], 0);
  await client.storage.from(bucket).upload(path, bytes, { contentType: type, upsert: true });
}

export class Worker {
  private claimedAt = new Map<string, number>();
  // Checksums computed in THIS request ("bucket/path" → sha256 + size).
  private hashed = new Map<string, { sha256: string; size: number }>();
  bytesHashed = 0;

  // actor: the verified admin's user id (admin functions), or null with
  // schedulerRun: the id of an open scheduled run (media-quarantine-scheduled,
  // 20261126120000) — recorded as actor_kind 'scheduler', never as a user.
  constructor(private client: SupabaseClient, private actor: string | null, private fault: string | null, private leaseSeconds: number,
              private schedulerRun: string | null = null) {
    if ((actor === null) === (schedulerRun === null)) throw new Error('worker needs exactly one actor');
  }

  // Call right after claiming: the lease runs from (no earlier than) now.
  claimed(job: ClaimedJob) {
    this.claimedAt.set(job.id, Date.now());
  }

  private leaseOk(job: ClaimedJob): boolean {
    if (this.fault === 'lease_nearly_expired') return false;
    const t = this.claimedAt.get(job.id);
    return t !== undefined && Date.now() < t + this.leaseSeconds * 1000 - LEASE_SAFETY_MS;
  }

  private async digest(bucket: string, path: string, reuse = false): Promise<Digest> {
    const key = `${bucket}/${path}`;
    const known = this.hashed.get(key);
    if (reuse && known) return { ok: true, ...known };
    const d = await digest(this.client, bucket, path);
    if (d.ok) {
      this.bytesHashed += d.size;
      this.hashed.set(key, { sha256: d.sha256, size: d.size });
    }
    return d;
  }

  private log(job: string, outcome: string, reason?: string) {
    console.log(JSON.stringify({ fn: 'media-quarantine-worker', job, outcome, ...(reason ? { reason } : {}) }));
  }

  private async inspect(job: ClaimedJob): Promise<Inspect | null> {
    const { data, error } = await this.client.rpc('media_quarantine_inspect', { p_id: job.id, p_lease: job.lease_token });
    if (error || !data?.ok) return null;
    return data as Inspect;
  }

  private async advance(job: ClaimedJob, to: string, facts: Record<string, unknown> = {}) {
    const { data, error } = await this.client.rpc('media_quarantine_advance', {
      p_id: job.id, p_lease: job.lease_token, p_to_state: to, p_facts: { ...facts, ...(this.actor ? { actor: this.actor } : { scheduler_run: this.schedulerRun }) },
    });
    if (error) return { ok: false, reason: 'advance_failed' } as Advanced;
    return data as Advanced;
  }

  // Records a failure in the job's CURRENT state (no transition). Permanent
  // = a validation failure: flagged for an admin immediately. Transient
  // failures back off and are flagged once the attempt budget is spent.
  private async fail(job: ClaimedJob, state: string, code: string, permanent = false): Promise<Outcome> {
    const r = await this.advance(job, state, { error: code, permanent });
    const outcome: Outcome = !r.ok ? 'lease_lost' : r.needs_attention ? 'needs_attention' : 'retry_scheduled';
    this.log(job.id, outcome, code);
    return outcome;
  }

  // The object at the source path is still exactly the one that was queued.
  private sameSource(i: Inspect): boolean {
    return i.source.exists && i.source.object_id === i.recorded.object_id
      && (i.source.version ?? null) === (i.recorded.version ?? null)
      && (i.recorded.size === null || i.source.size === i.recorded.size)
      && !!i.source.mime && (i.recorded.mime === null || i.source.mime === i.recorded.mime);
  }

  // ── Quarantine ────────────────────────────────────────────────────────────
  async quarantine(job: ClaimedJob): Promise<Outcome> {
    for (let step = 0; step < 6; step++) {
      const i = await this.inspect(job);
      if (!i) return 'lease_lost';
      if (!i.path_owned) return this.fail(job, i.state, 'invalid_source', true);

      if (i.state === 'pending') {
        if (!i.source.exists) {
          if (i.copy.exists) return this.fail(job, i.state, 'unverified_copy', true);
          const r = await this.advance(job, 'source_missing');
          this.log(job.id, r.ok ? 'source_missing' : 'refused', r.reason);
          return r.ok ? 'source_missing' : this.fail(job, i.state, r.reason ?? 'refused', true);
        }
        if (!this.sameSource(i)) return this.fail(job, i.state, 'source_changed', true);
        if (!i.copy.exists) {
          if (this.fault === 'copy_fail') return this.fail(job, i.state, 'copy_failed');
          const c = await serverCopy(this.client, i.source_bucket, i.source_path, i.quarantine_bucket, i.quarantine_path);
          if (c === 'exists') continue; // another attempt's copy landed: compare it next round
          if (c === 'error') return this.fail(job, i.state, 'copy_failed');
          if (this.fault === 'corrupt_copy') await corruptCopy(this.client, i.quarantine_bucket, i.quarantine_path, i.source.size ?? 0, i.source.mime ?? 'image/jpeg');
        }
        // Hash the source as it is now, then make sure it did not change while
        // it was being read (the database refuses writes to held paths, so a
        // change here means something outside the app touched it).
        const src = await this.digest(i.source_bucket, i.source_path);
        if (!src.ok) {
          if (src.missing) continue;
          return this.fail(job, i.state, 'source_read_failed');
        }
        const after = await this.inspect(job);
        if (!after) return 'lease_lost';
        if (!this.sameSource(after) || src.size !== after.source.size) return this.fail(job, i.state, 'source_changed', true);
        if (i.copy.exists) {
          // A copy from an earlier, interrupted attempt: it must be byte-identical.
          const existing = await this.digest(i.quarantine_bucket, i.quarantine_path);
          if (!existing.ok) return this.fail(job, i.state, 'verify_failed');
          if (existing.sha256 !== src.sha256 || existing.size !== src.size) return this.fail(job, i.state, 'destination_conflict', true);
        }
        if (this.fault === 'crash_after_copy') throw new Interrupted('crash_after_copy');
        const r = await this.advance(job, 'copied', { source_sha256: src.sha256, size_bytes: src.size, mime_type: after.source.mime });
        if (!r.ok) return r.reason === 'lease' ? 'lease_lost' : this.fail(job, i.state, r.reason ?? 'refused', true);
        continue;
      }

      if (i.state === 'copied' || i.state === 'verified') {
        // Released before the source was removed: keep the source, finish
        // (the private copy is retained, never purged here).
        if (i.desired === 'restore' && i.source.exists) {
          const r = await this.advance(job, 'cancelled');
          this.log(job.id, r.ok ? 'cancelled' : 'refused', r.reason);
          return r.ok ? 'cancelled' : 'lease_lost';
        }
        // Re-read and re-hash the private copy every time before relying on it.
        // Re-read and re-hash the private copy unless THIS request already did.
        const copy: Digest = this.fault === 'verify_read_fail'
          ? { ok: false, missing: false }
          : await this.digest(i.quarantine_bucket, i.quarantine_path, true);
        if (!copy.ok) return this.fail(job, i.state, copy.missing ? 'copy_missing' : 'verify_failed', copy.missing);
        if (copy.sha256 !== i.recorded.source_sha256 || copy.size !== i.recorded.size || i.copy.mime !== i.recorded.mime) {
          return this.fail(job, i.state, 'hash_mismatch', true);
        }
        if (i.state === 'copied') {
          const r = await this.advance(job, 'verified', { quarantine_sha256: copy.sha256 });
          if (!r.ok) return r.reason === 'lease' ? 'lease_lost' : this.fail(job, i.state, r.reason ?? 'refused', true);
          if (this.fault === 'crash_after_verify') throw new Interrupted('crash_after_verify');
          continue;
        }
        // verified → remove the source (only the exact, unchanged original).
        if (i.source.exists) {
          if (!this.sameSource(i)) return this.fail(job, i.state, 'source_changed', true);
          const src = await this.digest(i.source_bucket, i.source_path, true);
          if (src.ok && (src.sha256 !== i.recorded.source_sha256 || src.size !== i.recorded.size)) return this.fail(job, i.state, 'source_changed', true);
          if (!src.ok && !src.missing) return this.fail(job, i.state, 'source_read_failed');
          if (!this.leaseOk(job)) {
            this.log(job.id, 'lease_lost', 'lease_nearly_expired');
            return 'lease_lost'; // no destructive step on a lease about to lapse
          }
          if (this.fault !== 'delete_noop') await this.client.storage.from(i.source_bucket).remove([i.source_path]);
          const gone = await this.inspect(job);
          if (!gone) return 'lease_lost';
          if (gone.source.exists) return this.fail(job, i.state, 'delete_failed');
        }
        if (!(await absentAtOrigin(this.client, i.source_bucket, i.source_path))) return this.fail(job, i.state, 'delete_failed');
        if (this.fault === 'crash_after_delete') throw new Interrupted('crash_after_delete');
        const r = await this.advance(job, 'quarantined', { source_removed: true });
        if (!r.ok) return r.reason === 'lease' ? 'lease_lost' : this.fail(job, i.state, r.reason ?? 'refused', true);
        // Released mid-run, the database moves it straight on to restore_pending.
        const done: Outcome = r.state === 'restore_pending' ? 'restore_pending' : 'quarantined';
        this.log(job.id, done);
        return done;
      }
      return 'skipped';
    }
    return this.fail(job, (await this.inspect(job))?.state ?? 'pending', 'too_many_steps');
  }

  // ── Restore ───────────────────────────────────────────────────────────────
  async restore(job: ClaimedJob): Promise<Outcome> {
    // Restoration is an admin decision; a scheduled worker never restores
    // (the database refuses it too).
    if (this.schedulerRun !== null) throw new Error('restore is admin-only');
    for (let step = 0; step < 4; step++) {
      const i = await this.inspect(job);
      if (!i) return 'lease_lost';
      if (!i.path_owned) return this.fail(job, i.state, 'invalid_source', true);
      if (i.state === 'restore_pending') {
        const r = await this.advance(job, 'restoring');
        if (!r.ok) return r.reason === 'lease' ? 'lease_lost' : this.fail(job, i.state, r.reason ?? 'refused', true);
        continue;
      }
      if (i.state !== 'restoring') return 'skipped';
      if (i.desired !== 'restore' || i.active_holds > 0) return this.fail(job, i.state, 'held_again', true);
      if (!i.owner_exists || i.owner_hidden) return this.fail(job, i.state, 'owner_unavailable', true);

      const copy = await this.digest(i.quarantine_bucket, i.quarantine_path);
      if (!copy.ok) return this.fail(job, i.state, copy.missing ? 'copy_missing' : 'copy_read_failed', copy.missing);
      if (copy.sha256 !== i.recorded.source_sha256 || copy.size !== i.recorded.size) return this.fail(job, i.state, 'hash_mismatch', true);

      if (i.source.exists) {
        // Only our own earlier restore (identical bytes) counts as restored.
        const dest = await this.digest(i.source_bucket, i.source_path);
        if (dest.ok && dest.sha256 === i.recorded.source_sha256 && dest.size === i.recorded.size) return this.finishRestore(job);
        return this.fail(job, i.state, 'destination_occupied', true);
      }
      if (this.fault === 'restore_upload_fail') return this.fail(job, i.state, 'restore_failed');
      if (!this.leaseOk(job)) {
        this.log(job.id, 'lease_lost', 'lease_nearly_expired');
        return 'lease_lost';
      }
      const c = await serverCopy(this.client, i.quarantine_bucket, i.quarantine_path, i.source_bucket, i.source_path);
      if (c === 'exists') continue; // compare against it next round, never overwrite
      if (c === 'error') return this.fail(job, i.state, 'restore_failed');
      if (this.fault === 'crash_after_restore_upload') throw new Interrupted('crash_after_restore_upload');
      const dest = await this.digest(i.source_bucket, i.source_path);
      if (!dest.ok || dest.sha256 !== i.recorded.source_sha256 || dest.size !== i.recorded.size) {
        return this.fail(job, i.state, 'restore_verify_failed', true);
      }
      return this.finishRestore(job);
    }
    return this.fail(job, 'restoring', 'too_many_steps');
  }

  private async finishRestore(job: ClaimedJob): Promise<Outcome> {
    const r = await this.advance(job, 'restored');
    if (!r.ok) return r.reason === 'lease' ? 'lease_lost' : this.fail(job, 'restoring', r.reason ?? 'refused', true);
    this.log(job.id, 'restored');
    return 'restored';
  }
}
