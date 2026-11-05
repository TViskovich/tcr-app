// Download My Data — Dashboard Milestone 2, Checkpoints 3 and 4.
//
//   POST { action: 'status' }    the collector's latest export
//   POST { action: 'request' }   start a new export (recent sign-in required)
//   POST { action: 'advance' }   do one bounded step of the export in progress
//   POST { action: 'download' }  short-lived signed URLs for every part
//
// The collector is ALWAYS the owner of the verified access token; no export
// id, user id or path is accepted from the request, so nobody can reach
// another collector's job, files or archive. Collectors pending deletion are
// served too (their authorised path to their own data); an account already
// being permanently deleted is not.
//
// Job lifecycle (20261105120000_add_account_exports, 20261106130000_account_export_parts):
//   queued → collecting → archiving → ready (7 days) → expired
//   any → failed (staging files, partial uploads and parts removed)
// collecting: reads the data, writes the JSON/CSV files to staging and plans
//   the export as PARTS — each a complete ZIP no larger than PART_BYTES
//   (no file is ever split; a file larger than a part gets its own part).
//   Part 1 holds README.txt, manifest.json (every file and its part) and
//   the data files; photos follow.
// archiving: each step appends whole files (~6 MB) to the current part's
//   resumable upload; when a part's files are in, its ZIP directory
//   completes it. Memory stays bounded whatever the collection size.
// The app drives the steps while its export screen is open ('advance');
// expiry and abandoned-job cleanup run in the account-maintenance worker
// itself (_shared/account-export-cleanup.ts) — no call into this function.
//
// Server key: _shared/service-key.ts (a secret API key, or the legacy
// service-role JWT during the transition). Resumable uploads present it the
// way Storage accepts for its kind (apikey header; Bearer only for a JWT).

import { createClient } from 'npm:@supabase/supabase-js@2';

import { EXPORT_ACTIVE_STATES, exportCleanup } from '../_shared/account-export-cleanup.ts';
import { handleCorsPreflight, jsonResponse } from '../_shared/registry-image.ts';
import { signedInRecently } from '../_shared/recent-auth.ts';
import { tryResolveServiceKey } from '../_shared/service-key.ts';
import { collectData, mediaName, README, type OwnedObject } from './collect.ts';
import { centralDirectory, concat, crc32, localEntry, localEntrySize, nameBytes, ZIP_MAX_BYTES, ZIP_MAX_ENTRIES } from './zip.ts';

const BUCKET = 'account-exports'; // = EXPORT_BUCKET
const EXPORT_DAYS = 7;
const SIGNED_URL_SECONDS = 300;
const LEASE_SECONDS = 90;
const STEP_TARGET_BYTES = 6 * 1024 * 1024;
const STEP_TIME_BUDGET_MS = 20_000;
const MAX_ATTEMPTS = 3; // archive (re)builds
const MAX_STEP_FAILURES = 5; // consecutive failed steps
const ACTIVE = EXPORT_ACTIVE_STATES;

// Largest part, in bytes. Default stays under Supabase's default 50 MB
// upload limit; set ACCOUNT_EXPORT_PART_BYTES to match the project's limit.
const PART_BYTES = (() => {
  const configured = Number.parseInt(Deno.env.get('ACCOUNT_EXPORT_PART_BYTES') ?? '', 10);
  const fallback = 45 * 1024 * 1024;
  if (!Number.isFinite(configured) || configured < 512 * 1024) return fallback;
  return Math.min(configured, ZIP_MAX_BYTES);
})();

type Job = {
  id: string;
  user_id: string;
  status: 'queued' | 'collecting' | 'archiving' | 'ready' | 'failed' | 'expired';
  attempts: number;
  step_failures: number;
  entries_total: number | null;
  entries_written: number;
  bytes_total: number | null;
  bytes_written: number;
  part_count: number | null;
  object_path: string | null;
  last_error_code: string | null;
  created_at: string;
  ready_at: string | null;
  expires_at: string | null;
};
type Entry = {
  export_id: string;
  seq: number;
  part: number;
  archive_name: string;
  source_bucket: string;
  source_path: string;
  size: number;
  local_offset: number;
  crc32: number | null;
  written: boolean;
};
type Part = {
  export_id: string;
  part: number;
  object_path: string;
  bytes_total: number;
  bytes_written: number;
  upload_url: string | null;
  completed: boolean;
};

// No usable server key → every request fails closed (server_misconfigured).
const SERVICE_KEY = tryResolveServiceKey();
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const client = createClient(SUPABASE_URL, SERVICE_KEY?.key ?? 'unconfigured', {
  auth: { autoRefreshToken: false, persistSession: false },
});
const cleanup = exportCleanup<Job>({
  client, supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, log: (f) => log(f),
});
const STORAGE_URL = cleanup.storageUrl;
const tusHeaders = cleanup.tusHeaders;
const encoder = new TextEncoder();

const failed = (reason: string, status: number) => jsonResponse({ status: 'failed', reason }, status);
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'account-export', ...fields }));

class Rebuild extends Error {} // rebuild the archive from the start
class Fatal extends Error {} // end the job

// ── Public view of a job ────────────────────────────────────────────────────
function view(job: Job | null) {
  if (!job) return { status: 'ok', export: null };
  const state = ACTIVE.includes(job.status) ? 'preparing' : job.status;
  const total = job.entries_total ?? 0;
  return {
    status: 'ok',
    export: {
      state,
      stage: job.status,
      progress: { done: job.entries_written, total, percent: total ? Math.floor((job.entries_written / total) * 100) : 0 },
      size_bytes: job.bytes_total,
      part_count: job.part_count,
      created_at: job.created_at,
      ready_at: job.ready_at,
      expires_at: job.expires_at,
      error: job.status === 'failed' ? (job.last_error_code ?? 'export_failed') : null,
    },
  };
}

async function latestJob(userId: string): Promise<Job | null> {
  const { data, error } = await client.from('account_exports').select('*').eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`job_read_failed: ${error.code}`);
  return data as Job | null;
}

const update = cleanup.update;

async function partsOf(exportId: string): Promise<Part[]> {
  const { data, error } = await client.from('account_export_parts').select('*').eq('export_id', exportId).order('part');
  if (error) throw new Error(`parts_read_failed: ${error.code}`);
  return (data ?? []) as Part[];
}

// ── Storage helpers ─────────────────────────────────────────────────────────
// removePrefix / terminateUpload: _shared/account-export-cleanup.ts.

async function createUpload(objectPath: string, length: number): Promise<string> {
  const meta = [`bucketName ${btoa(BUCKET)}`, `objectName ${btoa(objectPath)}`, `contentType ${btoa('application/zip')}`].join(',');
  const res = await fetch(`${STORAGE_URL}/upload/resumable`, {
    method: 'POST',
    headers: { ...tusHeaders, 'Upload-Length': String(length), 'Upload-Metadata': meta, 'x-upsert': 'true' },
  });
  if (res.status === 413) throw new Fatal('export_too_large');
  if (res.status !== 201) throw new Error(`tus_create_${res.status}`);
  // Keep only the upload's id: the Location host reflects proxy headers
  // (locally an internal gateway address), so the URL is rebuilt here.
  const uploadId = res.headers.get('Location')?.split('/upload/resumable/')[1];
  if (!uploadId) throw new Error('tus_create_no_location');
  return `${STORAGE_URL}/upload/resumable/${uploadId}`;
}

async function uploadOffset(url: string): Promise<number | null> {
  const res = await fetch(url, { method: 'HEAD', headers: tusHeaders });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`tus_head_${res.status}`);
  return Number(res.headers.get('Upload-Offset'));
}

async function appendBytes(url: string, offset: number, bytes: Uint8Array): Promise<number> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...tusHeaders, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
    body: bytes as unknown as BodyInit,
  });
  if (res.status === 409) throw new Rebuild('offset_conflict');
  if (res.status === 404 || res.status === 410) throw new Rebuild('upload_lost');
  if (res.status === 413) throw new Fatal('export_too_large');
  if (!res.ok) throw new Error(`tus_patch_${res.status}`);
  return Number(res.headers.get('Upload-Offset'));
}

async function readSource(entry: Entry): Promise<Uint8Array> {
  const { data, error } = await client.storage.from(entry.source_bucket).download(entry.source_path);
  if (error || !data) {
    const status = (error as { status?: number } | null)?.status ?? (error as { statusCode?: string } | null)?.statusCode;
    if (String(status) === '404' || String(status) === '400') throw new Rebuild('source_missing');
    throw new Error('source_read_failed');
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.length !== Number(entry.size)) throw new Rebuild('source_changed');
  return bytes;
}

// ── Cleanup / terminal states (shared with the maintenance sweep) ───────────
const { discardArchive, failJob, expireJob, removePrefix } = cleanup;

const isOverdue = (job: Job) => job.status === 'ready' && !!job.expires_at && Date.parse(job.expires_at) <= Date.now();

// ── Planning ────────────────────────────────────────────────────────────────
type Planned = { name: string; bucket: string; path: string; size: number; part: number; offset: number };

// Greedy split into parts of at most PART_BYTES; files are never split.
function assignParts(files: { name: string; bucket: string; path: string; size: number }[]): { planned: Planned[]; partBytes: number[] } {
  const planned: Planned[] = [];
  const partBytes: number[] = [];
  let part = 0;
  let bytes = 0; // current part, excluding its 22-byte end record
  let offset = 0;
  let count = 0;
  for (const f of files) {
    const need = localEntrySize(f.name, f.size) + 46 + nameBytes(f.name).length;
    if (need + 22 > ZIP_MAX_BYTES) throw new Fatal('export_too_large');
    if (part === 0 || (count > 0 && (bytes + need + 22 > PART_BYTES || count >= ZIP_MAX_ENTRIES))) {
      if (part > 0) partBytes.push(bytes + 22);
      part += 1;
      bytes = 0;
      offset = 0;
      count = 0;
    }
    planned.push({ ...f, part, offset });
    offset += localEntrySize(f.name, f.size);
    bytes += need;
    count += 1;
  }
  if (part > 0) partBytes.push(bytes + 22);
  return { planned, partBytes };
}

const partFileName = (date: string, part: number, of: number) =>
  of === 1 ? `CacheCase-export-${date}.zip` : `CacheCase-export-${date}-part-${part}-of-${of}.zip`;

// ── Stage: collecting ───────────────────────────────────────────────────────
async function collect(job: Job): Promise<Job> {
  const userId = job.user_id;
  if (job.attempts >= MAX_ATTEMPTS) throw new Fatal('too_many_attempts');
  await discardArchive(job);

  // The collector's own Storage objects (their own folders only).
  const owned: OwnedObject[] = [];
  let after = { bucket: '', name: '' };
  for (;;) {
    const { data, error } = await client.rpc('export_owned_storage_objects', {
      p_user_id: userId, p_after_bucket: after.bucket, p_after_name: after.name, p_limit: 1000,
    });
    if (error) throw new Error(`owned_objects_failed: ${error.code}`);
    const page = (data ?? []) as { bucket_id: string; name: string; size: number }[];
    for (const o of page) {
      owned.push({ bucket: o.bucket_id, path: o.name, size: Number(o.size), archiveName: mediaName(userId, o.bucket_id, o.name) });
    }
    if (page.length < 1000) break;
    after = { bucket: page[page.length - 1].bucket_id, name: page[page.length - 1].name };
  }

  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10);
  const { files, counts } = await collectData(client, userId, owned);
  const { data: excluded } = await client.rpc('account_export_unreleased_records', { p_user_id: userId });
  const readme = encoder.encode(README(generatedAt));
  const staging = `${userId}/${job.id}/staging`;
  const dataFiles = files.map((f) => ({ name: f.name, bucket: BUCKET, path: `${staging}/${f.name}`, size: f.bytes.length }));
  const media = owned.map((o) => ({ name: o.archiveName, bucket: o.bucket, path: o.path, size: o.size }));

  // The manifest lists every file and its part, and lives in part 1, so its
  // size is reserved first and the manifest padded to exactly that size.
  let reserve = 8192 + 160 * (dataFiles.length + media.length);
  let manifestBytes: Uint8Array | null = null;
  let plan: ReturnType<typeof assignParts> | null = null;
  for (let round = 0; round < 4 && !manifestBytes; round++) {
    const ordered = [
      { name: 'README.txt', bucket: BUCKET, path: `${staging}/README.txt`, size: readme.length },
      { name: 'manifest.json', bucket: BUCKET, path: `${staging}/manifest.json`, size: reserve },
      ...dataFiles,
      ...media,
    ];
    plan = assignParts(ordered);
    const partCount = plan.partBytes.length;
    const manifest = {
      format_version: 2,
      export_id: job.id,
      generated_at: generatedAt,
      parts: plan.partBytes.map((bytes, i) => ({ part: i + 1, file_name: partFileName(date, i + 1, partCount), bytes })),
      counts: { ...counts, media_files: owned.length },
      files: plan.planned.filter((p) => p.name !== 'manifest.json').map((p) => ({ name: p.name, bytes: p.size, part: p.part })),
      how_to_use: partCount > 1
        ? `This export has ${partCount} parts. Download every part; each is a complete ZIP you can open on its own. files[].part says which part holds each file.`
        : 'This export is a single ZIP.',
      not_included: [
        'Messages other collectors sent you',
        'Photos attached to direct messages',
        'Other collectors’ content, including posts you reposted or quoted',
      ],
    };
    const text = encoder.encode(JSON.stringify(manifest, null, 2) + '\n');
    if (text.length <= reserve) {
      const padded = new Uint8Array(reserve).fill(0x20); // trailing spaces are valid JSON
      padded.set(text);
      manifestBytes = padded;
    } else {
      reserve = Math.ceil(text.length * 1.25);
    }
  }
  if (!manifestBytes || !plan) throw new Error('manifest_plan_failed');

  // Stage the data files.
  const staged: [string, Uint8Array][] = [['README.txt', readme], ['manifest.json', manifestBytes], ...files.map((f) => [f.name, f.bytes] as [string, Uint8Array])];
  for (const [name, bytes] of staged) {
    const { error } = await client.storage.from(BUCKET).upload(`${staging}/${name}`, bytes, { upsert: true, contentType: 'application/octet-stream' });
    if (error) throw new Error('staging_upload_failed');
  }

  const rows = plan.planned.map((p, seq) => ({
    export_id: job.id, seq, part: p.part, archive_name: p.name, source_bucket: p.bucket, source_path: p.path,
    size: p.size, local_offset: p.offset, crc32: null, written: false,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await client.from('account_export_entries').insert(rows.slice(i, i + 500));
    if (error) throw new Error(`plan_failed: ${error.code}`);
  }
  const partCount = plan.partBytes.length;
  const partRows = plan.partBytes.map((bytes, i) => ({
    export_id: job.id, part: i + 1, object_path: `${userId}/${job.id}/${partFileName(date, i + 1, partCount)}`, bytes_total: bytes,
  }));
  const { error: partsError } = await client.from('account_export_parts').insert(partRows);
  if (partsError) throw new Error(`parts_plan_failed: ${partsError.code}`);

  const total = plan.partBytes.reduce((n, b) => n + b, 0);
  log({ outcome: 'planned', export_id: job.id, entries: rows.length, parts: partCount, bytes: total, attempt: job.attempts + 1 });
  return update(job.id, {
    status: 'archiving', attempts: job.attempts + 1, entries_total: rows.length, entries_written: 0,
    bytes_total: total, bytes_written: 0, part_count: partCount, object_path: `${userId}/${job.id}/`,
    excluded_records: excluded ?? null, last_error_code: null,
  });
}

// ── Stage: archiving (one bounded step on the current part) ─────────────────
async function archiveStep(job: Job): Promise<Job> {
  const parts = await partsOf(job.id);
  const part = parts.find((p) => !p.completed);
  if (!part) throw new Rebuild('incomplete_plan');
  const started = Date.now();

  // Opening a part's upload is a step of its own, so "open, nothing written
  // yet" is a recorded state the next step can always reconcile.
  const uploadUrl = part.upload_url;
  if (!uploadUrl) {
    const created = await createUpload(part.object_path, Number(part.bytes_total));
    await client.from('account_export_parts').update({ upload_url: created, bytes_written: 0 }).eq('export_id', job.id).eq('part', part.part);
    return update(job.id, { step_failures: 0, lease_until: null });
  }

  // Reconcile with what the upload actually holds (a previous step may have
  // uploaded and then been interrupted before recording it).
  const serverOffset = await uploadOffset(uploadUrl);
  if (serverOffset === null) throw new Rebuild('upload_lost');
  let written = Number(part.bytes_written);
  if (serverOffset !== written) {
    const { data } = await client.from('account_export_entries').select('*').eq('export_id', job.id).eq('part', part.part)
      .eq('written', false).not('crc32', 'is', null).order('seq').limit(5000);
    let end = written;
    const recovered: Entry[] = [];
    for (const e of (data ?? []) as Entry[]) {
      const entryEnd = Number(e.local_offset) + localEntrySize(e.archive_name, Number(e.size));
      if (Number(e.local_offset) !== end || entryEnd > serverOffset) break;
      recovered.push(e);
      end = entryEnd;
    }
    if (end !== serverOffset) throw new Rebuild('offset_mismatch'); // stopped mid-file
    if (recovered.length) {
      await client.from('account_export_entries').update({ written: true }).eq('export_id', job.id).in('seq', recovered.map((r) => r.seq));
    }
    await client.from('account_export_parts').update({ bytes_written: serverOffset }).eq('export_id', job.id).eq('part', part.part);
    job = await update(job.id, {
      bytes_written: Number(job.bytes_written) + (serverOffset - written), entries_written: job.entries_written + recovered.length,
    });
    written = serverOffset;
    log({ outcome: 'reconciled', export_id: job.id, part: part.part, recovered: recovered.length });
  }

  const { data: pending, error } = await client.from('account_export_entries').select('*')
    .eq('export_id', job.id).eq('part', part.part).eq('written', false).order('seq').limit(500);
  if (error) throw new Error(`entries_read_failed: ${error.code}`);
  const next = (pending ?? []) as Entry[];

  if (next.length > 0) {
    const chunk: Uint8Array[] = [];
    const done: Entry[] = [];
    let chunkBytes = 0;
    for (const entry of next) {
      if (done.length > 0 && (chunkBytes >= STEP_TARGET_BYTES || Date.now() - started > STEP_TIME_BUDGET_MS)) break;
      if (Number(entry.local_offset) !== written + chunkBytes) throw new Rebuild('plan_mismatch');
      const data = await readSource(entry);
      const crc = crc32(data);
      const local = localEntry(entry.archive_name, data, crc);
      chunk.push(local);
      chunkBytes += local.length;
      done.push({ ...entry, crc32: crc });
    }
    // Record CRCs first: if the upload succeeds but this step dies before
    // recording it, the next step can still reconcile these files.
    const { error: crcError } = await client.from('account_export_entries').upsert(done, { onConflict: 'export_id,seq' });
    if (crcError) throw new Error(`crc_record_failed: ${crcError.code}`);
    const newOffset = await appendBytes(uploadUrl, written, concat(chunk));
    if (newOffset !== written + chunkBytes) throw new Rebuild('offset_mismatch');
    await client.from('account_export_entries').update({ written: true }).eq('export_id', job.id).in('seq', done.map((d) => d.seq));
    await client.from('account_export_parts').update({ bytes_written: newOffset }).eq('export_id', job.id).eq('part', part.part);
    return update(job.id, {
      bytes_written: Number(job.bytes_written) + chunkBytes, entries_written: job.entries_written + done.length,
      step_failures: 0, lease_until: null,
    });
  }

  // Every file of this part is in: its ZIP directory completes the part.
  const all: Entry[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error: readError } = await client.from('account_export_entries').select('*')
      .eq('export_id', job.id).eq('part', part.part).order('seq').range(from, from + 999);
    if (readError) throw new Error(`entries_read_failed: ${readError.code}`);
    all.push(...((data ?? []) as Entry[]));
    if ((data ?? []).length < 1000) break;
  }
  if (all.some((e) => e.crc32 === null || !e.written)) throw new Rebuild('incomplete_plan');
  const directory = centralDirectory(
    all.map((e) => ({ name: e.archive_name, size: Number(e.size), crc: Number(e.crc32), offset: Number(e.local_offset) })),
    written,
  );
  if (written + directory.length !== Number(part.bytes_total)) throw new Rebuild('size_mismatch');
  const finalOffset = await appendBytes(uploadUrl, written, directory);
  if (finalOffset !== Number(part.bytes_total)) throw new Rebuild('size_mismatch');
  await client.from('account_export_parts').update({ bytes_written: finalOffset, completed: true, upload_url: null })
    .eq('export_id', job.id).eq('part', part.part);
  job = await update(job.id, { bytes_written: Number(job.bytes_written) + directory.length, step_failures: 0 });
  log({ outcome: 'part_ready', export_id: job.id, part: part.part, of: parts.length });

  if (parts.some((p) => p.part !== part.part && !p.completed)) return update(job.id, { lease_until: null });

  // Every part is complete.
  await removePrefix(`${job.user_id}/${job.id}/staging`);
  await client.from('account_export_entries').delete().eq('export_id', job.id);
  const now = Date.now();
  log({ outcome: 'ready', export_id: job.id, parts: parts.length, bytes: job.bytes_total });
  return update(job.id, {
    status: 'ready', lease_until: null, ready_at: new Date(now).toISOString(),
    expires_at: new Date(now + EXPORT_DAYS * 86_400_000).toISOString(),
  });
}

// One step of the collector's export in progress, if nobody else is on it.
async function advance(job: Job): Promise<Job> {
  // Refused while another request holds the lease, or once the account is
  // deleting (the deletion worker waits for a lease taken before that).
  const { data: leasedRows, error: leaseError } = await client.rpc('account_export_take_lease', {
    p_export_id: job.id, p_lease_seconds: LEASE_SECONDS,
  });
  if (leaseError) throw new Error(`lease_failed: ${leaseError.code}`);
  const leased = ((leasedRows ?? []) as Job[])[0];
  if (!leased) return job;

  let current = leased as Job;
  try {
    if (current.status === 'queued' || current.status === 'collecting') {
      current = await update(current.id, { status: 'collecting' });
      current = await collect(current);
      return await update(current.id, { lease_until: null });
    }
    return await archiveStep(current);
  } catch (e) {
    if (e instanceof Fatal) return failJob(current, e.message);
    if (e instanceof Rebuild) {
      log({ outcome: 'rebuild', export_id: current.id, reason: e.message, attempts: current.attempts });
      if (current.attempts >= MAX_ATTEMPTS) return failJob(current, 'export_failed');
      return update(current.id, { status: 'collecting', lease_until: null, last_error_code: e.message });
    }
    const failures = current.step_failures + 1;
    log({ outcome: 'step_failed', export_id: current.id, failures, error: (e as Error).message.slice(0, 120) });
    if (failures >= MAX_STEP_FAILURES) return failJob(current, 'export_failed');
    // Back off (2, 4, 8, 16 s) by holding the lease.
    return update(current.id, { step_failures: failures, lease_until: new Date(Date.now() + 2 ** failures * 1000).toISOString() });
  }
}

async function accountIsDeleting(userId: string): Promise<boolean> {
  const { data } = await client.from('account_lifecycle').select('state').eq('user_id', userId).maybeSingle();
  return (data as { state?: string } | null)?.state === 'deleting';
}

// ── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return failed('method_not_allowed', 405);

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return failed('invalid_body', 400);
  }
  const action = body.action;
  if (!['status', 'request', 'advance', 'download'].includes(action as string)) return failed('invalid_action', 400);

  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  if (!token) return failed('invalid_token', 401);

  if (!SERVICE_KEY) {
    log({ outcome: 'server_key_unavailable' });
    return failed('server_misconfigured', 500);
  }

  try {
    // Deliberately not resolveCaller: that refuses accounts pending
    // deletion, and exporting their data is exactly what they may still do.
    const { data: userData, error: userError } = await client.auth.getUser(token);
    if (userError || !userData?.user) return failed('invalid_token', 401);
    const userId = userData.user.id;

    let job = await latestJob(userId);
    if (job && isOverdue(job)) job = await expireJob(job);

    if (action === 'status') return jsonResponse(view(job), 200);

    if ((action === 'request' || action === 'advance') && (await accountIsDeleting(userId))) {
      return failed('account_deleting', 403);
    }

    if (action === 'request') {
      if (!signedInRecently(token)) return failed('reauthentication_required', 403);
      if (job && ACTIVE.includes(job.status)) return jsonResponse(view(job), 200); // one at a time
      if (job?.status === 'ready') await expireJob(job); // a new export replaces a previous one
      const { data, error } = await client.from('account_exports').insert({ user_id: userId }).select('*').single();
      if (error) {
        if (error.code === '23505') return jsonResponse(view(await latestJob(userId)), 200);
        throw new Error(`job_create_failed: ${error.code}`);
      }
      log({ outcome: 'requested', export_id: (data as Job).id, user_id: userId });
      return jsonResponse(view(data as Job), 200);
    }

    if (action === 'advance') {
      if (!job || !ACTIVE.includes(job.status)) return jsonResponse(view(job), 200);
      return jsonResponse(view(await advance(job)), 200);
    }

    // download: one short-lived link per part
    if (!job || job.status !== 'ready') return failed('no_ready_export', 404);
    const parts = await partsOf(job.id);
    if (!parts.length || parts.some((p) => !p.completed)) return failed('no_ready_export', 404);
    const links = [];
    for (const p of parts) {
      const fileName = p.object_path.split('/').pop() ?? `part-${p.part}.zip`;
      const { data: signed, error: signError } = await client.storage.from(BUCKET)
        .createSignedUrl(p.object_path, SIGNED_URL_SECONDS, { download: fileName });
      if (signError || !signed) return failed('server_error', 500);
      links.push({ part: p.part, of: parts.length, file_name: fileName, bytes: Number(p.bytes_total), url: signed.signedUrl });
    }
    log({ outcome: 'download_links', export_id: job.id, user_id: userId, parts: parts.length });
    return jsonResponse({ status: 'ok', parts: links, url: links[0].url, expires_in: SIGNED_URL_SECONDS }, 200);
  } catch (e) {
    log({ outcome: 'error', action, error: (e as Error).message.slice(0, 160) });
    return failed('server_error', 500);
  }
});
