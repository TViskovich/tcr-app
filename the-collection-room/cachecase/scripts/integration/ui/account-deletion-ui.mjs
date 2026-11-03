// Account deletion (Dashboard Milestone 2, Checkpoint 2) — UI test of the
// real screens (web build) against the LOCAL Supabase stack, in isolated
// browser contexts:
//   A  — schedules deletion from the Dashboard, then recovers
//   A2 — A on a second device, signed in before the deletion was scheduled
//   B  — a collector with a DM, a quote and a repost involving A
// Fixture rows are written through each collector's own signed-in client;
// the service role only creates/deletes the disposable accounts.
//
// Prerequisites: same as group-messaging-ui.mjs (supabase start, local-only
// Metro on :8090, shell-proxy.mjs on :8091), plus the Edge Functions served
// with the account-deletion function (supabase functions serve).
// Run:  node scripts/integration/ui/account-deletion-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'account-deletion-ui';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-account-deletion-ui`;
mkdirSync(OUT, { recursive: true });

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{')));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(APP)) throw new Error(`Refusing: ${APP} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
{
  const html = await (await fetch(APP)).text();
  const src = html.match(/src="([^"]+entry\.bundle[^"]*)"/)?.[1];
  const bundle = await (await fetch(new URL(src, APP))).text();
  if (!bundle.includes(`"EXPO_PUBLIC_SUPABASE_URL": { enumerable: true, value: "${st.API_URL}"`)) {
    throw new Error('Refusing: the web build is not pointed at the local Supabase URL.');
  }
}

// ── Check harness ──────────────────────────────────────────────────────────
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
async function eventually(name, page, fn, timeout = 20000) {
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

// ── Fixtures ───────────────────────────────────────────────────────────────
const run = randomUUID().replace(/-/g, '').slice(0, 5);
const users = {};

async function sweep() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const ids = data.users.filter((u) => u.app_metadata?.fixture === FIXTURE_TAG).map((u) => u.id);
  if (!ids.length) return 0;
  await admin.from('account_lifecycle').delete().in('user_id', ids).eq('state', 'pending_deletion');
  const { data: parts } = await admin.from('conversation_participants').select('conversation_id').in('user_id', ids);
  const convIds = [...new Set((parts ?? []).map((r) => r.conversation_id))];
  if (convIds.length) await admin.from('conversations').delete().in('id', convIds);
  await admin.from('notifications').delete().in('user_id', ids);
  await admin.from('notifications').delete().in('actor_id', ids);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}

async function createUser(key, displayName) {
  const username = `ad${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `ad-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { username, display_name: displayName },
    app_metadata: { fixture: FIXTURE_TAG },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: e } = await db.auth.signInWithPassword({ email, password });
  if (e) throw e;
  return { key, id: data.user.id, username, email, password, name: displayName, db };
}

// ── Page helpers ───────────────────────────────────────────────────────────
// react-native-web's Alert.alert is a no-op; record alerts and press the
// next queued button instead (as group-messaging-ui).
async function installAlertShim(page) {
  await page.waitFor('typeof __r === "function"', 30000);
  const ok = await page.eval(`(() => {
    const mods = __r.getModules();
    const entries = mods instanceof Map ? [...mods.entries()] : Object.entries(mods);
    const hit = entries.find(([, m]) => /react-native-web\\/dist\\/(cjs\\/)?exports\\/Alert\\/index\\.js$/.test(m.verboseName ?? ''));
    if (!hit) return false;
    const Alert = __r(Number(hit[0])).default ?? __r(Number(hit[0]));
    window.__alerts = window.__alerts ?? [];
    window.__alertChoices = window.__alertChoices ?? [];
    Alert.alert = (title, message, buttons) => {
      window.__alerts.push({ title, message: message ?? '', buttons: (buttons ?? []).map((b) => b.text) });
      const choice = window.__alertChoices.shift();
      const button = (buttons ?? []).find((b) => b.text === choice);
      if (button?.onPress) setTimeout(() => button.onPress(), 0);
    };
    return true;
  })()`);
  if (!ok) throw new Error('Alert shim: react-native-web Alert module not found');
}

async function open(page, path) {
  await page.goto(`${APP}${path}`);
  await installAlertShim(page);
}
async function login(page, u) {
  await open(page, '/login');
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
// The labelled element is on screen and not covered (screens lower in the
// stack stay in the DOM, hidden).
const showsLabel = (page, label) => page.eval(`(() => { const el = ${labelEl(label)}; if (!el) return false; const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && el.contains(hit); })()`);
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
// Replaces the text of the input labelled `label`.
async function fill(page, label, text) {
  await page.waitFor(`!!(${labelEl(label)})`, 20000, label);
  await page.eval(`(() => { const el = ${labelEl(label)}; el.focus(); el.select(); })()`);
  await page.send('Input.insertText', { text });
  await sleep(250);
}

// ── Scenario ───────────────────────────────────────────────────────────────
async function scenario(p) {
  const { A, B } = users;

  // A's post; B quotes and reposts it; an A↔B conversation; B follows nobody.
  const postA = randomUUID();
  must(await A.db.from('posts').insert({ id: postA, user_id: A.id, content: `Original by A ${run}`, post_type: 'text' }), 'A post');
  const quoteId = randomUUID();
  must(await B.db.from('posts').insert({ id: quoteId, user_id: B.id, post_type: 'quote', quote_of_post_id: postA, content: `B quoting ${run}` }), 'B quote');
  must(await B.db.from('posts').insert({ user_id: B.id, post_type: 'repost', repost_of_post_id: postA }), 'B repost');
  const convId = must(await A.db.rpc('get_or_create_conversation', { other_user_id: B.id }), 'conversation');
  must(await A.db.from('messages').insert({ id: randomUUID(), conversation_id: convId, sender_id: A.id, body: `Hello from A ${run}` }), 'A message');
  must(await B.db.from('messages').insert({ id: randomUUID(), conversation_id: convId, sender_id: B.id, body: `Hello from B ${run}` }), 'B message');

  step('0. Sign in (A, A on a second device, B)');
  await login(p.A2, A);
  await login(p.A, A);
  await login(p.B, B);
  check('all signed in', true);

  step('1. B, before: A is visible everywhere');
  await open(p.B, `/user/${A.username}`);
  await eventually('B sees A’s profile', p.B, () => bodyHas(p.B, `@${A.username}`));
  await open(p.B, `/conversation/${convId}`);
  await eventually('B has the conversation with A open (kept open, soon stale)', p.B, async () =>
    (await bodyHas(p.B, `Hello from A ${run}`)) && (await bodyHas(p.B, `Hello from B ${run}`)));

  step('2. Dashboard → Delete Account (explain, confirm)');
  await open(p.A, '/dashboard');
  await eventually('Account & Security offers Delete Account', p.A, () => hasLabel(p.A, 'Delete Account'));
  check('Download My Data is offered from Account & Security', await hasLabel(p.A, 'Download My Data'));
  await tapLabel(p.A, 'Delete Account');
  await eventually('the explanation explains the 14-day window', p.A, async () =>
    (await bodyHas(p.A, 'Delete your account after 14 days')) && (await bodyHas(p.A, 'Nothing is deleted. Sign in and tap Cancel Deletion')));
  check('nothing is scheduled by opening the explanation', (await admin.from('account_lifecycle').select('user_id').eq('user_id', A.id)).data?.length === 0);
  await tapLabel(p.A, 'Continue to confirmation');
  await eventually('the confirmation screen asks for password and DELETE', p.A, () => hasLabel(p.A, 'Type DELETE to confirm'));
  await fill(p.A, 'Password', A.password);
  check('confirm button stays disabled until DELETE is typed',
    await p.A.eval(`${labelEl('Delete my account in 14 days')}?.getAttribute('aria-disabled') === 'true'`));
  await fill(p.A, 'Type DELETE to confirm', 'DELETE');
  await fill(p.A, 'Password', 'not-the-password');
  await tapLabel(p.A, 'Delete my account in 14 days');
  await eventually('a wrong password is explained, nothing scheduled', p.A, async () =>
    (await bodyHas(p.A, 'That password isn’t right')) && (await admin.from('account_lifecycle').select('user_id').eq('user_id', A.id)).data?.length === 0);
  await fill(p.A, 'Password', A.password);
  await tapLabel(p.A, 'Delete my account in 14 days');

  step('3. Pending Deletion screen');
  await eventually('A lands on the Pending Deletion screen', p.A, async () => (await path(p.A)) === '/account/pending'
    && (await bodyHas(p.A, 'Your account is scheduled for deletion')));
  const { data: row } = await admin.from('account_lifecycle').select('state, scheduled_for').eq('user_id', A.id).single();
  check('the server has A pending for 14 days', row?.state === 'pending_deletion'
    && Math.abs(Date.parse(row.scheduled_for) - Date.now() - 14 * 86_400_000) < 300_000, row);
  const expectedDay = await p.A.eval(`new Date(${JSON.stringify(row?.scheduled_for)}).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })`);
  check('the exact deletion date is shown', await bodyHas(p.A, expectedDay), expectedDay);
  check('the remaining recovery time is shown', await p.A.eval(`/1[34] days.*left to recover your account/.test(document.body.textContent)`));
  check('Cancel Deletion and Sign Out are offered', (await hasLabel(p.A, 'Cancel deletion')) && (await hasLabel(p.A, 'Sign out')));
  await eventually('Download My Data is available on the Pending screen', p.A, () => hasLabel(p.A, 'Request my data'));
  // Checkpoint 4: Delete Permanently Now is offered (the backend is ready).
  await eventually('Delete Permanently Now is offered on the Pending screen', p.A, () => hasLabel(p.A, 'Delete permanently now'));
  check('no tab bar on the Pending Deletion screen', !(await showsLabel(p.A, 'Dashboard')));
  await p.A.screenshot(`${OUT}/01-pending.png`);
  await open(p.A, '/dashboard');
  await eventually('opening any other route bounces back to Pending Deletion', p.A, async () => (await path(p.A)) === '/account/pending');

  step('4. The other device');
  await p.A2.goto(`${APP}/dashboard`);
  await eventually('A’s second device shows only sign-in or Pending Deletion, never the app', p.A2, async () => {
    const at = await path(p.A2);
    return at.includes('login') || at === '/account/pending';
  });
  if (!(await path(p.A2)).includes('login')) {
    // Its access token hasn't expired yet; once it does, refreshing fails.
    check('(second device still has an unexpired token: shown Pending Deletion)', true);
  }

  step('5. B, during: A is unavailable everywhere');
  await p.B.type('placeholder', 'Message...', 'are you there?');
  await tapLabel(p.B, 'Send message');
  await eventually('sending from the stale thread shows the unavailable state, not a silent failure', p.B, () =>
    bodyHas(p.B, 'This conversation isn’t available'));
  await open(p.B, `/user/${A.username}`);
  await eventually('A’s profile: "This collector isn’t available."', p.B, () => bodyHas(p.B, 'This collector isn’t available.'));
  await open(p.B, '/messages');
  await sleep(4000);
  check('B’s inbox no longer lists the conversation with A', !(await bodyHas(p.B, `Hello from A ${run}`)) && !(await bodyHas(p.B, `Hello from B ${run}`)));
  await open(p.B, `/conversation/${convId}`);
  await eventually('opening the conversation shows the unavailable state', p.B, () => bodyHas(p.B, 'This conversation isn’t available'));
  check('no message of that conversation is shown', !(await bodyHas(p.B, `Hello from A ${run}`)) && !(await bodyHas(p.B, `Hello from B ${run}`)));
  await open(p.B, `/user/${B.username}`);
  await eventually('B’s quote of A’s post shows "This post is unavailable"', p.B, async () =>
    (await bodyHas(p.B, `B quoting ${run}`)) && (await bodyHas(p.B, 'This post is unavailable')));
  check('A’s original post text appears nowhere (repost dropped)', !(await bodyHas(p.B, `Original by A ${run}`)));
  await p.B.screenshot(`${OUT}/02-b-during.png`);

  step('6. Failures keep recovery available');
  await p.A.fakeRequests([{ match: /\/functions\/v1\/account-deletion/, fail: true }]);
  await tapLabel(p.A, 'Cancel deletion');
  await eventually('a network failure is explained; A stays on Pending Deletion', p.A, async () =>
    (await bodyHas(p.A, 'Couldn’t reach CacheCase')) && (await path(p.A)) === '/account/pending');
  await p.A.fakeRequests([{ match: /\/functions\/v1\/account-deletion/, status: 500, body: { status: 'failed', reason: 'server_error' } }]);
  await tapLabel(p.A, 'Cancel deletion');
  await eventually('a server failure is explained; nothing changed', p.A, async () =>
    (await bodyHas(p.A, 'Something went wrong')) && (await admin.from('account_lifecycle').select('state').eq('user_id', A.id)).data?.[0]?.state === 'pending_deletion');
  await p.A.fakeRequests([
    { match: /\/functions\/v1\/account-deletion/, status: 401, body: { status: 'failed', reason: 'invalid_token' } },
    { match: /\/auth\/v1\/token/, status: 400, body: { error: 'invalid_grant', error_description: 'Refresh Token Not Found' } },
  ]);
  await tapLabel(p.A, 'Cancel deletion');
  await eventually('an expired session leads to signing in again', p.A, async () =>
    (await path(p.A)).includes('login') || (await hasLabel(p.A, 'Sign in again')));
  await p.A.fakeRequests([]);
  if (!(await path(p.A)).includes('login')) {
    await tapLabel(p.A, 'Sign in again');
    await p.A.waitFor('location.pathname.includes("login")', 20000, 'login');
  }
  await login(p.A, A);
  await eventually('after signing in again A is back on Pending Deletion', p.A, async () => (await path(p.A)) === '/account/pending'
    && (await bodyHas(p.A, 'Your account is scheduled for deletion')));

  step('7. Cancel Deletion restores everything');
  await tapLabel(p.A, 'Cancel deletion');
  await eventually('A is back in the app', p.A, async () => (await path(p.A)) !== '/account/pending' && (await showsLabel(p.A, 'Dashboard')));
  check('the server has A active again', (await admin.from('account_lifecycle').select('user_id').eq('user_id', A.id)).data?.length === 0);
  await open(p.A, '/dashboard');
  await eventually('the Dashboard works for A again', p.A, () => hasLabel(p.A, 'Posts: 1'));
  await open(p.B, `/user/${A.username}`);
  await eventually('B sees A’s profile again', p.B, () => bodyHas(p.B, `@${A.username}`));
  await open(p.B, `/conversation/${convId}`);
  await eventually('B’s conversation with A is back with both original messages', p.B, async () =>
    (await bodyHas(p.B, `Hello from A ${run}`)) && (await bodyHas(p.B, `Hello from B ${run}`)));
  // B's own profile is cached on the device for 45 s (lib/own-profile-cache.ts),
  // so the always-fresh post page is checked here.
  await open(p.B, `/post/${quoteId}`);
  await eventually('B’s quote shows A’s post again', p.B, () => bodyHas(p.B, `Original by A ${run}`));
  await p.B.screenshot(`${OUT}/03-b-after.png`);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL}  (run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
users.A = await createUser('A', 'Del Ana');
users.B = await createUser('B', 'Del Ben');
const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
const pages = {};
let fatal = null;
try {
  for (const key of ['A', 'A2', 'B']) pages[key] = await browser.newPage(key);
  await scenario(pages);
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${current}": ${e.message}`);
  for (const [key, pg] of Object.entries(pages)) await pg.screenshot(`${OUT}/abort-${key}.png`).catch(() => {});
} finally {
  const pageErrors = Object.entries(pages).flatMap(([k, pg]) => pg.errors.map((e) => `${k}: ${String(e).replace(/\s+/g, ' ').slice(0, 260)}`));
  await browser.close();
  const removed = await sweep();
  console.log(`\nCleanup: ${removed} accounts removed.`);
  const uniq = [...new Set(pageErrors)];
  if (uniq.length) console.log(`Console errors seen (${uniq.length} distinct):\n  ${uniq.slice(0, 20).join('\n  ')}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
