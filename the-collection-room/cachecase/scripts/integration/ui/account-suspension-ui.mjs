// Account suspension (Phase 2B M3) — UI test of the real app screens (web
// build) against the LOCAL Supabase stack, in isolated browser contexts:
//   S — signed in, app open, when an admin suspends them
//   O — another collector looking at S
// Admin decisions are made through the admin RPCs with a disposable admin's
// own signed-in client; the service role only creates/deletes the accounts.
//
// Prerequisites (as group-messaging-ui.mjs): supabase start, local-only Metro
// on :8090, shell-proxy.mjs on :8091.
// Run:  node scripts/integration/ui/account-suspension-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';
import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'account-suspension-ui';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-account-suspension-ui`;
mkdirSync(OUT, { recursive: true });

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{')));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(APP)) throw new Error(`Refusing: ${APP} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const psql = (sql) => execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
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
  const list = ids.map((i) => `'${i}'`).join(',');
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM public.moderation_actions WHERE target_id::text IN (${list}) OR admin_id::text IN (${list});
        DELETE FROM public.account_suspensions WHERE user_id::text IN (${list});
        COMMIT;`);
  const { data: parts } = await admin.from('conversation_participants').select('conversation_id').in('user_id', ids);
  const convIds = [...new Set((parts ?? []).map((r) => r.conversation_id))];
  if (convIds.length) await admin.from('conversations').delete().in('id', convIds);
  await admin.from('notifications').delete().in('user_id', ids);
  await admin.from('notifications').delete().in('actor_id', ids);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}
async function createUser(key, displayName) {
  const username = `su${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `su-${randomUUID()}`;
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

// ── Page helpers (as account-deletion-ui) ──────────────────────────────────
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
async function tapLabel(page, label) {
  await page.waitFor(`!!(${labelEl(label)})`, 20000, label);
  for (let i = 0; i < 10; i++) {
    const clear = await page.eval(`(() => { const el = ${labelEl(label)}; if (!el) return false; const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && el.contains(hit); })()`);
    if (clear) break;
    await page.eval(`${labelEl(label)}?.scrollIntoView({ block: 'center' })`);
    await sleep(400);
  }
  await page.tap('label', label);
}
const onSuspended = async (page) => (await path(page)).startsWith('/account/suspended') && (await bodyHas(page, 'Your account is suspended'));

// ── Scenario ───────────────────────────────────────────────────────────────
async function scenario(p) {
  const { S, O, M1, M2 } = users;
  const postS = randomUUID();
  must(await S.db.from('posts').insert({ id: postS, user_id: S.id, content: `Post by S ${run}`, post_type: 'text' }), 'S post');
  const convId = must(await S.db.rpc('get_or_create_conversation', { other_user_id: O.id }), 'conversation');
  must(await S.db.from('messages').insert({ id: randomUUID(), conversation_id: convId, sender_id: S.id, body: `Hello from S ${run}` }), 'S message');

  step('0. Sign in (S and O); S has a conversation open');
  await login(p.S, S);
  await login(p.O, O);
  await open(p.S, `/conversation/${convId}`);
  await eventually('S sees the conversation', p.S, () => bodyHas(p.S, `Hello from S ${run}`));

  step('1. An admin suspends S while S\'s app is open');
  must(await M1.db.rpc('admin_suspend_account', { p_user_id: S.id, p_reason_code: 'harassment', p_note: 'ui test' }), 'suspend');
  // S, unaware, sends a message (as group-messaging-ui sends one).
  await p.S.type('placeholder', 'Message...', `blocked ${run}`);
  await p.S.tap('label', 'Send message');
  await eventually('the refused send switches the open app to the Account Suspended screen', p.S, () => onSuspended(p.S), 30000);
  check('the message was not sent', psql(`SELECT count(*) FROM public.messages WHERE body = 'blocked ${run}'`) === '0');

  step('2. The Account Suspended screen');
  check('a safe reason category, not the internal reason', (await bodyHas(p.S, 'Violating the CacheCase Community Guidelines')) && !(await bodyHas(p.S, 'harassment')) && !(await bodyHas(p.S, 'ui test')));
  check('an indefinite suspension says it has no end date', await bodyHas(p.S, 'No end date'));
  check('the support address is shown', await bodyHas(p.S, 'info@cachecase.com'));
  check('Download My Data is offered', await bodyHas(p.S, 'Download My Data'));
  check('Delete Account is offered', await hasLabel(p.S, 'Delete account'));
  check('no tab bar or app navigation is shown', !(await bodyHas(p.S, `Post by S ${run}`)) && !(await hasLabel(p.S, 'Home')));

  step('3. Nothing else is reachable');
  for (const target of ['/', `/user/${O.username}`, '/dashboard', `/conversation/${convId}`, '/settings']) {
    await open(p.S, target);
    await eventually(`${target} bounces back to the suspended screen`, p.S, () => onSuspended(p.S), 30000);
  }
  await tapLabel(p.S, 'Delete account');
  await eventually('Delete Account stays reachable', p.S, async () => (await path(p.S)).startsWith('/account/delete') && (await bodyHas(p.S, 'Delete your account after')));
  await open(p.S, '/account/suspended');
  await eventually('after a reload S still sees the suspended screen', p.S, () => onSuspended(p.S), 30000);

  step('4. O looks at S');
  await open(p.O, `/user/${S.username}`);
  await sleep(3000);
  check('O does not see S\'s profile or posts', !(await bodyHas(p.O, `Post by S ${run}`)));

  step('5. A temporary suspension, then its expiry while the screen is open');
  must(await M2.db.rpc('admin_lift_suspension', { p_user_id: S.id, p_reason_code: 'resolved_in_error' }), 'lift');
  const until = new Date(Date.now() + 2 * 3600_000).toISOString();
  must(await M1.db.rpc('admin_suspend_account', { p_user_id: S.id, p_reason_code: 'spam', p_expires_at: until }), 'temporary');
  await tapLabel(p.S, 'Check again');
  await eventually('the screen shows the end date and the spam category', p.S, async () =>
    (await bodyHas(p.S, 'Suspended until')) && (await bodyHas(p.S, 'Spam, scams or fraudulent activity')));
  // Time passes (simulated as an operator would).
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE public.account_suspensions SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 second' WHERE user_id = '${S.id}' AND lifted_at IS NULL;
        COMMIT;`);
  await tapLabel(p.S, 'Check again');
  await eventually('after expiry S is back in the app, with no new account', p.S, async () => !(await path(p.S)).startsWith('/account/suspended'), 30000);

  step('6. Reinstatement by an admin while the screen is open (no tap needed)');
  must(await M1.db.rpc('admin_suspend_account', { p_user_id: S.id, p_reason_code: 'impersonation' }), 'suspend again');
  await open(p.S, '/');
  await eventually('suspended again', p.S, () => onSuspended(p.S), 30000);
  must(await M2.db.rpc('admin_lift_suspension', { p_user_id: S.id, p_reason_code: 'appeal_granted' }), 'lift again');
  await eventually('the open app returns by itself within a minute', p.S, async () => !(await path(p.S)).startsWith('/account/suspended'), 80000);
  await open(p.O, `/user/${S.username}`);
  await eventually('O sees S again', p.O, () => bodyHas(p.O, `@${S.username}`), 30000);
  check('no deletion was started at any point', psql(`SELECT count(*) FROM public.account_lifecycle WHERE user_id = '${S.id}'`) === '0');
}

const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
users.S = await createUser('S', 'Sus Sam');
users.O = await createUser('O', 'Sus Oli');
users.M1 = await createUser('M1', 'Sus Admin One');
users.M2 = await createUser('M2', 'Sus Admin Two');
must(await admin.from('admin_users').insert([{ user_id: users.M1.id }, { user_id: users.M2.id }]), 'admins');
const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
const pages = {};
let fatal = null;
try {
  for (const key of ['S', 'O']) pages[key] = await browser.newPage(key);
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
