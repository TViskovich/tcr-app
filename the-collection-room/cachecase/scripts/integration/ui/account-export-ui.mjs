// Download My Data (Dashboard Milestone 2, Checkpoint 3) — UI test of the
// real screens (web build) against the LOCAL Supabase stack, plus the two
// Checkpoint 2 fixes (unknown account state; nothing running under the
// Pending Deletion screen). Disposable collector A, isolated browser
// contexts. The archive downloaded through the UI is validated with
// Python's zipfile (CRC checks).
//
// Prerequisites: same as account-deletion-ui.mjs (supabase start, local-only
// Metro on :8090, shell-proxy.mjs on :8091, functions served).
// Run:  node scripts/integration/ui/account-export-ui.mjs
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'account-export-ui';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-account-export-ui`;
mkdirSync(OUT, { recursive: true });

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{')));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(APP)) throw new Error(`Refusing: ${APP} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);

const results = [];
let current = '';
const step = (name) => {
  current = name;
  console.log(`\n${name}`);
};
function check(name, ok, detail) {
  results.push({ step: current, name, ok: !!ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
async function eventually(name, page, fn, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last === true) return check(name, true);
    } catch (e) {
      last = e.message;
    }
    await sleep(300);
  }
  await page.screenshot(`${OUT}/fail-${results.length}.png`);
  check(name, false, `${last ?? 'timed out'} (screenshot fail-${results.length}.png)`);
}

const run = randomUUID().replace(/-/g, '').slice(0, 5);
async function sweep() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const ids = data.users.filter((u) => u.app_metadata?.fixture === FIXTURE_TAG).map((u) => u.id);
  for (const id of ids) {
    await admin.from('account_lifecycle').delete().eq('user_id', id).eq('state', 'pending_deletion');
    for (const bucket of ['item-images', 'account-exports']) await removeAll(bucket, id);
    await admin.auth.admin.deleteUser(id);
  }
  return ids.length;
}
async function removeAll(bucket, prefix) {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  const files = (data ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
  for (const dir of (data ?? []).filter((o) => !o.id)) await removeAll(bucket, `${prefix}/${dir.name}`);
  if (files.length) await admin.storage.from(bucket).remove(files);
}

async function login(page, u) {
  await page.goto(`${APP}/login`);
  await page.waitForEl('testid', 'login-email-input', 60000);
  await page.type('testid', 'login-email-input', u.email);
  await page.type('testid', 'login-password-input', u.password);
  await page.tap('text', 'Log In');
  await page.waitFor('!location.pathname.includes("login")', 20000, 'leave login');
}
const path = (page) => page.eval('location.pathname');
const bodyHas = (page, text) => page.eval(`document.body.textContent.includes(${JSON.stringify(text)})`);
const labelEl = (label) => `[...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label') === ${JSON.stringify(label)}).pop()`;
const hasLabel = (page, label) => page.eval(`!!(${labelEl(label)})`);
async function tapLabel(page, label) {
  await page.waitFor(`!!(${labelEl(label)})`, 20000, label);
  const unobstructed = `(() => { const el = ${labelEl(label)}; if (!el) return false; const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && el.contains(hit); })()`;
  for (let i = 0; i < 10 && !(await page.eval(unobstructed)); i++) {
    await page.eval(`${labelEl(label)}?.scrollIntoView({ block: 'center' })`);
    await sleep(400);
  }
  await page.tap('label', label);
}
async function fill(page, label, text) {
  await page.waitFor(`!!(${labelEl(label)})`, 20000, label);
  await page.eval(`(() => { const el = ${labelEl(label)}; el.focus(); el.select(); })()`);
  await page.send('Input.insertText', { text });
  await sleep(250);
}
// window.open → recorded (the Download button opens the signed link).
const captureOpens = (page) => page.eval(`(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; })()`);
const reachable = (url) => url.replace(/^https?:\/\/[^/]+/, st.API_URL);
function zipCheck(bytes, label) {
  const file = `${OUT}/${label}.zip`;
  writeFileSync(file, bytes);
  return JSON.parse(execFileSync('python3', ['-I', '-c', `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({'bad': z.testzip(), 'names': z.namelist(), 'items': json.loads(z.read('items/items.json'))}))
`, file], { encoding: 'utf8' }));
}
async function requestExport(page, u, startLabel = 'Request my data') {
  await tapLabel(page, startLabel);
  await fill(page, 'Password for Download My Data', u.password);
  await tapLabel(page, 'Prepare my data');
}

async function scenario(p, A) {
  // A has a public collection with a photographed item.
  const folder = randomUUID();
  const item = randomUUID();
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  await db.auth.signInWithPassword({ email: A.email, password: A.password });
  await db.from('folders').insert({ id: folder, user_id: A.id, name: 'UI Binder', is_public: true });
  await db.from('collection_items').insert({ id: item, folder_id: folder, user_id: A.id, title: `UI Card ${run}`, item_type: 'sports_card', is_public: true, collection_status: 'active' });
  const photoPath = `${A.id}/${item}/p.jpg`;
  await db.storage.from('item-images').upload(photoPath, randomBytes(300_000), { contentType: 'image/jpeg' });
  await db.from('collection_item_images').insert({ item_id: item, user_id: A.id, image_url: photoPath, storage_path: photoPath, is_primary: true });

  step('0. Sign in');
  await login(p.A, A);
  check('signed in', true);

  step('1. Dashboard → Download My Data');
  await p.A.goto(`${APP}/dashboard`);
  await tapLabel(p.A, 'Download My Data');
  await eventually('the export screen offers a request', p.A, async () => (await path(p.A)) === '/account/export' && (await hasLabel(p.A, 'Request my data')));
  check('it explains what is (and isn’t) included', (await bodyHas(p.A, 'original photos')) && (await bodyHas(p.A, 'Messages other collectors sent you aren’t included')));
  await tapLabel(p.A, 'Request my data');
  await fill(p.A, 'Password for Download My Data', 'wrong-password');
  await tapLabel(p.A, 'Prepare my data');
  await eventually('a wrong password is explained; nothing is requested', p.A, async () => (await bodyHas(p.A, 'That password isn’t right'))
    && ((await admin.from('account_exports').select('id').eq('user_id', A.id)).data ?? []).length === 0);
  await fill(p.A, 'Password for Download My Data', A.password);
  await tapLabel(p.A, 'Prepare my data');
  await eventually('Preparing… with progress', p.A, () => bodyHas(p.A, 'Preparing…'), 15000);
  await p.A.screenshot(`${OUT}/01-preparing.png`);
  await eventually('Ready to Download (driven by the open screen)', p.A, () => bodyHas(p.A, 'Ready to Download'), 90000);
  check('size and "available until" date are shown', await p.A.eval(`/KB|MB/.test(document.body.textContent) && document.body.textContent.includes('available until')`));
  await p.A.screenshot(`${OUT}/02-ready.png`);
  await captureOpens(p.A);
  await tapLabel(p.A, 'Download my data');
  await eventually('Download opens a short-lived signed link', p.A, async () => (await p.A.eval('(window.__opened ?? []).length')) === 1);
  const url = (await p.A.eval('window.__opened[0]'));
  const zip = zipCheck(Buffer.from(await (await fetch(reachable(url))).arrayBuffer()), 'ui-active');
  check('the downloaded file is a valid ZIP with the item and its photo', zip.bad === null && zip.items[0]?.title === `UI Card ${run}`
    && zip.names.includes(`media/item-images/${item}/p.jpg`), { bad: zip.bad, names: zip.names.slice(0, 20) });

  step('2. Failed, Expired and unavailable states');
  const { data: job } = await admin.from('account_exports').select('id').eq('user_id', A.id).single();
  await admin.from('account_exports').update({ expires_at: new Date(Date.now() - 86_400_000).toISOString() }).eq('id', job.id);
  await p.A.goto(`${APP}/account/export`);
  await eventually('an overdue export shows Expired and offers a new request', p.A, async () =>
    (await bodyHas(p.A, 'Expired')) && (await hasLabel(p.A, 'Request my data again')));
  await admin.from('account_exports').update({ status: 'failed', last_error_code: 'export_failed', object_path: null }).eq('id', job.id);
  await p.A.goto(`${APP}/account/export`);
  await eventually('a failed export shows Failed with Try again', p.A, async () => (await bodyHas(p.A, 'Failed')) && (await hasLabel(p.A, 'Try again')));
  check('…and the support email', await bodyHas(p.A, 'If it keeps failing, contact info@cachecase.com.'));
  await captureOpens(p.A);
  await tapLabel(p.A, 'Email support at info@cachecase.com');
  await eventually('tapping it opens an email draft to info@cachecase.com', p.A, async () =>
    (await p.A.eval('JSON.stringify(window.__opened)')) === JSON.stringify(['mailto:info@cachecase.com?subject=CacheCase%20Download%20My%20Data']));
  await p.A.fakeRequests([{ match: /\/functions\/v1\/account-export/, status: 404, body: { message: 'Function not found' } }]);
  await p.A.goto(`${APP}/account/export`);
  await eventually('when the backend isn’t available the feature says so (no working-looking button)', p.A, async () =>
    (await bodyHas(p.A, 'isn’t available right now')) && !(await hasLabel(p.A, 'Request my data')));
  await p.A.fakeRequests([]);

  step('3. Pending deletion: Download My Data on the Pending screen');
  await admin.rpc('schedule_account_deletion', { p_user_id: A.id });
  await p.A.goto(`${APP}/dashboard`);
  await eventually('A lands on Pending Deletion', p.A, async () => (await path(p.A)) === '/account/pending');
  // The last export was forced to Failed in step 2, so it offers Try again.
  await eventually('the Pending screen offers Download My Data (showing the last export: Failed)', p.A, async () =>
    (await bodyHas(p.A, 'Download My Data')) && (await hasLabel(p.A, 'Try again')));
  await eventually('the Pending screen also offers Delete Permanently Now', p.A, () => hasLabel(p.A, 'Delete permanently now'));
  // CP2 fix: nothing of the app keeps loading underneath.
  await p.A.fakeRequests([]); // record requests from here on (nothing faked)
  await sleep(6000);
  const noise = p.A.requestUrls.filter((u) => u.includes('/rest/v1/') && !u.includes('/rest/v1/account_lifecycle'));
  check('no app data requests run underneath the Pending screen', noise.length === 0, noise.slice(0, 5));
  await requestExport(p.A, A, 'Try again');
  await eventually('a pending collector’s export becomes ready', p.A, () => bodyHas(p.A, 'Ready to Download'), 90000);
  await captureOpens(p.A);
  await tapLabel(p.A, 'Download my data');
  await eventually('the download link opens', p.A, async () => (await p.A.eval('(window.__opened ?? []).length')) === 1);
  const pendingZip = zipCheck(Buffer.from(await (await fetch(reachable(await p.A.eval('window.__opened[0]')))).arrayBuffer()), 'ui-pending');
  check('the pending collector’s archive is valid and complete', pendingZip.bad === null && pendingZip.items.length === 1);
  await p.A.screenshot(`${OUT}/03-pending-export.png`);
  await admin.rpc('cancel_account_deletion', { p_user_id: A.id });

  step('4. First launch offline: the app is not shown until the state is known');
  await p.Fresh.fakeRequests([]);
  await login(p.Fresh, A);
  await eventually('(fresh device signed in normally)', p.Fresh, async () => (await path(p.Fresh)) !== '/login');
  await p.Fresh.eval('Object.keys(localStorage).filter(k => k.startsWith("cachecase.account-lifecycle.")).forEach(k => localStorage.removeItem(k))');
  await p.Fresh.fakeRequests([{ match: /\/rest\/v1\/account_lifecycle/, fail: true }]);
  await p.Fresh.goto(`${APP}/dashboard`);
  await eventually('state unknown → "Can’t reach CacheCase", not the app', p.Fresh, async () =>
    (await bodyHas(p.Fresh, 'Can’t reach CacheCase')) && (await hasLabel(p.Fresh, 'Try again')));
  await p.Fresh.screenshot(`${OUT}/04-unknown.png`);
  await p.Fresh.fakeRequests([]);
  await eventually('once reachable, it retries by itself and shows the app', p.Fresh, async () =>
    !(await bodyHas(p.Fresh, 'Can’t reach CacheCase')) && (await bodyHas(p.Fresh, 'Analytics')), 20000);
  await p.Fresh.fakeRequests([{ match: /\/rest\/v1\/account_lifecycle/, fail: true }]);
  await p.Fresh.goto(`${APP}/dashboard`);
  await sleep(3000);
  check('offline with a known (cached) active state: the app is shown', (await bodyHas(p.Fresh, 'Analytics')) && !(await bodyHas(p.Fresh, 'Can’t reach CacheCase')));
  await p.Fresh.fakeRequests([]);
}

console.log(`App ${APP} → Supabase ${st.API_URL}  (run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
const username = `xu${run}a`;
const email = `${username}@example.test`;
const password = `xu-${randomUUID()}`;
const { data: created, error } = await admin.auth.admin.createUser({
  email, password, email_confirm: true, user_metadata: { username, display_name: 'Export Ana' }, app_metadata: { fixture: FIXTURE_TAG },
});
if (error) throw error;
const A = { id: created.user.id, email, password, username };
const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
const pages = {};
let fatal = null;
try {
  for (const key of ['A', 'Fresh']) pages[key] = await browser.newPage(key);
  await scenario(pages, A);
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${current}": ${e.message}`);
  for (const [key, pg] of Object.entries(pages)) await pg.screenshot(`${OUT}/abort-${key}.png`).catch(() => {});
} finally {
  await browser.close();
  console.log(`\nCleanup: ${await sweep()} accounts removed.`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
