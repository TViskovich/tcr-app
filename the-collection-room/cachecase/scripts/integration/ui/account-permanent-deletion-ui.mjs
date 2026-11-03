// Permanent account deletion (Dashboard Milestone 2, Checkpoint 4) — UI test
// of the real screens (web build) against the LOCAL Supabase stack, with
// disposable collectors in isolated browser contexts:
//   A  — chooses Delete Permanently Now from the Dashboard
//   A2 — checks the "not available" state when the backend isn't ready
//   B  — a collector with a DM and posts involving A's content
//
// Prerequisites: same as account-deletion-ui.mjs, plus the functions served
// with ACCOUNT_MAINTENANCE_SECRET and the local Vault secrets (see
// scripts/integration/account-permanent-deletion.ts).
// Run:  node scripts/integration/ui/account-permanent-deletion-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'permanent-deletion-ui';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-permanent-deletion-ui`;
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
const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const run = randomUUID().replace(/-/g, '').slice(0, 5);
async function removeAll(bucket, prefix) {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  const files = (data ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
  for (const dir of (data ?? []).filter((o) => !o.id)) await removeAll(bucket, `${prefix}/${dir.name}`);
  if (files.length) await admin.storage.from(bucket).remove(files);
}
async function sweep() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const ids = data.users.filter((u) => u.app_metadata?.fixture === FIXTURE_TAG).map((u) => u.id);
  for (const id of ids) {
    await admin.from('account_lifecycle').delete().eq('user_id', id).eq('state', 'pending_deletion');
    for (const bucket of ['item-images', 'avatars', 'share-snapshots']) await removeAll(bucket, id);
    await admin.auth.admin.deleteUser(id);
  }
  return ids.length;
}
async function createUser(key, displayName) {
  const username = `pu${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `pu-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username, display_name: displayName }, app_metadata: { fixture: FIXTURE_TAG },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: e } = await db.auth.signInWithPassword({ email, password });
  if (e) throw e;
  return { id: data.user.id, username, email, password, name: displayName, db };
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

async function scenario(p, A, A2, B) {
  // A's item; B's posts that copied it; an A↔B conversation.
  const folder = randomUUID();
  const item = randomUUID();
  must(await A.db.from('folders').insert({ id: folder, user_id: A.id, name: 'Gone Binder', is_public: true }), 'folder');
  must(await A.db.from('collection_items').insert({ id: item, folder_id: folder, user_id: A.id, title: `Gone Card ${run}`, item_type: 'sports_card', is_public: true, collection_status: 'active' }), 'item');
  must(await A.db.storage.from('item-images').upload(`${A.id}/${item}/p.jpg`, randomBytes(4000), { contentType: 'image/jpeg' }), 'photo');
  const bFolder = randomUUID();
  const bItem = randomUUID();
  must(await B.db.from('folders').insert({ id: bFolder, user_id: B.id, name: 'Stay Binder', is_public: true }), 'B folder');
  must(await B.db.from('collection_items').insert({ id: bItem, folder_id: bFolder, user_id: B.id, title: `Stay Card ${run}`, item_type: 'sports_card', is_public: true, collection_status: 'active' }), 'B item');
  const snap = `${B.id}/copy-of-a.jpg`;
  must(await admin.storage.from('share-snapshots').upload(snap, randomBytes(3000), { contentType: 'image/jpeg' }), 'snapshot');
  const snapUrl = admin.storage.from('share-snapshots').getPublicUrl(snap).data.publicUrl;
  const itemPost = randomUUID();
  must(await B.db.from('posts').insert({ id: itemPost, user_id: B.id, post_type: 'item', item_id: item, image_url: snapUrl, caption: `B loves it ${run}` }), 'item post');
  const sharePost = randomUUID();
  must(await B.db.from('posts').insert({ id: sharePost, user_id: B.id, post_type: 'card_share', content: `B card share ${run}` }), 'share post');
  must(await admin.from('card_share_items').insert([
    { post_id: sharePost, item_id: item, snapshot_image_url: snapUrl, snapshot_title: `Gone Card ${run}` },
    { post_id: sharePost, item_id: bItem, snapshot_image_url: null, snapshot_title: `Stay Card ${run}` },
  ]), 'share items');
  const conv = must(await A.db.rpc('get_or_create_conversation', { other_user_id: B.id }), 'conv');
  must(await A.db.from('messages').insert({ id: randomUUID(), conversation_id: conv, sender_id: A.id, body: `From A ${run}` }), 'A msg');
  must(await B.db.from('messages').insert({ id: randomUUID(), conversation_id: conv, sender_id: B.id, body: `From B ${run}` }), 'B msg');

  // Checkpoint 5: the maintenance job starts inactive; an operator activates
  // it (here: the local stack) before Delete Now is offered.
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-Atc',
    "select cron.alter_job(job_id := jobid, active := true) from cron.job where jobname = 'account-maintenance'"], { stdio: 'ignore' });

  step('0. Sign in');
  await login(p.A, A);
  await login(p.A2, A2);
  await login(p.B, B);
  check('signed in', true);

  step('1. Delete Permanently Now is offered only when the backend is ready');
  await p.A2.fakeRequests([{ match: /\/functions\/v1\/account-deletion/, status: 200,
    body: { status: 'ok', state: 'active', scheduled_for: null, requested_at: null, job: null, delete_now_available: false } }]);
  await p.A2.goto(`${APP}/account/delete`);
  await eventually('backend not ready → "not available", no button', p.A2, async () =>
    (await hasLabel(p.A2, 'Delete Permanently Now, not available right now')) && !(await hasLabel(p.A2, 'Delete permanently now')));
  await p.A2.fakeRequests([]);

  step('1b. Checkpoint 5: Delete Now whose answer is lost on the way back');
  // A2's request really reaches the server (deletion starts) but the app
  // gets a dropped connection: it must re-check and follow the deletion,
  // not report a failure.
  await p.A2.goto(`${APP}/account/delete`);
  await eventually('A2 sees Delete Permanently Now', p.A2, () => hasLabel(p.A2, 'Delete permanently now'));
  await tapLabel(p.A2, 'Delete permanently now');
  await fill(p.A2, 'Password for permanent deletion', A2.password);
  await fill(p.A2, 'Type DELETE to delete permanently', 'DELETE');
  await p.A2.fakeRequests([{ match: /\/functions\/v1\/account-deletion/, bodyMatch: /"delete_now"/, dropResponse: true }]);
  await tapLabel(p.A2, 'Permanently delete my account now');
  await eventually('the lost answer is detected and the deletion is followed', p.A2, async () =>
    (await bodyHas(p.A2, 'Your account is being deleted')) || (await bodyHas(p.A2, 'Your account has been deleted')), 60000);
  check('the response really was dropped', p.A2.fakedUrls.length >= 1, p.A2.requestUrls);
  check('no failure message was shown', !(await bodyHas(p.A2, 'Couldn’t reach CacheCase')) && !(await bodyHas(p.A2, 'Something went wrong')));
  await p.A2.fakeRequests([]);

  step('1c. Signed-out confirmation with the status capability, across a relaunch');
  // The lost Delete Now answer carried A2's status capability; the app must
  // have asked for a new one while still signed in.
  const stored = async () => JSON.parse(await p.A2.eval(`JSON.stringify({ cap: localStorage.getItem('cachecase.account-deletion-status'), legacy: localStorage.getItem('cachecase.account-deletion-job') })`));
  await eventually('this device holds a status capability (not a job id)', p.A2, async () => {
    const s = await stored();
    return !!s.cap && /^[A-Za-z0-9_-]{43}$/.test(JSON.parse(s.cap).token) && s.legacy === null;
  }, 30000);
  const a2Job = async () => (await admin.from('account_deletion_jobs').select('status').eq('user_id', A2.id).maybeSingle()).data?.status;
  for (let i = 0; i < 90 && (await a2Job()) !== 'completed'; i++) await sleep(1000);
  check('A2’s deletion completes on the server', (await a2Job()) === 'completed');
  await eventually('signed out, the app confirms completion with the capability', p.A2, () => bodyHas(p.A2, 'Your account has been deleted'), 60000);
  await p.A2.fakeRequests([]); // record requests from here on
  // Close and reopen the app: a full reload, nothing in memory survives.
  await p.A2.goto(`${APP}/login`);
  await eventually('after a relaunch the final notice is shown again', p.A2, () => bodyHas(p.A2, 'Your account has been deleted'), 30000);
  const urls = p.A2.requestUrls.filter((u) => u.includes('/functions/v1/'));
  check('…read from account-deletion-status, never from account-deletion', urls.some((u) => u.includes('/functions/v1/account-deletion-status'))
    && !urls.some((u) => /\/functions\/v1\/account-deletion(\?|$)/.test(u)), urls);
  // Backgrounding: coming back to the foreground checks at once.
  await p.A2.fakeRequests([{ match: /\/functions\/v1\/account-deletion-status/, status: 200, body: { status: 'ok', state: 'processing' } }]);
  await p.A2.goto(`${APP}/login`);
  await eventually('a deletion still running reads "being deleted"', p.A2, () => bodyHas(p.A2, 'Your account is being deleted'), 30000);
  const before = p.A2.fakedUrls.length;
  await p.A2.eval(`(() => { const set = (v) => Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    set('hidden'); document.dispatchEvent(new Event('visibilitychange')); set('visible'); document.dispatchEvent(new Event('visibilitychange')); })()`);
  await sleep(1200);
  check('returning to the foreground checks again straight away (before the next poll)', p.A2.fakedUrls.length > before, { before, after: p.A2.fakedUrls.length });
  // A failed deletion, and a capability the server no longer accepts.
  await p.A2.fakeRequests([{ match: /\/functions\/v1\/account-deletion-status/, status: 200, body: { status: 'ok', state: 'failed' } }]);
  await p.A2.goto(`${APP}/login`);
  await eventually('failed: "Deletion isn’t finished yet", with support', p.A2, async () => (await bodyHas(p.A2, 'Deletion isn’t finished yet'))
    && (await bodyHas(p.A2, 'info@cachecase.com')), 30000);
  await p.A2.fakeRequests([{ match: /\/functions\/v1\/account-deletion-status/, status: 401, body: { status: 'failed', reason: 'invalid_capability' } }]);
  await p.A2.goto(`${APP}/login`);
  await eventually('an expired or revoked capability: "We couldn’t confirm your deletion" (never "deleted")', p.A2, async () =>
    (await bodyHas(p.A2, 'We couldn’t confirm your deletion')) && !(await bodyHas(p.A2, 'Your account has been deleted')), 30000);
  await p.A2.fakeRequests([]);
  await p.A2.goto(`${APP}/login`);
  await eventually('back to the real answer: deleted', p.A2, () => bodyHas(p.A2, 'Your account has been deleted'), 30000);
  await tapLabel(p.A2, 'OK');
  await eventually('OK forgets the capability', p.A2, async () => (await stored()).cap === null);
  await p.A2.goto(`${APP}/login`);
  await sleep(1500);
  check('with no capability, no deletion notice is shown', !(await bodyHas(p.A2, 'Your account has been deleted')) && !(await bodyHas(p.A2, 'being deleted')));

  step('2. A chooses Delete Permanently Now');
  await p.A.goto(`${APP}/dashboard`);
  await tapLabel(p.A, 'Delete Account');
  await eventually('the Delete Account screen offers both choices', p.A, async () =>
    (await hasLabel(p.A, 'Continue to confirmation')) && (await hasLabel(p.A, 'Delete permanently now')));
  await tapLabel(p.A, 'Delete permanently now');
  check('the irreversible consequences are spelled out', (await bodyHas(p.A, 'This is permanent and immediate'))
    && (await bodyHas(p.A, 'no way to cancel once it starts')) && (await bodyHas(p.A, 'Download My Data first')));
  check('the delete button stays disabled until password and DELETE are entered',
    await p.A.eval(`${labelEl('Permanently delete my account now')}?.getAttribute('aria-disabled') === 'true'`));
  await fill(p.A, 'Password for permanent deletion', 'wrong-password');
  await fill(p.A, 'Type DELETE to delete permanently', 'DELETE');
  await tapLabel(p.A, 'Permanently delete my account now');
  await eventually('a wrong password is explained; nothing starts', p.A, async () => (await bodyHas(p.A, 'That password isn’t right'))
    && ((await admin.from('account_deletion_jobs').select('id').eq('user_id', A.id)).data ?? []).length === 0);
  await fill(p.A, 'Password for permanent deletion', A.password);
  await tapLabel(p.A, 'Permanently delete my account now');

  step('3. Deletion in progress, then confirmed by the server');
  const seen = [];
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const text = await p.A.eval('document.body.textContent');
    if (text.includes('Your account is being deleted') && !seen.includes('in_progress')) {
      seen.push('in_progress');
      await p.A.screenshot(`${OUT}/01-deleting.png`);
    }
    if (text.includes('Your account has been deleted')) {
      seen.push('completed');
      break;
    }
    await sleep(250);
  }
  check('A first sees "Your account is being deleted"', seen[0] === 'in_progress', seen);
  check('…and "deleted" only after the server confirms', seen.includes('completed'), seen);
  const { data: job } = await admin.from('account_deletion_jobs').select('status').eq('user_id', A.id).maybeSingle();
  check('the server’s job really is completed', job?.status === 'completed', job);
  check('the account is really gone', !(await admin.auth.admin.getUserById(A.id)).data?.user);
  await p.A.screenshot(`${OUT}/02-deleted.png`);
  await tapLabel(p.A, 'OK');
  await eventually('OK leaves the app at sign-in', p.A, async () => (await path(p.A)).includes('login') && !(await bodyHas(p.A, 'Your account has been deleted')));

  step('4. B: the conversation is kept, read-only, as "Deleted account"');
  await p.B.goto(`${APP}/messages`);
  await eventually('the inbox lists the conversation as "Deleted account"', p.B, () => bodyHas(p.B, 'Deleted account'));
  await p.B.goto(`${APP}/conversation/${conv}`);
  await eventually('the thread is titled "Deleted account" and shows B’s own message', p.B, async () =>
    (await bodyHas(p.B, 'Deleted account')) && (await bodyHas(p.B, `From B ${run}`)));
  check('A’s messages are gone', !(await bodyHas(p.B, `From A ${run}`)));
  check('the composer is replaced by a read-only notice', (await bodyHas(p.B, 'This account has been deleted. You can read your messages, but can’t reply.'))
    && !(await p.B.eval(`[...document.querySelectorAll('textarea, input')].some(e => e.placeholder === 'Message...')`)));
  await p.B.screenshot(`${OUT}/03-read-only.png`);

  step('5. B: own posts stay, copies of A’s content are unavailable');
  await p.B.goto(`${APP}/user/${B.username}`);
  await eventually('the item post shows its caption and "Shared item unavailable"', p.B, async () =>
    (await bodyHas(p.B, `B loves it ${run}`)) && (await bodyHas(p.B, 'Shared item unavailable')));
  const shareRows = (await admin.from('card_share_items').select('snapshot_title').eq('post_id', sharePost)).data ?? [];
  check('the card share keeps B’s own card only (A’s card appears nowhere)', !(await bodyHas(p.B, `Gone Card ${run}`))
    && shareRows.length === 1 && shareRows[0].snapshot_title === `Stay Card ${run}`, shareRows);
  await p.B.screenshot(`${OUT}/04-b-posts.png`);
}

console.log(`App ${APP} → Supabase ${st.API_URL}  (run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
const A = await createUser('A', 'Perm Ana');
const A2 = await createUser('Z', 'Perm Zed');
const B = await createUser('B', 'Perm Ben');
const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
const pages = {};
let fatal = null;
try {
  for (const key of ['A', 'A2', 'B']) pages[key] = await browser.newPage(key);
  await scenario(pages, A, A2, B);
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
