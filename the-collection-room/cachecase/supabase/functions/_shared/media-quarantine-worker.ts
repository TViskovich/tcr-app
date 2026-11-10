// Media quarantine and restoration workers (Phase 2B M2.3c). Shared by
// admin-media-quarantine and admin-media-restore.
//
// The database (supabase/migrations/20261119120000_media_quarantine_
// foundation.sql, 20261120120000_media_quarantine_worker.sql) owns the queue,
// the holds, the leases and the state machine, and re-checks Storage before
// accepting any step. This module only performs Storage work for a job it has
// claimed, and every decision it takes is re-derived from a fresh
// media_quarantine_inspect() — never from a request body.
//
// Guarantees:
//   * a source is never deleted before its private copy has been re-read and
//     its SHA-256 and size match the bytes read from the source;
//   * nothing is ever overwritten (uploads are never upsert): an occupied
//     destination is compared byte-for-byte and otherwise refused;
//   * a source that changed since it was queued (different object, version,
//     size, content type or bytes) is never removed — the job is flagged;
//   * removal is never inferred from a delete response: the database must no
//     longer list the object AND the Storage origin must not serve it;
//   * every step is resumable: a crash at any point leaves a state the next
//     claim continues from (copy present → compared, source gone → the
//     verified copy is the evidence);
//   * responses and logs carry job ids and reason codes only — never paths,
//     owners or media.

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

// ── Local-only fault injection (tests) ──────────────────────────────────────
// Honoured ONLY when this function runs against a local stack AND the local
// flag is set; a hosted project ignores the header entirely.
const LOCAL_HOSTS = ['kong', 'localhost', '127.0.0.1', 'host.docker.internal'];
const FAULTS = new Set([
  'copy_fail', 'corrupt_copy', 'verify_read_fail', 'delete_noop',
  'crash_after_copy', 'crash_after_verify', 'crash_after_delete',
  'restore_upload_fail', 'crash_after_restore_upload',
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

// ── Helpers ─────────────────────────────────────────────────────────────────
async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

type Read = { ok: true; bytes: Uint8Array; type: string } | { ok: false; missing: boolean };
async function read(client: SupabaseClient, bucket: string, path: string): Promise<Read> {
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) {
    const status = String((error as { status?: number; statusCode?: string } | null)?.status
      ?? (error as { statusCode?: string } | null)?.statusCode ?? '');
    return { ok: false, missing: status === '400' || status === '404' || /not found/i.test(error?.message ?? '') };
  }
  return { ok: true, bytes: new Uint8Array(await data.arrayBuffer()), type: data.type };
}

type Write = 'ok' | 'exists' | 'error';
async function writeNew(client: SupabaseClient, bucket: string, path: string, bytes: Uint8Array, type: string): Promise<Write> {
  const { error } = await client.storage.from(bucket).upload(path, bytes, { contentType: type, upsert: false });
  if (!error) return 'ok';
  const status = String((error as { statusCode?: string; status?: number }).statusCode ?? (error as { status?: number }).status ?? '');
  return status === '409' || /already exists/i.test(error.message) ? 'exists' : 'error';
}

// The Storage origin must not serve the object any more: an unauthenticated
// GET of its public URL (public buckets) and a service-role download (every
// bucket) both fail. (A CDN in front of a hosted project is checked separately.)
const PUBLIC_BUCKETS = new Set(['avatars', 'share-snapshots']);
async function absentAtOrigin(client: SupabaseClient, bucket: string, path: string): Promise<boolean> {
  if (PUBLIC_BUCKETS.has(bucket)) {
    const url = client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    await res.body?.cancel();
    if (res.ok) return false;
  }
  const r = await read(client, bucket, path);
  return !r.ok && r.missing;
}

export class Worker {
  constructor(private client: SupabaseClient, private actor: string, private fault: string | null) {}

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
      p_id: job.id, p_lease: job.lease_token, p_to_state: to, p_facts: { ...facts, actor: this.actor },
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

  private sameSource(i: Inspect): boolean {
    return i.source.exists && i.source.object_id === i.recorded.object_id
      && (i.source.version ?? null) === (i.recorded.version ?? null);
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
        const src = await read(this.client, i.source_bucket, i.source_path);
        if (!src.ok) {
          if (src.missing) continue; // re-inspect: it vanished meanwhile
          return this.fail(job, i.state, 'source_read_failed');
        }
        if (src.bytes.length !== i.source.size || (i.recorded.size !== null && src.bytes.length !== i.recorded.size)
            || !i.source.mime || src.type !== i.source.mime || (i.recorded.mime !== null && i.recorded.mime !== i.source.mime)) {
          return this.fail(job, i.state, 'source_changed', true);
        }
        const sha = await sha256(src.bytes);
        if (i.copy.exists) {
          const existing = await read(this.client, i.quarantine_bucket, i.quarantine_path);
          if (!existing.ok) return this.fail(job, i.state, 'verify_failed');
          if ((await sha256(existing.bytes)) !== sha) return this.fail(job, i.state, 'destination_conflict', true);
        } else {
          if (this.fault === 'copy_fail') return this.fail(job, i.state, 'copy_failed');
          const bytes = this.fault === 'corrupt_copy' ? Uint8Array.from(src.bytes, (b, k) => (k === 0 ? b ^ 0xff : b)) : src.bytes;
          const w = await writeNew(this.client, i.quarantine_bucket, i.quarantine_path, bytes, src.type);
          if (w === 'exists') continue; // someone else's attempt landed: compare it next round
          if (w === 'error') return this.fail(job, i.state, 'copy_failed');
        }
        if (this.fault === 'crash_after_copy') throw new Interrupted('crash_after_copy');
        const r = await this.advance(job, 'copied', { source_sha256: sha, size_bytes: src.bytes.length, mime_type: src.type });
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
        const copy = this.fault === 'verify_read_fail'
          ? ({ ok: false, missing: false } as Read)
          : await read(this.client, i.quarantine_bucket, i.quarantine_path);
        if (!copy.ok) return this.fail(job, i.state, copy.missing ? 'copy_missing' : 'verify_failed', copy.missing);
        const csha = await sha256(copy.bytes);
        if (csha !== i.recorded.source_sha256 || copy.bytes.length !== i.recorded.size) {
          return this.fail(job, i.state, 'hash_mismatch', true);
        }
        if (i.state === 'copied') {
          const r = await this.advance(job, 'verified', { quarantine_sha256: csha });
          if (!r.ok) return r.reason === 'lease' ? 'lease_lost' : this.fail(job, i.state, r.reason ?? 'refused', true);
          if (this.fault === 'crash_after_verify') throw new Interrupted('crash_after_verify');
          continue;
        }
        // verified → remove the source (only the exact, unchanged original).
        if (i.source.exists) {
          if (!this.sameSource(i)) return this.fail(job, i.state, 'source_changed', true);
          const src = await read(this.client, i.source_bucket, i.source_path);
          if (src.ok && (await sha256(src.bytes)) !== i.recorded.source_sha256) return this.fail(job, i.state, 'source_changed', true);
          if (!src.ok && !src.missing) return this.fail(job, i.state, 'source_read_failed');
          if (this.fault !== 'delete_noop') await this.client.storage.from(i.source_bucket).remove([i.source_path]);
          const after = await this.inspect(job);
          if (!after) return 'lease_lost';
          if (after.source.exists) return this.fail(job, i.state, 'delete_failed');
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

      const copy = await read(this.client, i.quarantine_bucket, i.quarantine_path);
      if (!copy.ok) return this.fail(job, i.state, copy.missing ? 'copy_missing' : 'copy_read_failed', copy.missing);
      const csha = await sha256(copy.bytes);
      if (csha !== i.recorded.source_sha256 || copy.bytes.length !== i.recorded.size) return this.fail(job, i.state, 'hash_mismatch', true);

      if (i.source.exists) {
        // Only our own earlier upload (identical bytes) counts as restored.
        const dest = await read(this.client, i.source_bucket, i.source_path);
        if (dest.ok && (await sha256(dest.bytes)) === i.recorded.source_sha256) return this.finishRestore(job);
        return this.fail(job, i.state, 'destination_occupied', true);
      }
      if (this.fault === 'restore_upload_fail') return this.fail(job, i.state, 'restore_failed');
      const w = await writeNew(this.client, i.source_bucket, i.source_path, copy.bytes, i.recorded.mime ?? copy.type);
      if (w === 'exists') continue; // compare against it next round, never overwrite
      if (w === 'error') return this.fail(job, i.state, 'restore_failed');
      if (this.fault === 'crash_after_restore_upload') throw new Interrupted('crash_after_restore_upload');
      const dest = await read(this.client, i.source_bucket, i.source_path);
      if (!dest.ok || (await sha256(dest.bytes)) !== i.recorded.source_sha256) return this.fail(job, i.state, 'restore_verify_failed', true);
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
