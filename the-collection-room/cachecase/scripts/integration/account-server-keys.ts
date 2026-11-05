/// <reference types="node" />
// Server-side Supabase keys (secret API keys vs legacy service-role JWT) —
// LOCAL Supabase only, disposable collectors only.
//
// MODE=configured — run once with the functions using the legacy JWT, and
//   once with ONLY a secret key (legacy key ignored). Checks:
//   * account-maintenance and account-monitor accept only
//     ACCOUNT_MAINTENANCE_SECRET: no credentials, a wrong secret, the legacy
//     service-role JWT, or a secret key (as Bearer or apikey) → 403;
//   * account-export has no sweep action;
//   * the maintenance worker expires a real 7-day-old export and fails a
//     real abandoned one (resumable upload terminated, files and plan rows
//     removed) IN-PROCESS — no request reaches account-export;
//   * no key value appears in any response or the function logs.
// MODE=unavailable — functions served with no usable server key (legacy
//   ignored, and a missing or malformed secret key): every privileged
//   function fails closed with a 500 and no key material; unauthorized
//   maintenance callers still get 403 first.
//
// Functions env (see the report / runbook): ACCOUNT_MAINTENANCE_SECRET,
// ACCOUNT_RECENT_AUTH_SECONDS=8, ACCOUNT_EXPORT_PART_BYTES=3145728, and for
// the key path (honoured only against a local stack):
//   secret only   CACHECASE_LOCAL_DISABLE_LEGACY_KEY=1   (EXPECT_KEY_SOURCE=SUPABASE_SECRET_KEYS)
//   legacy only   CACHECASE_LOCAL_DISABLE_SECRET_KEYS=1  (EXPECT_KEY_SOURCE=SUPABASE_SERVICE_ROLE_KEY)
//   no key        both                                   (MODE=unavailable)
//   malformed     both + CACHECASE_LOCAL_SECRET_KEYS={"default":"not-a-key"} (MODE=unavailable)
// Run:  MODE=… EXPECT_KEY_SOURCE=… MAINTENANCE_SECRET_FILE=… FUNCTIONS_LOG=… node scripts/integration/account-server-keys.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const MODE = process.env.MODE ?? 'configured';
const secret = readFileSync(process.env.MAINTENANCE_SECRET_FILE ?? '', 'utf8').trim();
const LOG = process.env.FUNCTIONS_LOG ?? '';
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'server-keys-it';
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const KEYS = [st.SERVICE_ROLE_KEY, st.SECRET_KEY, secret]; // must never appear in output

const results: { name: string; ok: boolean }[] = [];
let section = '';
const step = (s: string) => {
  section = s;
  console.log(`\n${s}`);
};
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name: `[${section}] ${name}`, ok });
  const shown = detail === undefined ? '' : JSON.stringify(detail).slice(0, 300);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && shown && !KEYS.some((k) => shown.includes(k)) ? `  — ${shown}` : ''}`);
}
const texts: string[] = [];
async function fn(name: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${st.API_URL}/functions/v1/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const text = await res.text();
  texts.push(text);
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
const bearer = (t: string) => ({ apikey: st.ANON_KEY, Authorization: `Bearer ${t}` });
const logCount = (pattern: string) => (LOG ? readFileSync(LOG, 'utf8').split(pattern).length - 1 : 0);

type User = { id: string; email: string; password: string; db: SupabaseClient; token: string };
const run = randomUUID().replace(/-/g, '').slice(0, 5);
const users: User[] = [];
async function createUser(key: string): Promise<User> {
  const username = `sk${run}${key}`;
  const email = `${username}@example.test`;
  const password = `sk-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE } });
  if (error) throw error;
  const u: User = { id: data.user.id, email, password, db: createClient(st.API_URL, st.ANON_KEY, opts), token: '' };
  await signIn(u);
  users.push(u);
  return u;
}
async function signIn(u: User) {
  const { data, error } = await u.db.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw error;
  u.token = data.session.access_token;
}
async function removeAll(bucket: string, prefix: string) {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  const files = (data ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
  for (const dir of (data ?? []).filter((o) => !o.id)) await removeAll(bucket, `${prefix}/${dir.name}`);
  if (files.length) await admin.storage.from(bucket).remove(files);
}
const listAll = async (bucket: string, prefix: string): Promise<string[]> => {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  const out = (data ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
  for (const dir of (data ?? []).filter((o) => !o.id)) out.push(...(await listAll(bucket, `${prefix}/${dir.name}`)));
  return out;
};

let fatal: unknown = null;
try {
  const X = await createUser('x');

  if (MODE === 'unavailable') {
    step('No usable server key: fail closed');
    const unauthorized = await fn('account-maintenance', {}, bearer('wrong'.repeat(10)));
    check('maintenance: an unauthorized caller still gets 403 first', unauthorized.status === 403);
    const m = await fn('account-maintenance', {}, bearer(secret));
    check('maintenance with the right secret: 500 server_misconfigured (nothing runs)', m.status === 500 && m.json?.reason === 'server_misconfigured', m.json);
    const mon = await fn('account-monitor', {}, bearer(secret));
    check('monitor: 500 server_misconfigured', mon.status === 500 && mon.json?.reason === 'server_misconfigured', mon.json);
    const monTest = await fn('account-monitor', { action: 'test' }, bearer(secret));
    check('monitor test email: 500, nothing sent', monTest.status === 500, monTest.json);
    const exp = await fn('account-export', { action: 'status' }, bearer(X.token));
    check('account-export (signed-in collector): 500 server_misconfigured', exp.status === 500 && exp.json?.reason === 'server_misconfigured', exp.json);
    const del = await fn('account-deletion', { action: 'status' }, bearer(X.token));
    check('account-deletion: refuses (5xx)', del.status >= 500, del.status);
    const ds = await fn('account-deletion-status', { token: randomBytes(32).toString('base64url') }, { apikey: st.PUBLISHABLE_KEY, Authorization: `Bearer ${st.PUBLISHABLE_KEY}` });
    check('account-deletion-status: refuses (5xx), never answers a state', ds.status >= 500 && !ds.json?.state, ds.status);
    const cover = await fn('get-collection-item-image-signed-url', { image_ids: [randomUUID()] }, { apikey: st.ANON_KEY });
    check('a shared-client function (signed URLs): refuses (5xx)', cover.status >= 500, cover.status);
  } else {
    step('1. Maintenance and monitoring accept only ACCOUNT_MAINTENANCE_SECRET');
    const attempts: [string, Record<string, string>][] = [
      ['no credentials', {}],
      ['a wrong secret', bearer(randomBytes(32).toString('hex'))],
      ['the legacy service-role JWT', bearer(st.SERVICE_ROLE_KEY)],
      ['a secret API key as Bearer', bearer(st.SECRET_KEY)],
      ['a secret API key on apikey only', { apikey: st.SECRET_KEY }],
    ];
    for (const [label, headers] of attempts) {
      const a = await fn('account-maintenance', {}, headers);
      const b = await fn('account-monitor', {}, headers);
      const c = await fn('account-monitor', { action: 'test' }, headers);
      check(`${label}: maintenance 403, monitor 403, monitor test 403`, a.status === 403 && b.status === 403 && c.status === 403, [a.status, b.status, c.status]);
    }
    const ok = await fn('account-maintenance', {}, bearer(secret));
    check('the maintenance secret runs the worker', ok.status === 200 && ok.json?.status === 'ok', ok.json?.status);
    if (process.env.EXPECT_KEY_SOURCE && LOG) {
      await sleep(500);
      const runs = readFileSync(LOG, 'utf8').match(/"key_kind":"[a-z_]+","key_source":"[A-Z_]+"/g) ?? [];
      check(`the functions really use ${process.env.EXPECT_KEY_SOURCE}`, (runs.at(-1) ?? '').includes(`"key_source":"${process.env.EXPECT_KEY_SOURCE}"`), runs.at(-1));
    }
    const okMon = await fn('account-monitor', {}, bearer(secret));
    check('…and the monitor', okMon.status === 200 && okMon.json?.status === 'ok', okMon.json?.status);

    // Two collectors, so nothing but the worker can expire Y's export (a new
    // request by the same collector would replace it).
    const Y = await createUser('y');
    const seedPhotos = async (u: User) => {
      for (const [i, mb] of [[1, 4.2], [2, 3.6]] as const) {
        const folder = randomUUID();
        const item = randomUUID();
        await u.db.from('folders').insert({ id: folder, user_id: u.id, name: `Binder ${i}`, is_public: true });
        await u.db.from('collection_items').insert({ id: item, folder_id: folder, user_id: u.id, title: `Card ${i}`, item_type: 'sports_card', is_public: true, collection_status: 'active' });
        const path = `${u.id}/${item}/photo.jpg`;
        await u.db.storage.from('item-images').upload(path, randomBytes(Math.round(mb * 1048576)), { contentType: 'image/jpeg' });
        await u.db.from('collection_item_images').insert({ item_id: item, user_id: u.id, image_url: path, storage_path: path, sort_order: 0 });
      }
    };
    await seedPhotos(Y);
    await seedPhotos(X);

    step('2. A real export through resumable uploads (collector Y)');
    await signIn(Y);
    check('request accepted', (await fn('account-export', { action: 'request' }, bearer(Y.token))).status === 200);
    let state = '';
    for (let i = 0; i < 200 && !['ready', 'failed'].includes(state); i++) {
      state = (await fn('account-export', { action: 'advance' }, bearer(Y.token))).json?.export?.state;
      await sleep(100);
    }
    const e1 = (await admin.from('account_exports').select('*').eq('user_id', Y.id).order('created_at', { ascending: false }).limit(1).single()).data;
    check('the export completes, in several parts', state === 'ready' && (e1?.part_count ?? 0) >= 2, { state, parts: e1?.part_count });
    const dl = await fn('account-export', { action: 'download' }, bearer(Y.token));
    const firstPart = dl.json?.parts?.[0];
    const zip = firstPart ? new Uint8Array(await (await fetch(String(firstPart.url).replace(/^https?:\/\/[^/]+/, st.API_URL))).arrayBuffer()) : new Uint8Array();
    check('part 1 downloads as a ZIP of the stated size', zip.length === firstPart?.bytes && zip[0] === 0x50 && zip[1] === 0x4b, { got: zip.length, want: firstPart?.bytes });
    check('its files are in Storage', (await listAll('account-exports', `${Y.id}/${e1?.id}`)).length >= 2);

    step('3. An abandoned export with a live resumable upload (collector X)');
    await signIn(X);
    check('a new request is accepted', (await fn('account-export', { action: 'request' }, bearer(X.token))).status === 200);
    let e2: any = null;
    for (let i = 0; i < 60; i++) {
      await fn('account-export', { action: 'advance' }, bearer(X.token));
      e2 = (await admin.from('account_exports').select('*').eq('user_id', X.id).order('created_at', { ascending: false }).limit(1).single()).data;
      const { data: parts } = await admin.from('account_export_parts').select('upload_url, completed').eq('export_id', e2.id);
      if (e2.status === 'archiving' && (parts ?? []).some((p: any) => p.upload_url && !p.completed)) break;
      await sleep(100);
    }
    const { data: liveParts } = await admin.from('account_export_parts').select('upload_url, completed').eq('export_id', e2.id);
    const uploadUrl = (liveParts ?? []).find((p: any) => p.upload_url && !p.completed)?.upload_url as string | undefined;
    check('it is mid-archive with a resumable upload in progress', e2?.status === 'archiving' && !!uploadUrl, e2?.status);
    const tusHead = async () => uploadUrl ? (await fetch(uploadUrl.replace(/^https?:\/\/[^/]+/, st.API_URL), { method: 'HEAD', headers: { apikey: st.SECRET_KEY, 'Tus-Resumable': '1.0.0' } })).status : 0;
    check('the upload is live (HEAD 200)', (await tusHead()) === 200);

    step('4. The worker cleans up both, in-process');
    psql(`update public.account_exports set expires_at = now() - interval '1 second' where id = '${e1.id}';
          update public.account_exports set updated_at = now() - interval '25 hours', lease_until = null where id = '${e2.id}';`);
    const exportCallsBefore = logCount('serving the request with supabase/functions/account-export');
    const w = await fn('account-maintenance', {}, bearer(secret));
    check('worker run: exports ok, 1+ expired and 1+ abandoned', w.json?.exports?.status === 'ok' && w.json?.exports?.expired >= 1 && w.json?.exports?.abandoned >= 1, w.json?.exports);
    await sleep(1500);
    if (LOG) check('no request reached account-export during the run', logCount('serving the request with supabase/functions/account-export') === exportCallsBefore);
    const after1 = (await admin.from('account_exports').select('status, object_path').eq('id', e1.id).single()).data;
    const after2 = (await admin.from('account_exports').select('status, last_error_code').eq('id', e2.id).single()).data;
    check('Y’s overdue export is expired by the worker', after1?.status === 'expired' && after1?.object_path === null, after1);
    check('the abandoned one is failed export_abandoned', after2?.status === 'failed' && after2?.last_error_code === 'export_abandoned', after2);
    check('all their files are removed', (await listAll('account-exports', `${Y.id}/${e1.id}`)).length === 0 && (await listAll('account-exports', `${X.id}/${e2.id}`)).length === 0);
    check('their parts and plan rows are removed', psql(`select (select count(*) from public.account_export_parts where export_id in ('${e1.id}','${e2.id}')) + (select count(*) from public.account_export_entries where export_id in ('${e1.id}','${e2.id}'))`) === '0');
    const head = await tusHead();
    check('the resumable upload was terminated', head === 404 || head === 410, head);
    check('account-export has no sweep action', (await fn('account-export', { action: 'sweep' }, bearer(X.token))).json?.reason === 'invalid_action');
  }

  step('No key values exposed');
  check('no key or secret in any response', !texts.some((t) => KEYS.some((k) => t.includes(k))));
  if (LOG) {
    const log = readFileSync(LOG, 'utf8');
    check('no key or secret in the function logs', !KEYS.some((k) => log.includes(k)));
  }
} catch (e) {
  fatal = e;
  const msg = (e as Error).message;
  console.error(`Aborted in "${section}": ${KEYS.some((k) => msg.includes(k)) ? '<message withheld: contained a key>' : msg}`);
} finally {
  for (const u of users) {
    for (const bucket of ['item-images', 'account-exports']) await removeAll(bucket, u.id);
    await admin.auth.admin.deleteUser(u.id); // disposable fixtures only
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${MODE}: ${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
process.exitCode = failed.length || fatal ? 1 : 0;
