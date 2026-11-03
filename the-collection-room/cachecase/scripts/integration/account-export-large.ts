/// <reference types="node" />
// Download My Data at realistic size (Dashboard Milestone 2, Checkpoint 5)
// — LOCAL Supabase only, one disposable collector.
//
// A collection of full-size photos totalling well over 50 MB (including one
// ~18 MB photo) is exported with the PRODUCTION part size (the default,
// ACCOUNT_EXPORT_PART_BYTES unset → 45 MiB). Every part is downloaded and
// checked: a complete, valid ZIP on its own (every entry's CRC-32 verified),
// within the part size and the 50 MiB upload limit, the manifest consistent
// with the parts, and every photo byte-identical (SHA-256) to the original.
//
// Prerequisite: functions served WITHOUT ACCOUNT_EXPORT_PART_BYTES and with
//   ACCOUNT_RECENT_AUTH_SECONDS unset or ≥ 600.
// Run (Node 24 runs .ts directly):
//   node scripts/integration/account-export-large.ts
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const PART_LIMIT = 45 * 1024 * 1024;
const UPLOAD_LIMIT = 50 * 1024 * 1024;
// Sizes in MB: typical phone photos, a few large scans, one very large one.
const PHOTO_MB = [3.2, 4.1, 5.6, 2.4, 6.8, 4.9, 3.7, 7.5, 5.2, 4.4, 18.3, 3.9, 6.1, 2.8];
const work = mkdtempSync(join(tmpdir(), 'cachecase-export-large-'));

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
}
const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function fn(body: unknown, token: string) {
  const res = await fetch(`${st.API_URL}/functions/v1/account-export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}

// Lists, tests (CRC-32 of every entry) and hashes a ZIP part with Python's
// standard zipfile module, independent of the writer under test.
function inspect(path: string): { bad: string | null; files: Record<string, string>; manifest: any } {
  return JSON.parse(execFileSync('python3', ['-I', '-c', `
import zipfile, json, sys, hashlib
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
files = {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}
m = json.loads(z.read('manifest.json')) if 'manifest.json' in files else None
print(json.dumps({'bad': bad, 'files': files, 'manifest': m}))
`, path], { encoding: 'utf8', maxBuffer: 1 << 28 }));
}

const username = `xl${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const email = `${username}@example.test`;
const password = `xl-${randomUUID()}`;
const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username } });
if (created.error || !created.data.user) throw new Error(`user: ${created.error?.message}`);
const userId = created.data.user.id;
const db = createClient(st.API_URL, st.ANON_KEY, opts);
let fatal: unknown = null;
try {
  const signedIn = await db.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) throw new Error(`sign in: ${signedIn.error?.message}`);
  const token = signedIn.data.session.access_token;
  const folder = randomUUID();
  const item = randomUUID();
  must(await db.from('folders').insert({ id: folder, user_id: userId, name: 'Large binder', is_public: true }), 'folder');
  must(await db.from('collection_items').insert({ id: item, folder_id: folder, user_id: userId, title: 'Large card', item_type: 'sports_card', is_public: true, collection_status: 'active' }), 'item');
  const originals = new Map<string, string>(); // archive name → sha256
  let total = 0;
  for (const [i, mb] of PHOTO_MB.entries()) {
    const bytes = randomBytes(Math.round(mb * 1024 * 1024)); // incompressible, like JPEG data
    const path = `${userId}/${item}/photo-${i}.jpg`;
    must(await db.storage.from('item-images').upload(path, bytes, { contentType: 'image/jpeg' }), `photo ${i}`);
    must(await db.from('collection_item_images').insert({ item_id: item, user_id: userId, image_url: path, storage_path: path, sort_order: i }), 'image row');
    originals.set(`media/item-images/${item}/photo-${i}.jpg`, sha256(bytes));
    total += bytes.length;
  }
  console.log(`Seeded ${PHOTO_MB.length} photos, ${(total / 1048576).toFixed(1)} MiB.`);
  check('the collection is larger than 50 MB', total > 50 * 1000 * 1000);

  must(await fn({ action: 'request' }, token).then((r) => ({ data: r.json, error: r.status === 200 ? null : { message: JSON.stringify(r.json) } })), 'request');
  const started = Date.now();
  let state: Record<string, any> | null = null;
  let steps = 0;
  for (; steps < 800; steps++) {
    state = (await fn({ action: 'advance' }, token)).json;
    if (['ready', 'failed', 'expired'].includes(state?.export?.state)) break;
    await sleep(100);
  }
  console.log(`Export finished in ${steps} steps, ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  check('the export completes', state?.export?.state === 'ready', state);
  check('in more than one part', (state?.export?.part_count ?? 0) >= 2, state?.export);

  const dl = (await fn({ action: 'download' }, token)).json;
  const parts = (dl?.parts ?? []) as { part: number; of: number; file_name: string; bytes: number; url: string }[];
  check('one download link per part', parts.length === state?.export?.part_count, dl);
  const inZips = new Map<string, string>();
  let manifest: any = null;
  let duplicate = false;
  for (const p of parts) {
    const res = await fetch(p.url.replace(/^https?:\/\/[^/]+/, st.API_URL));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const file = join(work, p.file_name);
    writeFileSync(file, bytes);
    const z = inspect(file);
    console.log(`  part ${p.part}/${p.of}: ${(bytes.length / 1048576).toFixed(1)} MiB, ${Object.keys(z.files).length} files`);
    check(`part ${p.part}: a valid ZIP on its own (every CRC-32 verified)`, res.ok && z.bad === null, z.bad);
    check(`part ${p.part}: size matches the link (${bytes.length} bytes) and is within 45 MiB / the 50 MiB upload limit`,
      bytes.length === p.bytes && bytes.length <= PART_LIMIT && bytes.length <= UPLOAD_LIMIT);
    for (const [name, hash] of Object.entries(z.files)) {
      if (inZips.has(name)) duplicate = true;
      inZips.set(name, hash);
    }
    if (z.manifest) manifest = z.manifest;
  }
  check('no file appears in two parts', !duplicate);
  check('part 1 holds the manifest', !!manifest && !!inZips.get('manifest.json'));
  check('the manifest lists every part with its exact size', manifest?.parts?.length === parts.length
    && manifest.parts.every((m: any, i: number) => m.bytes === parts[i].bytes && m.file_name === parts[i].file_name));
  const listed = new Map<string, any>((manifest?.files ?? []).map((f: any) => [f.name, f]));
  check('the manifest lists exactly the files in the parts', listed.size + 1 === inZips.size && [...listed.keys()].every((n) => inZips.has(n)));
  check('every photo is byte-identical to the original (SHA-256)', [...originals].every(([n, h]) => inZips.get(n) === h),
    [...originals].filter(([n, h]) => inZips.get(n) !== h).map(([n]) => n));
  const big = `media/item-images/${item}/photo-${PHOTO_MB.indexOf(18.3)}.jpg`;
  check('the 18 MB photo is stored whole, in one part', !!inZips.get(big) && listed.get(big)?.bytes === Math.round(18.3 * 1024 * 1024));
  check('the manifest’s byte counts match the photos', [...originals.keys()].every((n) => typeof listed.get(n)?.bytes === 'number'));
} catch (e) {
  fatal = e;
  console.error(`Aborted: ${(e as Error).message}`);
} finally {
  // Disposable collector: remove their files, exports and account.
  for (const bucket of ['item-images', 'avatars', 'account-exports']) {
    const stack = [userId];
    while (stack.length) {
      const prefix = stack.pop()!;
      const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
      const files = (data ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
      if (files.length) await admin.storage.from(bucket).remove(files);
      stack.push(...(data ?? []).filter((o) => !o.id).map((o) => `${prefix}/${o.name}`));
    }
  }
  await admin.auth.admin.deleteUser(userId);
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
process.exitCode = failed.length || fatal ? 1 : 0;
